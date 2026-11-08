import assert from "node:assert/strict";
import { calculateShareBalance, calculateSplit } from "./calculations.ts";
import { calculateSavingsProgress } from "../savings/calculations.ts";
import { claimReminder, retryReminder, cancelIfSettled } from "./reminder-core.ts";

assert.deepEqual(calculateSplit(10, "equal", [0, 0, 0]), [3.33, 3.33, 3.34]);
assert.deepEqual(calculateSplit(10, "percentage", [33.33, 33.33, 33.34]), [3.33, 3.33, 3.34]);
assert.deepEqual(calculateSplit(10, "custom", [2, 8]), [2, 8]);
const balance = calculateShareBalance(10, [{ amount: 3, payment_status: "confirmed" }, { amount: 2, payment_status: "pending" }]);
assert.equal(balance.outstandingBalance, 7);
assert.equal(balance.settlementHistory.length, 1);
assert.deepEqual(calculateSavingsProgress(100, [{ amount: 40, contribution_status: "confirmed" }, { amount: 30, contribution_status: "pending" }]), { currentAmount: 40, progressPercent: 40, isGoalMet: false, confirmedContributionCount: 1 });
const scheduled = { status: "scheduled" as const, attempts: 0, maxAttempts: 2, dueAt: 10 };
const claimed = claimReminder(scheduled, 10, 100)!;
assert.equal(claimReminder(claimed, 20, 100), null);
assert.equal(retryReminder({ ...claimed, attempts: 2 }, 20, 2, 100).status, "failed");
assert.equal(cancelIfSettled(scheduled, 10, [5, 5]).status, "cancelled");
console.log("Batch B calculation and reminder integration tests passed");
