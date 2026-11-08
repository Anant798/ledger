-- Additive savings-goal completion: soft deletion, audit-preserving contribution
-- changes, recurring rules, and atomic notification/contribution writes.
ALTER TABLE public.savings_goals ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.goal_contributions ADD COLUMN IF NOT EXISTS manually_reversed_at timestamptz;
ALTER TABLE public.goal_contributions ADD COLUMN IF NOT EXISTS reversed_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_savings_goals_active_user ON public.savings_goals(user_id, created_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS public.savings_contribution_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contribution_id uuid NOT NULL REFERENCES public.goal_contributions(id) ON DELETE RESTRICT,
  goal_id uuid NOT NULL REFERENCES public.savings_goals(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('created','updated','reversed')),
  before_state jsonb,
  after_state jsonb,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_savings_contribution_events_history ON public.savings_contribution_events(user_id, goal_id, created_at DESC);
ALTER TABLE public.savings_contribution_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.savings_contribution_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.savings_contribution_events TO authenticated;
GRANT ALL ON public.savings_contribution_events TO service_role;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='savings_contribution_events' AND policyname='Users view own savings contribution events') THEN
    CREATE POLICY "Users view own savings contribution events" ON public.savings_contribution_events FOR SELECT TO authenticated USING ((SELECT auth.uid())=user_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.savings_goal_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id uuid NOT NULL REFERENCES public.savings_goals(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount numeric NOT NULL CHECK (amount > 0),
  frequency text NOT NULL CHECK (frequency IN ('weekly','monthly')),
  day_of_month smallint CHECK (day_of_month BETWEEN 1 AND 31),
  enabled boolean NOT NULL DEFAULT true,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  last_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_savings_goal_rules_goal UNIQUE (goal_id)
);
CREATE INDEX IF NOT EXISTS idx_savings_goal_rules_due ON public.savings_goal_rules(next_run_at) WHERE enabled=true;
ALTER TABLE public.savings_goal_rules ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.savings_goal_rules FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.savings_goal_rules TO authenticated;
GRANT ALL ON public.savings_goal_rules TO service_role;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='savings_goal_rules' AND policyname='Users manage own savings goal rules') THEN
    CREATE POLICY "Users manage own savings goal rules" ON public.savings_goal_rules FOR ALL TO authenticated
      USING ((SELECT auth.uid())=user_id AND EXISTS (SELECT 1 FROM public.savings_goals g WHERE g.id=goal_id AND g.user_id=(SELECT auth.uid()) AND g.deleted_at IS NULL))
      WITH CHECK ((SELECT auth.uid())=user_id AND EXISTS (SELECT 1 FROM public.savings_goals g WHERE g.id=goal_id AND g.user_id=(SELECT auth.uid()) AND g.deleted_at IS NULL));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.audit_savings_contribution_source_changes()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_goal public.savings_goals; v_total numeric;
