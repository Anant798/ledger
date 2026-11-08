-- READ ONLY. Run statements individually against the intended project only
-- after approval. No statement below changes schema, settings, or data.

-- 1. Duplicates that would prevent the transaction reference unique index.
SELECT user_id, payment_provider, external_reference, count(*) AS row_count,
       array_agg(id ORDER BY id) AS transaction_ids
FROM public.transactions
WHERE payment_provider IS NOT NULL AND external_reference IS NOT NULL AND external_reference <> ''
GROUP BY user_id, payment_provider, external_reference HAVING count(*) > 1;
-- Rows returned: manually determine whether these are true duplicate imports or
-- distinct real transactions. Do not delete/merge financial records automatically.

-- 2. Duplicate webhook event keys.
SELECT provider, provider_event_id, count(*) AS row_count, array_agg(id ORDER BY id) AS event_ids
FROM public.webhook_events
GROUP BY provider, provider_event_id HAVING count(*) > 1;
-- Rows returned: inspect processing state/payloads and reconcile manually before
-- creating uq_webhook_events_provider_id.

-- 3. UUID-shaped duplicate repayment idempotency references.
SELECT user_id, expense_share_id, external_reference, count(*) AS row_count,
       array_agg(id ORDER BY id) AS repayment_ids
FROM public.repayments
WHERE external_reference ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
GROUP BY user_id, expense_share_id, external_reference HAVING count(*) > 1;
-- Rows returned: manually inspect events and balances before resolving conflicts.

-- 4. Invalid reminder timezones.
SELECT rs.user_id, rs.timezone
FROM public.reminder_settings rs
WHERE rs.timezone IS NULL OR NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_timezone_names tz WHERE tz.name = rs.timezone
);
-- Rows returned: have the user select a valid IANA zone or agree on a safe
-- account-specific correction before enabling their reminder schedule.

-- 5. Same-name objects that could be mistaken for the new objects by IF NOT EXISTS.
SELECT n.object_name, to_regclass('public.' || n.object_name) AS existing_relation
FROM (VALUES ('server_oauth_tokens'), ('processed_emails'), ('import_review_queue'),
             ('reminder_attempts')) AS n(object_name);
SELECT c.relname AS table_name, a.attname AS column_name, format_type(a.atttypid,a.atttypmod) AS data_type,
       a.attnotnull AS not_null, pg_get_expr(d.adbin,d.adrelid) AS default_expression
FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
WHERE ns.nspname='public' AND c.relname IN ('server_oauth_tokens','processed_emails','import_review_queue','reminder_attempts')
ORDER BY c.relname,a.attnum;
-- Existing relations/columns: compare every definition, constraint, index,
-- privilege and policy against the migration. Stop and write a reviewed
-- reconciliation migration if definitions differ; do not rely on IF NOT EXISTS.

-- 6. Constraint definitions targeted for replacement, plus all custom checks on
-- those columns. This is inspection only; compare exact definitions.
SELECT conrelid::regclass AS table_name, conname, contype, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid IN ('public.transactions'::regclass,'public.alerts'::regclass,'public.reminder_logs'::regclass)
  AND contype='c'
ORDER BY table_name,conname;

-- 7. Existing trigger bindings and function definitions on tables touched here.
SELECT t.tgrelid::regclass AS table_name, t.tgname, pg_get_triggerdef(t.oid,true) AS trigger_definition,
       p.oid::regprocedure AS function_signature, p.prosecdef AS security_definer,
       p.proconfig AS function_settings, pg_get_functiondef(p.oid) AS function_definition
FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
WHERE NOT t.tgisinternal AND t.tgrelid IN (
  'public.transactions'::regclass,'public.repayments'::regclass,'public.reminder_logs'::regclass
)
ORDER BY table_name,t.tgname;
-- Review same-name and behaviorally overlapping triggers/functions before
-- deployment. The migration creates new named triggers and intentionally does
-- not drop or replace any existing trigger.

-- 8. Security review for the legacy advisor findings and new public routines.
SELECT p.oid::regprocedure AS function_signature, p.prosecdef AS security_definer,
       p.proconfig AS function_settings, pg_get_functiondef(p.oid) AS function_definition,
       has_function_privilege('anon',p.oid,'EXECUTE') AS anon_can_execute,
       has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated_can_execute,
       has_function_privilege('service_role',p.oid,'EXECUTE') AS service_role_can_execute
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname IN (
  'handle_new_user','log_repayment_event','cancel_expense_reminders_for_share',
  'record_shared_expense_repayment','create_shared_expense_group','add_automated_goal_contribution',
  'add_transaction_goal_contribution','reverse_linked_goal_contributions',
  'reconcile_goal_contribution_refunds','schedule_expense_reminders','schedule_all_expense_reminders',
  'reschedule_expense_reminders','cancel_user_expense_reminders','claim_due_expense_reminders',
  'finish_expense_reminder_attempt','reconcile_expense_reminders_after_repayment_change',
  'schedule_followup_expense_reminder'
)
ORDER BY p.proname,p.oid::regprocedure::text;
-- Function ACL results show effective EXECUTE, including PUBLIC inheritance.
-- For each legacy SECURITY DEFINER routine inspect body/search_path/trigger
-- binding before deciding whether direct EXECUTE should be revoked.

SELECT t.tgrelid::regclass AS table_name, t.tgname, pg_get_triggerdef(t.oid,true) AS trigger_definition,
       t.tgfoid::regprocedure AS function_signature
FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE NOT t.tgisinternal AND n.nspname='public'
  AND p.proname IN ('handle_new_user','log_repayment_event')
ORDER BY table_name,t.tgname;
-- No rows means no table trigger binding was found; investigate callers before
-- revoking privileges or changing a function.

-- 9. Existing RLS policies and effective table ACLs (RLS is not a substitute
-- for table privileges, and advisor output is not a complete ACL report).
SELECT schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check
FROM pg_policies
WHERE schemaname='public'
  AND tablename IN ('server_oauth_tokens','webhook_events','reminder_attempts',
                    'reminder_logs','reminder_settings','transactions','repayments')
ORDER BY tablename,policyname;
SELECT c.oid::regclass AS table_name,
       has_table_privilege('anon',c.oid,'SELECT') AS anon_select,
       has_table_privilege('anon',c.oid,'INSERT') AS anon_insert,
       has_table_privilege('authenticated',c.oid,'SELECT') AS authenticated_select,
       has_table_privilege('authenticated',c.oid,'INSERT') AS authenticated_insert,
       has_table_privilege('authenticated',c.oid,'UPDATE') AS authenticated_update,
       has_table_privilege('service_role',c.oid,'SELECT') AS service_select,
       has_table_privilege('service_role',c.oid,'INSERT') AS service_insert,
       c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced,
       c.relacl AS explicit_acl
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname IN ('server_oauth_tokens','webhook_events','reminder_attempts')
ORDER BY c.relname;
-- Backend-only tables should show no anon/authenticated privileges, service_role
-- access, and RLS enabled. Unexpected grants/policies require explicit review.

-- 10. Index definitions and coverage of all existing foreign keys.
SELECT i.indrelid::regclass AS table_name, i.indexrelid::regclass AS index_name,
       pg_get_indexdef(i.indexrelid) AS definition
FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname IN ('transactions','alerts','ai_messages','goal_contributions',
  'reminder_logs','repayment_events','repayments','expense_shares','webhook_events')
ORDER BY table_name,index_name;
-- Keep indexes supporting FK checks, unique constraints, active application
-- queries and idempotency. Advisor 'unused' results alone do not prove redundancy.
