import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const directory = dirname(fileURLToPath(import.meta.url));
const batchA = await readFile(join(directory, "20261108000000_batch_a_backend_closure.sql"), "utf8");
const batchB = await readFile(join(directory, "20261108000100_expense_reminders.sql"), "utf8");
const expenseGroups = await readFile(join(directory, "20261108000200_expense_groups_module.sql"), "utf8");
const repayments = await readFile(join(directory, "20261108000300_repayments_settlements.sql"), "utf8");
const savings = await readFile(join(directory, "20261108000400_savings_goals_module.sql"), "utf8");
const transactions = await readFile(join(directory, "20261108000500_transaction_management.sql"), "utf8");
const gmailCompletion = await readFile(join(directory, "20261108000600_gmail_bank_alert_completion.sql"), "utf8");
const allSql = `${batchA}\n${batchB}\n${expenseGroups}\n${repayments}\n${savings}\n${transactions}\n${gmailCompletion}`;

test("migration versions are unique and ordered", () => {
  const versions = ["20261108000000", "20261108000100", "20261108000200", "20261108000300", "20261108000400", "20261108000500", "20261108000600"];
  assert.equal(new Set(versions).size, versions.length);
  assert.deepEqual([...versions].sort(), versions);
});

test("backend-only credential and webhook tables revoke inherited PUBLIC access", () => {
  assert.match(batchA, /REVOKE ALL ON public\.server_oauth_tokens FROM PUBLIC, anon, authenticated;/i);
  assert.match(batchA, /GRANT ALL ON public\.server_oauth_tokens TO service_role;/i);
  assert.match(batchA, /REVOKE ALL ON public\.webhook_events FROM PUBLIC, anon, authenticated;/i);
  assert.match(batchB, /REVOKE ALL ON public\.reminder_attempts FROM PUBLIC, anon, authenticated;/i);
  assert.match(batchB, /GRANT ALL ON public\.reminder_attempts TO service_role;/i);
  assert.match(batchB, /Users can view own reminder attempts[\s\S]*?FOR SELECT TO authenticated USING \(\(SELECT auth\.uid\(\)\) = user_id\)/i);
});

test("constraint replacement is limited to expected definitions", () => {
  assert.equal((allSql.match(/DROP CONSTRAINT/g) ?? []).length, 4);
  assert.doesNotMatch(allSql, /FOR c IN SELECT conname[\s\S]{0,300}DROP CONSTRAINT/i);
  assert.match(batchA, /Expected exactly one known transactions\.transaction_type check/);
  assert.match(batchA, /Expected exactly one known alerts\.alert_type check/);
  assert.match(batchB, /Expected exactly one known reminder_logs\.delivery_status check/);
});

test("migration does not delete policies or replace existing triggers destructively", () => {
  assert.doesNotMatch(allSql, /DROP\s+POLICY/i);
  assert.doesNotMatch(allSql, /DROP\s+TRIGGER/i);
  assert.match(batchB, /CREATE TRIGGER trg_reverse_linked_goal_contributions/);
  assert.match(batchB, /CREATE TRIGGER trg_reconcile_expense_reminders_after_repayment_change/);
  assert.match(batchB, /CREATE TRIGGER trg_schedule_followup_expense_reminder/);
});

test("reminder scheduling validates timezones and uses preferences with idempotency", () => {
  assert.match(batchB, /pg_timezone_names WHERE name = p_timezone/);
  assert.match(batchB, /initial_message_enabled/);
  assert.match(batchB, /preferred_send_time/);
  assert.match(batchB, /frequency_hours/);
  assert.match(batchB, /ON CONFLICT \(idempotency_key\) DO NOTHING/);
  assert.match(batchB, /lease_until < now\(\)/);
  assert.match(batchB, /cancel_expense_reminders_for_share\(uuid\) FROM PUBLIC, anon, authenticated/);
  assert.match(batchB, /outcome='cancelled', error='Share settled'/);
  assert.match(batchB, /outcome='cancelled', error='Reminders disabled by user'/);
});

