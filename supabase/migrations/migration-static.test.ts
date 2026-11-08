import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const directory = dirname(fileURLToPath(import.meta.url));
const batchA = await readFile(join(directory, "20261108000000_batch_a_backend_closure.sql"), "utf8");
const batchB = await readFile(join(directory, "20261108000100_expense_reminders.sql"), "utf8");
const allSql = `${batchA}\n${batchB}`;

test("migration versions are unique and ordered", () => {
  const versions = ["20261108000000", "20261108000100"];
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
  assert.equal((allSql.match(/DROP CONSTRAINT/g) ?? []).length, 3);
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
