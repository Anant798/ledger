import assert from "node:assert/strict";
import test from "node:test";
import { calculateExpenseGroupBalance, calculateShareBalance, calculateSplit } from "./calculations.ts";
import { archiveExpenseGroupSchema, createExpenseGroupSchema, repaymentActionSchema } from "./validation.ts";
import { resolveOwnerId } from "./integration-helpers.ts";

const participants = (amounts: number[]) => amounts.map((amount, index) => ({
  participant_name: `Person ${index + 1}`,
  participant_type: index === 0 ? "self" as const : "external" as const,
  amount_owed: amount,
}));

test("expense split calculations preserve the exact total for equal and percentage splits", () => {
  assert.deepEqual(calculateSplit(25, "equal", [0, 0, 0]), [8.33, 8.33, 8.34]);
  assert.deepEqual(calculateSplit(0.29, "equal", [0]), [0.29]);
  assert.deepEqual(calculateSplit(25, "percentage", [33.33, 33.33, 33.34]), [8.33, 8.33, 8.34]);
});

test("create validation accepts equal, custom and percentage splits and rejects unbalanced shares", () => {
  assert.equal(createExpenseGroupSchema.safeParse({ title: "Dinner", total_amount: 20, split_method: "equal", participants: participants([0, 0]) }).success, true);
  assert.equal(createExpenseGroupSchema.safeParse({ title: "Dinner", total_amount: 20, split_method: "custom", participants: participants([8, 12]) }).success, true);
  assert.equal(createExpenseGroupSchema.safeParse({ title: "Dinner", total_amount: 20, split_method: "percentage", participants: participants([25, 75]) }).success, true);
  assert.equal(createExpenseGroupSchema.safeParse({ title: "Dinner", total_amount: 20, split_method: "custom", participants: participants([8, 11]) }).success, false);
  assert.equal(createExpenseGroupSchema.safeParse({ title: "Dinner", total_amount: 20, split_method: "custom", participants: participants([8.005, 11.995]) }).success, false);
  assert.equal(createExpenseGroupSchema.safeParse({ title: "Dinner", total_amount: 20, split_method: "percentage", participants: participants([25, 70]) }).success, false);
});

test("archiving accepts an archive-only payload and rejects unrelated fields", () => {
  assert.equal(archiveExpenseGroupSchema.safeParse({ archived: false }).success, true);
  assert.equal(archiveExpenseGroupSchema.safeParse({ archived: false, title: "oops" }).success, false);
});

test("balances exclude the payer and inactive participants and count confirmed repayments only", () => {
  const owner = { participant_type: "owner", amount_owed: 10, repayments: [] };
  const active = { participant_type: "contact", amount_owed: 30, repayments: [
    { amount: 5, payment_status: "confirmed" },
    { amount: 10, payment_status: "pending" },
  ] };
  const removed = { participant_type: "contact", is_active: false, amount_owed: 60, repayments: [] };
  assert.deepEqual(calculateShareBalance(30, active.repayments), {
    totalRepaid: 5,
    outstandingBalance: 25,
    isSettled: false,
    settlementHistory: [active.repayments[0]],
  });
  assert.deepEqual(calculateExpenseGroupBalance([owner, active, removed]), {
    totalOwed: 30,
    totalRepaid: 5,
    outstandingBalance: 25,
    isFullySettled: false,
  });
});

test("multiple partial repayments and reversals recalculate the share balance", () => {
  const result = calculateShareBalance(100, [
    { amount: 25, payment_status: "confirmed" },
    { amount: 15, payment_status: "confirmed" },
    { amount: 20, payment_status: "reversed" },
    { amount: 10, payment_status: "pending" },
  ]);
  assert.equal(result.totalRepaid, 40);
  assert.equal(result.outstandingBalance, 60);
  assert.equal(result.settlementHistory.length, 2);
});

test("repayment edit and reversal actions require idempotency and a reason", () => {
  assert.equal(repaymentActionSchema.safeParse({ action: "edit", amount: 12.5, payment_method: "cash", idempotency_key: "d4f7c50a-cd20-47b7-bc68-46ced200d249" }).success, true);
  assert.equal(repaymentActionSchema.safeParse({ action: "reverse", reason: "Duplicate entry" }).success, true);
  assert.equal(repaymentActionSchema.safeParse({ action: "reverse", reason: " " }).success, false);
  assert.equal(repaymentActionSchema.safeParse({ action: "edit", amount: 12.5, payment_method: "cash" }).success, false);
});

test("embedded Supabase ownership relationships resolve as either an object or one-row array", () => {
  assert.equal(resolveOwnerId({ user_id: "owner-1" }), "owner-1");
  assert.equal(resolveOwnerId([{ user_id: "owner-1" }]), "owner-1");
  assert.equal(resolveOwnerId([]), null);
});