test("Gmail approval dedupe is scoped by user, provider and reference", () => {
  const approval = batchA.slice(batchA.indexOf("CREATE FUNCTION public.approve_review_queue_item"), batchA.indexOf("CREATE FUNCTION public.reject_review_queue_item"));
  assert.match(approval, /user_id=p_user_id[\s\S]*payment_provider=COALESCE\(p_payment_provider, v_review\.payment_provider\)[\s\S]*external_reference=v_review\.external_reference/);
  assert.match(approval, /ON CONFLICT \(user_id,payment_provider,external_reference\)/);
});

test("all definer functions pin search_path and include an explicit revoke", () => {
  const blocks = allSql.split(/(?=CREATE OR REPLACE FUNCTION public\.|CREATE FUNCTION public\.)/i).filter((part) => /SECURITY DEFINER/i.test(part.slice(0, 700)));
  assert.ok(blocks.length >= 15, `expected substantial SECURITY DEFINER coverage, found ${blocks.length}`);
  for (const block of blocks) {
    const head = block.slice(0, 700);
    assert.match(head, /SET search_path\s*=\s*pg_catalog, public, pg_temp/i);
    const signature = head.match(/FUNCTION\s+public\.([a-z0-9_]+)\s*\(([^)]*)\)/i);
    assert.ok(signature, "SECURITY DEFINER function signature should be found");
    const revoke = new RegExp(`REVOKE ALL ON FUNCTION public\\.${signature[1]}\\(`, "i");
    assert.match(allSql, revoke, `missing explicit EXECUTE revoke for ${signature[1]}`);
  }
});

test("linked savings contributions recalculate on refunds and reversals", () => {
  assert.match(batchB, /transaction_type IN \('refund','reversal'\) AND status='completed'/);
  assert.match(batchB, /v_refunded >= gc\.amount THEN 'reversed'/);
  assert.match(batchB, /ON DELETE SET NULL/);
  assert.match(batchB, /v_source_status IN \('failed','cancelled','refunded'\)/);
});

test("expense group lifecycle migration preserves payment history and scopes mutations", () => {
  assert.match(expenseGroups, /ADD COLUMN IF NOT EXISTS archived_at timestamptz/i);
  assert.match(expenseGroups, /ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true/i);
  assert.match(expenseGroups, /CREATE OR REPLACE FUNCTION public\.create_shared_expense_group/i);
  assert.match(expenseGroups, /Invalid participant share/i);
  assert.match(expenseGroups, /WHERE id=p_group_id AND user_id=p_user_id FOR UPDATE/i);
  assert.match(expenseGroups, /Expense amount, currency, transaction and participant set are locked after repayments exist/i);
  assert.match(expenseGroups, /is_active=false/i);
  assert.match(expenseGroups, /delivery_status='cancelled'/i);
  assert.doesNotMatch(expenseGroups, /DELETE\s+FROM\s+public\.(expense_groups|expense_shares|repayments)/i);
  assert.match(expenseGroups, /g\.archived_at IS NULL/i);
  assert.match(expenseGroups, /s\.is_active=true/i);
  assert.match(expenseGroups, /REVOKE ALL ON FUNCTION public\.set_expense_group_archived\(uuid,uuid,boolean\) FROM PUBLIC,anon/i);
});

test("repayment settlement migration uses known states, atomic audit, and idempotent RPCs", () => {
  assert.match(repayments, /payment_status='reversed'/);
  assert.match(repayments, /reversed_by=p_user_id/);
  assert.match(repayments, /event_type IN \('created','confirmed','reversed','updated'\)/);
  assert.match(repayments, /idempotency_key uuid/);
  assert.match(repayments, /uq_repayment_events_user_idempotency/);
  assert.match(repayments, /p_idempotency_key IS NULL/);
  assert.match(repayments, /uq_repayments_user_share_idempotency/);
  assert.match(repayments, /FOR UPDATE/);
  assert.match(repayments, /INSERT INTO public\.alerts/);
  assert.match(repayments, /schedule_expense_reminders\(p_user_id\)/);
  assert.match(repayments, /CREATE FUNCTION public\.update_shared_expense_repayment/);
  assert.match(repayments, /CREATE FUNCTION public\.reverse_shared_expense_repayment/);
  assert.doesNotMatch(repayments, /DELETE\s+FROM\s+public\.(repayments|repayment_events)/i);
});

