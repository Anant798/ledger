import assert from "node:assert/strict";

type State = { status: "scheduled" | "sending" | "sent" | "cancelled" | "failed"; attempts: number; maxAttempts: number; dueAt: number; leaseUntil?: number };
function claimReminder(state: State, now: number, leaseMs: number): State | null {
  if (["sent", "cancelled", "failed"].includes(state.status) || (state.status === "sending" && (state.leaseUntil || 0) > now) || state.dueAt > now || state.attempts >= state.maxAttempts) return null;
  return { ...state, status: "sending", attempts: state.attempts + 1, leaseUntil: now + leaseMs };
}
function retryReminder(state: State, now: number, maxAttempts: number, baseDelayMs: number): State {
  return { ...state, status: state.attempts >= maxAttempts ? "failed" : "scheduled", dueAt: now + Math.min(baseDelayMs * 2 ** Math.max(0, state.attempts - 1), 86_400_000), maxAttempts, leaseUntil: undefined };
}
function cancelIfSettled(state: State, owed: number, paid: number[]): State {
  return Math.max(0, owed - paid.reduce((sum, n) => sum + n, 0)) <= 0.01 ? { ...state, status: "cancelled", leaseUntil: undefined } : state;
}

const base: State = { status: "scheduled", attempts: 0, maxAttempts: 3, dueAt: 1000 };
assert.equal(claimReminder(base, 999, 100), null);
const first = claimReminder(base, 1000, 100)!;
assert.equal(first.status, "sending");
assert.equal(claimReminder(first, 1050, 100), null);
assert.equal(claimReminder(first, 1101, 100)?.attempts, 2);
assert.equal(retryReminder({ ...first, attempts: 1 }, 1000, 3, 100).dueAt, 1100);
assert.equal(retryReminder({ ...first, attempts: 3 }, 1000, 3, 100).status, "failed");
assert.equal(cancelIfSettled(base, 10, [4, 6]).status, "cancelled");
assert.equal(cancelIfSettled(base, 10, [4, 3]).status, "scheduled");
console.log("Reminder schedule, retry, deduplication, and settlement tests passed");
