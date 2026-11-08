-- Repayments & Settlements: use the existing repayments, repayment_events,
-- alerts, and reminder trigger structures. Prepared locally; do not apply to
-- live Supabase without review and approval.

ALTER TABLE public.repayment_events ADD COLUMN IF NOT EXISTS idempotency_key uuid;
CREATE UNIQUE INDEX IF NOT EXISTS uq_repayment_events_user_idempotency
  ON public.repayment_events(user_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
ALTER TABLE public.repayments ADD COLUMN IF NOT EXISTS idempotency_key uuid;
CREATE UNIQUE INDEX IF NOT EXISTS uq_repayments_user_share_idempotency
  ON public.repayments(user_id,expense_share_id,idempotency_key) WHERE idempotency_key IS NOT NULL;

DO $$
DECLARE
  v_count integer;
  v_constraint text;
BEGIN
  SELECT count(*), min(conname) INTO v_count, v_constraint
  FROM pg_constraint
  WHERE conrelid='public.repayment_events'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) ILIKE '%event_type%';
  IF v_count <> 1 OR v_constraint <> 'repayment_events_event_type_check' THEN
    RAISE EXCEPTION 'Expected exactly one known repayment_events.event_type check; inspect constraints before applying';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='public.repayment_events'::regclass
      AND conname=v_constraint
      AND pg_get_constraintdef(oid) ILIKE '%created%confirmed%reversed%'
  ) THEN
    RAISE EXCEPTION 'Unexpected repayment event constraint definition; inspect before applying';
  END IF;
  ALTER TABLE public.repayment_events DROP CONSTRAINT repayment_events_event_type_check;
  ALTER TABLE public.repayment_events ADD CONSTRAINT repayment_events_event_type_check
    CHECK (event_type IN ('created','confirmed','reversed','updated'));
END $$;

