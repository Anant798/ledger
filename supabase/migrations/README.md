# Ledger database migrations

## Project and current state

The intended Supabase project is `xonryzgjqtphcjwlicgp` (Ledger, `eu-west-2`, PostgreSQL 17). Live inspection on 2026-11-10 found an existing Ledger schema and no recorded rows in `supabase_migrations.schema_migrations`. The live schema already contains the base transaction, profile, expense group/share, repayment/event, reminder, savings, AI, payment source, alert, and webhook tables. It contains existing user/financial data; do not treat it as a new empty database.

The live preflight checks found no duplicate transaction `(user_id, payment_provider, external_reference)` keys, no duplicate webhook event IDs, no duplicate UUID-shaped repayment references, and no invalid reminder timezones. Current counts include 2 profiles, 2 transactions, and 1 savings goal. The migrations below are additive upgrades to the existing base schema. They are not a standalone bootstrap for a blank Supabase project.

## Ordered migration sequence

1. `20261108000000_batch_a_backend_closure.sql` — Gmail ingestion, transaction audit RPCs, backend credential tables, FK indexes. Reuses the existing unique webhook key and checks it rather than creating a duplicate index.
2. `20261108000100_expense_reminders.sql` — reminder scheduling/attempt state, participant links, and transaction-linked savings idempotency.
3. `20261108000200_expense_groups_module.sql` — group lifecycle, splits and reminder integration.
4. `20261108000300_repayments_settlements.sql` — repayment idempotency, audit and reversal operations.
5. `20261108000400_savings_goals_module.sql` — contribution audit, transaction/refund links, rules and goal lifecycle.
6. `20261108000500_transaction_management.sql` — transaction categories, methods, archival and summaries.
7. `20261108000600_gmail_bank_alert_completion.sql` — incomplete Gmail review and atomic review resolution.
8. `20261109000000_user_profile_preferences.sql` — date of birth and language preference columns.
9. `20261110000000_existing_security_hardening.sql` — removes direct client RPC execution from the two verified trigger-only SECURITY DEFINER functions without replacing their bindings.
10. `20261111000000_shared_expense_participant_read_access.sql` — grants read-only group, share, repayment and repayment-event access to explicitly linked participants; mutations remain owner-only.

Run `preflight.sql` read-only before deployment. It checks duplicate keys, object collisions, replacement constraints/triggers, function ACLs, RLS policies and FK index coverage. Stop and manually reconcile any unexpected rows or definitions; never remove/merge financial records automatically. `migration-static.test.ts` checks the local order, security properties, and schema assumptions.

## Backup and execution requirements

The repository environment currently has no Supabase CLI, no `pg_dump`, no database password/access token, and no `.env` secrets. The connected Supabase integration can inspect and apply migrations, but does not expose a database backup/export operation. Therefore no migration has been run. Before applying them, create and verify a recoverable project backup/PITR restore point or a full logical dump, then run the migrations in the exact order above and confirm their versions in `supabase_migrations.schema_migrations`.

For CLI-based setup and a full logical dump, provide/configure `SUPABASE_ACCESS_TOKEN` for CLI authentication and the database password (or a direct connection URL with equivalent database credentials). Keep credentials outside source control. The local `.env.local` contains only the project's public Supabase URL and publishable key; server-side operation still requires `SUPABASE_SERVICE_ROLE_KEY`. Gmail and extraction additionally require `TOKEN_ENCRYPTION_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GEMINI_API_KEY`.

## Security and rollback

Existing financial tables have RLS enabled and owner-scoped authenticated policies. The webhook table is backend-only by application design; it has a unique `(provider, provider_event_id)` constraint and no client-facing policies. The live advisor also reports direct `EXECUTE` on `handle_new_user()` and `log_repayment_event()`; the last migration revokes those client grants only after verifying their existing trigger bindings. Their current empty search paths and schema-qualified table references are preserved. Existing `auth.uid()` policy performance findings are not changed because rewriting unrelated live policies is outside these feature migrations.

No migration drops tables, user rows, or financial rows. A few migrations replace only exact known check constraints while retaining existing allowed values. Rollback is not automatic: stop workers first; inspect newly written rows before reversing constraints or removing new columns/indexes/tables. Preserve all repayment, transaction, contribution, processed-email, webhook and reminder attempt history. The security-hardening grant revokes can be reversed by restoring direct grants, but do so only after reviewing whether any client should call those trigger routines directly.
