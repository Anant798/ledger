import assert from "node:assert/strict";
import test from "node:test";
import { classifyBankTransaction } from "./classification.ts";

test("bank alert classification uses merchant text and transaction direction", () => {
  assert.equal(classifyBankTransaction({ merchant: "SWIGGY ONLINE", direction: "debit" }), "Food & dining");
  assert.equal(classifyBankTransaction({ merchant: "Monthly payroll", direction: "credit" }), "Salary");
  assert.equal(classifyBankTransaction({ merchant: "Unknown UPI store", direction: "debit" }), "Uncategorized");
});
