-- These routines are bound only to database triggers in the inspected project.
-- Keep their existing SECURITY DEFINER definitions and trigger behavior, while
-- preventing direct PostgREST RPC calls by client roles.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
      JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE NOT t.tgisinternal AND n.nspname='public' AND p.proname='handle_new_user'
      AND t.tgrelid='auth.users'::regclass
  ) THEN
    RAISE EXCEPTION 'Expected handle_new_user() to remain bound to auth.users; inspect before changing its grants';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
      JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE NOT t.tgisinternal AND n.nspname='public' AND p.proname='log_repayment_event'
      AND t.tgrelid='public.repayments'::regclass
  ) THEN
    RAISE EXCEPTION 'Expected log_repayment_event() to remain bound to public.repayments; inspect before changing its grants';
  END IF;
END $$;

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.log_repayment_event() FROM PUBLIC, anon, authenticated;
