import assert from "node:assert/strict";
import { cancelIfSettled, claimReminder, retryReminder, type ReminderState } from "./reminder-core.ts";
import { nextReminderTime, reminderIdempotencyKey } from "./integration-helpers.ts";
import { recordRepaymentSchema, toDatabaseParticipantType, toDatabaseSplitMethod } from "./validation.ts";
import { calculateSavingsProgress } from "../savings/calculations.ts";
import { createSavingsGoalSchema } from "../savings/validation.ts";

const base: ReminderState = { status: "scheduled", attempts: 0, maxAttempts: 3, dueAt: 1000 };
assert.equal(claimReminder(base, 999, 100), null);
const first = claimReminder(base, 1000, 100)!;
assert.equal(first.status, "sending");
assert.equal(claimReminder(first, 1050, 100), null);
assert.equal(claimReminder(first, 1101, 100)?.attempts, 2);
assert.equal(retryReminder({ ...first, attempts: 1 }, 1000, 3, 100).dueAt, 1100);
assert.equal(retryReminder({ ...first, attempts: 3 }, 1000, 3, 100).status, "failed");
assert.equal(cancelIfSettled(base, 10, [4, 6]).status, "cancelled");
assert.equal(cancelIfSettled(base, 10, [4, 3]).status, "scheduled");
assert.equal(reminderIdempotencyKey("share-1", 2), "share-1:2", "provider idempotency key is stable per share sequence");
assert.equal(createSavingsGoalSchema.parse({ title: "Trip", target_amount: 100 }).status, "active");
assert.equal(recordRepaymentSchema.safeParse({ expense_share_id: "c4f7c50a-cd20-47b7-bc68-46ced200d249", amount: 10, payment_method: "cash", idempotency_key: "d4f7c50a-cd20-47b7-bc68-46ced200d249" }).success, true);
assert.equal(recordRepaymentSchema.safeParse({ expense_share_id: "c4f7c50a-cd20-47b7-bc68-46ced200d249", amount: 10, payment_method: "cash" }).success, false);
assert.equal(recordRepaymentSchema.safeParse({ expense_share_id: "c4f7c50a-cd20-47b7-bc68-46ced200d249", amount: 10, payment_method: "manual_recorded", idempotency_key: "d4f7c50a-cd20-47b7-bc68-46ced200d249" }).success, false);
assert.equal(toDatabaseParticipantType("self"), "owner");
assert.equal(toDatabaseParticipantType("external"), "contact");
assert.equal(toDatabaseSplitMethod("percentage"), "custom");
assert.deepEqual(calculateSavingsProgress(100, [
  { amount: 30, contribution_status: "confirmed" },
  { amount: 20, contribution_status: "pending" },
  { amount: 10, contribution_status: "reversed" },
]), { currentAmount: 30, remainingAmount: 70, progressPercent: 30, isGoalMet: false, confirmedContributionCount: 1 });
const scheduled = nextReminderTime(new Date("2026-11-08T04:00:00.000Z"), {
  initial_message_enabled: true, frequency_hours: 24, preferred_send_time: "10:00:00", timezone: "Asia/Kolkata",
}, 1);
assert.equal(scheduled?.toISOString(), "2026-11-08T04:30:00.000Z");
const followUp = nextReminderTime(new Date("2026-11-08T04:00:00.000Z"), {
  initial_message_enabled: true, frequency_hours: 24, preferred_send_time: "10:00:00", timezone: "Asia/Kolkata",
}, 2);
assert.equal(followUp?.toISOString(), "2026-11-09T04:30:00.000Z");
assert.equal(nextReminderTime(new Date(), {
  initial_message_enabled: false, frequency_hours: 24, preferred_send_time: "10:00:00", timezone: "Asia/Kolkata",
}, 1), null);
console.log("Batch B schema mapping, reminder schedule/retry/dedupe/settlement, and savings tests passed");
