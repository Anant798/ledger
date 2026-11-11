-- Keep the pre-existing category write in the atomic Gmail importer while
-- persisting date/time provenance added by the preceding migration.
CREATE OR REPLACE FUNCTION public.complete_gmail_import(
  p_user_id uuid, p_message_id text, p_transaction jsonb, p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_email public.processed_emails; v_existing public.transactions; v_transaction public.transactions;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN RAISE EXCEPTION 'not authorized'; END IF;
  SELECT * INTO v_email FROM public.processed_emails WHERE user_id=p_user_id AND message_id=p_message_id FOR UPDATE;
  IF NOT FOUND OR v_email.status <> 'processing' THEN RAISE EXCEPTION 'email processing claim not found'; END IF;
  IF p_transaction->>'external_reference' IS NOT NULL AND p_transaction->>'external_reference' <> '' THEN
    SELECT * INTO v_existing FROM public.transactions WHERE user_id=p_user_id
      AND payment_provider=p_transaction->>'payment_provider' AND external_reference=p_transaction->>'external_reference' LIMIT 1;
  END IF;
  IF v_existing.id IS NOT NULL THEN
    UPDATE public.processed_emails SET status='parsed',transaction_id=v_existing.id,processing_started_at=NULL WHERE id=v_email.id;
    RETURN jsonb_build_object('transaction',to_jsonb(v_existing),'duplicate',true);
  END IF;
  INSERT INTO public.transactions(user_id,transaction_type,direction,amount,currency_code,status,description,
      merchant_name,bank_name,payment_provider,account_last4,external_reference,occurred_at,occurred_at_source,category)
  VALUES(p_user_id,p_transaction->>'transaction_type',p_transaction->>'direction',(p_transaction->>'amount')::numeric,
      COALESCE(p_transaction->>'currency_code','INR'),COALESCE(p_transaction->>'status','completed'),p_transaction->>'description',
      p_transaction->>'merchant_name',p_transaction->>'bank_name',p_transaction->>'payment_provider',p_transaction->>'account_last4',
      NULLIF(p_transaction->>'external_reference',''),COALESCE((p_transaction->>'occurred_at')::timestamptz,now()),
      NULLIF(p_transaction->>'occurred_at_source',''),NULLIF(p_transaction->>'category',''))
  ON CONFLICT (user_id,payment_provider,external_reference)
    WHERE payment_provider IS NOT NULL AND external_reference IS NOT NULL AND external_reference <> ''
    DO NOTHING RETURNING * INTO v_transaction;
  IF NOT FOUND THEN
    SELECT * INTO v_transaction FROM public.transactions WHERE user_id=p_user_id
      AND payment_provider=p_transaction->>'payment_provider' AND external_reference=p_transaction->>'external_reference' LIMIT 1;
    IF v_transaction.id IS NULL THEN RAISE EXCEPTION 'transaction deduplication conflict could not be resolved'; END IF;
    UPDATE public.processed_emails SET status='parsed',transaction_id=v_transaction.id,processing_started_at=NULL WHERE id=v_email.id;
    RETURN jsonb_build_object('transaction',to_jsonb(v_transaction),'duplicate',true);
  END IF;
  INSERT INTO public.ledger_events(transaction_id,user_id,event_type,event_source,description,metadata,external_event_id,occurred_at)
    VALUES(v_transaction.id,p_user_id,'created','system','Transaction imported from Gmail',
      COALESCE(p_metadata,'{}'::jsonb)||jsonb_build_object('gmail_message_id',p_message_id),p_message_id,v_transaction.occurred_at);
  UPDATE public.processed_emails SET status='parsed',transaction_id=v_transaction.id,processing_started_at=NULL WHERE id=v_email.id;
  RETURN jsonb_build_object('transaction',to_jsonb(v_transaction),'duplicate',false);
END; $$;
REVOKE ALL ON FUNCTION public.complete_gmail_import(uuid,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.complete_gmail_import(uuid,text,jsonb,jsonb) TO service_role;
