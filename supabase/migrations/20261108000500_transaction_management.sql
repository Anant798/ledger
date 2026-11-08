-- Additive transaction-management fields and safe, audited operations.
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS payment_method text;
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_transactions_live_user_occurred
  ON public.transactions(user_id, occurred_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_live_user_category
  ON public.transactions(user_id, category) WHERE deleted_at IS NULL AND category IS NOT NULL;

CREATE OR REPLACE FUNCTION public.create_manual_transaction_with_event(p_user_id uuid,p_transaction jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_txn public.transactions;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() IS DISTINCT FROM p_user_id THEN RAISE EXCEPTION 'not authorized'; END IF;
  IF (p_transaction->>'amount')::numeric<=0 THEN RAISE EXCEPTION 'transaction amount must be positive'; END IF;
  IF p_transaction->>'direction' NOT IN ('debit','credit') THEN RAISE EXCEPTION 'invalid transaction direction'; END IF;
  IF NULLIF(p_transaction->>'related_transaction_id','') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.transactions WHERE id=(p_transaction->>'related_transaction_id')::uuid AND user_id=p_user_id AND deleted_at IS NULL
  ) THEN RAISE EXCEPTION 'related transaction not found or access denied'; END IF;
  INSERT INTO public.transactions(user_id,transaction_type,direction,amount,currency_code,status,description,
      merchant_name,bank_name,payment_provider,account_last4,external_reference,related_transaction_id,occurred_at,category,payment_method)
    VALUES(p_user_id,COALESCE(p_transaction->>'transaction_type','manual'),p_transaction->>'direction',
      (p_transaction->>'amount')::numeric,COALESCE(p_transaction->>'currency_code','INR'),
      COALESCE(p_transaction->>'status','completed'),p_transaction->>'description',p_transaction->>'merchant_name',
      p_transaction->>'bank_name',COALESCE(p_transaction->>'payment_provider','manual'),p_transaction->>'account_last4',
      NULLIF(p_transaction->>'external_reference',''),NULLIF(p_transaction->>'related_transaction_id','')::uuid,
      COALESCE((p_transaction->>'occurred_at')::timestamptz,now()),NULLIF(p_transaction->>'category',''),
      NULLIF(p_transaction->>'payment_method','')) RETURNING * INTO v_txn;
  INSERT INTO public.ledger_events(transaction_id,user_id,event_type,event_source,description,metadata,occurred_at)
    VALUES(v_txn.id,p_user_id,'created','manual','Transaction created',p_transaction,v_txn.occurred_at);
  RETURN to_jsonb(v_txn);
END; $$;
REVOKE ALL ON FUNCTION public.create_manual_transaction_with_event(uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.create_manual_transaction_with_event(uuid,jsonb) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.update_manual_transaction_with_event(p_user_id uuid,p_transaction_id uuid,p_updates jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_txn public.transactions; v_before jsonb;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() IS DISTINCT FROM p_user_id THEN RAISE EXCEPTION 'not authorized'; END IF;
  SELECT * INTO v_txn FROM public.transactions WHERE id=p_transaction_id AND user_id=p_user_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'transaction not found or access denied'; END IF;
  IF p_updates ? 'related_transaction_id' AND NULLIF(p_updates->>'related_transaction_id','') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.transactions WHERE id=(p_updates->>'related_transaction_id')::uuid AND user_id=p_user_id AND deleted_at IS NULL
  ) THEN RAISE EXCEPTION 'related transaction not found or access denied'; END IF;
  IF p_updates ? 'amount' AND (p_updates->>'amount')::numeric<=0 THEN RAISE EXCEPTION 'transaction amount must be positive'; END IF;
  v_before:=to_jsonb(v_txn);
  UPDATE public.transactions SET
    transaction_type=CASE WHEN p_updates ? 'transaction_type' THEN p_updates->>'transaction_type' ELSE v_txn.transaction_type END,
    direction=CASE WHEN p_updates ? 'direction' THEN p_updates->>'direction' ELSE v_txn.direction END,
    amount=CASE WHEN p_updates ? 'amount' THEN (p_updates->>'amount')::numeric ELSE v_txn.amount END,
    currency_code=CASE WHEN p_updates ? 'currency_code' THEN p_updates->>'currency_code' ELSE v_txn.currency_code END,
    status=CASE WHEN p_updates ? 'status' THEN p_updates->>'status' ELSE v_txn.status END,
    description=CASE WHEN p_updates ? 'description' THEN p_updates->>'description' ELSE v_txn.description END,
    merchant_name=CASE WHEN p_updates ? 'merchant_name' THEN p_updates->>'merchant_name' ELSE v_txn.merchant_name END,
    bank_name=CASE WHEN p_updates ? 'bank_name' THEN p_updates->>'bank_name' ELSE v_txn.bank_name END,
    payment_provider=CASE WHEN p_updates ? 'payment_provider' THEN p_updates->>'payment_provider' ELSE v_txn.payment_provider END,
    payment_method=CASE WHEN p_updates ? 'payment_method' THEN p_updates->>'payment_method' ELSE v_txn.payment_method END,
    category=CASE WHEN p_updates ? 'category' THEN p_updates->>'category' ELSE v_txn.category END,
    account_last4=CASE WHEN p_updates ? 'account_last4' THEN p_updates->>'account_last4' ELSE v_txn.account_last4 END,
    external_reference=CASE WHEN p_updates ? 'external_reference' THEN p_updates->>'external_reference' ELSE v_txn.external_reference END,
    related_transaction_id=CASE WHEN p_updates ? 'related_transaction_id' THEN NULLIF(p_updates->>'related_transaction_id','')::uuid ELSE v_txn.related_transaction_id END,
    occurred_at=CASE WHEN p_updates ? 'occurred_at' THEN (p_updates->>'occurred_at')::timestamptz ELSE v_txn.occurred_at END,
    updated_at=now()
    WHERE id=p_transaction_id RETURNING * INTO v_txn;
  INSERT INTO public.ledger_events(transaction_id,user_id,event_type,event_source,description,metadata,occurred_at)
    VALUES(v_txn.id,p_user_id,'adjustment','manual','Transaction updated',jsonb_build_object('before',v_before,'after',to_jsonb(v_txn),'changes',p_updates),now());
  RETURN to_jsonb(v_txn);
END; $$;
REVOKE ALL ON FUNCTION public.update_manual_transaction_with_event(uuid,uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.update_manual_transaction_with_event(uuid,uuid,jsonb) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.archive_transaction_with_event(p_user_id uuid,p_transaction_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_txn public.transactions; v_previous_status text;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() IS DISTINCT FROM p_user_id THEN RAISE EXCEPTION 'not authorized'; END IF;
  SELECT * INTO v_txn FROM public.transactions WHERE id=p_transaction_id AND user_id=p_user_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'transaction not found or already archived'; END IF;
  v_previous_status:=v_txn.status;
  UPDATE public.transactions SET deleted_at=now(),status='cancelled',updated_at=now()
    WHERE id=p_transaction_id RETURNING * INTO v_txn;
  INSERT INTO public.ledger_events(transaction_id,user_id,event_type,event_source,description,metadata,occurred_at)
    VALUES(v_txn.id,p_user_id,'adjustment','manual','Transaction archived',jsonb_build_object('deleted_at',v_txn.deleted_at,'previous_status',v_previous_status),now());
  RETURN jsonb_build_object('success',true,'transaction_id',v_txn.id,'deleted_at',v_txn.deleted_at);
END; $$;
REVOKE ALL ON FUNCTION public.archive_transaction_with_event(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.archive_transaction_with_event(uuid,uuid) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.get_transaction_summary(p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_summary jsonb;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() IS DISTINCT FROM p_user_id THEN RAISE EXCEPTION 'not authorized'; END IF;
  SELECT jsonb_build_object(
    'currencies',COALESCE((SELECT jsonb_agg(jsonb_build_object('currency_code',currency_code,'income',income,'expenses',expenses,'refunds',refunds,'net',net) ORDER BY currency_code)
      FROM (SELECT currency_code,
        COALESCE(SUM(amount) FILTER (WHERE direction='credit' AND transaction_type NOT IN ('refund','reversal') AND status NOT IN ('pending','failed','cancelled')),0) AS income,
        COALESCE(SUM(amount) FILTER (WHERE direction='debit' AND transaction_type NOT IN ('refund','reversal') AND status NOT IN ('pending','failed','cancelled')),0) AS expenses,
        COALESCE(SUM(amount) FILTER (WHERE transaction_type IN ('refund','reversal') AND status NOT IN ('pending','failed','cancelled')),0) AS refunds,
        COALESCE(SUM(CASE WHEN direction='credit' THEN amount ELSE -amount END) FILTER (WHERE status NOT IN ('pending','failed','cancelled')),0) AS net
        FROM public.transactions WHERE user_id=p_user_id AND deleted_at IS NULL GROUP BY currency_code) currency_totals),'[]'::jsonb),
    'postedCount',(SELECT COUNT(*) FROM public.transactions WHERE user_id=p_user_id AND deleted_at IS NULL AND status NOT IN ('pending','failed','cancelled')),
    'pendingCount',(SELECT COUNT(*) FROM public.transactions WHERE user_id=p_user_id AND deleted_at IS NULL AND status='pending')) INTO v_summary;
  RETURN v_summary;
END; $$;
REVOKE ALL ON FUNCTION public.get_transaction_summary(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_transaction_summary(uuid) TO authenticated,service_role;
