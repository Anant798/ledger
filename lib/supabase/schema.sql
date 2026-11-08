-- ============================================================================
-- LEDGER DATABASE SCHEMA: ADDITIVE MIGRATION ONLY
-- Preserves all 16 existing tables, relationships, and RLS policies.
-- Do NOT execute directly on production without review.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. SECURE SERVER-ONLY GMAIL TOKENS & INTEGRATIONS TABLE
-- Client roles (authenticated, anon) have ZERO access.
-- Only accessible via service_role (Admin client) on backend.
CREATE TABLE IF NOT EXISTS public.server_oauth_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('gmail')),
    email_address TEXT,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    token_expiry TIMESTAMPTZ,
    scope TEXT,
    history_id TEXT,
    next_page_token TEXT,
    history_page_token TEXT,
    initial_sync_completed BOOLEAN NOT NULL DEFAULT false,
    watch_expiration TIMESTAMPTZ,
    last_synced_at TIMESTAMPTZ,
    sync_status TEXT DEFAULT 'idle' CHECK (sync_status IN ('idle', 'syncing', 'error')),
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_server_oauth_user_provider UNIQUE (user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_server_oauth_user_id ON public.server_oauth_tokens(user_id);

ALTER TABLE public.server_oauth_tokens ENABLE ROW LEVEL SECURITY;

-- 2. BACKEND-CONTROLLED PROCESSED EMAILS TABLE (Deduplication & Ingestion Audit)
-- Authenticated users can only SELECT (read-only audit); they CANNOT INSERT, UPDATE or DELETE.
-- Ingestion inserts are handled strictly via service_role backend client.
CREATE TABLE IF NOT EXISTS public.processed_emails (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    history_id TEXT,
    internal_date TIMESTAMPTZ,
    sender TEXT,
    subject TEXT,
    status TEXT NOT NULL CHECK (status IN ('parsed', 'ignored_not_transaction', 'uncertain_queued', 'failed')),
    transaction_id UUID REFERENCES public.transactions(id) ON DELETE SET NULL,
    uncertain_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_processed_emails_user_msg UNIQUE (user_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_processed_emails_user_msg ON public.processed_emails(user_id, message_id);

ALTER TABLE public.processed_emails ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own processed email logs"
    ON public.processed_emails FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

-- 3. IMPORT REVIEW QUEUE (Preserves transactions table status values)
-- Composite foreign key references (user_id, message_id) in processed_emails.
-- ON DELETE CASCADE ensures user_id is never set to NULL.
CREATE TABLE IF NOT EXISTS public.import_review_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    email_message_id TEXT,
    direction TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
    amount NUMERIC NOT NULL CHECK (amount > 0),
    currency_code TEXT NOT NULL DEFAULT 'INR',
    transaction_type TEXT NOT NULL DEFAULT 'payment',
    description TEXT,
    merchant_name TEXT,
    bank_name TEXT,
    payment_provider TEXT,
    account_last4 TEXT,
    external_reference TEXT,
    upi_id TEXT,
    confidence NUMERIC(3, 2),
    uncertain_reason TEXT,
    raw_snippet TEXT,
    review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'approved', 'rejected')),
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ,
    created_transaction_id UUID REFERENCES public.transactions(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fk_import_review_processed_email FOREIGN KEY (user_id, email_message_id) 
        REFERENCES public.processed_emails(user_id, message_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_import_review_user ON public.import_review_queue(user_id, review_status);

ALTER TABLE public.import_review_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own review queue"
    ON public.import_review_queue FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

CREATE POLICY "Users can update review items"
    ON public.import_review_queue FOR UPDATE
    TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- 4. ATOMIC REVIEW APPROVAL RPC (Supabase Stored Procedure)
-- SECURITY DEFINER with fixed search_path and strict caller verification (auth.uid() = p_user_id)
-- Atomically claims the pending review item with FOR UPDATE,
-- inserts the confirmed transaction and ledger_events,
-- updates processed_emails, resolves alerts, and marks the review item approved.
CREATE OR REPLACE FUNCTION public.approve_review_queue_item(
    p_user_id UUID,
    p_review_id UUID,
    p_amount NUMERIC DEFAULT NULL,
    p_direction TEXT DEFAULT NULL,
    p_merchant_name TEXT DEFAULT NULL,
    p_bank_name TEXT DEFAULT NULL,
    p_payment_provider TEXT DEFAULT NULL,
    p_description TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller_id UUID;
    v_review_item RECORD;
    v_new_transaction RECORD;
    v_final_amount NUMERIC;
    v_final_direction TEXT;
    v_final_merchant TEXT;
    v_final_bank TEXT;
    v_final_provider TEXT;
    v_final_desc TEXT;
    v_existing_txn_id UUID;
BEGIN
    -- 1. Security Check: Enforce caller ownership when called from authenticated context
    v_caller_id := auth.uid();
    IF v_caller_id IS NOT NULL AND v_caller_id != p_user_id THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Forbidden: Caller does not own this resource',
            'status', 403
        );
    END IF;

    -- 2. Atomically lock and retrieve the review item
    SELECT * INTO v_review_item
    FROM public.import_review_queue
    WHERE id = p_review_id AND user_id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Review item not found',
            'status', 404
        );
    END IF;

    -- 3. Idempotency Check
    IF v_review_item.review_status != 'pending' THEN
        RETURN jsonb_build_object(
            'success', false, 
            'error', 'Review item has already been ' || v_review_item.review_status,
            'review_status', v_review_item.review_status,
            'transaction_id', v_review_item.created_transaction_id,
            'status', 409
        );
    END IF;

    -- 4. Check for existing transaction if external_reference is present (Duplicate-transaction branch)
    IF v_review_item.external_reference IS NOT NULL THEN
        SELECT id INTO v_existing_txn_id
        FROM public.transactions
        WHERE user_id = p_user_id 
          AND external_reference = v_review_item.external_reference
        LIMIT 1;

        IF v_existing_txn_id IS NOT NULL THEN
            -- Mark review item approved with existing transaction ID
            UPDATE public.import_review_queue
            SET review_status = 'approved',
                created_transaction_id = v_existing_txn_id,
                resolved_at = now(),
                updated_at = now()
            WHERE id = p_review_id;

            -- Also update processed_emails if email_message_id is present
            IF v_review_item.email_message_id IS NOT NULL THEN
                UPDATE public.processed_emails
                SET status = 'parsed',
                    transaction_id = v_existing_txn_id
                WHERE user_id = p_user_id AND message_id = v_review_item.email_message_id;
            END IF;

            -- Also resolve corresponding alert
            UPDATE public.alerts
            SET is_resolved = true,
                resolved_at = now()
            WHERE user_id = p_user_id
              AND alert_type = 'transaction_review'
              AND message LIKE '%' || v_review_item.amount || '%';

            RETURN jsonb_build_object(
                'success', true,
                'message', 'Transaction already exists with this reference. Review marked as approved.',
                'transaction_id', v_existing_txn_id
            );
        END IF;
    END IF;

    -- 5. Apply user corrections or fallback to original values
    v_final_amount := COALESCE(p_amount, v_review_item.amount);
    v_final_direction := COALESCE(p_direction, v_review_item.direction);
    v_final_merchant := COALESCE(p_merchant_name, v_review_item.merchant_name);
    v_final_bank := COALESCE(p_bank_name, v_review_item.bank_name);
    v_final_provider := COALESCE(p_payment_provider, v_review_item.payment_provider);
    v_final_desc := COALESCE(p_description, v_review_item.description);

    -- 6. Insert new confirmed transaction
    INSERT INTO public.transactions (
        user_id,
        transaction_type,
        direction,
        amount,
        currency_code,
        status,
        description,
        merchant_name,
        bank_name,
        payment_provider,
        account_last4,
        external_reference,
        occurred_at
    ) VALUES (
        p_user_id,
        COALESCE(v_review_item.transaction_type, 'payment'),
        v_final_direction,
        v_final_amount,
        COALESCE(v_review_item.currency_code, 'INR'),
        'completed',
        v_final_desc,
        v_final_merchant,
        v_final_bank,
        v_final_provider,
        v_review_item.account_last4,
        v_review_item.external_reference,
        v_review_item.occurred_at
    )
    RETURNING * INTO v_new_transaction;

    -- 7. Insert audit event into ledger_events
    INSERT INTO public.ledger_events (
        transaction_id,
        user_id,
        event_type,
        event_source,
        description,
        metadata,
        occurred_at
    ) VALUES (
        v_new_transaction.id,
        p_user_id,
        'review_queue_approved',
        'manual',
        'Transaction approved from review queue item ' || p_review_id,
        jsonb_build_object(
            'review_id', p_review_id,
            'original_confidence', v_review_item.confidence,
            'email_message_id', v_review_item.email_message_id
        ),
        now()
    );

    -- 8. Update import_review_queue item to approved
    UPDATE public.import_review_queue
    SET review_status = 'approved',
        created_transaction_id = v_new_transaction.id,
        resolved_at = now(),
        updated_at = now()
    WHERE id = p_review_id;

    -- 9. Update processed_emails with new transaction_id
    IF v_review_item.email_message_id IS NOT NULL THEN
        UPDATE public.processed_emails
        SET status = 'parsed',
            transaction_id = v_new_transaction.id
        WHERE user_id = p_user_id AND message_id = v_review_item.email_message_id;
    END IF;

    -- 10. Resolve any corresponding alerts
    UPDATE public.alerts
    SET is_resolved = true,
        resolved_at = now()
    WHERE user_id = p_user_id
      AND alert_type = 'transaction_review'
      AND message LIKE '%' || v_review_item.amount || '%';

    RETURN jsonb_build_object(
        'success', true,
        'message', 'Transaction approved and confirmed',
        'transaction', to_jsonb(v_new_transaction)
    );
END;
$$;

-- Restrict execute permissions appropriately: only authenticated users & service role
REVOKE ALL ON FUNCTION public.approve_review_queue_item(UUID, UUID, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.approve_review_queue_item(UUID, UUID, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.approve_review_queue_item(UUID, UUID, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_review_queue_item(UUID, UUID, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;

-- 5. SAFE ADDITIONS TO transactions TABLE (Optional / Non-breaking)
DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'bank_name') THEN
        ALTER TABLE public.transactions ADD COLUMN bank_name TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'account_last4') THEN
        ALTER TABLE public.transactions ADD COLUMN account_last4 TEXT;
    END IF;
END $$;
