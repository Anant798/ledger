-- Additive Gmail ingestion and review-queue support. This migration assumes
-- the project's existing Ledger base tables and preserves their current data.

ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS bank_name text;
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS account_last4 text;

-- Replace only the exact live constraints verified during reconciliation. Any
-- custom/unknown constraint causes a safe abort for manual review.
DO $$
DECLARE v_name text; v_count integer;
BEGIN
  SELECT count(*), min(conname) INTO v_count, v_name FROM pg_constraint
    WHERE conrelid='public.transactions'::regclass AND contype='c'
      AND regexp_replace(replace(lower(pg_get_constraintdef(oid)), '::text', ''), '[[:space:]''()\[\]]', '', 'g') =
        'checktransaction_type=anyarraypayment,refund,shared_expense,repayment,manual';
  IF v_count <> 1 THEN RAISE EXCEPTION 'Expected exactly one known transactions.transaction_type check, found %; inspect constraints before applying', v_count; END IF;
  EXECUTE format('ALTER TABLE public.transactions DROP CONSTRAINT %I', v_name);
  ALTER TABLE public.transactions ADD CONSTRAINT transactions_type_batch_a_check
    CHECK (transaction_type IN ('payment', 'refund', 'shared_expense', 'repayment', 'manual', 'reversal', 'other'));

  SELECT count(*), min(conname) INTO v_count, v_name FROM pg_constraint
    WHERE conrelid='public.alerts'::regclass AND contype='c'
      AND regexp_replace(replace(lower(pg_get_constraintdef(oid)), '::text', ''), '[[:space:]''()\[\]]', '', 'g') =
        'checkalert_type=anyarraypayment_pending,refund_pending,repayment_due,goal_milestone,general';
  IF v_count <> 1 THEN RAISE EXCEPTION 'Expected exactly one known alerts.alert_type check, found %; inspect constraints before applying', v_count; END IF;
  EXECUTE format('ALTER TABLE public.alerts DROP CONSTRAINT %I', v_name);
  ALTER TABLE public.alerts ADD CONSTRAINT alerts_type_batch_a_check
    CHECK (alert_type IN ('payment_pending', 'refund_pending', 'repayment_due', 'goal_milestone', 'general', 'transaction_review'));
END $$;

-- A repeated reference from the same provider must not create a second import.
-- Preflight existing data for duplicate nonempty references before applying.
CREATE UNIQUE INDEX uq_transactions_user_provider_reference
  ON public.transactions(user_id, payment_provider, external_reference)
  WHERE payment_provider IS NOT NULL AND external_reference IS NOT NULL AND external_reference <> '';

CREATE TABLE public.server_oauth_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider = 'gmail'),
  email_address text,
  access_token text NOT NULL,
  refresh_token text,
  token_expiry timestamptz,
  scope text,
  history_id text,
  next_page_token text,
  history_page_token text,
  initial_sync_completed boolean NOT NULL DEFAULT false,
  watch_expiration timestamptz,
  last_synced_at timestamptz,
  sync_status text NOT NULL DEFAULT 'idle' CHECK (sync_status IN ('idle', 'syncing', 'error')),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_server_oauth_user_provider UNIQUE (user_id, provider)
);
-- The UNIQUE(user_id, provider) constraint already indexes user_id as its
-- leading column; a separate user_id index is redundant.
ALTER TABLE public.server_oauth_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.server_oauth_tokens FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.server_oauth_tokens TO service_role;

CREATE TABLE public.processed_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  message_id text NOT NULL,
  history_id text,
  internal_date timestamptz,
  sender text,
  subject text,
  status text NOT NULL CHECK (status IN ('processing', 'parsed', 'ignored_not_transaction', 'uncertain_queued', 'failed')),
  transaction_id uuid REFERENCES public.transactions(id) ON DELETE SET NULL,
  uncertain_reason text,
  processing_started_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_processed_emails_user_msg UNIQUE (user_id, message_id)
);
-- uq_processed_emails_user_msg already supports this lookup; no duplicate index.
ALTER TABLE public.processed_emails ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.processed_emails FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE ON public.processed_emails FROM authenticated;
GRANT SELECT ON public.processed_emails TO authenticated;
GRANT ALL ON public.processed_emails TO service_role;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='processed_emails' AND policyname='Users can view their own processed email logs') THEN
    CREATE POLICY "Users can view their own processed email logs" ON public.processed_emails
      FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
  END IF;
