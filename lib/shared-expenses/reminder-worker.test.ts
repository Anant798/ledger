import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runReminderWorker } from "./reminder-worker.ts";

function fakeDb(options: { settled?: boolean; attemptCount?: number; maxAttempts?: number; shareLookupError?: boolean; finishResult?: boolean } = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const item = {
    id: "reminder-1", user_id: "user-1", expense_share_id: "share-1", reminder_sequence: 1,
    idempotency_key: "share-1:1", attempt_count: options.attemptCount ?? 1,
    max_attempts: options.maxAttempts ?? 5, scheduled_for: new Date(0).toISOString(),
  };
  const db = {
    calls,
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      if (name === "claim_due_expense_reminders") return { data: [item], error: null };
      if (name === "finish_expense_reminder_attempt") return { data: options.finishResult ?? true, error: null };
      return { data: null, error: null };
    },
    from(table: string) {
      const query = {
        select() { return query; },
        eq() { return query; },
        async maybeSingle() {
          if (table === "reminder_logs") return { data: { delivery_status: "sending" }, error: null };
          if (options.shareLookupError) return { data: null, error: new Error("temporary database failure") };
          return { data: {
            id: "share-1", user_id: "user-1", amount_owed: 100, email: "p@example.com",
            participant_name: "Participant", group: { title: "Dinner", currency_code: "INR" },
            repayments: options.settled ? [{ amount: 100, payment_status: "confirmed" }] : [],
          }, error: null };
        },
      };
      return query;
    },
  };
  return { db: db as unknown as SupabaseClient, calls };
}

test("worker sends with a stable provider idempotency key and records delivery atomically", async () => {
  const { db, calls } = fakeDb();
  const delivered: Array<Record<string, unknown>> = [];
  const result = await runReminderWorker(25, db, async (payload) => { delivered.push(payload); });
  assert.deepEqual(result.results.map((row) => row.status), ["sent"]);
  assert.equal(calls[0]?.name, "schedule_all_expense_reminders");
  assert.equal(calls[1]?.name, "claim_due_expense_reminders");
  assert.equal(delivered[0].idempotencyKey, "share-1:1");
  assert.equal(calls.at(-1)?.name, "finish_expense_reminder_attempt");
  assert.equal(calls.at(-1)?.args.p_outcome, "sent");
});

test("worker schedules exponential retry and stops after the maximum attempt", async () => {
  const retryDb = fakeDb({ attemptCount: 2, maxAttempts: 4 });
  const retry = await runReminderWorker(25, retryDb.db, async () => { throw new Error("provider unavailable"); });
  assert.equal(retry.results[0].status, "scheduled");
  assert.equal(retryDb.calls.at(-1)?.args.p_outcome, "failed");
  assert.equal(typeof retryDb.calls.at(-1)?.args.p_next_attempt_at, "string");

  const exhaustedDb = fakeDb({ attemptCount: 4, maxAttempts: 4 });
  const exhausted = await runReminderWorker(25, exhaustedDb.db, async () => { throw new Error("provider unavailable"); });
  assert.equal(exhausted.results[0].status, "failed");
  assert.equal(exhaustedDb.calls.at(-1)?.args.p_next_attempt_at, null);
});

test("worker cancels a claimed reminder when confirmed repayments settle its share", async () => {
  const { db, calls } = fakeDb({ settled: true });
  let sent = false;
  const result = await runReminderWorker(25, db, async () => { sent = true; });
  assert.equal(result.results[0].status, "cancelled");
  assert.equal(sent, false);
  assert.equal(calls.at(-1)?.args.p_outcome, "cancelled");
});

test("worker records a retryable attempt when share lookup fails and continues safely", async () => {
  const { db, calls } = fakeDb({ shareLookupError: true, attemptCount: 1, maxAttempts: 4 });
  const result = await runReminderWorker(25, db, async () => assert.fail("must not deliver without share data"));
  assert.equal(result.results[0]?.status, "scheduled");
  assert.equal(calls.at(-1)?.name, "finish_expense_reminder_attempt");
  assert.equal(calls.at(-1)?.args.p_outcome, "failed");
  assert.equal(typeof calls.at(-1)?.args.p_next_attempt_at, "string");
});

test("worker does not report delivery as committed if the lease state already changed", async () => {
  const { db } = fakeDb({ finishResult: false });
  const result = await runReminderWorker(25, db, async () => undefined);
  assert.equal(result.results[0]?.status, "state_changed_after_delivery");
});
