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
    watch_expiration TIMESTAMPTZ,
    last_synced_at TIMESTAMPTZ,
    sync_status TEXT DEFAULT 'idle' CHECK (sync_status IN ('idle', 'syncing', 'error')),
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_server_oauth_user_provider UNIQUE (user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_server_oauth_user_id ON public.server_oauth_tokens(user_id);

-- Enable RLS and DO NOT add permissive policies for authenticated/anon.
-- By default in Supabase, when RLS is enabled with no policies, ALL access is denied to clients,
-- while service_role (bypassing RLS) retains full backend access.
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

-- Read-only policy for authenticated user
CREATE POLICY "Users can view their own processed email logs"
    ON public.processed_emails FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

-- 3. IMPORT REVIEW QUEUE (Preserves transactions table status values)
-- Keeps existing transactions.status unpolluted.
-- Pending/uncertain imports sit here until user approves or rejects them.
CREATE TABLE IF NOT EXISTS public.import_review_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    email_message_id TEXT REFERENCES public.processed_emails(message_id) ON DELETE SET NULL,
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
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
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

-- 4. SAFE ADDITIONS TO transactions TABLE (Optional / Non-breaking)
-- Adds bank_name if you want to store bank alongside payment_provider without overloading
DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'bank_name') THEN
        ALTER TABLE public.transactions ADD COLUMN bank_name TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'account_last4') THEN
        ALTER TABLE public.transactions ADD COLUMN account_last4 TEXT;
    END IF;
END $$;
