-- Expense Groups module: editable owner-scoped expenses with durable history.
-- This migration is additive and is prepared locally; do not apply without
-- reviewing preflight.sql against the target database.

ALTER TABLE public.expense_groups
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE public.expense_shares
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

-- Retain the existing create RPC contract while enforcing the same invariants
-- for direct authenticated RPC callers as the application validation layer.
CREATE OR REPLACE FUNCTION public.create_shared_expense_group(p_user_id uuid,p_group jsonb,p_shares jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_group public.expense_groups; v_shares jsonb; v_sum numeric;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE='42501';
  END IF;
  IF jsonb_typeof(p_shares) <> 'array' OR jsonb_array_length(p_shares) < 1 THEN
    RAISE EXCEPTION 'At least one participant is required' USING ERRCODE='22023';
  END IF;
  IF COALESCE((p_group->>'total_amount')::numeric,0) <= 0
     OR round((p_group->>'total_amount')::numeric,2) <> (p_group->>'total_amount')::numeric
     OR COALESCE(p_group->>'split_method','') NOT IN ('equal','custom')
     OR NULLIF(btrim(p_group->>'title'),'') IS NULL THEN
    RAISE EXCEPTION 'Invalid expense total or split method' USING ERRCODE='22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_shares) AS t(item)
    WHERE COALESCE((item->>'amount_owed')::numeric,0) <= 0
       OR round((item->>'amount_owed')::numeric,2) <> (item->>'amount_owed')::numeric
       OR item->>'participant_type' NOT IN ('owner','contact')
       OR NULLIF(btrim(item->>'participant_name'),'') IS NULL
  ) THEN RAISE EXCEPTION 'Invalid participant share' USING ERRCODE='22023'; END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(p_shares) AS t(item)
      WHERE item->>'participant_type'='owner') > 1 THEN
    RAISE EXCEPTION 'An expense can have at most one payer share' USING ERRCODE='22023';
  END IF;
  SELECT COALESCE(SUM((item->>'amount_owed')::numeric),0) INTO v_sum
    FROM jsonb_array_elements(p_shares) AS t(item);
  IF v_sum <> (p_group->>'total_amount')::numeric THEN
    RAISE EXCEPTION 'Participant shares must add up to the expense total' USING ERRCODE='22023';
  END IF;
  IF NULLIF(p_group->>'transaction_id','') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.transactions WHERE id=(p_group->>'transaction_id')::uuid AND user_id=p_user_id
  ) THEN RAISE EXCEPTION 'Transaction not found or access denied' USING ERRCODE='42501'; END IF;

  INSERT INTO public.expense_groups(user_id,transaction_id,title,total_amount,currency_code,split_method)
  VALUES(p_user_id,NULLIF(p_group->>'transaction_id','')::uuid,p_group->>'title',
    (p_group->>'total_amount')::numeric,COALESCE(p_group->>'currency_code','INR'),p_group->>'split_method')
  RETURNING * INTO v_group;
  INSERT INTO public.expense_shares(expense_group_id,user_id,participant_type,participant_name,
      participant_user_id,email,phone_number,amount_owed)
  SELECT v_group.id,p_user_id,item->>'participant_type',item->>'participant_name',
      NULLIF(item->>'participant_user_id','')::uuid,NULLIF(item->>'email',''),
      NULLIF(item->>'phone_number',''),(item->>'amount_owed')::numeric
  FROM jsonb_array_elements(p_shares) AS t(item);
  SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.created_at,s.id),'[]'::jsonb) INTO v_shares
    FROM public.expense_shares s WHERE s.expense_group_id=v_group.id;
  RETURN to_jsonb(v_group)||jsonb_build_object('shares',v_shares);
