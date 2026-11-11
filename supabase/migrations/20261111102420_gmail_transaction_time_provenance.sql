ALTER TABLE public.import_review_queue
  ADD COLUMN occurred_at_source text CHECK (occurred_at_source IS NULL OR occurred_at_source IN ('bank_provided','email_received_fallback'));
ALTER TABLE public.transactions
  ADD COLUMN occurred_at_source text CHECK (occurred_at_source IS NULL OR occurred_at_source IN ('bank_provided','email_received_fallback'));

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

CREATE OR REPLACE FUNCTION public.complete_gmail_review(
  p_user_id uuid, p_message_id text, p_review jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_email public.processed_emails; v_review_id uuid;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN RAISE EXCEPTION 'not authorized'; END IF;
  SELECT * INTO v_email FROM public.processed_emails WHERE user_id=p_user_id AND message_id=p_message_id FOR UPDATE;
  IF NOT FOUND OR v_email.status <> 'processing' THEN RAISE EXCEPTION 'email processing claim not found'; END IF;
  INSERT INTO public.import_review_queue(user_id,email_message_id,direction,amount,currency_code,transaction_type,category,
      description,merchant_name,bank_name,payment_provider,account_last4,external_reference,upi_id,confidence,
      uncertain_reason,raw_snippet,occurred_at,occurred_at_source)
  VALUES(p_user_id,p_message_id,NULLIF(p_review->>'direction',''),NULLIF(p_review->>'amount','')::numeric,
      NULLIF(p_review->>'currency_code',''),COALESCE(p_review->>'transaction_type','payment'),NULLIF(p_review->>'category',''),
      p_review->>'description',NULLIF(p_review->>'merchant_name',''),NULLIF(p_review->>'bank_name',''),
      NULLIF(p_review->>'payment_provider',''),p_review->>'account_last4',NULLIF(p_review->>'external_reference',''),
      p_review->>'upi_id',(p_review->>'confidence')::numeric,p_review->>'uncertain_reason',p_review->>'raw_snippet',
      NULLIF(p_review->>'occurred_at','')::timestamptz,NULLIF(p_review->>'occurred_at_source',''))
  ON CONFLICT (user_id,email_message_id) WHERE email_message_id IS NOT NULL DO NOTHING RETURNING id INTO v_review_id;
  IF v_review_id IS NULL THEN SELECT id INTO v_review_id FROM public.import_review_queue WHERE user_id=p_user_id AND email_message_id=p_message_id; END IF;
  INSERT INTO public.alerts(user_id,alert_type,title,message,is_read,is_resolved,import_review_id)
    SELECT p_user_id,'transaction_review','Transaction Review Needed','A Gmail transaction needs confirmation.',false,false,v_review_id
    WHERE NOT EXISTS (SELECT 1 FROM public.alerts WHERE user_id=p_user_id AND import_review_id=v_review_id);
  UPDATE public.processed_emails SET status='uncertain_queued',uncertain_reason=p_review->>'uncertain_reason',processing_started_at=NULL WHERE id=v_email.id;
  RETURN v_review_id;
END; $$;
REVOKE ALL ON FUNCTION public.complete_gmail_review(uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.complete_gmail_review(uuid,text,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.approve_review_queue_item(
  p_user_id uuid, p_review_id uuid, p_amount numeric DEFAULT NULL, p_direction text DEFAULT NULL,
  p_merchant_name text DEFAULT NULL, p_bank_name text DEFAULT NULL, p_payment_provider text DEFAULT NULL,
  p_description text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_review public.import_review_queue; v_txn public.transactions; v_existing public.transactions;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN RETURN jsonb_build_object('success',false,'error','Forbidden','status',403); END IF;
  SELECT * INTO v_review FROM public.import_review_queue WHERE id=p_review_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','Review item not found','status',404); END IF;
  IF v_review.review_status <> 'pending' THEN RETURN jsonb_build_object('success',false,'error','Review item has already been processed','status',409,
      'review_status',v_review.review_status,'transaction_id',v_review.created_transaction_id); END IF;
  IF v_review.external_reference IS NOT NULL AND COALESCE(p_payment_provider,v_review.payment_provider) IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.transactions WHERE user_id=p_user_id
      AND payment_provider=COALESCE(p_payment_provider,v_review.payment_provider) AND external_reference=v_review.external_reference LIMIT 1;
  END IF;
  IF v_existing.id IS NOT NULL THEN v_txn:=v_existing;
  ELSE
    INSERT INTO public.transactions(user_id,transaction_type,direction,amount,currency_code,status,description,
        merchant_name,bank_name,payment_provider,account_last4,external_reference,occurred_at,occurred_at_source)
    VALUES(p_user_id,v_review.transaction_type,COALESCE(p_direction,v_review.direction),COALESCE(p_amount,v_review.amount),
        COALESCE(v_review.currency_code,'INR'),'completed',COALESCE(p_description,v_review.description),
        COALESCE(p_merchant_name,v_review.merchant_name),COALESCE(p_bank_name,v_review.bank_name),
        COALESCE(p_payment_provider,v_review.payment_provider),v_review.account_last4,v_review.external_reference,
        v_review.occurred_at,v_review.occurred_at_source)
    ON CONFLICT (user_id,payment_provider,external_reference)
      WHERE payment_provider IS NOT NULL AND external_reference IS NOT NULL AND external_reference <> '' DO NOTHING RETURNING * INTO v_txn;
    IF NOT FOUND THEN
      SELECT * INTO v_txn FROM public.transactions WHERE user_id=p_user_id
        AND payment_provider=COALESCE(p_payment_provider,v_review.payment_provider) AND external_reference=v_review.external_reference LIMIT 1;
      IF v_txn.id IS NULL THEN RAISE EXCEPTION 'transaction deduplication conflict could not be resolved'; END IF;
    ELSE
      INSERT INTO public.ledger_events(transaction_id,user_id,event_type,event_source,description,metadata,external_event_id,occurred_at)
      VALUES(v_txn.id,p_user_id,'created','manual','Transaction approved from Gmail review',
        jsonb_build_object('review_id',p_review_id,'email_message_id',v_review.email_message_id),v_review.email_message_id,now());
    END IF;
  END IF;
  UPDATE public.import_review_queue SET review_status='approved',created_transaction_id=v_txn.id,resolved_at=now(),updated_at=now() WHERE id=p_review_id;
  IF v_review.email_message_id IS NOT NULL THEN
    UPDATE public.processed_emails SET status='parsed',transaction_id=v_txn.id,processing_started_at=NULL
      WHERE user_id=p_user_id AND message_id=v_review.email_message_id;
  END IF;
  UPDATE public.alerts SET is_resolved=true,resolved_at=now() WHERE user_id=p_user_id AND import_review_id=p_review_id;
  RETURN jsonb_build_object('success',true,'message','Transaction approved','transaction_id',v_txn.id,'transaction',to_jsonb(v_txn));
END; $$;
REVOKE ALL ON FUNCTION public.approve_review_queue_item(uuid,uuid,numeric,text,text,text,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.approve_review_queue_item(uuid,uuid,numeric,text,text,text,text,text) TO authenticated,service_role;