BEGIN
  IF TG_OP='INSERT' THEN
    INSERT INTO public.savings_contribution_events(contribution_id,goal_id,user_id,event_type,after_state)
      VALUES(NEW.id,NEW.goal_id,NEW.user_id,'created',to_jsonb(NEW));
    IF NEW.contribution_source IN ('transaction','automatic') THEN
      SELECT * INTO v_goal FROM public.savings_goals WHERE id=NEW.goal_id AND user_id=NEW.user_id FOR UPDATE;
      INSERT INTO public.alerts(user_id,alert_type,title,message,is_read,is_resolved)
        VALUES(NEW.user_id,'general','Savings contribution recorded',format('Added %s to %s.',NEW.amount,v_goal.title),false,false);
      SELECT COALESCE(SUM(amount),0) INTO v_total FROM public.goal_contributions WHERE goal_id=NEW.goal_id AND contribution_status='confirmed';
      IF v_total>=v_goal.target_amount AND v_goal.status='active' THEN
        UPDATE public.savings_goals SET status='completed',updated_at=now() WHERE id=NEW.goal_id;
        UPDATE public.savings_goal_rules SET enabled=false,updated_at=now() WHERE goal_id=NEW.goal_id;
        INSERT INTO public.alerts(user_id,alert_type,title,message,is_read,is_resolved)
          VALUES(NEW.user_id,'goal_milestone','Savings goal completed',format('You reached your %s savings target.',v_goal.title),false,false);
      END IF;
    END IF;
  ELSIF NEW.contribution_status IS DISTINCT FROM OLD.contribution_status
    AND NEW.manually_reversed_at IS NULL AND NEW.contribution_source<>'manual' THEN
    INSERT INTO public.savings_contribution_events(contribution_id,goal_id,user_id,event_type,before_state,after_state,reason)
      VALUES(NEW.id,NEW.goal_id,NEW.user_id,'reversed',to_jsonb(OLD),to_jsonb(NEW),'Source transaction reversed, failed, or refunded');
    PERFORM public.reconcile_savings_goal_completion(NEW.goal_id,NEW.user_id);
  END IF;
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.audit_savings_contribution_source_changes() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER trg_audit_savings_contribution_source_changes
AFTER INSERT OR UPDATE OF contribution_status ON public.goal_contributions
FOR EACH ROW EXECUTE FUNCTION public.audit_savings_contribution_source_changes();

