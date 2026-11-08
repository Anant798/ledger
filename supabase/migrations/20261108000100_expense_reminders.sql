-- Additive Batch B reconciliation for the existing live schema.
-- This file is prepared for review only and must not be applied automatically.

ALTER TABLE public.expense_shares ADD COLUMN IF NOT EXISTS participant_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;
CREATE INDEX idx_expense_shares_participant_user_id
  ON public.expense_shares(participant_user_id) WHERE participant_user_id IS NOT NULL;

CREATE FUNCTION public.next_expense_reminder_time(
  p_after timestamptz, p_preferred_send_time time, p_timezone text
) RETURNS timestamptz LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_local timestamp; v_candidate timestamp;
BEGIN
  IF p_timezone IS NULL OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = p_timezone) THEN
    RAISE EXCEPTION 'invalid reminder timezone: %', p_timezone USING ERRCODE = '22023';
  END IF;
  v_local := p_after AT TIME ZONE p_timezone;
  v_candidate := date_trunc('day', v_local) + p_preferred_send_time;
  IF v_candidate < v_local THEN v_candidate := v_candidate + interval '1 day'; END IF;
  RETURN v_candidate AT TIME ZONE p_timezone;
END; $$;

-- Application requests already carry UUID idempotency keys. Keep the existing
-- external_reference column and protect retries without changing old rows.
CREATE UNIQUE INDEX uq_repayments_idempotency_reference
  ON public.repayments(user_id, expense_share_id, external_reference)
  WHERE external_reference ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

