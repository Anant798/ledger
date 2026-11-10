# Ledger database migrations

Migrations in this directory begin with `20261107000000_ledger_foundation.sql`, which creates the local Ledger base schema. The ten following migrations apply feature upgrades in timestamp order. The foundation was reconstructed against the current app and migration dependencies; it does not load data or execute the archival `lib/supabase/schema.sql`.

## Ordered migration sequence

1. `20261107000000_ledger_foundation.sql`
2. `20261108000000_batch_a_backend_closure.sql`
3. `20261108000100_expense_reminders.sql`
4. `20261108000200_expense_groups_module.sql`
5. `20261108000300_repayments_settlements.sql`
6. `20261108000400_savings_goals_module.sql`
7. `20261108000500_transaction_management.sql`
8. `20261108000600_gmail_bank_alert_completion.sql`
9. `20261109000000_user_profile_preferences.sql`
10. `20261110000000_existing_security_hardening.sql`
11. `20261111000000_shared_expense_participant_read_access.sql`

The normal local command is `npm run supabase:local:reset`; it rebuilds **only the local** database from the migration files, in timestamp order. It never uses `--remote`. The reset was executed on a clean local database and all 11 migration versions were recorded. It does not copy any hosted financial data into local development.

`preflight.sql` is read-only and contains checks written for the live base schema. It may be useful for a compatible local snapshot, but cannot replace schema preparation. `migration-static.test.ts` checks migration order and security properties without connecting to a database.

## Local environment

See the repository's `docs/local-supabase.md` for local-only setup, start/stop/status commands, health checks, migration workflow, and TypeScript type generation. `.env.local` is ignored by git and points the app to `127.0.0.1` with generated local keys.

## Remote safety

The local `project_id` is only the Supabase CLI's local project identifier; it does not connect to the hosted project. Do not use `supabase link`, any `--remote` option, `db push`, or remote reset for local development. These instructions do not authorize modifying the hosted database.
