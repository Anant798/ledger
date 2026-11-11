import assert from "node:assert/strict";
import test from "node:test";
import { resolveReviewSchema } from "./validation.ts";

test("HDFC review approval payload emitted by Gmail editor passes strict validation", () => {
  const payload = {
    reviewId: "6bead2af-37b6-4485-b65a-3536fe8b886e",
    action: "approve",
    updates: {
      amount: 40,
      direction: "debit",
      currency_code: "INR",
      transaction_type: "payment",
      category: "Uncategorized",
      occurred_at: new Date("2026-11-02T11:53:00+05:30").toISOString(),
      merchant_name: "HOSTEL H BOYS NEW HOSTEL",
      bank_name: "HDFC Bank",
      payment_provider: "hdfc_bank",
      external_reference: "121291757896",
      description: "",
    },
  };
  const result = resolveReviewSchema.safeParse(payload);
  assert.equal(result.success, true, result.success ? "" : JSON.stringify(result.error.issues));
});

test("review approval still rejects invalid financial values and unknown fields", () => {
  const base = { reviewId: "6bead2af-37b6-4485-b65a-3536fe8b886e", action: "approve", updates: { amount: -1, direction: "debit", currency_code: "INR", occurred_at: "2026-11-02T06:23:00.000Z", surprise: true } };
  assert.equal(resolveReviewSchema.safeParse(base).success, false);
});
