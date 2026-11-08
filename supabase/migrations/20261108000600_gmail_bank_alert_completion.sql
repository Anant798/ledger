-- Allow incomplete bank alerts to remain in the review queue until a person
-- confirms the required financial fields. No existing records are removed.
ALTER TABLE public.import_review_queue ALTER COLUMN direction DROP NOT NULL;
ALTER TABLE public.import_review_queue ALTER COLUMN amount DROP NOT NULL;
ALTER TABLE public.import_review_queue ALTER COLUMN currency_code DROP NOT NULL;
ALTER TABLE public.import_review_queue ADD COLUMN IF NOT EXISTS category text;

CREATE OR REPLACE FUNCTION public.complete_gmail_import(
  p_user_id uuid, p_message_id text, p_transaction jsonb, p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_email public.processed_emails; v_existing public.transactions; v_transaction public.transactions;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN RAISE EXCEPTION 'not authorized'; END IF;
  SELECT * INTO v_email FROM public.processed_emails
    WHERE user_id=p_user_id AND message_id=p_message_id FOR UPDATE;
  IF NOT FOUND OR v_email.status <> 'processing' THEN RAISE EXCEPTION 'email processing claim not found'; END IF;
  IF p_transaction->>'external_reference' IS NOT NULL AND p_transaction->>'external_reference' <> '' THEN
    SELECT * INTO v_existing FROM public.transactions WHERE user_id=p_user_id
      AND payment_provider=p_transaction->>'payment_provider'
      AND external_reference=p_transaction->>'external_reference' LIMIT 1;
  END IF;
  IF v_existing.id IS NOT NULL THEN
    UPDATE public.processed_emails SET status='parsed',transaction_id=v_existing.id,processing_started_at=NULL
      WHERE id=v_email.id;
    RETURN jsonb_build_object('transaction',to_jsonb(v_existing),'duplicate',true);
  END IF;
  INSERT INTO public.transactions(user_id,transaction_type,direction,amount,currency_code,status,description,
      merchant_name,bank_name,payment_provider,account_last4,external_reference,occurred_at,category)
  VALUES(p_user_id,p_transaction->>'transaction_type',p_transaction->>'direction',
      (p_transaction->>'amount')::numeric,COALESCE(p_transaction->>'currency_code','INR'),
      COALESCE(p_transaction->>'status','completed'),p_transaction->>'description',
      p_transaction->>'merchant_name',p_transaction->>'bank_name',p_transaction->>'payment_provider',
      p_transaction->>'account_last4',NULLIF(p_transaction->>'external_reference',''),
      COALESCE((p_transaction->>'occurred_at')::timestamptz,now()),NULLIF(p_transaction->>'category',''))
  ON CONFLICT (user_id,payment_provider,external_reference)
    WHERE payment_provider IS NOT NULL AND external_reference IS NOT NULL AND external_reference <> ''
    DO NOTHING RETURNING * INTO v_transaction;
  IF NOT FOUND THEN
    SELECT * INTO v_transaction FROM public.transactions WHERE user_id=p_user_id
      AND payment_provider=p_transaction->>'payment_provider'
      AND external_reference=p_transaction->>'external_reference' LIMIT 1;
    IF v_transaction.id IS NULL THEN RAISE EXCEPTION 'transaction deduplication conflict could not be resolved'; END IF;
    UPDATE public.processed_emails SET status='parsed',transaction_id=v_transaction.id,processing_started_at=NULL
      WHERE id=v_email.id;
    RETURN jsonb_build_object('transaction',to_jsonb(v_transaction),'duplicate',true);
  END IF;
  INSERT INTO public.ledger_events(transaction_id,user_id,event_type,event_source,description,metadata,external_event_id,occurred_at)
    VALUES(v_transaction.id,p_user_id,'created','system','Transaction imported from Gmail',
      COALESCE(p_metadata,'{}'::jsonb)||jsonb_build_object('gmail_message_id',p_message_id),p_message_id,v_transaction.occurred_at);
  UPDATE public.processed_emails SET status='parsed',transaction_id=v_transaction.id,processing_started_at=NULL WHERE id=v_email.id;
  RETURN jsonb_build_object('transaction',to_jsonb(v_transaction),'duplicate',false);
END; $$;
REVOKE ALL ON FUNCTION public.complete_gmail_import(uuid,text,jsonb,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_gmail_import(uuid,text,jsonb,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.complete_gmail_review(
  p_user_id uuid, p_message_id text, p_review jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_email public.processed_emails; v_review_id uuid;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN RAISE EXCEPTION 'not authorized'; END IF;
  SELECT * INTO v_email FROM public.processed_emails
    WHERE user_id=p_user_id AND message_id=p_message_id FOR UPDATE;
  IF NOT FOUND OR v_email.status <> 'processing' THEN RAISE EXCEPTION 'email processing claim not found'; END IF;
  INSERT INTO public.import_review_queue(user_id,email_message_id,direction,amount,currency_code,transaction_type,category,
      description,merchant_name,bank_name,payment_provider,account_last4,external_reference,upi_id,confidence,
      uncertain_reason,raw_snippet,occurred_at)
  VALUES(p_user_id,p_message_id,NULLIF(p_review->>'direction',''),NULLIF(p_review->>'amount','')::numeric,
      NULLIF(p_review->>'currency_code',''),COALESCE(p_review->>'transaction_type','payment'),NULLIF(p_review->>'category',''),
      p_review->>'description',NULLIF(p_review->>'merchant_name',''),NULLIF(p_review->>'bank_name',''),
      NULLIF(p_review->>'payment_provider',''),p_review->>'account_last4',NULLIF(p_review->>'external_reference',''),
      p_review->>'upi_id',(p_review->>'confidence')::numeric,p_review->>'uncertain_reason',p_review->>'raw_snippet',
      COALESCE((p_review->>'occurred_at')::timestamptz,now()))
  ON CONFLICT (user_id,email_message_id) WHERE email_message_id IS NOT NULL DO NOTHING
  RETURNING id INTO v_review_id;
  IF v_review_id IS NULL THEN
    SELECT id INTO v_review_id FROM public.import_review_queue WHERE user_id=p_user_id AND email_message_id=p_message_id;
  END IF;
  INSERT INTO public.alerts(user_id,alert_type,title,message,is_read,is_resolved,import_review_id)
    SELECT p_user_id,'transaction_review','Transaction Review Needed',
      'A Gmail transaction needs confirmation.',false,false,v_review_id
    WHERE NOT EXISTS (SELECT 1 FROM public.alerts WHERE user_id=p_user_id AND import_review_id=v_review_id);
  UPDATE public.processed_emails SET status='uncertain_queued',uncertain_reason=p_review->>'uncertain_reason',
    processing_started_at=NULL WHERE id=v_email.id;
  RETURN v_review_id;
END; $$;
REVOKE ALL ON FUNCTION public.complete_gmail_review(uuid,text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_gmail_review(uuid,text,jsonb) TO service_role;

-- Corrections and approval happen in one transaction. The existing approval
-- RPC remains responsible for uniqueness, ledger event, email state and alert.
CREATE OR REPLACE FUNCTION public.resolve_gmail_import_review(
  p_user_id uuid, p_review_id uuid, p_action text, p_corrections jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_review public.import_review_queue; v_approved jsonb; v_duplicate boolean := false;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_user_id THEN
    RETURN jsonb_build_object('success',false,'error','Forbidden','status',403);
  END IF;
  IF p_action NOT IN ('approve','reject') THEN
    RETURN jsonb_build_object('success',false,'error','Invalid action','status',400);
  END IF;
  SELECT * INTO v_review FROM public.import_review_queue
    WHERE id=p_review_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND OR v_review.review_status <> 'pending' THEN
    RETURN jsonb_build_object('success',false,'error','Review item not found or already processed','status',409);
  END IF;
  IF p_action='reject' THEN
    RETURN public.reject_review_queue_item(p_user_id,p_review_id);
  END IF;

  UPDATE public.import_review_queue SET
    amount=CASE WHEN p_corrections ? 'amount' THEN NULLIF(p_corrections->>'amount','')::numeric ELSE amount END,
    direction=CASE WHEN p_corrections ? 'direction' THEN NULLIF(p_corrections->>'direction','') ELSE direction END,
    currency_code=CASE WHEN p_corrections ? 'currency_code' THEN NULLIF(upper(p_corrections->>'currency_code'),'') ELSE currency_code END,
    transaction_type=CASE WHEN p_corrections ? 'transaction_type' THEN p_corrections->>'transaction_type' ELSE transaction_type END,
    category=CASE WHEN p_corrections ? 'category' THEN NULLIF(p_corrections->>'category','') ELSE category END,
    occurred_at=CASE WHEN p_corrections ? 'occurred_at' THEN (p_corrections->>'occurred_at')::timestamptz ELSE occurred_at END,
    merchant_name=CASE WHEN p_corrections ? 'merchant_name' THEN NULLIF(p_corrections->>'merchant_name','') ELSE merchant_name END,
    bank_name=CASE WHEN p_corrections ? 'bank_name' THEN NULLIF(p_corrections->>'bank_name','') ELSE bank_name END,
    payment_provider=CASE WHEN p_corrections ? 'payment_provider' THEN NULLIF(p_corrections->>'payment_provider','') ELSE payment_provider END,
    external_reference=CASE WHEN p_corrections ? 'external_reference' THEN NULLIF(p_corrections->>'external_reference','') ELSE external_reference END,
    description=CASE WHEN p_corrections ? 'description' THEN NULLIF(p_corrections->>'description','') ELSE description END,
    updated_at=now()
  WHERE id=p_review_id AND user_id=p_user_id;

  SELECT * INTO v_review FROM public.import_review_queue WHERE id=p_review_id AND user_id=p_user_id;
  IF v_review.amount IS NULL OR v_review.amount <= 0 OR v_review.direction IS NULL OR v_review.direction NOT IN ('debit','credit')
     OR v_review.currency_code IS NULL OR v_review.currency_code !~ '^[A-Z]{3}$'
     OR v_review.transaction_type IS NULL OR v_review.transaction_type NOT IN ('payment','refund','shared_expense','repayment','manual','reversal','other')
     OR v_review.occurred_at IS NULL THEN
    RETURN jsonb_build_object('success',false,'error','Amount, direction, currency, type and transaction time must be valid before approval','status',400);
  END IF;

  v_approved := public.approve_review_queue_item(p_user_id,p_review_id,NULL,NULL,NULL,NULL,NULL,NULL);
  SELECT NOT EXISTS (SELECT 1 FROM public.ledger_events
    WHERE transaction_id=(v_approved->>'transaction_id')::uuid AND user_id=p_user_id
      AND metadata->>'review_id'=p_review_id::text) INTO v_duplicate;
  IF COALESCE((v_approved->>'success')::boolean,false) AND NOT v_duplicate AND v_review.category IS NOT NULL THEN
    UPDATE public.transactions SET category=v_review.category
      WHERE id=(v_approved->>'transaction_id')::uuid AND user_id=p_user_id;
    UPDATE public.ledger_events SET event_source='system', metadata=COALESCE(metadata,'{}'::jsonb)||jsonb_build_object('source','gmail')
      WHERE transaction_id=(v_approved->>'transaction_id')::uuid AND user_id=p_user_id
        AND metadata->>'review_id'=p_review_id::text;
  END IF;
  RETURN v_approved;
END; $$;
REVOKE ALL ON FUNCTION public.resolve_gmail_import_review(uuid,uuid,text,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_gmail_import_review(uuid,uuid,text,jsonb) TO authenticated, service_role;