END $$;

CREATE TABLE public.import_review_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email_message_id text,
  direction text NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount numeric NOT NULL CHECK (amount > 0),
  currency_code text NOT NULL DEFAULT 'INR',
  transaction_type text NOT NULL DEFAULT 'payment',
  description text,
  merchant_name text,
  bank_name text,
  payment_provider text,
  account_last4 text,
  external_reference text,
  upi_id text,
  confidence numeric(3,2),
  uncertain_reason text,
  raw_snippet text,
  review_status text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'approved', 'rejected')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  created_transaction_id uuid REFERENCES public.transactions(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_import_review_processed_email FOREIGN KEY (user_id, email_message_id)
    REFERENCES public.processed_emails(user_id, message_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX uq_import_review_user_email
  ON public.import_review_queue(user_id, email_message_id) WHERE email_message_id IS NOT NULL;
CREATE INDEX idx_import_review_user ON public.import_review_queue(user_id, review_status);
ALTER TABLE public.import_review_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.import_review_queue FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE ON public.import_review_queue FROM authenticated;
GRANT SELECT ON public.import_review_queue TO authenticated;
GRANT ALL ON public.import_review_queue TO service_role;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='import_review_queue' AND policyname='Users can view their own review queue') THEN
    CREATE POLICY "Users can view their own review queue" ON public.import_review_queue
      FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
  END IF;
END $$;

ALTER TABLE public.alerts ADD COLUMN IF NOT EXISTS import_review_id uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.alerts'::regclass AND conname='alerts_import_review_id_fkey') THEN
    ALTER TABLE public.alerts ADD CONSTRAINT alerts_import_review_id_fkey
      FOREIGN KEY (import_review_id) REFERENCES public.import_review_queue(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX idx_alerts_import_review_batch_a ON public.alerts(import_review_id);
CREATE INDEX idx_processed_emails_transaction_batch_a ON public.processed_emails(transaction_id);
CREATE INDEX idx_import_review_created_transaction_batch_a ON public.import_review_queue(created_transaction_id);

CREATE FUNCTION public.claim_processed_email(
  p_user_id uuid, p_message_id text, p_history_id text, p_internal_date timestamptz, p_sender text, p_subject text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_claimed boolean;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN RAISE EXCEPTION 'not authorized'; END IF;
  INSERT INTO public.processed_emails(user_id,message_id,history_id,internal_date,sender,subject,status,processing_started_at)
  VALUES(p_user_id,p_message_id,p_history_id,p_internal_date,p_sender,p_subject,'processing',now())
  ON CONFLICT (user_id,message_id) DO UPDATE SET history_id=EXCLUDED.history_id,
    internal_date=EXCLUDED.internal_date, sender=EXCLUDED.sender, subject=EXCLUDED.subject,
    status='processing', uncertain_reason=NULL, processing_started_at=now()
  WHERE public.processed_emails.status='failed'
    OR (public.processed_emails.status='processing' AND public.processed_emails.processing_started_at < now()-interval '15 minutes')
  RETURNING true INTO v_claimed;
  RETURN COALESCE(v_claimed,false);
END; $$;
REVOKE ALL ON FUNCTION public.claim_processed_email(uuid,text,text,timestamptz,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_processed_email(uuid,text,text,timestamptz,text,text) TO service_role;

CREATE FUNCTION public.finish_processed_email(
  p_user_id uuid, p_message_id text, p_status text, p_reason text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN RAISE EXCEPTION 'not authorized'; END IF;
  IF p_status NOT IN ('ignored_not_transaction','failed') THEN RAISE EXCEPTION 'invalid terminal email status'; END IF;
  UPDATE public.processed_emails SET status=p_status, uncertain_reason=p_reason, processing_started_at=NULL
    WHERE user_id=p_user_id AND message_id=p_message_id AND status='processing';
  IF NOT FOUND THEN RAISE EXCEPTION 'email processing claim not found'; END IF;
END; $$;
REVOKE ALL ON FUNCTION public.finish_processed_email(uuid,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_processed_email(uuid,text,text,text) TO service_role;

CREATE FUNCTION public.complete_gmail_import(
  p_user_id uuid, p_message_id text, p_transaction jsonb, p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_email public.processed_emails; v_existing public.transactions; v_transaction public.transactions;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN RAISE EXCEPTION 'not authorized'; END IF;
  SELECT * INTO v_email FROM public.processed_emails WHERE user_id=p_user_id AND message_id=p_message_id FOR UPDATE;
  IF NOT FOUND OR v_email.status <> 'processing' THEN RAISE EXCEPTION 'email processing claim not found'; END IF;
  IF p_transaction->>'external_reference' IS NOT NULL AND p_transaction->>'external_reference' <> '' THEN
    SELECT * INTO v_existing FROM public.transactions WHERE user_id=p_user_id
      AND payment_provider=p_transaction->>'payment_provider'
      AND external_reference=p_transaction->>'external_reference' LIMIT 1;
  END IF;
  IF v_existing.id IS NOT NULL THEN
    UPDATE public.processed_emails SET status='parsed', transaction_id=v_existing.id, processing_started_at=NULL
      WHERE id=v_email.id;
    RETURN jsonb_build_object('transaction',to_jsonb(v_existing),'duplicate',true);
  END IF;
  INSERT INTO public.transactions(user_id,transaction_type,direction,amount,currency_code,status,description,
      merchant_name,bank_name,payment_provider,account_last4,external_reference,occurred_at)
  VALUES(p_user_id,p_transaction->>'transaction_type',p_transaction->>'direction',
      (p_transaction->>'amount')::numeric,COALESCE(p_transaction->>'currency_code','INR'),
      COALESCE(p_transaction->>'status','completed'),p_transaction->>'description',
      p_transaction->>'merchant_name',p_transaction->>'bank_name',p_transaction->>'payment_provider',
      p_transaction->>'account_last4',NULLIF(p_transaction->>'external_reference',''),
      COALESCE((p_transaction->>'occurred_at')::timestamptz,now()))
  ON CONFLICT (user_id,payment_provider,external_reference)
    WHERE payment_provider IS NOT NULL AND external_reference IS NOT NULL AND external_reference <> ''
    DO NOTHING RETURNING * INTO v_transaction;
  IF NOT FOUND THEN
    SELECT * INTO v_transaction FROM public.transactions WHERE user_id=p_user_id
      AND payment_provider=p_transaction->>'payment_provider'
      AND external_reference=p_transaction->>'external_reference' LIMIT 1;
    UPDATE public.processed_emails SET status='parsed', transaction_id=v_transaction.id, processing_started_at=NULL
      WHERE id=v_email.id;
    RETURN jsonb_build_object('transaction',to_jsonb(v_transaction),'duplicate',true);
  END IF;
  INSERT INTO public.ledger_events(transaction_id,user_id,event_type,event_source,description,metadata,external_event_id,occurred_at)
    VALUES(v_transaction.id,p_user_id,'created','system','Transaction imported from Gmail',
      COALESCE(p_metadata,'{}'::jsonb)||jsonb_build_object('gmail_message_id',p_message_id),p_message_id,v_transaction.occurred_at);
  UPDATE public.processed_emails SET status='parsed', transaction_id=v_transaction.id, processing_started_at=NULL
    WHERE id=v_email.id;
  RETURN jsonb_build_object('transaction',to_jsonb(v_transaction),'duplicate',false);
END; $$;
REVOKE ALL ON FUNCTION public.complete_gmail_import(uuid,text,jsonb,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_gmail_import(uuid,text,jsonb,jsonb) TO service_role;

CREATE FUNCTION public.complete_gmail_review(
  p_user_id uuid, p_message_id text, p_review jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_email public.processed_emails; v_review_id uuid;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN RAISE EXCEPTION 'not authorized'; END IF;
  SELECT * INTO v_email FROM public.processed_emails WHERE user_id=p_user_id AND message_id=p_message_id FOR UPDATE;
  IF NOT FOUND OR v_email.status <> 'processing' THEN RAISE EXCEPTION 'email processing claim not found'; END IF;
  INSERT INTO public.import_review_queue(user_id,email_message_id,direction,amount,currency_code,transaction_type,
      description,merchant_name,bank_name,payment_provider,account_last4,external_reference,upi_id,confidence,
      uncertain_reason,raw_snippet,occurred_at)
  VALUES(p_user_id,p_message_id,p_review->>'direction',(p_review->>'amount')::numeric,
      COALESCE(p_review->>'currency_code','INR'),COALESCE(p_review->>'transaction_type','payment'),
      p_review->>'description',p_review->>'merchant_name',p_review->>'bank_name',p_review->>'payment_provider',
      p_review->>'account_last4',p_review->>'external_reference',p_review->>'upi_id',
      (p_review->>'confidence')::numeric,p_review->>'uncertain_reason',p_review->>'raw_snippet',
      COALESCE((p_review->>'occurred_at')::timestamptz,now()))
  ON CONFLICT (user_id,email_message_id) WHERE email_message_id IS NOT NULL DO NOTHING
  RETURNING id INTO v_review_id;
  IF v_review_id IS NULL THEN
    SELECT id INTO v_review_id FROM public.import_review_queue WHERE user_id=p_user_id AND email_message_id=p_message_id;
  END IF;
  INSERT INTO public.alerts(user_id,alert_type,title,message,is_read,is_resolved,import_review_id)
    VALUES(p_user_id,'transaction_review','Transaction Review Needed',
      'A Gmail transaction needs confirmation.',false,false,v_review_id);
  UPDATE public.processed_emails SET status='uncertain_queued', uncertain_reason=p_review->>'uncertain_reason',
    processing_started_at=NULL WHERE id=v_email.id;
  RETURN v_review_id;
END; $$;
REVOKE ALL ON FUNCTION public.complete_gmail_review(uuid,text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_gmail_review(uuid,text,jsonb) TO service_role;

CREATE FUNCTION public.approve_review_queue_item(
  p_user_id uuid, p_review_id uuid, p_amount numeric DEFAULT NULL, p_direction text DEFAULT NULL,
  p_merchant_name text DEFAULT NULL, p_bank_name text DEFAULT NULL, p_payment_provider text DEFAULT NULL,
  p_description text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_review public.import_review_queue; v_txn public.transactions; v_existing public.transactions;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RETURN jsonb_build_object('success',false,'error','Forbidden','status',403);
  END IF;
  SELECT * INTO v_review FROM public.import_review_queue WHERE id=p_review_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','Review item not found','status',404); END IF;
  IF v_review.review_status <> 'pending' THEN
    RETURN jsonb_build_object('success',false,'error','Review item has already been processed','status',409,
      'review_status',v_review.review_status,'transaction_id',v_review.created_transaction_id);
  END IF;
  IF v_review.external_reference IS NOT NULL AND COALESCE(p_payment_provider, v_review.payment_provider) IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.transactions
      WHERE user_id=p_user_id
        AND payment_provider=COALESCE(p_payment_provider, v_review.payment_provider)
        AND external_reference=v_review.external_reference LIMIT 1;
  END IF;
  IF v_existing.id IS NOT NULL THEN
    v_txn := v_existing;
  ELSE
    INSERT INTO public.transactions(user_id,transaction_type,direction,amount,currency_code,status,description,
        merchant_name,bank_name,payment_provider,account_last4,external_reference,occurred_at)
    VALUES(p_user_id,v_review.transaction_type,COALESCE(p_direction,v_review.direction),
        COALESCE(p_amount,v_review.amount),COALESCE(v_review.currency_code,'INR'),'completed',
        COALESCE(p_description,v_review.description),COALESCE(p_merchant_name,v_review.merchant_name),
        COALESCE(p_bank_name,v_review.bank_name),COALESCE(p_payment_provider,v_review.payment_provider),
      v_review.account_last4,v_review.external_reference,v_review.occurred_at)
    ON CONFLICT (user_id,payment_provider,external_reference)
      WHERE payment_provider IS NOT NULL AND external_reference IS NOT NULL AND external_reference <> ''
      DO NOTHING
    RETURNING * INTO v_txn;
    IF NOT FOUND THEN
      SELECT * INTO v_txn FROM public.transactions WHERE user_id=p_user_id
        AND payment_provider=COALESCE(p_payment_provider, v_review.payment_provider)
        AND external_reference=v_review.external_reference LIMIT 1;
      IF v_txn.id IS NULL THEN RAISE EXCEPTION 'transaction deduplication conflict could not be resolved'; END IF;
    ELSE
    INSERT INTO public.ledger_events(transaction_id,user_id,event_type,event_source,description,metadata,external_event_id,occurred_at)
      VALUES(v_txn.id,p_user_id,'created','manual','Transaction approved from Gmail review',
        jsonb_build_object('review_id',p_review_id,'email_message_id',v_review.email_message_id),
        v_review.email_message_id,now());
    END IF;
  END IF;
  UPDATE public.import_review_queue SET review_status='approved',created_transaction_id=v_txn.id,
    resolved_at=now(),updated_at=now() WHERE id=p_review_id;
  IF v_review.email_message_id IS NOT NULL THEN
    UPDATE public.processed_emails SET status='parsed',transaction_id=v_txn.id,processing_started_at=NULL
      WHERE user_id=p_user_id AND message_id=v_review.email_message_id;
  END IF;
  UPDATE public.alerts SET is_resolved=true,resolved_at=now()
    WHERE user_id=p_user_id AND import_review_id=p_review_id;
  RETURN jsonb_build_object('success',true,'message','Transaction approved','transaction_id',v_txn.id,'transaction',to_jsonb(v_txn));
END; $$;
REVOKE ALL ON FUNCTION public.approve_review_queue_item(uuid,uuid,numeric,text,text,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_review_queue_item(uuid,uuid,numeric,text,text,text,text,text) TO authenticated, service_role;

CREATE FUNCTION public.reject_review_queue_item(p_user_id uuid,p_review_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_review public.import_review_queue;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN RETURN jsonb_build_object('success',false,'status',403); END IF;
  UPDATE public.import_review_queue SET review_status='rejected',resolved_at=now(),updated_at=now()
    WHERE id=p_review_id AND user_id=p_user_id AND review_status='pending' RETURNING * INTO v_review;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'status',409,'error','Review item not found or already processed'); END IF;
  IF v_review.email_message_id IS NOT NULL THEN
    UPDATE public.processed_emails SET status='ignored_not_transaction',processing_started_at=NULL
      WHERE user_id=p_user_id AND message_id=v_review.email_message_id;
  END IF;
  UPDATE public.alerts SET is_resolved=true,resolved_at=now() WHERE user_id=p_user_id AND import_review_id=p_review_id;
  RETURN jsonb_build_object('success',true,'review_status','rejected');
END; $$;
REVOKE ALL ON FUNCTION public.reject_review_queue_item(uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reject_review_queue_item(uuid,uuid) TO authenticated, service_role;

CREATE FUNCTION public.create_manual_transaction_with_event(p_user_id uuid,p_transaction jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_txn public.transactions;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN RAISE EXCEPTION 'not authorized'; END IF;
  IF NULLIF(p_transaction->>'related_transaction_id','') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.transactions WHERE id=(p_transaction->>'related_transaction_id')::uuid AND user_id=p_user_id
  ) THEN RAISE EXCEPTION 'related transaction not found or access denied'; END IF;
  INSERT INTO public.transactions(user_id,transaction_type,direction,amount,currency_code,status,description,
      merchant_name,bank_name,payment_provider,account_last4,external_reference,related_transaction_id,occurred_at)
    VALUES(p_user_id,COALESCE(p_transaction->>'transaction_type','manual'),p_transaction->>'direction',
      (p_transaction->>'amount')::numeric,COALESCE(p_transaction->>'currency_code','INR'),
      COALESCE(p_transaction->>'status','completed'),p_transaction->>'description',p_transaction->>'merchant_name',
      p_transaction->>'bank_name',COALESCE(p_transaction->>'payment_provider','manual'),p_transaction->>'account_last4',
      p_transaction->>'external_reference',NULLIF(p_transaction->>'related_transaction_id','')::uuid,
      COALESCE((p_transaction->>'occurred_at')::timestamptz,now())) RETURNING * INTO v_txn;
  INSERT INTO public.ledger_events(transaction_id,user_id,event_type,event_source,description,metadata,occurred_at)
    VALUES(v_txn.id,p_user_id,'created','manual','Manual transaction created',p_transaction,v_txn.occurred_at);
  RETURN to_jsonb(v_txn);
END; $$;
REVOKE ALL ON FUNCTION public.create_manual_transaction_with_event(uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_manual_transaction_with_event(uuid,jsonb) TO authenticated, service_role;

CREATE FUNCTION public.update_manual_transaction_with_event(p_user_id uuid,p_transaction_id uuid,p_updates jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_txn public.transactions;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN RAISE EXCEPTION 'not authorized'; END IF;
  SELECT * INTO v_txn FROM public.transactions WHERE id=p_transaction_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'transaction not found or access denied'; END IF;
  IF p_updates ? 'related_transaction_id' AND NULLIF(p_updates->>'related_transaction_id','') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.transactions WHERE id=(p_updates->>'related_transaction_id')::uuid AND user_id=p_user_id
  ) THEN RAISE EXCEPTION 'related transaction not found or access denied'; END IF;
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
    account_last4=CASE WHEN p_updates ? 'account_last4' THEN p_updates->>'account_last4' ELSE v_txn.account_last4 END,
    external_reference=CASE WHEN p_updates ? 'external_reference' THEN p_updates->>'external_reference' ELSE v_txn.external_reference END,
    related_transaction_id=CASE WHEN p_updates ? 'related_transaction_id' THEN NULLIF(p_updates->>'related_transaction_id','')::uuid ELSE v_txn.related_transaction_id END,
    occurred_at=CASE WHEN p_updates ? 'occurred_at' THEN (p_updates->>'occurred_at')::timestamptz ELSE v_txn.occurred_at END,
    updated_at=now()
  WHERE id=p_transaction_id RETURNING * INTO v_txn;
  INSERT INTO public.ledger_events(transaction_id,user_id,event_type,event_source,description,metadata,occurred_at)
    VALUES(v_txn.id,p_user_id,'adjustment','manual','Transaction updated',p_updates,now());
  RETURN to_jsonb(v_txn);
END; $$;
REVOKE ALL ON FUNCTION public.update_manual_transaction_with_event(uuid,uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_manual_transaction_with_event(uuid,uuid,jsonb) TO authenticated, service_role;

-- This table intentionally has no user-facing policies: Gmail credentials are
-- backend-only and all functions above are service-role-only except review RPCs.

-- Durable, idempotent Pub/Sub webhook processing. Existing duplicate provider
-- event IDs must be resolved before creating the unique index.
CREATE INDEX idx_ai_messages_conversation_user_batch_a ON public.ai_messages(conversation_id,user_id);
CREATE INDEX idx_alerts_transaction_batch_a ON public.alerts(transaction_id);
CREATE INDEX idx_goal_contributions_goal_user_batch_a ON public.goal_contributions(goal_id,user_id);
CREATE INDEX idx_reminder_logs_share_batch_a ON public.reminder_logs(expense_share_id);
CREATE INDEX idx_repayment_events_repayment_batch_a ON public.repayment_events(repayment_id);
CREATE INDEX idx_repayment_events_user_batch_a ON public.repayment_events(user_id);
CREATE INDEX idx_repayments_reversed_by_batch_a ON public.repayments(reversed_by);
CREATE INDEX idx_transactions_related_batch_a ON public.transactions(related_transaction_id);
CREATE INDEX idx_transactions_user_batch_a ON public.transactions(user_id);
-- webhook_events already has a unique constraint on this exact key in the
-- inspected project. Reuse that key for ON CONFLICT instead of adding a second
-- equivalent unique index. Abort on a drifted base schema rather than guessing.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND tablename='webhook_events'
      AND indexdef ILIKE '%(provider, provider_event_id)%'
      AND indexdef ILIKE 'CREATE UNIQUE INDEX%'
  ) THEN
    RAISE EXCEPTION 'Expected existing unique webhook_events(provider, provider_event_id) key; inspect the live definition before applying';
  END IF;
END $$;
ALTER TABLE public.webhook_events ADD COLUMN IF NOT EXISTS processing_started_at timestamptz;
ALTER TABLE public.server_oauth_tokens ADD COLUMN IF NOT EXISTS sync_lease_until timestamptz;
REVOKE ALL ON public.webhook_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.webhook_events TO service_role;

CREATE FUNCTION public.claim_gmail_webhook_event(
  p_provider text,p_event_id text,p_event_type text,p_payload jsonb
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_claimed boolean;
BEGIN
  INSERT INTO public.webhook_events(provider,provider_event_id,event_type,processing_status,payload,processing_started_at)
    VALUES(p_provider,p_event_id,p_event_type,'processing',COALESCE(p_payload,'{}'::jsonb),now())
  ON CONFLICT(provider,provider_event_id) DO UPDATE SET processing_status='processing',
    payload=EXCLUDED.payload,error_message=NULL,processing_started_at=now()
  WHERE public.webhook_events.processing_status='failed'
    OR (public.webhook_events.processing_status IN ('received','processing')
      AND COALESCE(public.webhook_events.processing_started_at,public.webhook_events.received_at) < now()-interval '10 minutes')
  RETURNING true INTO v_claimed;
  RETURN COALESCE(v_claimed,false);
END; $$;
REVOKE ALL ON FUNCTION public.claim_gmail_webhook_event(text,text,text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_gmail_webhook_event(text,text,text,jsonb) TO service_role;

CREATE FUNCTION public.finish_gmail_webhook_event(
  p_provider text,p_event_id text,p_status text,p_error text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_status NOT IN ('processed','failed') THEN RAISE EXCEPTION 'invalid webhook status'; END IF;
  UPDATE public.webhook_events SET processing_status=p_status,error_message=p_error,
    processed_at=CASE WHEN p_status='processed' THEN now() ELSE NULL END,processing_started_at=NULL
    WHERE provider=p_provider AND provider_event_id=p_event_id AND processing_status='processing';
  IF NOT FOUND THEN RAISE EXCEPTION 'webhook claim not found'; END IF;
END; $$;
REVOKE ALL ON FUNCTION public.finish_gmail_webhook_event(text,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_gmail_webhook_event(text,text,text,text) TO service_role;

CREATE FUNCTION public.claim_gmail_sync(p_user_id uuid,p_lease_seconds integer DEFAULT 300)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_claimed boolean;
BEGIN
  UPDATE public.server_oauth_tokens SET sync_status='syncing',sync_lease_until=now()+make_interval(secs=>LEAST(GREATEST(p_lease_seconds,30),1800)),last_error=NULL
    WHERE user_id=p_user_id AND provider='gmail'
      AND (sync_status<>'syncing' OR sync_lease_until IS NULL OR sync_lease_until<now())
    RETURNING true INTO v_claimed;
  RETURN COALESCE(v_claimed,false);
END; $$;
REVOKE ALL ON FUNCTION public.claim_gmail_sync(uuid,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_gmail_sync(uuid,integer) TO service_role;