test("savings module keeps audit history, schedules recurring rules, and scopes writes", () => {
  assert.match(savings, /ADD COLUMN IF NOT EXISTS deleted_at timestamptz/i);
  assert.match(savings, /CREATE TABLE IF NOT EXISTS public\.savings_contribution_events/i);
  assert.match(savings, /CREATE TABLE IF NOT EXISTS public\.savings_goal_rules/i);
  assert.match(savings, /FOR UPDATE SKIP LOCKED/i);
  assert.match(savings, /IF auth\.uid\(\) IS DISTINCT FROM p_user_id THEN RAISE EXCEPTION 'not authorized'/i);
  assert.match(savings, /manually_reversed_at IS NULL/i);
  assert.match(savings, /greatest\(COALESCE\(gc\.source_amount,gc\.amount\)-v_refunded,0\)/i);
  assert.match(savings, /REVOKE ALL ON FUNCTION public\.run_due_savings_goal_rules\(integer\) FROM PUBLIC,anon,authenticated/i);
  assert.match(savings, /GRANT EXECUTE ON FUNCTION public\.run_due_savings_goal_rules\(integer\) TO service_role/i);
  assert.match(savings, /Savings goal completed/i);
  assert.doesNotMatch(savings, /DELETE\s+FROM\s+public\.(savings_goals|goal_contributions)/i);
});

test("transaction management adds fields safely, scopes RPCs, and preserves history on archive", () => {
  assert.match(transactions, /ADD COLUMN IF NOT EXISTS category text/i);
  assert.match(transactions, /ADD COLUMN IF NOT EXISTS payment_method text/i);
  assert.match(transactions, /CREATE OR REPLACE FUNCTION public\.archive_transaction_with_event/i);
  assert.match(transactions, /SET deleted_at=now\(\),status='cancelled'/i);
  assert.match(transactions, /Transaction archived/i);
  assert.match(transactions, /CREATE OR REPLACE FUNCTION public\.get_transaction_summary/i);
  assert.match(transactions, /auth\.uid\(\) IS NOT NULL AND auth\.uid\(\) IS DISTINCT FROM p_user_id/i);
  assert.match(transactions, /GROUP BY currency_code/i);
  assert.match(transactions, /status NOT IN \('pending','failed','cancelled'\)/i);
  assert.doesNotMatch(transactions, /DELETE\s+FROM\s+public\.transactions/i);
});

test("Gmail review migration retains incomplete alerts and resolves them through atomic owner-scoped RPCs", () => {
  assert.match(gmailCompletion, /ALTER COLUMN direction DROP NOT NULL/i);
  assert.match(gmailCompletion, /ALTER COLUMN amount DROP NOT NULL/i);
  assert.match(gmailCompletion, /CREATE OR REPLACE FUNCTION public\.complete_gmail_review/i);
  assert.match(gmailCompletion, /ON CONFLICT \(user_id,email_message_id\)[\s\S]*?DO NOTHING/i);
  assert.match(gmailCompletion, /CREATE OR REPLACE FUNCTION public\.resolve_gmail_import_review/i);
  assert.match(gmailCompletion, /auth\.uid\(\) <> p_user_id/i);
  assert.match(gmailCompletion, /FOR UPDATE/i);
  assert.match(gmailCompletion, /public\.approve_review_queue_item/i);
  assert.match(gmailCompletion, /GRANT EXECUTE ON FUNCTION public\.resolve_gmail_import_review\(uuid,uuid,text,jsonb\) TO authenticated, service_role/i);
  assert.match(gmailCompletion, /INSERT INTO public\.transactions[\s\S]*?occurred_at,category/i);
  assert.match(gmailCompletion, /INSERT INTO public\.ledger_events/i);
});
