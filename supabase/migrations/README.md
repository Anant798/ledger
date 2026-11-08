# Ledger migration readiness

## Runner and order

These files use the Supabase CLI migration convention. The ordered versions are:

1. `20261108000000_batch_a_backend_closure.sql`
2. `20261108000100_expense_reminders.sql`

The first migration creates the Gmail ingestion/review support and indexes used by the second. The second adds shared expense and savings support and extends the existing reminder queue. Before any future deployment, run the read-only statements in `preflight.sql` against the intended project and review every returned row and catalog definition. This repository has a minimal `supabase/config.toml`; link the intended project only as an explicitly approved deployment step. No migration has been run as part of this work.

## Rollback considerations

Both migrations are additive except for replacing the three specifically verified check constraints on `transactions.transaction_type`, `alerts.alert_type`, and `reminder_logs.delivery_status`. Each replacement is guarded by an exact normalized-definition check and aborts unless the expected live constraint is present exactly once. The original allowed values remain included. They do not drop tables, financial records, policies, or triggers. New unique indexes can fail if preflight detects duplicates; resolve financial records manually and never auto-delete/merge them.

There is no automatic rollback migration. Before deployment, use a database backup/PITR window. For rollback, first stop the application workers that call the new RPCs. Review dependencies and data created after deployment before reversing any columns/indexes/tables. In particular, do not drop `participant_user_id`, contribution idempotency/transaction columns, reminder attempt history, or Gmail state until the application no longer reads them and their data has been retained/exported. Removing functions/triggers disables corresponding behavior. Restoring the previous check constraints may reject values written after deployment (`reversal`, `other`, `transaction_review`, `sending`), so inspect data before any rollback. Never reverse by deleting repayment, transaction, contribution, email, or webhook rows automatically.

## Known external security work

The previous read-only advisor report found `handle_new_user()` and `log_repayment_event()` SECURITY DEFINER routines executable by `anon` and `authenticated`. Their bodies, effective ACLs, search paths and trigger bindings were not exposed by the connector. Do not alter them based solely on the advisor. Use the routine/trigger/ACL inspection statements in `preflight.sql`, then determine whether they are trigger-only and whether direct execution is required. If trigger-only, revoke direct `EXECUTE` from `PUBLIC`, `anon` and `authenticated`; pin a trusted search path after reviewing body dependencies. Trigger invocation does not require granting the caller direct execution. Also review the listed RLS initplan and FK-index advisor recommendations separately; this pair of migrations does not rewrite existing user policies or add speculative policy definitions. Leaked-password protection requires a separately approved Auth setting change.

The reported 33 auth-initplan candidates were policies on `profiles` (view/create/update), `transactions` (view/create/update), `ledger_events` (view), `alerts` (view/create/update/delete), `expense_groups` (owners manage), `expense_shares` (owners manage), `repayments` (owners view), `reminder_settings` (owners manage), `reminder_logs` (owners view), `savings_goals` (view/create/update/delete), `goal_contributions` (view/add-manual-confirmed), `ai_conversations` (view/create/update/delete), `ai_messages` (view/send), `payment_sources` (view/create/update/delete), and `repayment_events` (view). After inspecting each existing policy's `qual` and `with_check`, apply `(select auth.uid())` only where it preserves the same ownership predicate; retain both `USING` and `WITH CHECK` on updates. The reported nine unindexed foreign keys were `ai_messages(conversation_id,user_id)`, `alerts(transaction_id)`, `goal_contributions(goal_id,user_id)`, `reminder_logs(expense_share_id)`, `repayment_events(repayment_id)`, `repayment_events(user_id)`, `repayments(reversed_by)`, `transactions(related_transaction_id)`, and `transactions(user_id)`. Batch A adds a supporting index for each. The reported 18 unused indexes need workload review; the advisor itself is not sufficient evidence to drop them. The leaked-password protection finding is an Auth setting and intentionally remains unchanged.

## Compatibility caveats

The catalog inspection previously established the relevant live table names, status values, existing `reminder_logs.idempotency_key`, and absence of the new Batch A/B objects/columns. New table/function/trigger/index creation intentionally fails on same-name collisions rather than silently reusing or replacing an object. `IF NOT EXISTS` remains only for additive columns; preflight checks are required to verify any existing same-named column has the expected definition. `CREATE TRIGGER` intentionally fails on a same-name collision rather than silently replacing an unrelated trigger.