ALTER TABLE public.goal_contributions ADD COLUMN IF NOT EXISTS idempotency_key uuid;
ALTER TABLE public.goal_contributions ADD COLUMN IF NOT EXISTS transaction_id uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.goal_contributions'::regclass AND conname='goal_contributions_transaction_id_fkey') THEN
    ALTER TABLE public.goal_contributions ADD CONSTRAINT goal_contributions_transaction_id_fkey
      FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE UNIQUE INDEX uq_goal_contributions_automatic_idempotency
  ON public.goal_contributions(user_id, goal_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX uq_goal_contributions_transaction
  ON public.goal_contributions(user_id, goal_id, transaction_id)
  WHERE transaction_id IS NOT NULL;
CREATE INDEX idx_goal_contributions_transaction_id
  ON public.goal_contributions(transaction_id) WHERE transaction_id IS NOT NULL;

CREATE FUNCTION public.record_shared_expense_repayment(
  p_user_id uuid, p_share_id uuid, p_amount numeric, p_currency_code text,
  p_payment_method text, p_payment_provider text, p_external_reference text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_share public.expense_shares;
  v_existing public.repayments;
  v_paid numeric;
  v_remaining numeric;
  v_repayment public.repayments;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authorized');
  END IF;
  -- Lock the share to serialize competing repayments and same-key retries.
  SELECT * INTO v_share FROM public.expense_shares
    WHERE id = p_share_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM public.expense_groups WHERE id = v_share.expense_group_id AND user_id = p_user_id
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Expense share not found or access denied');
  END IF;

  IF p_external_reference IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.repayments
      WHERE user_id = p_user_id AND expense_share_id = p_share_id
        AND external_reference = p_external_reference LIMIT 1;
    IF FOUND THEN
      SELECT COALESCE(SUM(amount), 0) INTO v_paid FROM public.repayments
        WHERE expense_share_id = p_share_id AND payment_status = 'confirmed';
      RETURN jsonb_build_object('success', true, 'result', jsonb_build_object(
        'repayment', to_jsonb(v_existing), 'duplicate', true,
        'remainingBalance', greatest(0, v_share.amount_owed - v_paid)
      ));
    END IF;
  END IF;

  IF p_amount <= 0 THEN RETURN jsonb_build_object('success', false, 'error', 'Repayment amount must be positive'); END IF;
  IF p_payment_method NOT IN ('upi', 'paypal', 'cash', 'bank_transfer', 'other') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unsupported payment method');
  END IF;
  SELECT COALESCE(SUM(amount), 0) INTO v_paid FROM public.repayments
    WHERE expense_share_id = p_share_id AND payment_status = 'confirmed';
  v_remaining := greatest(0, v_share.amount_owed - v_paid);
  IF p_amount > v_remaining + 0.01 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Repayment exceeds outstanding balance');
  END IF;

  INSERT INTO public.repayments(expense_share_id, user_id, amount, currency_code, payment_method,
      payment_status, confirmation_source, payment_provider, external_reference, confirmed_at)
    VALUES(p_share_id, p_user_id, p_amount, p_currency_code, p_payment_method,
      'confirmed', 'manual', p_payment_provider, p_external_reference, now())
    RETURNING * INTO v_repayment;
  -- This insert is in the same transaction as repayment creation; failure rolls back both.
  INSERT INTO public.repayment_events(repayment_id, user_id, event_type, event_source, metadata)
    VALUES(v_repayment.id, p_user_id, 'confirmed', 'manual',
      jsonb_build_object('expense_share_id', p_share_id, 'amount', p_amount,
        'remaining_balance', greatest(0, v_remaining - p_amount)));
  RETURN jsonb_build_object('success', true, 'result', jsonb_build_object(
    'repayment', to_jsonb(v_repayment), 'remainingBalance', greatest(0, v_remaining - p_amount),
    'isShareSettled', v_paid + p_amount >= v_share.amount_owed - 0.01
  ));
END; $$;
REVOKE ALL ON FUNCTION public.record_shared_expense_repayment(uuid,uuid,numeric,text,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_shared_expense_repayment(uuid,uuid,numeric,text,text,text,text) TO authenticated, service_role;

CREATE FUNCTION public.create_shared_expense_group(p_user_id uuid,p_group jsonb,p_shares jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_group public.expense_groups; v_shares jsonb; v_sum numeric;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN RAISE EXCEPTION 'not authorized'; END IF;
  IF jsonb_typeof(p_shares) <> 'array' OR jsonb_array_length(p_shares) < 1 THEN RAISE EXCEPTION 'at least one share is required'; END IF;
  IF NULLIF(p_group->>'transaction_id','') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.transactions WHERE id=(p_group->>'transaction_id')::uuid AND user_id=p_user_id
  ) THEN RAISE EXCEPTION 'transaction not found or access denied'; END IF;
  SELECT COALESCE(SUM((share->>'amount_owed')::numeric),0) INTO v_sum FROM jsonb_array_elements(p_shares) share;
  IF abs(v_sum-(p_group->>'total_amount')::numeric) > 0.01 THEN RAISE EXCEPTION 'share amounts must equal total amount'; END IF;
  INSERT INTO public.expense_groups(user_id,transaction_id,title,total_amount,currency_code,split_method)
  VALUES(p_user_id,NULLIF(p_group->>'transaction_id','')::uuid,p_group->>'title',
    (p_group->>'total_amount')::numeric,COALESCE(p_group->>'currency_code','INR'),p_group->>'split_method')
  RETURNING * INTO v_group;
  INSERT INTO public.expense_shares(expense_group_id,user_id,participant_type,participant_name,participant_user_id,email,phone_number,amount_owed)
  SELECT v_group.id,p_user_id,share->>'participant_type',share->>'participant_name',
    NULLIF(share->>'participant_user_id','')::uuid,
    NULLIF(share->>'email',''),NULLIF(share->>'phone_number',''),(share->>'amount_owed')::numeric
  FROM jsonb_array_elements(p_shares) share;
  SELECT COALESCE(jsonb_agg(to_jsonb(sh) ORDER BY sh.created_at,sh.id),'[]'::jsonb) INTO v_shares
    FROM public.expense_shares sh WHERE sh.expense_group_id=v_group.id;
  RETURN to_jsonb(v_group)||jsonb_build_object('shares',v_shares);
END; $$;
REVOKE ALL ON FUNCTION public.create_shared_expense_group(uuid,jsonb,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_shared_expense_group(uuid,jsonb,jsonb) TO authenticated, service_role;

CREATE FUNCTION public.add_automated_goal_contribution(
  p_user_id uuid, p_goal_id uuid, p_amount numeric, p_notes text, p_idempotency_key uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_contribution public.goal_contributions;
BEGIN
  IF p_amount <= 0 OR p_idempotency_key IS NULL THEN RAISE EXCEPTION 'A positive amount and idempotency key are required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.savings_goals WHERE id = p_goal_id AND user_id = p_user_id) THEN
    RAISE EXCEPTION 'Goal not found or access denied';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.transactions WHERE id = p_idempotency_key AND user_id = p_user_id AND status='completed') THEN
    RAISE EXCEPTION 'Completed source transaction not found or access denied';
  END IF;
  INSERT INTO public.goal_contributions(goal_id, user_id, amount, contribution_source,
      contribution_status, notes, contributed_at, idempotency_key, transaction_id)
    VALUES(p_goal_id, p_user_id, p_amount, 'automatic', 'confirmed', p_notes, now(), p_idempotency_key, p_idempotency_key)
    ON CONFLICT (user_id, goal_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
    RETURNING * INTO v_contribution;
  IF NOT FOUND THEN
    SELECT * INTO v_contribution FROM public.goal_contributions
      WHERE user_id = p_user_id AND goal_id = p_goal_id AND idempotency_key = p_idempotency_key;
  END IF;
  RETURN to_jsonb(v_contribution);
END; $$;
REVOKE ALL ON FUNCTION public.add_automated_goal_contribution(uuid,uuid,numeric,text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_automated_goal_contribution(uuid,uuid,numeric,text,uuid) TO service_role;

CREATE FUNCTION public.add_transaction_goal_contribution(
  p_user_id uuid,p_goal_id uuid,p_transaction_id uuid,p_amount numeric,p_notes text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_contribution public.goal_contributions;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN RAISE EXCEPTION 'not authorized'; END IF;
  IF p_amount <= 0 OR NOT EXISTS (SELECT 1 FROM public.savings_goals WHERE id=p_goal_id AND user_id=p_user_id)
    OR NOT EXISTS (SELECT 1 FROM public.transactions WHERE id=p_transaction_id AND user_id=p_user_id AND status='completed') THEN
    RAISE EXCEPTION 'Goal or transaction not found, or invalid contribution amount';
  END IF;
  INSERT INTO public.goal_contributions(goal_id,user_id,amount,contribution_source,contribution_status,
      notes,contributed_at,idempotency_key,transaction_id)
    VALUES(p_goal_id,p_user_id,p_amount,'transaction','confirmed',p_notes,now(),p_transaction_id,p_transaction_id)
    ON CONFLICT (user_id,goal_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
    RETURNING * INTO v_contribution;
  IF NOT FOUND THEN
    SELECT * INTO v_contribution FROM public.goal_contributions
      WHERE user_id=p_user_id AND goal_id=p_goal_id AND idempotency_key=p_transaction_id;
  END IF;
  RETURN to_jsonb(v_contribution);
END; $$;
REVOKE ALL ON FUNCTION public.add_transaction_goal_contribution(uuid,uuid,uuid,numeric,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_transaction_goal_contribution(uuid,uuid,uuid,numeric,text) TO authenticated, service_role;

CREATE FUNCTION public.reverse_linked_goal_contributions()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_source_id uuid;
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.transaction_type NOT IN ('refund','reversal') THEN
      UPDATE public.goal_contributions SET contribution_status='reversed'
        WHERE transaction_id=OLD.id AND contribution_status='confirmed';
    ELSE
      PERFORM public.reconcile_goal_contribution_refunds(OLD.related_transaction_id);
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' AND OLD.transaction_type IN ('refund','reversal') THEN
    PERFORM public.reconcile_goal_contribution_refunds(OLD.related_transaction_id);
  END IF;
  IF NEW.transaction_type IN ('refund','reversal') THEN v_source_id := NEW.related_transaction_id;
  ELSE v_source_id := NEW.id; END IF;
  PERFORM public.reconcile_goal_contribution_refunds(v_source_id);
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.reverse_linked_goal_contributions() FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.reconcile_goal_contribution_refunds(p_source_transaction_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_source_status text; v_refunded numeric;
BEGIN
  IF p_source_transaction_id IS NULL THEN RETURN; END IF;
  SELECT status INTO v_source_status FROM public.transactions WHERE id=p_source_transaction_id;
  SELECT COALESCE(SUM(abs(amount)),0) INTO v_refunded FROM public.transactions
    WHERE related_transaction_id=p_source_transaction_id
      AND transaction_type IN ('refund','reversal') AND status='completed';
  UPDATE public.goal_contributions gc SET contribution_status=CASE
    WHEN v_source_status IN ('failed','cancelled','refunded') OR v_refunded >= gc.amount THEN 'reversed'
    ELSE 'confirmed' END
  WHERE gc.transaction_id=p_source_transaction_id AND gc.contribution_status IN ('confirmed','reversed');
END; $$;
REVOKE ALL ON FUNCTION public.reconcile_goal_contribution_refunds(uuid) FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_reverse_linked_goal_contributions
  AFTER INSERT OR UPDATE OR DELETE ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.reverse_linked_goal_contributions();

-- Reuse reminder_logs as the queue and delivery state. scheduled_for is also
-- the retry due time; reminder_attempts stores the durable per-attempt history.
ALTER TABLE public.reminder_logs
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS reminder_sequence integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS lease_until timestamptz,
  ADD COLUMN IF NOT EXISTS last_error text;
ALTER TABLE public.reminder_settings
  ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 5;
DO $$
DECLARE v_name text; v_count integer;
BEGIN
  SELECT count(*), min(conname) INTO v_count, v_name FROM pg_constraint
    WHERE conrelid='public.reminder_logs'::regclass AND contype='c'
      AND regexp_replace(replace(lower(pg_get_constraintdef(oid)), '::text', ''), '[[:space:]''()\[\]]', '', 'g') =
        'checkdelivery_status=anyarrayscheduled,sent,delivered,failed,cancelled';
  IF v_count <> 1 THEN RAISE EXCEPTION 'Expected exactly one known reminder_logs.delivery_status check, found %; inspect constraints before applying', v_count; END IF;
  EXECUTE format('ALTER TABLE public.reminder_logs DROP CONSTRAINT %I', v_name);
  ALTER TABLE public.reminder_logs ADD CONSTRAINT reminder_logs_delivery_status_batch_b_check
    CHECK (delivery_status IN ('scheduled', 'sending', 'sent', 'delivered', 'failed', 'cancelled'));
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.reminder_logs'::regclass AND conname = 'reminder_logs_attempt_state_batch_b_check') THEN
    ALTER TABLE public.reminder_logs ADD CONSTRAINT reminder_logs_attempt_state_batch_b_check
      CHECK (attempt_count >= 0 AND max_attempts BETWEEN 1 AND 10 AND reminder_sequence >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.reminder_settings'::regclass AND conname = 'reminder_settings_max_attempts_batch_b_check') THEN
    ALTER TABLE public.reminder_settings ADD CONSTRAINT reminder_settings_max_attempts_batch_b_check
      CHECK (max_attempts BETWEEN 1 AND 10);
  END IF;
END $$;
CREATE INDEX idx_reminder_logs_due_batch_b
  ON public.reminder_logs(delivery_status, scheduled_for)
  WHERE delivery_status IN ('scheduled', 'sending');

CREATE TABLE public.reminder_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reminder_log_id uuid NOT NULL REFERENCES public.reminder_logs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  outcome text NOT NULL CHECK (outcome IN ('started', 'sent', 'failed', 'cancelled')),
  error text,
  next_attempt_at timestamptz,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_reminder_attempt_number UNIQUE (reminder_log_id, attempt_number)
);
CREATE INDEX idx_reminder_attempts_user ON public.reminder_attempts(user_id, attempted_at DESC);
ALTER TABLE public.reminder_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reminder_attempts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.reminder_attempts TO authenticated;
GRANT ALL ON public.reminder_attempts TO service_role;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'reminder_attempts' AND policyname = 'Users can view own reminder attempts') THEN
    CREATE POLICY "Users can view own reminder attempts" ON public.reminder_attempts
      FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
  END IF;
END $$;

CREATE FUNCTION public.schedule_expense_reminders(p_user_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_count integer;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN RAISE EXCEPTION 'not authorized'; END IF;
  INSERT INTO public.reminder_logs(user_id, expense_share_id, scheduled_for, delivery_status,
      idempotency_key, reminder_sequence, max_attempts)
  SELECT p_user_id, sh.id,
    CASE WHEN seq.next_sequence = 1
      THEN public.next_expense_reminder_time(now(), rs.preferred_send_time, rs.timezone)
      ELSE public.next_expense_reminder_time(now() + make_interval(hours => rs.frequency_hours), rs.preferred_send_time, rs.timezone) END,
    'scheduled', sh.id::text || ':' || seq.next_sequence::text, seq.next_sequence, rs.max_attempts
  FROM public.expense_shares sh
  JOIN public.expense_groups eg ON eg.id = sh.expense_group_id AND eg.user_id = p_user_id
  JOIN public.reminder_settings rs ON rs.user_id = p_user_id AND rs.enabled = true
  CROSS JOIN LATERAL (SELECT COALESCE(MAX(rl.reminder_sequence), 0) + 1 AS next_sequence
    FROM public.reminder_logs rl WHERE rl.expense_share_id = sh.id) seq
  WHERE sh.user_id = p_user_id AND sh.email IS NOT NULL
    AND (seq.next_sequence > 1 OR rs.initial_message_enabled = true)
    AND seq.next_sequence <= rs.max_reminders
    AND NOT EXISTS (SELECT 1 FROM public.reminder_logs active WHERE active.expense_share_id = sh.id
      AND active.delivery_status IN ('scheduled', 'sending'))
    AND (SELECT COALESCE(SUM(r.amount), 0) FROM public.repayments r
      WHERE r.expense_share_id = sh.id AND r.payment_status = 'confirmed') < sh.amount_owed - 0.01
  ON CONFLICT (idempotency_key) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END; $$;
REVOKE ALL ON FUNCTION public.schedule_expense_reminders(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.schedule_expense_reminders(uuid) TO authenticated, service_role;

CREATE FUNCTION public.schedule_all_expense_reminders()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_user uuid; v_total integer := 0;
BEGIN
  FOR v_user IN SELECT user_id FROM public.reminder_settings WHERE enabled = true LOOP
    BEGIN
      v_total := v_total + public.schedule_expense_reminders(v_user);
    EXCEPTION WHEN SQLSTATE '22023' THEN
      RAISE WARNING 'Skipping expense reminders for user % due to invalid timezone setting', v_user;
    END;
  END LOOP;
  RETURN v_total;
END; $$;
REVOKE ALL ON FUNCTION public.schedule_all_expense_reminders() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.schedule_all_expense_reminders() TO service_role;

CREATE FUNCTION public.reschedule_expense_reminders(p_user_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_count integer;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN RAISE EXCEPTION 'not authorized'; END IF;
  UPDATE public.reminder_logs r SET delivery_status='failed',lease_until=NULL,
    max_attempts=s.max_attempts,last_error='Maximum attempts reduced in reminder settings'
  FROM public.reminder_settings s
  WHERE s.user_id=p_user_id AND r.user_id=p_user_id AND r.delivery_status='scheduled'
    AND r.attempt_count>=s.max_attempts;
  UPDATE public.reminder_attempts a SET outcome='cancelled', error='Reminder settings changed', next_attempt_at=NULL
  WHERE a.user_id=p_user_id AND a.outcome='started' AND a.reminder_log_id IN (
    SELECT r.id FROM public.reminder_logs r JOIN public.reminder_settings s ON s.user_id=r.user_id
    WHERE s.user_id=p_user_id AND r.user_id=p_user_id AND r.delivery_status IN ('scheduled','sending')
      AND (r.reminder_sequence>s.max_reminders OR (r.reminder_sequence=1 AND NOT s.initial_message_enabled))
  );
  UPDATE public.reminder_logs r SET delivery_status='cancelled',lease_until=NULL
  FROM public.reminder_settings s
  WHERE s.user_id=p_user_id AND r.user_id=p_user_id AND r.delivery_status IN ('scheduled','sending')
    AND (r.reminder_sequence>s.max_reminders OR (r.reminder_sequence=1 AND NOT s.initial_message_enabled));
  UPDATE public.reminder_logs r SET
    scheduled_for=CASE WHEN r.reminder_sequence=1
      THEN public.next_expense_reminder_time(now(),s.preferred_send_time,s.timezone)
      ELSE public.next_expense_reminder_time(now()+make_interval(hours=>s.frequency_hours),s.preferred_send_time,s.timezone) END,
    max_attempts=s.max_attempts
  FROM public.reminder_settings s
  WHERE s.user_id=p_user_id AND r.user_id=p_user_id AND r.delivery_status='scheduled'
    AND r.reminder_sequence<=s.max_reminders
    AND (r.reminder_sequence>1 OR s.initial_message_enabled);
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN v_count;
END; $$;
REVOKE ALL ON FUNCTION public.reschedule_expense_reminders(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reschedule_expense_reminders(uuid) TO authenticated, service_role;

CREATE FUNCTION public.cancel_user_expense_reminders(p_user_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_count integer;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN RAISE EXCEPTION 'not authorized'; END IF;
  UPDATE public.reminder_attempts a SET outcome='cancelled', error='Reminders disabled by user', next_attempt_at=NULL
    WHERE a.user_id=p_user_id AND a.outcome='started' AND a.reminder_log_id IN (
      SELECT id FROM public.reminder_logs WHERE user_id=p_user_id
        AND delivery_status IN ('scheduled','sending')
    );
  UPDATE public.reminder_logs SET delivery_status = 'cancelled', lease_until = NULL
    WHERE user_id = p_user_id AND delivery_status IN ('scheduled', 'sending');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END; $$;
REVOKE ALL ON FUNCTION public.cancel_user_expense_reminders(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_user_expense_reminders(uuid) TO authenticated, service_role;

CREATE FUNCTION public.claim_due_expense_reminders(p_limit integer DEFAULT 25, p_lease_seconds integer DEFAULT 300)
RETURNS SETOF public.reminder_logs LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  -- Close attempts whose worker lease expired before a terminal retry, then
  -- leave the queue row eligible for an immediate retry.
  UPDATE public.reminder_attempts a SET outcome='failed',
    error='Worker lease expired; delivery outcome unknown',next_attempt_at=now()
  FROM public.reminder_logs r
  WHERE r.id=a.reminder_log_id AND r.delivery_status='sending' AND r.lease_until<now()
    AND r.attempt_count<r.max_attempts AND a.attempt_number=r.attempt_count AND a.outcome='started';
  UPDATE public.reminder_logs SET delivery_status='failed',lease_until=NULL,
    last_error='Worker lease expired after maximum attempts'
  WHERE delivery_status='sending' AND lease_until<now() AND attempt_count>=max_attempts;
  UPDATE public.reminder_attempts a SET outcome='failed',
    error='Worker lease expired after maximum attempts',next_attempt_at=NULL
  FROM public.reminder_logs r
  WHERE r.id=a.reminder_log_id AND r.delivery_status='failed'
    AND r.last_error='Worker lease expired after maximum attempts'
    AND a.attempt_number=r.attempt_count AND a.outcome='started';

  RETURN QUERY
  WITH candidates AS (
    SELECT r.id FROM public.reminder_logs r
    JOIN public.reminder_settings s ON s.user_id = r.user_id AND s.enabled = true
    WHERE r.scheduled_for <= now() AND (r.delivery_status = 'scheduled'
      OR (r.delivery_status = 'sending' AND r.lease_until < now()))
      AND r.attempt_count < r.max_attempts
    ORDER BY r.scheduled_for FOR UPDATE OF r SKIP LOCKED LIMIT LEAST(GREATEST(p_limit, 1), 100)
  ), claimed AS (
    UPDATE public.reminder_logs r SET delivery_status = 'sending', attempt_count = r.attempt_count + 1,
      lease_until = now() + make_interval(secs => p_lease_seconds)
    FROM candidates c WHERE r.id = c.id RETURNING r.*
  ), attempts AS (
    INSERT INTO public.reminder_attempts(reminder_log_id,user_id,attempt_number,outcome)
    SELECT c.id,c.user_id,c.attempt_count,'started' FROM claimed c
    ON CONFLICT (reminder_log_id,attempt_number) DO NOTHING RETURNING reminder_log_id
  )
  SELECT * FROM claimed;
END; $$;
REVOKE ALL ON FUNCTION public.claim_due_expense_reminders(integer,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_expense_reminders(integer,integer) TO service_role;

CREATE FUNCTION public.finish_expense_reminder_attempt(
  p_reminder_id uuid,p_outcome text,p_error text DEFAULT NULL,p_next_attempt_at timestamptz DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_reminder public.reminder_logs;
BEGIN
  IF p_outcome NOT IN ('sent','failed','cancelled') THEN RAISE EXCEPTION 'invalid reminder attempt outcome'; END IF;
  SELECT * INTO v_reminder FROM public.reminder_logs WHERE id=p_reminder_id FOR UPDATE;
  IF NOT FOUND OR v_reminder.delivery_status <> 'sending' THEN RETURN false; END IF;
  UPDATE public.reminder_logs SET
    delivery_status=CASE WHEN p_outcome='sent' THEN 'sent' WHEN p_outcome='cancelled' OR v_reminder.attempt_count >= v_reminder.max_attempts THEN CASE WHEN p_outcome='cancelled' THEN 'cancelled' ELSE 'failed' END ELSE 'scheduled' END,
    sent_at=CASE WHEN p_outcome='sent' THEN now() ELSE sent_at END,
    scheduled_for=CASE WHEN p_outcome='failed' AND v_reminder.attempt_count < v_reminder.max_attempts THEN COALESCE(p_next_attempt_at,now()+interval '1 minute') ELSE scheduled_for END,
    lease_until=NULL,
    last_error=CASE WHEN p_outcome='sent' THEN NULL WHEN p_outcome='cancelled' THEN COALESCE(p_error,'Share settled') ELSE p_error END
    WHERE id=p_reminder_id;
  UPDATE public.reminder_attempts SET outcome=p_outcome,error=p_error,
    next_attempt_at=CASE WHEN p_outcome='failed' AND v_reminder.attempt_count < v_reminder.max_attempts THEN COALESCE(p_next_attempt_at,now()+interval '1 minute') ELSE NULL END
    WHERE reminder_log_id=p_reminder_id AND attempt_number=v_reminder.attempt_count;
  RETURN true;
END; $$;
REVOKE ALL ON FUNCTION public.finish_expense_reminder_attempt(uuid,text,text,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_expense_reminder_attempt(uuid,text,text,timestamptz) TO service_role;

CREATE FUNCTION public.reconcile_expense_reminders_after_repayment_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_share uuid; v_owed numeric; v_paid numeric;
BEGIN
  v_share := CASE WHEN TG_OP = 'DELETE' THEN OLD.expense_share_id ELSE NEW.expense_share_id END;
  PERFORM public.cancel_expense_reminders_for_share(v_share);
  IF TG_OP = 'UPDATE' AND OLD.expense_share_id IS DISTINCT FROM NEW.expense_share_id THEN
    PERFORM public.cancel_expense_reminders_for_share(OLD.expense_share_id);
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END; $$;
REVOKE ALL ON FUNCTION public.reconcile_expense_reminders_after_repayment_change() FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.cancel_expense_reminders_for_share(p_share uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_owed numeric; v_paid numeric; v_count integer;
BEGIN
  SELECT amount_owed INTO v_owed FROM public.expense_shares WHERE id = p_share;
  SELECT COALESCE(SUM(amount), 0) INTO v_paid FROM public.repayments
    WHERE expense_share_id = p_share AND payment_status = 'confirmed';
  IF v_owed IS NULL OR v_paid >= v_owed - 0.01 THEN
    UPDATE public.reminder_attempts a SET outcome='cancelled', error='Share settled', next_attempt_at=NULL
      WHERE a.outcome='started' AND a.reminder_log_id IN (
        SELECT id FROM public.reminder_logs WHERE expense_share_id=p_share
          AND delivery_status IN ('scheduled','sending')
      );
    UPDATE public.reminder_logs SET delivery_status = 'cancelled',
      lease_until = NULL WHERE expense_share_id = p_share
      AND delivery_status IN ('scheduled', 'sending');
    GET DIAGNOSTICS v_count = ROW_COUNT;
  ELSE
    v_count := 0;
  END IF;
  RETURN v_count;
END; $$;
REVOKE ALL ON FUNCTION public.cancel_expense_reminders_for_share(uuid) FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_reconcile_expense_reminders_after_repayment_change
  AFTER INSERT OR UPDATE OR DELETE ON public.repayments
  FOR EACH ROW EXECUTE FUNCTION public.reconcile_expense_reminders_after_repayment_change();

CREATE FUNCTION public.schedule_followup_expense_reminder()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_share public.expense_shares; v_settings public.reminder_settings;
BEGIN
  IF NEW.delivery_status NOT IN ('sent', 'delivered') OR OLD.delivery_status IN ('sent', 'delivered') THEN RETURN NEW; END IF;
  SELECT * INTO v_share FROM public.expense_shares WHERE id = NEW.expense_share_id;
  SELECT * INTO v_settings FROM public.reminder_settings WHERE user_id = NEW.user_id AND enabled = true;
  IF v_share.id IS NULL OR v_settings.user_id IS NULL OR NEW.reminder_sequence >= v_settings.max_reminders THEN RETURN NEW; END IF;
  IF v_settings.timezone IS NULL OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=v_settings.timezone) THEN
    RAISE WARNING 'Skipping follow-up reminder for log % because its timezone is invalid', NEW.id;
    RETURN NEW;
  END IF;
  IF (SELECT COALESCE(SUM(amount), 0) FROM public.repayments
    WHERE expense_share_id = v_share.id AND payment_status = 'confirmed') >= v_share.amount_owed - 0.01 THEN RETURN NEW; END IF;
  INSERT INTO public.reminder_logs(user_id, expense_share_id, scheduled_for, delivery_status,
      idempotency_key, reminder_sequence, max_attempts)
    VALUES(NEW.user_id, NEW.expense_share_id,
      public.next_expense_reminder_time(now() + make_interval(hours => v_settings.frequency_hours), v_settings.preferred_send_time, v_settings.timezone), 'scheduled',
      NEW.expense_share_id::text || ':' || (NEW.reminder_sequence + 1)::text,
      NEW.reminder_sequence + 1, v_settings.max_attempts)
    ON CONFLICT (idempotency_key) DO NOTHING;
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.schedule_followup_expense_reminder() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_schedule_followup_expense_reminder
  AFTER UPDATE OF delivery_status ON public.reminder_logs FOR EACH ROW
  WHEN (NEW.delivery_status IN ('sent', 'delivered') AND OLD.delivery_status IS DISTINCT FROM NEW.delivery_status)
  EXECUTE FUNCTION public.schedule_followup_expense_reminder();

-- Security-advisor fixes to apply only after reviewing the live function bodies:
-- Advisor findings: handle_new_user() and log_repayment_event() are
-- SECURITY DEFINER and callable by anon/authenticated. Inspect their trigger
-- bindings and bodies, then revoke direct EXECUTE if they are trigger-only and
-- pin each search_path to trusted schemas. This connector does not expose the
-- required definitions/grants without a catalog query.
-- webhook_events has RLS enabled with no policies: keep it backend-only and
-- verify anon/authenticated table privileges are revoked.