CREATE OR REPLACE FUNCTION public.reconcile_goal_contribution_refunds(p_source_transaction_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_source_status text; v_refunded numeric;
BEGIN
  IF p_source_transaction_id IS NULL THEN RETURN; END IF;
  SELECT status INTO v_source_status FROM public.transactions WHERE id=p_source_transaction_id;
  SELECT COALESCE(SUM(abs(amount)),0) INTO v_refunded FROM public.transactions
    WHERE related_transaction_id=p_source_transaction_id AND transaction_type IN ('refund','reversal') AND status='completed';
  UPDATE public.goal_contributions gc SET contribution_status=CASE
    WHEN v_source_status IN ('failed','cancelled','refunded') OR v_refunded>=gc.amount THEN 'reversed' ELSE 'confirmed' END
    WHERE gc.transaction_id=p_source_transaction_id AND gc.manually_reversed_at IS NULL
      AND gc.contribution_status IN ('confirmed','reversed');
END; $$;
REVOKE ALL ON FUNCTION public.reconcile_goal_contribution_refunds(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_goal_contribution_refunds(uuid) TO service_role;

-- Keep user reversals authoritative when source-transaction refund triggers run.
CREATE OR REPLACE FUNCTION public.reverse_linked_goal_contributions()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    UPDATE public.goal_contributions SET contribution_status='reversed'
      WHERE transaction_id=OLD.id AND manually_reversed_at IS NULL AND contribution_status='confirmed';
    RETURN OLD;
  END IF;
  IF NEW.status IN ('failed','cancelled','refunded') THEN
    UPDATE public.goal_contributions SET contribution_status='reversed'
      WHERE transaction_id=NEW.id AND manually_reversed_at IS NULL AND contribution_status='confirmed';
  ELSE
    PERFORM public.reconcile_goal_contribution_refunds(NEW.id);
  END IF;
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.reverse_linked_goal_contributions() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.record_manual_goal_contribution(p_user_id uuid,p_goal_id uuid,p_amount numeric,p_notes text,p_contributed_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_goal public.savings_goals; v_row public.goal_contributions; v_total numeric; v_old numeric;
BEGIN
  IF auth.uid() IS DISTINCT FROM p_user_id THEN RAISE EXCEPTION 'not authorized'; END IF;
  IF p_amount<=0 THEN RAISE EXCEPTION 'Contribution amount must be positive'; END IF;
  SELECT * INTO v_goal FROM public.savings_goals WHERE id=p_goal_id AND user_id=p_user_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Savings goal not found'; END IF;
  SELECT COALESCE(SUM(amount),0) INTO v_old FROM public.goal_contributions WHERE goal_id=p_goal_id AND contribution_status='confirmed';
  INSERT INTO public.goal_contributions(goal_id,user_id,amount,contribution_source,contribution_status,notes,contributed_at)
    VALUES(p_goal_id,p_user_id,p_amount,'manual','confirmed',p_notes,COALESCE(p_contributed_at,now())) RETURNING * INTO v_row;
  SELECT COALESCE(SUM(amount),0) INTO v_total FROM public.goal_contributions WHERE goal_id=p_goal_id AND contribution_status='confirmed';
  INSERT INTO public.alerts(user_id,alert_type,title,message,is_read,is_resolved)
    VALUES(p_user_id,'general','Savings contribution recorded',format('Added %s to %s.',p_amount,v_goal.title),false,false);
  IF v_old<v_goal.target_amount*0.5 AND v_total>=v_goal.target_amount*0.5 THEN
    INSERT INTO public.alerts(user_id,alert_type,title,message,is_read,is_resolved) VALUES(p_user_id,'goal_milestone','Savings goal halfway there',format('%s reached 50%% of its target.',v_goal.title),false,false);
  ELSIF v_old<v_goal.target_amount*0.25 AND v_total>=v_goal.target_amount*0.25 THEN
    INSERT INTO public.alerts(user_id,alert_type,title,message,is_read,is_resolved) VALUES(p_user_id,'goal_milestone','Savings goal milestone',format('%s reached 25%% of its target.',v_goal.title),false,false);
  END IF;
  IF v_old<v_goal.target_amount AND v_total>=v_goal.target_amount THEN
    UPDATE public.savings_goals SET status='completed',updated_at=now() WHERE id=p_goal_id;
    INSERT INTO public.alerts(user_id,alert_type,title,message,is_read,is_resolved) VALUES(p_user_id,'goal_milestone','Savings goal completed',format('You reached your %s savings target.',v_goal.title),false,false);
  END IF;
  RETURN to_jsonb(v_row);
END; $$;
REVOKE ALL ON FUNCTION public.record_manual_goal_contribution(uuid,uuid,numeric,text,timestamptz) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.record_manual_goal_contribution(uuid,uuid,numeric,text,timestamptz) TO authenticated;

CREATE OR REPLACE FUNCTION public.archive_savings_goal(p_user_id uuid,p_goal_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF auth.uid() IS DISTINCT FROM p_user_id THEN RAISE EXCEPTION 'not authorized'; END IF;
  UPDATE public.savings_goals SET deleted_at=now(),updated_at=now() WHERE id=p_goal_id AND user_id=p_user_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Savings goal not found'; END IF;
  UPDATE public.savings_goal_rules SET enabled=false,updated_at=now() WHERE goal_id=p_goal_id AND user_id=p_user_id;
  RETURN true;
END; $$;
REVOKE ALL ON FUNCTION public.archive_savings_goal(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.archive_savings_goal(uuid,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.complete_savings_goal(p_user_id uuid,p_goal_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_goal public.savings_goals; v_total numeric;
BEGIN
  IF auth.uid() IS DISTINCT FROM p_user_id THEN RAISE EXCEPTION 'not authorized'; END IF;
  SELECT * INTO v_goal FROM public.savings_goals WHERE id=p_goal_id AND user_id=p_user_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Savings goal not found'; END IF;
  SELECT COALESCE(SUM(amount),0) INTO v_total FROM public.goal_contributions WHERE goal_id=p_goal_id AND contribution_status='confirmed';
  IF v_total<v_goal.target_amount THEN RAISE EXCEPTION 'Goal cannot be completed before confirmed contributions reach the target'; END IF;
  UPDATE public.savings_goals SET status='completed',updated_at=now() WHERE id=p_goal_id;
  UPDATE public.savings_goal_rules SET enabled=false,updated_at=now() WHERE goal_id=p_goal_id;
  INSERT INTO public.alerts(user_id,alert_type,title,message,is_read,is_resolved) VALUES(p_user_id,'goal_milestone','Savings goal completed',format('You reached your %s savings target.',v_goal.title),false,false);
  RETURN jsonb_build_object('completed',true,'confirmed_amount',v_total);
END; $$;
REVOKE ALL ON FUNCTION public.complete_savings_goal(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.complete_savings_goal(uuid,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.update_savings_contribution(p_user_id uuid,p_contribution_id uuid,p_amount numeric,p_notes text,p_update_notes boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_row public.goal_contributions; v_before jsonb;
BEGIN
  IF auth.uid() IS DISTINCT FROM p_user_id THEN RAISE EXCEPTION 'not authorized'; END IF;
  SELECT * INTO v_row FROM public.goal_contributions WHERE id=p_contribution_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND OR v_row.contribution_status<>'confirmed' THEN RAISE EXCEPTION 'Confirmed contribution not found'; END IF;
  IF v_row.contribution_source<>'manual' THEN RAISE EXCEPTION 'Only manual contributions can be edited'; END IF;
  IF p_amount IS NOT NULL AND p_amount<=0 THEN RAISE EXCEPTION 'Contribution amount must be positive'; END IF;
  PERFORM 1 FROM public.savings_goals WHERE id=v_row.goal_id AND user_id=p_user_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Savings goal not found'; END IF;
  v_before:=to_jsonb(v_row);
  UPDATE public.goal_contributions SET amount=COALESCE(p_amount,amount),notes=CASE WHEN p_update_notes THEN p_notes ELSE notes END WHERE id=p_contribution_id RETURNING * INTO v_row;
  INSERT INTO public.savings_contribution_events(contribution_id,goal_id,user_id,event_type,before_state,after_state) VALUES(v_row.id,v_row.goal_id,p_user_id,'updated',v_before,to_jsonb(v_row));
  PERFORM public.reconcile_savings_goal_completion(v_row.goal_id,p_user_id);
  RETURN to_jsonb(v_row);
END; $$;
REVOKE ALL ON FUNCTION public.update_savings_contribution(uuid,uuid,numeric,text,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.update_savings_contribution(uuid,uuid,numeric,text,boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.reverse_savings_contribution(p_user_id uuid,p_contribution_id uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_row public.goal_contributions; v_before jsonb;
BEGIN
  IF auth.uid() IS DISTINCT FROM p_user_id THEN RAISE EXCEPTION 'not authorized'; END IF;
  SELECT * INTO v_row FROM public.goal_contributions WHERE id=p_contribution_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND OR v_row.contribution_status<>'confirmed' THEN RAISE EXCEPTION 'Confirmed contribution not found'; END IF;
  PERFORM 1 FROM public.savings_goals WHERE id=v_row.goal_id AND user_id=p_user_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Savings goal not found'; END IF;
  v_before:=to_jsonb(v_row);
  UPDATE public.goal_contributions SET contribution_status='reversed',manually_reversed_at=now(),reversed_by_user_id=p_user_id WHERE id=p_contribution_id RETURNING * INTO v_row;
  INSERT INTO public.savings_contribution_events(contribution_id,goal_id,user_id,event_type,before_state,after_state,reason)
    VALUES(v_row.id,v_row.goal_id,p_user_id,'reversed',v_before,to_jsonb(v_row),p_reason);
  INSERT INTO public.alerts(user_id,alert_type,title,message,is_read,is_resolved) VALUES(p_user_id,'general','Savings contribution reversed',format('A contribution to %s was reversed.',(SELECT title FROM public.savings_goals WHERE id=v_row.goal_id)),false,false);
  PERFORM public.reconcile_savings_goal_completion(v_row.goal_id,p_user_id);
  RETURN to_jsonb(v_row);
END; $$;
REVOKE ALL ON FUNCTION public.reverse_savings_contribution(uuid,uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.reverse_savings_contribution(uuid,uuid,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.reconcile_savings_goal_completion(p_goal_id uuid,p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_goal public.savings_goals; v_total numeric;
BEGIN
  SELECT * INTO v_goal FROM public.savings_goals WHERE id=p_goal_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND OR v_goal.deleted_at IS NOT NULL THEN RETURN; END IF;
  SELECT COALESCE(SUM(amount),0) INTO v_total FROM public.goal_contributions WHERE goal_id=p_goal_id AND contribution_status='confirmed';
  IF v_total<v_goal.target_amount AND v_goal.status='completed' THEN
    UPDATE public.savings_goals SET status='active',updated_at=now() WHERE id=p_goal_id;
    UPDATE public.savings_goal_rules SET enabled=true,updated_at=now(),next_run_at=GREATEST(next_run_at,now()) WHERE goal_id=p_goal_id AND last_run_at IS NOT NULL;
  ELSIF v_total>=v_goal.target_amount AND v_goal.status='active' THEN
    UPDATE public.savings_goals SET status='completed',updated_at=now() WHERE id=p_goal_id;
    UPDATE public.savings_goal_rules SET enabled=false,updated_at=now() WHERE goal_id=p_goal_id;
    INSERT INTO public.alerts(user_id,alert_type,title,message,is_read,is_resolved) VALUES(p_user_id,'goal_milestone','Savings goal completed',format('You reached your %s savings target.',v_goal.title),false,false);
  END IF;
END; $$;
REVOKE ALL ON FUNCTION public.reconcile_savings_goal_completion(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_savings_goal_completion(uuid,uuid) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.run_due_savings_goal_rules(p_limit integer DEFAULT 100)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r record; v_contribution public.goal_contributions; v_total numeric; v_count integer:=0; v_next timestamptz;
BEGIN
  IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service role required'; END IF;
  FOR r IN SELECT rule.*,goal.title,goal.target_amount FROM public.savings_goal_rules rule
    JOIN public.savings_goals goal ON goal.id=rule.goal_id AND goal.user_id=rule.user_id
    WHERE rule.enabled AND rule.next_run_at<=now() AND goal.status='active' AND goal.deleted_at IS NULL
    ORDER BY rule.next_run_at FOR UPDATE OF rule SKIP LOCKED LIMIT LEAST(GREATEST(p_limit,1),500)
  LOOP
    INSERT INTO public.goal_contributions(goal_id,user_id,amount,contribution_source,contribution_status,notes,contributed_at)
      VALUES(r.goal_id,r.user_id,r.amount,'automatic','confirmed','Scheduled savings contribution',now()) RETURNING * INTO v_contribution;
    SELECT COALESCE(SUM(amount),0) INTO v_total FROM public.goal_contributions WHERE goal_id=r.goal_id AND contribution_status='confirmed';
    IF r.frequency='weekly' THEN v_next:=r.next_run_at+interval '7 days';
    ELSE v_next:=make_timestamptz(
        EXTRACT(YEAR FROM r.next_run_at+interval '1 month')::integer,
        EXTRACT(MONTH FROM r.next_run_at+interval '1 month')::integer,
        LEAST(COALESCE(r.day_of_month,EXTRACT(DAY FROM r.next_run_at)::integer),
          EXTRACT(DAY FROM (date_trunc('month',r.next_run_at+interval '2 months')-interval '1 day'))::integer),
        EXTRACT(HOUR FROM r.next_run_at)::integer,EXTRACT(MINUTE FROM r.next_run_at)::integer,
        EXTRACT(SECOND FROM r.next_run_at), 'UTC'); END IF;
    UPDATE public.savings_goal_rules SET last_run_at=now(),next_run_at=v_next,updated_at=now()
      WHERE id=r.id AND enabled=true;
    v_count:=v_count+1;
  END LOOP;
  RETURN v_count;
END; $$;
REVOKE ALL ON FUNCTION public.run_due_savings_goal_rules(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.run_due_savings_goal_rules(integer) TO service_role;