CREATE OR REPLACE FUNCTION public.record_shared_expense_repayment(
  p_user_id uuid, p_share_id uuid, p_amount numeric, p_currency_code text,
  p_payment_method text, p_payment_provider text, p_external_reference text,p_idempotency_key uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_share public.expense_shares;
  v_existing public.repayments;
  v_paid numeric;
  v_remaining numeric;
  v_repayment public.repayments;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE='42501';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR round(p_amount,2) <> p_amount OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'Repayment amount must be positive and use cents' USING ERRCODE='22023';
  END IF;
  SELECT s.* INTO v_share
  FROM public.expense_shares s
  JOIN public.expense_groups g ON g.id=s.expense_group_id
  WHERE s.id=p_share_id AND s.user_id=p_user_id AND s.is_active=true
    AND g.user_id=p_user_id AND g.archived_at IS NULL
  FOR UPDATE OF s;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense share not found or access denied' USING ERRCODE='42501'; END IF;

  IF p_idempotency_key IS NOT NULL OR p_external_reference IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.repayments
    WHERE user_id=p_user_id AND expense_share_id=p_share_id
        AND (idempotency_key=p_idempotency_key OR
          (p_external_reference IS NOT NULL AND external_reference=p_external_reference)) LIMIT 1;
    IF FOUND THEN
      SELECT COALESCE(SUM(amount),0) INTO v_paid FROM public.repayments
      WHERE expense_share_id=p_share_id AND payment_status='confirmed';
      RETURN jsonb_build_object('success',true,'result',jsonb_build_object(
        'repayment',to_jsonb(v_existing),'duplicate',true,
        'remainingBalance',greatest(0,v_share.amount_owed-v_paid)));
    END IF;
  END IF;

  SELECT COALESCE(SUM(amount),0) INTO v_paid FROM public.repayments
  WHERE expense_share_id=p_share_id AND payment_status='confirmed';
  v_remaining:=greatest(0,v_share.amount_owed-v_paid);
  IF p_amount > v_remaining THEN RAISE EXCEPTION 'Repayment exceeds outstanding balance' USING ERRCODE='23514'; END IF;

  INSERT INTO public.repayments(expense_share_id,user_id,amount,currency_code,payment_method,
    payment_status,confirmation_source,payment_provider,external_reference,confirmed_at,idempotency_key)
  VALUES(p_share_id,p_user_id,p_amount,COALESCE(p_currency_code,'INR'),p_payment_method,
    'confirmed','manual',p_payment_provider,p_external_reference,now(),p_idempotency_key)
  RETURNING * INTO v_repayment;
  -- The existing AFTER INSERT trigger writes created and confirmed audit events.
  INSERT INTO public.alerts(user_id,alert_type,title,message,is_read,is_resolved)
  VALUES(p_user_id,'general','Repayment recorded',
    format('Recorded %s %s from %s for %s.',v_repayment.currency_code,
      to_char(v_repayment.amount,'FM999999999999990.00'),v_share.participant_name,
      (SELECT title FROM public.expense_groups WHERE id=v_share.expense_group_id)),false,false);
  SELECT COALESCE(SUM(amount),0) INTO v_paid FROM public.repayments
  WHERE expense_share_id=p_share_id AND payment_status='confirmed';
  v_remaining:=greatest(0,v_share.amount_owed-v_paid);
  RETURN jsonb_build_object('success',true,'result',jsonb_build_object(
    'repayment',to_jsonb(v_repayment),'duplicate',false,'remainingBalance',v_remaining,
    'isShareSettled',v_remaining<=0.01));
END; $$;
REVOKE ALL ON FUNCTION public.record_shared_expense_repayment(uuid,uuid,numeric,text,text,text,text,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.record_shared_expense_repayment(uuid,uuid,numeric,text,text,text,text,uuid) TO authenticated,service_role;

-- Keep the original seven-argument RPC contract available for existing callers.
CREATE OR REPLACE FUNCTION public.record_shared_expense_repayment(
  p_user_id uuid,p_share_id uuid,p_amount numeric,p_currency_code text,
  p_payment_method text,p_payment_provider text,p_external_reference text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RETURN public.record_shared_expense_repayment(p_user_id,p_share_id,p_amount,p_currency_code,
    p_payment_method,p_payment_provider,p_external_reference,gen_random_uuid());
END; $$;
REVOKE ALL ON FUNCTION public.record_shared_expense_repayment(uuid,uuid,numeric,text,text,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.record_shared_expense_repayment(uuid,uuid,numeric,text,text,text,text) TO authenticated,service_role;

CREATE FUNCTION public.update_shared_expense_repayment(
  p_user_id uuid,p_repayment_id uuid,p_amount numeric,p_payment_method text,p_payment_provider text,p_idempotency_key uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_repayment public.repayments;
  v_share public.expense_shares;
  v_group public.expense_groups;
  v_previous_amount numeric;
  v_previous_method text;
  v_previous_provider text;
  v_paid numeric;
  v_remaining numeric;
  v_event public.repayment_events;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid()<>p_user_id THEN RAISE EXCEPTION 'not authorized' USING ERRCODE='42501'; END IF;
  IF p_amount IS NULL OR p_amount<=0 OR round(p_amount,2)<>p_amount THEN
    RAISE EXCEPTION 'Repayment amount must be positive and use cents' USING ERRCODE='22023';
  END IF;
  IF p_payment_method NOT IN ('upi','paypal','cash','bank_transfer','other') THEN
    RAISE EXCEPTION 'Unsupported payment method' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_repayment FROM public.repayments
    WHERE id=p_repayment_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND OR v_repayment.payment_status<>'confirmed' THEN
    RAISE EXCEPTION 'Confirmed repayment not found or cannot be edited' USING ERRCODE='P0002';
  END IF;
  SELECT s.* INTO v_share FROM public.expense_shares s
    WHERE s.id=v_repayment.expense_share_id AND s.user_id=p_user_id FOR UPDATE;
  SELECT g.* INTO v_group FROM public.expense_groups g
    WHERE g.id=v_share.expense_group_id AND g.user_id=p_user_id;
  IF NOT FOUND OR v_group.id IS NULL THEN RAISE EXCEPTION 'Expense not found or access denied' USING ERRCODE='42501'; END IF;
  IF v_group.archived_at IS NOT NULL OR v_share.is_active=false THEN
    RAISE EXCEPTION 'Archived expenses or removed participants cannot be edited' USING ERRCODE='23514';
  END IF;

  IF p_idempotency_key IS NULL THEN RAISE EXCEPTION 'An idempotency key is required' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_event FROM public.repayment_events
    WHERE user_id=p_user_id AND idempotency_key=p_idempotency_key LIMIT 1;
  IF FOUND THEN
    IF v_event.repayment_id<>p_repayment_id THEN RAISE EXCEPTION 'Idempotency key was already used for another repayment' USING ERRCODE='23505'; END IF;
    SELECT COALESCE(SUM(amount),0) INTO v_paid FROM public.repayments
      WHERE expense_share_id=v_share.id AND payment_status='confirmed';
    RETURN jsonb_build_object('repayment',to_jsonb(v_repayment),
      'remainingBalance',greatest(0,v_share.amount_owed-v_paid),'duplicate',true);
  END IF;

  v_previous_amount:=v_repayment.amount;
  v_previous_method:=v_repayment.payment_method;
  v_previous_provider:=v_repayment.payment_provider;
  SELECT COALESCE(SUM(amount),0) INTO v_paid FROM public.repayments
    WHERE expense_share_id=v_share.id AND payment_status='confirmed' AND id<>v_repayment.id;
  IF v_paid+p_amount>v_share.amount_owed THEN RAISE EXCEPTION 'Edited repayment exceeds outstanding share' USING ERRCODE='23514'; END IF;
  UPDATE public.repayments SET amount=p_amount,payment_method=p_payment_method,
    payment_provider=COALESCE(p_payment_provider,payment_provider)
  WHERE id=p_repayment_id RETURNING * INTO v_repayment;
  INSERT INTO public.repayment_events(repayment_id,user_id,event_type,event_source,metadata,idempotency_key)
  VALUES(v_repayment.id,p_user_id,'updated','manual',jsonb_build_object(
    'previous_amount',v_previous_amount,'amount',p_amount,
    'previous_payment_method',v_previous_method,'payment_method',p_payment_method,
    'previous_payment_provider',v_previous_provider,'payment_provider',v_repayment.payment_provider,
    'edited_at',now()),p_idempotency_key);
  INSERT INTO public.alerts(user_id,alert_type,title,message,is_read,is_resolved)
  VALUES(p_user_id,'general','Repayment updated',
    format('Updated repayment for %s to %s %s.',v_share.participant_name,v_repayment.currency_code,
      to_char(v_repayment.amount,'FM999999999999990.00')),false,false);
  SELECT COALESCE(SUM(amount),0) INTO v_paid FROM public.repayments
    WHERE expense_share_id=v_share.id AND payment_status='confirmed';
  v_remaining:=greatest(0,v_share.amount_owed-v_paid);
  BEGIN
    PERFORM public.schedule_expense_reminders(p_user_id);
  EXCEPTION WHEN SQLSTATE '22023' THEN
    RAISE WARNING 'Skipping reminder reschedule for user % because reminder settings are invalid',p_user_id;
  END;
  RETURN jsonb_build_object('repayment',to_jsonb(v_repayment),'remainingBalance',v_remaining,
    'isShareSettled',v_remaining<=0.01);
END; $$;
REVOKE ALL ON FUNCTION public.update_shared_expense_repayment(uuid,uuid,numeric,text,text,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.update_shared_expense_repayment(uuid,uuid,numeric,text,text,uuid) TO authenticated,service_role;

CREATE FUNCTION public.reverse_shared_expense_repayment(
  p_user_id uuid,p_repayment_id uuid,p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_repayment public.repayments;
  v_share public.expense_shares;
  v_group public.expense_groups;
  v_paid numeric;
  v_remaining numeric;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid()<>p_user_id THEN RAISE EXCEPTION 'not authorized' USING ERRCODE='42501'; END IF;
  IF NULLIF(btrim(p_reason),'') IS NULL OR length(p_reason)>500 THEN
    RAISE EXCEPTION 'A reversal reason of at most 500 characters is required' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_repayment FROM public.repayments
    WHERE id=p_repayment_id AND user_id=p_user_id FOR UPDATE;
  IF FOUND AND v_repayment.payment_status='reversed' THEN
    SELECT s.* INTO v_share FROM public.expense_shares s WHERE s.id=v_repayment.expense_share_id AND s.user_id=p_user_id;
    SELECT g.* INTO v_group FROM public.expense_groups g WHERE g.id=v_share.expense_group_id AND g.user_id=p_user_id;
    SELECT COALESCE(SUM(amount),0) INTO v_paid FROM public.repayments
      WHERE expense_share_id=v_share.id AND payment_status='confirmed';
    RETURN jsonb_build_object('repayment',to_jsonb(v_repayment),
      'remainingBalance',greatest(0,v_share.amount_owed-v_paid),'duplicate',true);
  END IF;
  IF NOT FOUND OR v_repayment.payment_status<>'confirmed' THEN
    RAISE EXCEPTION 'Confirmed repayment not found or already reversed' USING ERRCODE='P0002';
  END IF;
  SELECT s.* INTO v_share FROM public.expense_shares s
    WHERE s.id=v_repayment.expense_share_id AND s.user_id=p_user_id FOR UPDATE;
  SELECT g.* INTO v_group FROM public.expense_groups g
    WHERE g.id=v_share.expense_group_id AND g.user_id=p_user_id;
  IF NOT FOUND OR v_group.id IS NULL THEN RAISE EXCEPTION 'Expense not found or access denied' USING ERRCODE='42501'; END IF;

  UPDATE public.repayments SET payment_status='reversed',reversed_at=now(),
    reversed_by=p_user_id,reversal_reason=btrim(p_reason)
  WHERE id=p_repayment_id RETURNING * INTO v_repayment;
  -- Existing repayment_event_logger records this transition atomically.
  INSERT INTO public.alerts(user_id,alert_type,title,message,is_read,is_resolved)
  VALUES(p_user_id,'general','Repayment reversed',
    format('Reversed %s %s from %s. Reason: %s',v_repayment.currency_code,
      to_char(v_repayment.amount,'FM999999999999990.00'),v_share.participant_name,btrim(p_reason)),false,false);
  SELECT COALESCE(SUM(amount),0) INTO v_paid FROM public.repayments
    WHERE expense_share_id=v_share.id AND payment_status='confirmed';
  v_remaining:=greatest(0,v_share.amount_owed-v_paid);
  IF v_group.archived_at IS NULL AND v_share.is_active THEN
    BEGIN
      PERFORM public.schedule_expense_reminders(p_user_id);
    EXCEPTION WHEN SQLSTATE '22023' THEN
      RAISE WARNING 'Skipping reminder reschedule for user % because reminder settings are invalid',p_user_id;
    END;
  END IF;
  RETURN jsonb_build_object('repayment',to_jsonb(v_repayment),'remainingBalance',v_remaining,
    'isShareSettled',v_remaining<=0.01);
END; $$;
REVOKE ALL ON FUNCTION public.reverse_shared_expense_repayment(uuid,uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.reverse_shared_expense_repayment(uuid,uuid,text) TO authenticated,service_role;

CREATE INDEX IF NOT EXISTS idx_repayments_share_status_settlements
  ON public.repayments(expense_share_id,payment_status,created_at DESC);