END;
$$;
REVOKE ALL ON FUNCTION public.create_shared_expense_group(uuid,jsonb,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_shared_expense_group(uuid,jsonb,jsonb) TO authenticated, service_role;

CREATE FUNCTION public.update_shared_expense_group(
  p_user_id uuid, p_group_id uuid, p_group jsonb, p_shares jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_group public.expense_groups;
  v_share_json jsonb;
  v_item jsonb;
  v_share_id uuid;
  v_share public.expense_shares;
  v_has_history boolean;
  v_share_total numeric;
  v_active_count integer;
  v_result_shares jsonb;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_group FROM public.expense_groups
    WHERE id=p_group_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense group not found' USING ERRCODE='P0002'; END IF;
  IF jsonb_typeof(p_shares) <> 'array' OR jsonb_array_length(p_shares) < 1 THEN
    RAISE EXCEPTION 'At least one participant is required' USING ERRCODE='22023';
  END IF;
  IF COALESCE((p_group->>'total_amount')::numeric,0) <= 0 THEN
    RAISE EXCEPTION 'Expense total must be positive' USING ERRCODE='22023';
  END IF;
  IF round((p_group->>'total_amount')::numeric,2) <> (p_group->>'total_amount')::numeric THEN
    RAISE EXCEPTION 'Expense total must use cents' USING ERRCODE='22023';
  END IF;
  SELECT COALESCE(SUM((item->>'amount_owed')::numeric),0) INTO v_share_total
    FROM jsonb_array_elements(p_shares) AS item;
  IF v_share_total <> (p_group->>'total_amount')::numeric THEN
    RAISE EXCEPTION 'Participant shares must add up to the expense total' USING ERRCODE='22023';
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(p_shares) AS item WHERE NULLIF(item->>'participant_name','') IS NULL) > 0 THEN
    RAISE EXCEPTION 'Each participant needs a name' USING ERRCODE='22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_shares) AS t(item)
    WHERE COALESCE((item->>'amount_owed')::numeric,0) <= 0
       OR item->>'participant_type' NOT IN ('owner','contact')
       OR round((item->>'amount_owed')::numeric,2) <> (item->>'amount_owed')::numeric
       OR NULLIF(btrim(item->>'participant_name'),'') IS NULL
  ) THEN RAISE EXCEPTION 'Invalid participant share' USING ERRCODE='22023'; END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(p_shares) AS t(item)
      WHERE item->>'participant_type'='owner') > 1 THEN
    RAISE EXCEPTION 'An expense can have at most one payer share' USING ERRCODE='22023';
  END IF;
  IF COALESCE(p_group->>'split_method','') NOT IN ('equal','custom')
     OR NULLIF(btrim(p_group->>'title'),'') IS NULL THEN
    RAISE EXCEPTION 'Invalid expense title or split method' USING ERRCODE='22023';
  END IF;
  IF NULLIF(p_group->>'transaction_id','') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.transactions WHERE id=(p_group->>'transaction_id')::uuid AND user_id=p_user_id
  ) THEN
    RAISE EXCEPTION 'Transaction not found or access denied' USING ERRCODE='42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_shares) AS item
    WHERE NULLIF(item->>'id','') IS NOT NULL
    GROUP BY (item->>'id') HAVING count(*) > 1
  ) THEN RAISE EXCEPTION 'Participant IDs must be unique' USING ERRCODE='22023'; END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.repayments r JOIN public.expense_shares s ON s.id=r.expense_share_id
    WHERE s.expense_group_id=p_group_id
  ) INTO v_has_history;
  SELECT count(*) INTO v_active_count FROM public.expense_shares
    WHERE expense_group_id=p_group_id AND user_id=p_user_id AND is_active=true;

  IF v_has_history THEN
    IF (p_group->>'total_amount')::numeric IS DISTINCT FROM v_group.total_amount
       OR COALESCE(p_group->>'currency_code','INR') IS DISTINCT FROM v_group.currency_code
       OR NULLIF(p_group->>'transaction_id','')::uuid IS DISTINCT FROM v_group.transaction_id
       OR jsonb_array_length(p_shares) <> v_active_count THEN
      RAISE EXCEPTION 'Expense amount, currency, transaction and participant set are locked after repayments exist' USING ERRCODE='23514';
    END IF;
    FOR v_share IN SELECT s.* FROM public.expense_shares s
      WHERE s.expense_group_id=p_group_id AND s.user_id=p_user_id AND s.is_active=true LOOP
      IF NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_shares) AS item
        WHERE NULLIF(item->>'id','')::uuid=v_share.id
          AND (item->>'amount_owed')::numeric=v_share.amount_owed
          AND item->>'participant_type'=v_share.participant_type
          AND NULLIF(item->>'participant_user_id','')::uuid IS NOT DISTINCT FROM v_share.participant_user_id
      ) THEN
        RAISE EXCEPTION 'Participant shares are locked after repayments exist' USING ERRCODE='23514';
      END IF;
    END LOOP;
  END IF;

  UPDATE public.expense_groups SET title=p_group->>'title',
    total_amount=(p_group->>'total_amount')::numeric,
    currency_code=COALESCE(p_group->>'currency_code','INR'),
    split_method=p_group->>'split_method',
    transaction_id=NULLIF(p_group->>'transaction_id','')::uuid,
    updated_at=now()
  WHERE id=p_group_id AND user_id=p_user_id;

  FOR v_share IN SELECT s.* FROM public.expense_shares s
    WHERE s.expense_group_id=p_group_id AND s.user_id=p_user_id AND s.is_active=true LOOP
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_shares) AS item WHERE NULLIF(item->>'id','')::uuid=v_share.id) THEN
      UPDATE public.reminder_attempts a SET outcome='cancelled', error='Participant removed from expense', next_attempt_at=NULL
        WHERE a.outcome='started' AND a.reminder_log_id IN (
          SELECT id FROM public.reminder_logs WHERE expense_share_id=v_share.id AND delivery_status IN ('scheduled','sending')
        );
      UPDATE public.reminder_logs SET delivery_status='cancelled', lease_until=NULL,
        last_error='Participant removed from expense'
        WHERE expense_share_id=v_share.id AND delivery_status IN ('scheduled','sending');
      UPDATE public.expense_shares SET is_active=false WHERE id=v_share.id;
    END IF;
  END LOOP;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_shares) AS t(value) LOOP
    v_share_id := NULLIF(v_item->>'id','')::uuid;
    IF v_share_id IS NULL THEN
      INSERT INTO public.expense_shares(expense_group_id,user_id,participant_type,participant_name,
        participant_user_id,email,phone_number,amount_owed,is_active)
      VALUES(p_group_id,p_user_id,v_item->>'participant_type',v_item->>'participant_name',
        NULLIF(v_item->>'participant_user_id','')::uuid,NULLIF(v_item->>'email',''),
        NULLIF(v_item->>'phone_number',''),(v_item->>'amount_owed')::numeric,true)
      RETURNING id INTO v_share_id;
    ELSE
      UPDATE public.expense_shares SET participant_name=v_item->>'participant_name',
        participant_type=v_item->>'participant_type',
        participant_user_id=NULLIF(v_item->>'participant_user_id','')::uuid,
        email=NULLIF(v_item->>'email',''),phone_number=NULLIF(v_item->>'phone_number',''),
        amount_owed=(v_item->>'amount_owed')::numeric,is_active=true
      WHERE id=v_share_id AND expense_group_id=p_group_id AND user_id=p_user_id AND is_active=true;
      IF NOT FOUND THEN RAISE EXCEPTION 'Participant not found in this expense' USING ERRCODE='42501'; END IF;
    END IF;
  END LOOP;

  SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.created_at,s.id),'[]'::jsonb) INTO v_result_shares
    FROM public.expense_shares s WHERE s.expense_group_id=p_group_id;
  SELECT * INTO v_group FROM public.expense_groups WHERE id=p_group_id;
  RETURN to_jsonb(v_group)||jsonb_build_object('shares',v_result_shares);
