# Batch C starting point: integration and reliability

This is a local repository audit. No live database, identity provider, Gmail, Gemini, or mail-delivery service was contacted.

## C1: integration map

| System | Flow and dependencies | Critical consistency boundary |
| --- | --- | --- |
| Authentication | Email/password and Google sign-in use Supabase Auth through the SSR client and cookie adapter. `/auth/callback` exchanges the code, reads the authenticated user, and uses an admin client with `ignoreDuplicates` to initialize a profile without replacing existing data. Protected APIs call `auth.getUser()`. | Session exchange and cookie persistence are runtime/configuration dependent. Profile trigger behavior is not defined in local ordered migrations. |
| Profiles | `profiles.id` follows the auth user. The callback only supplies metadata on insert and then verifies the profile exists. | `handle_new_user()` definition, effective grants, search path, and binding are unknown locally; inspect read-only against the project before changing. |
| Transactions | `TransactionService` scopes reads/writes by authenticated `user_id`. Create/update RPCs pair mutations with `ledger_events`; delete is a direct owner-filtered delete. | The atomicity and authorization of create/update depend on the pending Batch A RPC migration. Delete-trigger behavior depends on live foreign keys/triggers. |
| Gmail imports | Authenticated Gmail OAuth state is signed; readonly Gmail OAuth exchanges a separate code, encrypts tokens, and stores them server-side. Sync pages history/messages, claims `(user_id,message_id)`, heuristically filters, extracts/normalizes, then imports atomically or creates a review item. | `complete_gmail_import` and review RPCs are pending migration dependencies. Provider/reference uniqueness preflight must be clean. Gemini and Google API calls can fail or time out. |
| Review queue | Authenticated GET is user-filtered. Approve/reject routes call owner-aware atomic RPCs; approval creates the transaction/event and resolves the linked review/alert. | Real approval race/idempotency and actual RLS require the migration and a database-backed test. |
| Shared expenses | Authenticated service lists owner groups, computes balances from confirmed repayments, and creates groups through a SQL RPC. | Group editing is absent. The local RPC provides atomic group/share creation. Reversals/edit/delete of repayments have no application workflow; safe implementation requires confirming live status/event constraints first. |
| Repayments | RPC locks an owner share, dedupes the reference, checks remaining balance, inserts repayment and event atomically. A repayment trigger reconciles reminder cancellation. | Correct concurrency behavior requires database execution. The migration only defines confirmation; an application reversal endpoint/RPC is absent. |
| Reminders | Settings endpoint scopes by authenticated user. Existing `reminder_logs` is the queue; cron worker calls the scheduler and a lease-claim RPC, checks settlement, sends to a configured idempotent delivery endpoint, and records attempts/retries. | Cron registration/secrets and endpoint-level idempotency are external. A timeout after provider acceptance requires the delivery provider to honor the stable idempotency key. |
| Savings goals | Authenticated service filters goals by user; manual contributions use RLS, transaction-linked and automated contributions use owner-checking RPCs; progress sums confirmed rows. Transaction trigger recalculates refunds/reversals. | Automated savings policy/scheduler is not wired to a product rule. Reversal behavior is pending SQL and needs database tests. |
| Background workers | Gmail cron renews watches and runs sync; Pub/Sub webhook verifies a Google-signed OIDC token then claims a durable webhook event; reminder cron runs the worker. | Hosting schedules, secret configuration, Google Pub/Sub delivery, worker duration/concurrency and provider availability are outside local verification. |

### High-priority integration test plan

1. **Gmail import → review → approval → retry:** same provider/reference must yield one transaction and one creation event; duplicate approval must not add an event; retries after RPC/network failure must be safe.
2. **Shared expense → partial repayments → reminders → settlement:** concurrent repayment requests must serialize; confirmed events change balance; settlement cancels due and leased reminders; reversal returns the correct outstanding balance.
3. **Savings contribution → source transaction changes:** confirmed-only totals; repeated automated contribution is idempotent; full refund/reversal or source deletion reverses; partial refunds do not reverse until the agreed threshold.
4. **Cross-user isolation:** user B cannot read or mutate user A's Gmail, review, groups/shares, repayments, reminder attempts/logs, savings goals or contributions through API/RPC or direct table access.
5. **Worker failures and recovery:** delivery timeout, provider acceptance then timeout, expired lease, database lookup failure, and worker overlap all retain one provider idempotency key and a durable attempt history.
6. **Authentication lifecycle:** email signup/login, Google callback, existing-profile preservation, cookie refresh, logout, expired session, invalid state and cross-account linking.

The existing test runner can test application modules with fakes, but has no local PostgreSQL/Supabase integration harness. The new Gmail and reminder tests use actual service/worker modules; they are focused unit/integration-boundary tests, not proof of database RPC behavior. Add a disposable local Supabase test project and seeded multi-user fixtures before claiming the database workflows are end-to-end verified.

## C3: prioritized reliability backlog

### P0 — before marking backend completion

- Apply neither migration until the read-only duplicate and object/constraint preflight has been reviewed; test both migrations on a disposable database matching the inspected schema.
- Capture actual definitions, grants, `search_path`, and trigger bindings for `handle_new_user()` and `log_repayment_event()`. Current local source cannot establish their behavior or whether either is trigger-only.
- Add repayment edit/reversal behavior with the actual live allowed statuses/event sources and a single atomic RPC. Ensure reminder balances recalculate in both directions.
- Implement shared group editing with explicit semantics for participant changes after repayments/reminder history exist; do not delete financial history as a shortcut.
- Verify Google sign-in and Gmail readonly OAuth separately using real Supabase/Google credentials. Configuration checklist: enable Google provider in Supabase Auth; add the Supabase Auth callback URI shown in its provider settings to the Google OAuth client; allow the deployed app `/auth/callback` URL in Supabase redirect URLs; configure a separate Gmail OAuth client with readonly Gmail scope and `/api/integrations/gmail/callback`; set the app's client ID/secret, encryption secret and allowed deployment origin. Do not use Gmail readonly scope for sign-in.

### P1 — operational reliability

- Add retry backoff/attempt state for Gmail messages. Current failed-message selection is capped at five and has no persisted next-retry timestamp; persistent early failures can be retried on every sync and starve later failures.
- Make Gmail cron candidate selection fair and observable. It currently limits to ten records without pagination or a stable fairness cursor. Validate malformed stored watch timestamps.
- Monitor sync leases, failed imports, webhook failures, expired Gmail watches, reminder backlog/lease expiry and delivery failures; alert when cron stops running.
- Confirm the reminder delivery service deduplicates by `Idempotency-Key`; a database lease alone cannot guarantee exactly-once external delivery after an ambiguous network timeout.
- Add request IDs and redacted structured logging. Keep access/refresh tokens, OAuth codes, email content, references and error response bodies out of logs/API errors.

### P2 — performance and policy hygiene

- Review existing RLS `auth.uid()` initplan advisor findings by preserving each current `USING`/`WITH CHECK` predicate while wrapping stable auth calls; do not replace policy semantics generically.
- Validate the nine new foreign-key indexes against live definitions, then review the advisor's 18 “unused” indexes with production workload data before dropping any.
- Decide and document whether `lib/supabase/schema.sql` should eventually be removed or regenerated. It is explicitly marked archival because it conflicts with the ordered migrations.

## Current limitations

- Live schema, RLS, auth provider settings, legacy function bodies, triggers, effective privileges, cron registration, and external API delivery were not inspected during this local-only pass.
- The pending migrations have not been executed; no claim of DB-enforced correctness or live compatibility is made here.
