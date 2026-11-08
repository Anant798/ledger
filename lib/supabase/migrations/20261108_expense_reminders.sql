-- Additive Batch B reconciliation for the existing live schema.
-- This file is prepared for review only and must not be applied automatically.

-- Application requests already carry UUID idempotency keys. Keep the existing
-- external_reference column and protect retries without changing old rows.
CREATE UNIQUE INDEX IF NOT EXISTS uq_repayments_idempotency_reference
  ON public.repayments(user_id, expense_share_id, external_reference)
  WHERE external_reference ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

ALTER TABLE public.goal_contributions ADD COLUMN IF NOT EXISTS idempotency_key uuid;
CREATE UNIQUE INDEX IF NOT EXISTS uq_goal_contributions_automatic_idempotency
  ON public.goal_contributions(user_id, goal_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE OR REPLACE FUNCTION public.record_shared_expense_repayment(
  p_user_id uuid, p_share_id uuid, p_amount numeric, p_currency_code text,
  p_payment_method text, p_payment_provider text, p_external_reference text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_share public.expense_shares;
  v_existing public.repayments;
  v_paid numeric;
  v_remaining numeric;
  v_repayment public.repayments;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authorized');
  END IF;
  -- Lock the share to serialize competing repayments and same-key retries.
  SELECT * INTO v_share FROM public.expense_shares
    WHERE id = p_share_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM public.expense_groups WHERE id = v_share.expense_group_id AND user_id = p_user_id
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Expense share not found or access denied');
  END IF;

  IF p_external_reference IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.repayments
      WHERE user_id = p_user_id AND expense_share_id = p_share_id
        AND external_reference = p_external_reference LIMIT 1;
    IF FOUND THEN
      SELECT COALESCE(SUM(amount), 0) INTO v_paid FROM public.repayments
        WHERE expense_share_id = p_share_id AND payment_status = 'confirmed';
      RETURN jsonb_build_object('success', true, 'result', jsonb_build_object(
        'repayment', to_jsonb(v_existing), 'duplicate', true,
        'remainingBalance', greatest(0, v_share.amount_owed - v_paid)
      ));
    END IF;
  END IF;

  IF p_amount <= 0 THEN RETURN jsonb_build_object('success', false, 'error', 'Repayment amount must be positive'); END IF;
  IF p_payment_method NOT IN ('upi', 'paypal', 'cash', 'bank_transfer', 'other') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unsupported payment method');
  END IF;
  SELECT COALESCE(SUM(amount), 0) INTO v_paid FROM public.repayments
    WHERE expense_share_id = p_share_id AND payment_status = 'confirmed';
  v_remaining := greatest(0, v_share.amount_owed - v_paid);
  IF p_amount > v_remaining + 0.01 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Repayment exceeds outstanding balance');
  END IF;

  INSERT INTO public.repayments(expense_share_id, user_id, amount, currency_code, payment_method,
      payment_status, confirmation_source, payment_provider, external_reference, confirmed_at)
    VALUES(p_share_id, p_user_id, p_amount, p_currency_code, p_payment_method,
      'confirmed', 'manual', p_payment_provider, p_external_reference, now())
    RETURNING * INTO v_repayment;
  -- This insert is in the same transaction as repayment creation; failure rolls back both.
  INSERT INTO public.repayment_events(repayment_id, user_id, event_type, event_source, metadata)
    VALUES(v_repayment.id, p_user_id, 'confirmed', 'manual',
      jsonb_build_object('expense_share_id', p_share_id, 'amount', p_amount,
        'remaining_balance', greatest(0, v_remaining - p_amount)));
  RETURN jsonb_build_object('success', true, 'result', jsonb_build_object(
    'repayment', to_jsonb(v_repayment), 'remainingBalance', greatest(0, v_remaining - p_amount),
    'isShareSettled', v_paid + p_amount >= v_share.amount_owed - 0.01
  ));
END; $$;
REVOKE ALL ON FUNCTION public.record_shared_expense_repayment(uuid,uuid,numeric,text,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_shared_expense_repayment(uuid,uuid,numeric,text,text,text,text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.add_automated_goal_contribution(
  p_user_id uuid, p_goal_id uuid, p_amount numeric, p_notes text, p_idempotency_key uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_contribution public.goal_contributions;
BEGIN
  IF p_amount <= 0 OR p_idempotency_key IS NULL THEN RAISE EXCEPTION 'A positive amount and idempotency key are required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.savings_goals WHERE id = p_goal_id AND user_id = p_user_id) THEN
    RAISE EXCEPTION 'Goal not found or access denied';
  END IF;
  INSERT INTO public.goal_contributions(goal_id, user_id, amount, contribution_source,
      contribution_status, notes, contributed_at, idempotency_key)
    VALUES(p_goal_id, p_user_id, p_amount, 'automatic', 'confirmed', p_notes, now(), p_idempotency_key)
    ON CONFLICT (user_id, goal_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
    RETURNING * INTO v_contribution;
  IF NOT FOUND THEN
    SELECT * INTO v_contribution FROM public.goal_contributions
      WHERE user_id = p_user_id AND goal_id = p_goal_id AND idempotency_key = p_idempotency_key;
  END IF;
  RETURN to_jsonb(v_contribution);
END; $$;
REVOKE ALL ON FUNCTION public.add_automated_goal_contribution(uuid,uuid,numeric,text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_automated_goal_contribution(uuid,uuid,numeric,text,uuid) TO service_role;

-- Reuse reminder_logs as the queue and delivery state. scheduled_for is also
-- the retry due time; reminder_attempts stores the durable per-attempt history.
ALTER TABLE public.reminder_logs
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS reminder_sequence integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS lease_until timestamptz,
  ADD COLUMN IF NOT EXISTS last_error text;
ALTER TABLE public.reminder_settings
  ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 5;
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.reminder_logs'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%delivery_status%'
  LOOP EXECUTE format('ALTER TABLE public.reminder_logs DROP CONSTRAINT %I', c.conname); END LOOP;
  ALTER TABLE public.reminder_logs ADD CONSTRAINT reminder_logs_delivery_status_batch_b_check
    CHECK (delivery_status IN ('scheduled', 'sending', 'sent', 'delivered', 'failed', 'cancelled'));
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.reminder_logs'::regclass AND conname = 'reminder_logs_attempt_state_batch_b_check') THEN
    ALTER TABLE public.reminder_logs ADD CONSTRAINT reminder_logs_attempt_state_batch_b_check
      CHECK (attempt_count >= 0 AND max_attempts BETWEEN 1 AND 10 AND reminder_sequence >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.reminder_settings'::regclass AND conname = 'reminder_settings_max_attempts_batch_b_check') THEN
    ALTER TABLE public.reminder_settings ADD CONSTRAINT reminder_settings_max_attempts_batch_b_check
      CHECK (max_attempts BETWEEN 1 AND 10);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_reminder_logs_due_batch_b
  ON public.reminder_logs(delivery_status, scheduled_for)
  WHERE delivery_status IN ('scheduled', 'sending');

CREATE TABLE IF NOT EXISTS public.reminder_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reminder_log_id uuid NOT NULL REFERENCES public.reminder_logs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  outcome text NOT NULL CHECK (outcome IN ('started', 'sent', 'failed', 'cancelled')),
  error text,
  next_attempt_at timestamptz,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_reminder_attempt_number UNIQUE (reminder_log_id, attempt_number)
);
CREATE INDEX IF NOT EXISTS idx_reminder_attempts_user ON public.reminder_attempts(user_id, attempted_at DESC);
ALTER TABLE public.reminder_attempts ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'reminder_attempts' AND policyname = 'Users can view own reminder attempts') THEN
    CREATE POLICY "Users can view own reminder attempts" ON public.reminder_attempts
      FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.schedule_expense_reminders(p_user_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_count integer;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN RAISE EXCEPTION 'not authorized'; END IF;
  INSERT INTO public.reminder_logs(user_id, expense_share_id, scheduled_for, delivery_status,
      idempotency_key, reminder_sequence, max_attempts)
  SELECT p_user_id, sh.id,
    CASE WHEN rs.initial_message_enabled AND seq.next_sequence = 1 THEN
      CASE WHEN ((now() AT TIME ZONE rs.timezone)::date + rs.preferred_send_time) AT TIME ZONE rs.timezone > now()
        THEN ((now() AT TIME ZONE rs.timezone)::date + rs.preferred_send_time) AT TIME ZONE rs.timezone
        ELSE (((now() AT TIME ZONE rs.timezone)::date + 1) + rs.preferred_send_time) AT TIME ZONE rs.timezone END
      ELSE now() + make_interval(hours => rs.frequency_hours) END,
    'scheduled', sh.id::text || ':' || seq.next_sequence::text, seq.next_sequence, rs.max_attempts
  FROM public.expense_shares sh
  JOIN public.expense_groups eg ON eg.id = sh.expense_group_id AND eg.user_id = p_user_id
  JOIN public.reminder_settings rs ON rs.user_id = p_user_id AND rs.enabled = true
  CROSS JOIN LATERAL (SELECT COALESCE(MAX(rl.reminder_sequence), 0) + 1 AS next_sequence
    FROM public.reminder_logs rl WHERE rl.expense_share_id = sh.id) seq
  WHERE sh.user_id = p_user_id AND sh.email IS NOT NULL
    AND seq.next_sequence <= rs.max_reminders
    AND NOT EXISTS (SELECT 1 FROM public.reminder_logs active WHERE active.expense_share_id = sh.id
      AND active.delivery_status IN ('scheduled', 'sending'))
    AND (SELECT COALESCE(SUM(r.amount), 0) FROM public.repayments r
      WHERE r.expense_share_id = sh.id AND r.payment_status = 'confirmed') < sh.amount_owed - 0.01
  ON CONFLICT (idempotency_key) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END; $$;
REVOKE ALL ON FUNCTION public.schedule_expense_reminders(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.schedule_expense_reminders(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.cancel_user_expense_reminders(p_user_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_count integer;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN RAISE EXCEPTION 'not authorized'; END IF;
  UPDATE public.reminder_logs SET delivery_status = 'cancelled', lease_until = NULL
    WHERE user_id = p_user_id AND delivery_status IN ('scheduled', 'sending');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END; $$;
REVOKE ALL ON FUNCTION public.cancel_user_expense_reminders(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_user_expense_reminders(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.claim_due_expense_reminders(p_limit integer DEFAULT 25, p_lease_seconds integer DEFAULT 300)
RETURNS SETOF public.reminder_logs LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT r.id FROM public.reminder_logs r
    JOIN public.reminder_settings s ON s.user_id = r.user_id AND s.enabled = true
    WHERE r.scheduled_for <= now() AND (r.delivery_status = 'scheduled'
      OR (r.delivery_status = 'sending' AND r.lease_until < now()))
      AND r.attempt_count < r.max_attempts
    ORDER BY r.scheduled_for FOR UPDATE OF r SKIP LOCKED LIMIT LEAST(GREATEST(p_limit, 1), 100)
  )
  UPDATE public.reminder_logs r SET delivery_status = 'sending', attempt_count = r.attempt_count + 1,
    lease_until = now() + make_interval(secs => p_lease_seconds)
  FROM candidates c WHERE r.id = c.id RETURNING r.*;
END; $$;
REVOKE ALL ON FUNCTION public.claim_due_expense_reminders(integer,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_expense_reminders(integer,integer) TO service_role;

CREATE OR REPLACE FUNCTION public.reconcile_expense_reminders_after_repayment_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_share uuid; v_owed numeric; v_paid numeric;
BEGIN
  v_share := CASE WHEN TG_OP = 'DELETE' THEN OLD.expense_share_id ELSE NEW.expense_share_id END;
  SELECT amount_owed INTO v_owed FROM public.expense_shares WHERE id = v_share;
  SELECT COALESCE(SUM(amount), 0) INTO v_paid FROM public.repayments
    WHERE expense_share_id = v_share AND payment_status = 'confirmed';
  IF v_owed IS NULL OR v_paid >= v_owed - 0.01 THEN
    UPDATE public.reminder_logs SET delivery_status = 'cancelled',
      lease_until = NULL WHERE expense_share_id = v_share
      AND delivery_status IN ('scheduled', 'sending');
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END; $$;
DROP TRIGGER IF EXISTS trg_reconcile_expense_reminders_after_repayment_change ON public.repayments;
CREATE TRIGGER trg_reconcile_expense_reminders_after_repayment_change
  AFTER INSERT OR UPDATE OR DELETE ON public.repayments
  FOR EACH ROW EXECUTE FUNCTION public.reconcile_expense_reminders_after_repayment_change();

CREATE OR REPLACE FUNCTION public.schedule_followup_expense_reminder()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_share public.expense_shares; v_settings public.reminder_settings;
BEGIN
  IF NEW.delivery_status NOT IN ('sent', 'delivered') OR OLD.delivery_status IN ('sent', 'delivered') THEN RETURN NEW; END IF;
  SELECT * INTO v_share FROM public.expense_shares WHERE id = NEW.expense_share_id;
  SELECT * INTO v_settings FROM public.reminder_settings WHERE user_id = NEW.user_id AND enabled = true;
  IF v_share.id IS NULL OR v_settings.user_id IS NULL OR NEW.reminder_sequence >= v_settings.max_reminders THEN RETURN NEW; END IF;
  IF (SELECT COALESCE(SUM(amount), 0) FROM public.repayments
    WHERE expense_share_id = v_share.id AND payment_status = 'confirmed') >= v_share.amount_owed - 0.01 THEN RETURN NEW; END IF;
  INSERT INTO public.reminder_logs(user_id, expense_share_id, scheduled_for, delivery_status,
      idempotency_key, reminder_sequence, max_attempts)
    VALUES(NEW.user_id, NEW.expense_share_id,
      now() + make_interval(hours => v_settings.frequency_hours), 'scheduled',
      NEW.expense_share_id::text || ':' || (NEW.reminder_sequence + 1)::text,
      NEW.reminder_sequence + 1, v_settings.max_attempts)
    ON CONFLICT (idempotency_key) DO NOTHING;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_schedule_followup_expense_reminder ON public.reminder_logs;
CREATE TRIGGER trg_schedule_followup_expense_reminder
  AFTER UPDATE OF delivery_status ON public.reminder_logs FOR EACH ROW
  WHEN (NEW.delivery_status IN ('sent', 'delivered') AND OLD.delivery_status IS DISTINCT FROM NEW.delivery_status)
  EXECUTE FUNCTION public.schedule_followup_expense_reminder();

-- Security-advisor fixes to apply only after reviewing the live function bodies:
-- Advisor findings: handle_new_user() and log_repayment_event() are
-- SECURITY DEFINER and callable by anon/authenticated. Inspect their trigger
-- bindings and bodies, then revoke direct EXECUTE if they are trigger-only and
-- pin each search_path to trusted schemas. This connector does not expose the
-- required definitions/grants without a catalog query.
-- webhook_events has RLS enabled with no policies: keep it backend-only and
-- verify anon/authenticated table privileges are revoked.
