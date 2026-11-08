-- Additive reminder queue. Do not run automatically; review and apply separately.
CREATE TABLE IF NOT EXISTS public.expense_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expense_share_id uuid NOT NULL REFERENCES public.expense_shares(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','sending','sent','cancelled','failed')),
  next_attempt_at timestamptz,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
  reminder_sequence integer NOT NULL DEFAULT 1 CHECK (reminder_sequence >= 1),
  last_error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_expense_reminders_share_sequence UNIQUE (expense_share_id, reminder_sequence)
);
CREATE INDEX IF NOT EXISTS idx_expense_reminders_due ON public.expense_reminders(status, next_attempt_at) WHERE status IN ('scheduled','sending');
ALTER TABLE public.expense_reminders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own expense reminders" ON public.expense_reminders FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.expense_reminder_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reminder_id uuid NOT NULL REFERENCES public.expense_reminders(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('sent','failed','cancelled')),
  error text,
  next_attempt_at timestamptz,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_expense_reminder_attempt UNIQUE (reminder_id, attempt_number)
);
CREATE INDEX IF NOT EXISTS idx_expense_reminder_attempts_user ON public.expense_reminder_attempts(user_id, attempted_at DESC);
ALTER TABLE public.expense_reminder_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own expense reminder attempts" ON public.expense_reminder_attempts FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.schedule_expense_reminders(p_user_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count integer;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN RAISE EXCEPTION 'not authorized'; END IF;
  INSERT INTO public.expense_reminders(user_id, expense_share_id, next_attempt_at, max_attempts)
  SELECT p_user_id, sh.id, now() + make_interval(hours => COALESCE(rs.frequency_hours,168)), COALESCE(rs.max_attempts,5)
  FROM public.expense_shares sh JOIN public.expense_groups eg ON eg.id=sh.expense_group_id AND eg.user_id=p_user_id
  JOIN public.reminder_settings rs ON rs.user_id=p_user_id AND rs.enabled=true
  WHERE sh.user_id=p_user_id AND sh.email IS NOT NULL
    AND (SELECT COALESCE(SUM(r.amount),0) FROM public.repayments r WHERE r.expense_share_id=sh.id AND r.payment_status='confirmed') < sh.amount_owed - 0.01
    AND NOT EXISTS (SELECT 1 FROM public.expense_reminders er WHERE er.expense_share_id=sh.id AND er.status IN ('scheduled','sending'))
    AND (SELECT COALESCE(MAX(er.reminder_sequence),0) FROM public.expense_reminders er WHERE er.expense_share_id=sh.id) < rs.max_reminders
  ON CONFLICT (expense_share_id, reminder_sequence) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END; $$;
REVOKE ALL ON FUNCTION public.schedule_expense_reminders(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.schedule_expense_reminders(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.claim_due_expense_reminders(p_limit integer DEFAULT 25, p_lease_seconds integer DEFAULT 300)
RETURNS SETOF public.expense_reminders LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT r.id FROM public.expense_reminders r
    JOIN public.reminder_settings s ON s.user_id = r.user_id AND s.enabled = true
    WHERE r.next_attempt_at <= now() AND (r.status = 'scheduled' OR (r.status = 'sending' AND r.lease_until < now()))
      AND r.attempts < r.max_attempts
    ORDER BY r.next_attempt_at FOR UPDATE OF r SKIP LOCKED LIMIT LEAST(GREATEST(p_limit,1),100)
  )
  UPDATE public.expense_reminders r SET status='sending', attempts=r.attempts+1,
    lease_until=now() + make_interval(secs => p_lease_seconds), updated_at=now()
  FROM candidates c WHERE r.id=c.id RETURNING r.*;
END; $$;
REVOKE ALL ON FUNCTION public.claim_due_expense_reminders(integer,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_expense_reminders(integer,integer) TO service_role;

CREATE OR REPLACE FUNCTION public.cancel_settled_expense_reminders()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.expense_reminders r SET status='cancelled', next_attempt_at=NULL, lease_until=NULL, updated_at=now()
  WHERE r.expense_share_id=NEW.expense_share_id AND r.status IN ('scheduled','sending')
    AND (SELECT COALESCE(SUM(p.amount),0) FROM public.repayments p WHERE p.expense_share_id=NEW.expense_share_id AND p.payment_status='confirmed')
      >= (SELECT s.amount_owed - 0.01 FROM public.expense_shares s WHERE s.id=NEW.expense_share_id);
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_cancel_settled_expense_reminders ON public.repayments;
CREATE TRIGGER trg_cancel_settled_expense_reminders AFTER INSERT OR UPDATE OF payment_status, amount ON public.repayments FOR EACH ROW EXECUTE FUNCTION public.cancel_settled_expense_reminders();

CREATE OR REPLACE FUNCTION public.schedule_followup_expense_reminder()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_share public.expense_shares; v_settings public.reminder_settings; v_next integer;
BEGIN
  IF NEW.status <> 'sent' THEN RETURN NEW; END IF;
  SELECT * INTO v_share FROM public.expense_shares WHERE id=NEW.expense_share_id;
  SELECT * INTO v_settings FROM public.reminder_settings WHERE user_id=NEW.user_id AND enabled=true;
  IF v_share.id IS NULL OR v_settings.user_id IS NULL OR NEW.reminder_sequence >= v_settings.max_reminders THEN RETURN NEW; END IF;
  IF (SELECT COALESCE(SUM(amount),0) FROM public.repayments WHERE expense_share_id=v_share.id AND payment_status='confirmed') >= v_share.amount_owed - 0.01 THEN RETURN NEW; END IF;
  v_next := NEW.reminder_sequence + 1;
  INSERT INTO public.expense_reminders(user_id,expense_share_id,reminder_sequence,next_attempt_at,max_attempts)
  VALUES(NEW.user_id,NEW.expense_share_id,v_next,now()+make_interval(hours=>v_settings.frequency_hours),v_settings.max_attempts)
  ON CONFLICT (expense_share_id,reminder_sequence) DO NOTHING;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_schedule_followup_expense_reminder ON public.expense_reminders;
CREATE TRIGGER trg_schedule_followup_expense_reminder AFTER UPDATE OF status ON public.expense_reminders FOR EACH ROW WHEN (NEW.status='sent' AND OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION public.schedule_followup_expense_reminder();
