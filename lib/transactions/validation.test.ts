import assert from "node:assert/strict";
import test from "node:test";
import { createTransactionSchema, transactionQuerySchema, updateTransactionSchema } from "./validation.ts";

test("transaction validation handles both income credits and expense debits", () => {
  for (const direction of ["debit", "credit"] as const) {
    const parsed = createTransactionSchema.safeParse({ direction, amount: 10, category: "Food", payment_method: "upi", merchant_name: "Shop", occurred_at: "2026-11-08T10:00:00+05:30" });
    assert.equal(parsed.success, true);
    if (parsed.success) assert.equal(parsed.data.direction, direction);
  }
});

test("transaction filters validate sorting, dates, and safe pagination", () => {
  const parsed = transactionQuerySchema.safeParse({ sort: "amount", sortDirection: "asc", startDate: "2026-11-01", endDate: "2026-11-30", category: "Food", payment_method: "upi", page: "2", limit: "25" });
  assert.equal(parsed.success, true);
  assert.equal(transactionQuerySchema.safeParse({ page: "0", limit: "1000" }).success, false);
  assert.equal(transactionQuerySchema.safeParse({ sort: "user_id" }).success, false);
});

test("transaction updates reject invalid amounts and accept editable details", () => {
  assert.equal(updateTransactionSchema.safeParse({ amount: 0 }).success, false);
  assert.equal(updateTransactionSchema.safeParse({ category: "Travel", payment_method: "card", direction: "credit" }).success, true);
});