END;
$$;
REVOKE ALL ON FUNCTION public.update_shared_expense_group(uuid,uuid,jsonb,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_shared_expense_group(uuid,uuid,jsonb,jsonb) TO authenticated, service_role;

CREATE FUNCTION public.set_expense_group_archived(p_user_id uuid,p_group_id uuid,p_archived boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_group public.expense_groups;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid()<>p_user_id THEN RAISE EXCEPTION 'not authorized' USING ERRCODE='42501'; END IF;
  UPDATE public.expense_groups SET archived_at=CASE WHEN p_archived THEN COALESCE(archived_at,now()) ELSE NULL END,
    updated_at=now()
  WHERE id=p_group_id AND user_id=p_user_id RETURNING * INTO v_group;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense group not found' USING ERRCODE='P0002'; END IF;
  IF p_archived THEN
    UPDATE public.reminder_attempts a SET outcome='cancelled',error='Expense group archived',next_attempt_at=NULL
      WHERE a.outcome='started' AND a.reminder_log_id IN (
        SELECT r.id FROM public.reminder_logs r JOIN public.expense_shares s ON s.id=r.expense_share_id
        WHERE s.expense_group_id=p_group_id AND r.delivery_status IN ('scheduled','sending')
      );
    UPDATE public.reminder_logs r SET delivery_status='cancelled',lease_until=NULL,last_error='Expense group archived'
      WHERE r.delivery_status IN ('scheduled','sending') AND r.expense_share_id IN (
        SELECT id FROM public.expense_shares WHERE expense_group_id=p_group_id
      );
  END IF;
  RETURN to_jsonb(v_group);
END; $$;
REVOKE ALL ON FUNCTION public.set_expense_group_archived(uuid,uuid,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.set_expense_group_archived(uuid,uuid,boolean) TO authenticated,service_role;

-- Keep existing repayment RPC call sites, but reject archived groups/removed participants.
CREATE OR REPLACE FUNCTION public.record_shared_expense_repayment(
  p_user_id uuid,p_share_id uuid,p_amount numeric,p_currency_code text,
  p_payment_method text,p_payment_provider text,p_external_reference text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_share public.expense_shares; v_existing public.repayments; v_paid numeric; v_remaining numeric; v_repayment public.repayments;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid()<>p_user_id THEN RETURN jsonb_build_object('success',false,'error','not authorized'); END IF;
  SELECT s.* INTO v_share FROM public.expense_shares s JOIN public.expense_groups g ON g.id=s.expense_group_id
    WHERE s.id=p_share_id AND s.user_id=p_user_id AND s.is_active=true AND g.user_id=p_user_id AND g.archived_at IS NULL
    FOR UPDATE OF s;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','Expense share not found or access denied'); END IF;
  IF p_external_reference IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.repayments WHERE user_id=p_user_id AND expense_share_id=p_share_id
      AND external_reference=p_external_reference LIMIT 1;
    IF FOUND THEN
      SELECT COALESCE(SUM(amount),0) INTO v_paid FROM public.repayments WHERE expense_share_id=p_share_id AND payment_status='confirmed';
      RETURN jsonb_build_object('success',true,'result',jsonb_build_object('repayment',to_jsonb(v_existing),'duplicate',true,
        'remainingBalance',greatest(0,v_share.amount_owed-v_paid)));
    END IF;
  END IF;
  IF p_amount<=0 THEN RETURN jsonb_build_object('success',false,'error','Repayment amount must be positive'); END IF;
  IF p_payment_method NOT IN ('upi','paypal','cash','bank_transfer','other') THEN
    RETURN jsonb_build_object('success',false,'error','Unsupported payment method');
  END IF;
  SELECT COALESCE(SUM(amount),0) INTO v_paid FROM public.repayments WHERE expense_share_id=p_share_id AND payment_status='confirmed';
  v_remaining:=greatest(0,v_share.amount_owed-v_paid);
  IF p_amount>v_remaining+0.01 THEN RETURN jsonb_build_object('success',false,'error','Repayment exceeds outstanding balance'); END IF;
  INSERT INTO public.repayments(expense_share_id,user_id,amount,currency_code,payment_method,payment_status,
    confirmation_source,payment_provider,external_reference,confirmed_at)
  VALUES(p_share_id,p_user_id,p_amount,p_currency_code,p_payment_method,'confirmed','manual',p_payment_provider,p_external_reference,now())
  RETURNING * INTO v_repayment;
  INSERT INTO public.repayment_events(repayment_id,user_id,event_type,event_source,metadata)
  VALUES(v_repayment.id,p_user_id,'confirmed','manual',jsonb_build_object('expense_share_id',p_share_id,
    'amount',p_amount,'remaining_balance',greatest(0,v_remaining-p_amount)));
  RETURN jsonb_build_object('success',true,'result',jsonb_build_object('repayment',to_jsonb(v_repayment),
    'remainingBalance',greatest(0,v_remaining-p_amount),'isShareSettled',v_paid+p_amount>=v_share.amount_owed-0.01));
END; $$;
REVOKE ALL ON FUNCTION public.record_shared_expense_repayment(uuid,uuid,numeric,text,text,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.record_shared_expense_repayment(uuid,uuid,numeric,text,text,text,text) TO authenticated,service_role;

-- Scheduling only considers current, active, non-archived expense shares.
CREATE OR REPLACE FUNCTION public.schedule_expense_reminders(p_user_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_count integer;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid()<>p_user_id THEN RAISE EXCEPTION 'not authorized' USING ERRCODE='42501'; END IF;
  INSERT INTO public.reminder_logs(user_id,expense_share_id,scheduled_for,delivery_status,idempotency_key,reminder_sequence,max_attempts)
  SELECT p_user_id,s.id,
    CASE WHEN seq.next_sequence=1 THEN public.next_expense_reminder_time(now(),rs.preferred_send_time,rs.timezone)
      ELSE public.next_expense_reminder_time(now()+make_interval(hours=>rs.frequency_hours),rs.preferred_send_time,rs.timezone) END,
    'scheduled',s.id::text||':'||seq.next_sequence::text,seq.next_sequence,rs.max_attempts
  FROM public.expense_shares s JOIN public.expense_groups g ON g.id=s.expense_group_id AND g.user_id=p_user_id AND g.archived_at IS NULL
  JOIN public.reminder_settings rs ON rs.user_id=p_user_id AND rs.enabled=true
  CROSS JOIN LATERAL (SELECT COALESCE(MAX(r.reminder_sequence),0)+1 AS next_sequence FROM public.reminder_logs r WHERE r.expense_share_id=s.id) seq
  WHERE s.user_id=p_user_id AND s.is_active=true AND s.participant_type<>'owner' AND s.email IS NOT NULL
    AND (seq.next_sequence>1 OR rs.initial_message_enabled=true) AND seq.next_sequence<=rs.max_reminders
    AND NOT EXISTS (SELECT 1 FROM public.reminder_logs active WHERE active.expense_share_id=s.id AND active.delivery_status IN ('scheduled','sending'))
    AND (SELECT COALESCE(SUM(r.amount),0) FROM public.repayments r WHERE r.expense_share_id=s.id AND r.payment_status='confirmed')<s.amount_owed-0.01
  ON CONFLICT (idempotency_key) DO NOTHING;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN v_count;
END; $$;
REVOKE ALL ON FUNCTION public.schedule_expense_reminders(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.schedule_expense_reminders(uuid) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.schedule_followup_expense_reminder()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_share public.expense_shares; v_group public.expense_groups; v_settings public.reminder_settings;
BEGIN
  IF NEW.delivery_status NOT IN ('sent','delivered') OR OLD.delivery_status IN ('sent','delivered') THEN RETURN NEW; END IF;
  SELECT s.* INTO v_share FROM public.expense_shares s WHERE s.id=NEW.expense_share_id AND s.is_active=true;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT g.* INTO v_group FROM public.expense_groups g WHERE g.id=v_share.expense_group_id AND g.archived_at IS NULL;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT * INTO v_settings FROM public.reminder_settings WHERE user_id=NEW.user_id AND enabled=true;
  IF NOT FOUND OR NEW.reminder_sequence>=v_settings.max_reminders THEN RETURN NEW; END IF;
  IF v_settings.timezone IS NULL OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=v_settings.timezone) THEN
    RAISE WARNING 'Skipping follow-up reminder for log % because its timezone is invalid',NEW.id; RETURN NEW;
  END IF;
  IF (SELECT COALESCE(SUM(amount),0) FROM public.repayments WHERE expense_share_id=v_share.id AND payment_status='confirmed')>=v_share.amount_owed-0.01 THEN RETURN NEW; END IF;
  INSERT INTO public.reminder_logs(user_id,expense_share_id,scheduled_for,delivery_status,idempotency_key,reminder_sequence,max_attempts)
  VALUES(NEW.user_id,NEW.expense_share_id,
    public.next_expense_reminder_time(now()+make_interval(hours=>v_settings.frequency_hours),v_settings.preferred_send_time,v_settings.timezone),
    'scheduled',v_share.id::text||':'||(NEW.reminder_sequence+1)::text,NEW.reminder_sequence+1,v_settings.max_attempts)
  ON CONFLICT (idempotency_key) DO NOTHING;
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.schedule_followup_expense_reminder() FROM PUBLIC,anon,authenticated;

