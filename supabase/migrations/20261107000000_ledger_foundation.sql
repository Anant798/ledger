-- Foundational Ledger schema reconstructed from current application usage and
-- the ordered feature migrations. The archival lib/supabase/schema.sql is not
-- executed: it contains only an obsolete Gmail snapshot.

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text,
  full_name text,
  avatar_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  transaction_type text NOT NULL DEFAULT 'payment',
  direction text NOT NULL CHECK (direction IN ('debit','credit')),
  amount numeric NOT NULL CHECK (amount <> 0),
  currency_code text NOT NULL DEFAULT 'INR',
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('pending','completed','failed','cancelled','partially_refunded','refunded')),
  description text,
  merchant_name text,
  payment_provider text,
  external_reference text,
  related_transaction_id uuid REFERENCES public.transactions(id) ON DELETE SET NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transactions_type_check CHECK (transaction_type IN ('payment','refund','shared_expense','repayment','manual'))
);
CREATE INDEX idx_transactions_user_occurred ON public.transactions(user_id, occurred_at DESC);

CREATE TABLE public.ledger_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL REFERENCES public.transactions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  event_source text NOT NULL DEFAULT 'manual',
  description text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  external_event_id text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ledger_events_transaction ON public.ledger_events(transaction_id, created_at);

CREATE TABLE public.alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  transaction_id uuid REFERENCES public.transactions(id) ON DELETE SET NULL,
  alert_type text NOT NULL DEFAULT 'general' CHECK (alert_type IN ('payment_pending','refund_pending','repayment_due','goal_milestone','general')),
  title text NOT NULL,
  message text NOT NULL,
  is_read boolean NOT NULL DEFAULT false,
  is_resolved boolean NOT NULL DEFAULT false,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_alerts_user_created ON public.alerts(user_id, created_at DESC);

CREATE TABLE public.expense_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  transaction_id uuid REFERENCES public.transactions(id) ON DELETE SET NULL,
  title text NOT NULL,
  total_amount numeric NOT NULL CHECK (total_amount > 0),
  currency_code text NOT NULL DEFAULT 'INR',
  split_method text NOT NULL DEFAULT 'equal' CHECK (split_method IN ('equal','custom')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_expense_groups_user_created ON public.expense_groups(user_id, created_at DESC);

CREATE TABLE public.expense_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_group_id uuid NOT NULL REFERENCES public.expense_groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  participant_type text NOT NULL DEFAULT 'contact' CHECK (participant_type IN ('owner','contact')),
  participant_name text NOT NULL,
  email text,
  phone_number text,
  amount_owed numeric NOT NULL CHECK (amount_owed >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_expense_shares_group ON public.expense_shares(expense_group_id);
CREATE INDEX idx_expense_shares_user ON public.expense_shares(user_id);

CREATE TABLE public.repayments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_share_id uuid NOT NULL REFERENCES public.expense_shares(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount numeric NOT NULL CHECK (amount > 0),
  currency_code text NOT NULL DEFAULT 'INR',
  payment_method text,
  confirmation_source text,
  payment_provider text,
  payment_status text NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending','confirmed','reversed')),
  external_reference text,
  confirmed_at timestamptz,
  reversed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reversed_at timestamptz,
  reversal_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_repayments_share ON public.repayments(expense_share_id);
CREATE INDEX idx_repayments_user ON public.repayments(user_id);

CREATE TABLE public.repayment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repayment_id uuid NOT NULL REFERENCES public.repayments(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('created','confirmed','reversed')),
  event_source text NOT NULL DEFAULT 'manual',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_repayment_events_repayment ON public.repayment_events(repayment_id);

CREATE TABLE public.reminder_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  timezone text NOT NULL DEFAULT 'UTC',
  preferred_send_time time NOT NULL DEFAULT '09:00',
  frequency_hours integer NOT NULL DEFAULT 24 CHECK (frequency_hours > 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.reminder_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expense_share_id uuid NOT NULL REFERENCES public.expense_shares(id) ON DELETE CASCADE,
  scheduled_for timestamptz NOT NULL,
  delivery_status text NOT NULL DEFAULT 'scheduled' CHECK (delivery_status IN ('scheduled','sent','delivered','failed','cancelled')),
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  reminder_sequence integer NOT NULL DEFAULT 1,
  idempotency_key text NOT NULL UNIQUE,
  lease_until timestamptz,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_reminder_logs_user_created ON public.reminder_logs(user_id, created_at DESC);

CREATE TABLE public.savings_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  target_amount numeric NOT NULL CHECK (target_amount > 0),
  current_amount numeric NOT NULL DEFAULT 0,
  currency_code text NOT NULL DEFAULT 'INR',
  status text NOT NULL DEFAULT 'active',
  target_date date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_savings_goals_user_created ON public.savings_goals(user_id, created_at DESC);
CREATE TABLE public.goal_contributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id uuid NOT NULL REFERENCES public.savings_goals(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount numeric NOT NULL CHECK (amount > 0),
  contribution_source text NOT NULL DEFAULT 'manual',
  contribution_status text NOT NULL DEFAULT 'completed',
  notes text,
  contributed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_goal_contributions_goal ON public.goal_contributions(goal_id, created_at DESC);

CREATE TABLE public.ai_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_conversations_user ON public.ai_conversations(user_id, updated_at DESC);
CREATE TABLE public.ai_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.ai_conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user','assistant')),
  content text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_messages_conversation_created ON public.ai_messages(conversation_id, created_at);

CREATE TABLE public.webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  processing_status text NOT NULL DEFAULT 'received' CHECK (processing_status IN ('received','processing','processed','failed')),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  error_message text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_webhook_events_provider_event UNIQUE(provider, provider_event_id)
);

CREATE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  INSERT INTO public.profiles(id,email,full_name,avatar_url)
  VALUES (NEW.id, NEW.email, NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'avatar_url')
  ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email,
    full_name=COALESCE(public.profiles.full_name, EXCLUDED.full_name),
    avatar_url=COALESCE(public.profiles.avatar_url, EXCLUDED.avatar_url);
  RETURN NEW;
END; $$;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

CREATE FUNCTION public.log_repayment_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.payment_status IS DISTINCT FROM OLD.payment_status THEN
    INSERT INTO public.repayment_events(repayment_id,user_id,event_type,event_source,metadata)
    VALUES(NEW.id,NEW.user_id,CASE WHEN NEW.payment_status='reversed' THEN 'reversed' ELSE 'confirmed' END,
      'system',jsonb_build_object('from',OLD.payment_status,'to',NEW.payment_status));
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER trg_log_repayment_event AFTER UPDATE OF payment_status ON public.repayments
FOR EACH ROW EXECUTE FUNCTION public.log_repayment_event();

-- Owner-scoped policies for application tables. Backend-only tables are locked
-- down explicitly; later feature migrations add their own policy details.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['profiles','transactions','ledger_events','alerts','expense_groups','expense_shares','repayments','repayment_events','reminder_settings','reminder_logs','savings_goals','goal_contributions','ai_conversations','ai_messages'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    IF t='profiles' THEN
      EXECUTE 'CREATE POLICY profiles_owner_all ON public.profiles FOR ALL TO authenticated USING (id = (SELECT auth.uid())) WITH CHECK (id = (SELECT auth.uid()))';
    ELSE
      EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()))', t || '_owner_all', t);
    END IF;
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END $$;
ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.webhook_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.webhook_events TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;

