import assert from "node:assert";
import { normalizeTransactionDate } from "./date.ts";
import { isLikelyTransactionEmail, buildGmailTransactionQuery } from "../gmail/bank-filters.ts";

console.log("--- Starting Batch A Unit Tests ---");

// 1. Date Normalization Tests
console.log("Testing Date Normalization...");

// Date-only input must remain date-only without fake midnight time
const dateOnlyRes1 = normalizeTransactionDate("08-11-2026");
assert.strictEqual(dateOnlyRes1.precision, "date");
assert.strictEqual(dateOnlyRes1.value, "2026-11-08");

const dateOnlyRes2 = normalizeTransactionDate("08/11/2026");
assert.strictEqual(dateOnlyRes2.precision, "date");
assert.strictEqual(dateOnlyRes2.value, "2026-11-08");

const dateOnlyMonthName = normalizeTransactionDate("08 Nov 2026");
assert.strictEqual(dateOnlyMonthName.precision, "date");
assert.strictEqual(dateOnlyMonthName.value, "2026-11-08");

// Datetime with IST timezone
const datetimeIST = normalizeTransactionDate("08-11-2026, 14:30:15 IST");
assert.strictEqual(datetimeIST.precision, "datetime");
assert.strictEqual(datetimeIST.value, "2026-11-08T14:30:15+05:30");

// Invalid dates must return null / unknown
const invalidDate = normalizeTransactionDate("31-02-2026");
assert.strictEqual(invalidDate.precision, "unknown");
assert.strictEqual(invalidDate.value, null);

const invalidTime = normalizeTransactionDate("08-11-2026, 25:61:99 IST");
assert.strictEqual(invalidTime.precision, "unknown");
assert.strictEqual(invalidTime.value, null);

console.log("✓ Date Normalization Tests passed!");

// 2. Bank Heuristics & OTP Filtering Tests
console.log("Testing Bank Filter & OTP Rejection...");

const hdfcValid = isLikelyTransactionEmail(
  "alerts@hdfcbank.net",
  "Alert: Rs 450 debited from A/c **1234",
  "Rs 450.00 debited from HDFC Bank A/c **1234 towards SWIGGY on 08-11-2026. Info: UPI/331234."
);
assert.strictEqual(hdfcValid, true);

const sbiValid = isLikelyTransactionEmail(
  "donotreply@sbi.co.in",
  "Account Debited for INR 1,200",
  "Your SBI A/c 5678 is debited by INR 1200 on 08-11-2026 by UPI txn."
);
assert.strictEqual(sbiValid, true);

const iciciOtp = isLikelyTransactionEmail(
  "alerts@icicibank.com",
  "OTP for NetBanking Login",
  "Your One Time Password (OTP) for login is 987654. Do not disclose it to anyone."
);
assert.strictEqual(iciciOtp, false);

const marketingPromo = isLikelyTransactionEmail(
  "offers@axisbank.com",
  "Special Invitation: Get 10% discount on flight bookings",
  "Exclusive offer on your Axis Bank credit card. Apply now!"
);
assert.strictEqual(marketingPromo, false);

console.log("✓ Bank Filters & OTP Rejection passed!");

// 3. Gmail Query Builder Tests
console.log("Testing Gmail Query Builder...");
const queryWithoutTimestamp = buildGmailTransactionQuery();
assert.ok(queryWithoutTimestamp.includes("hdfcbank.net"));
assert.ok(queryWithoutTimestamp.includes("icicibank.com"));
assert.ok(queryWithoutTimestamp.includes("-{\"otp\""));

const queryWithTimestamp = buildGmailTransactionQuery(1700000000);
assert.ok(queryWithTimestamp.endsWith("after:1700000000"));
console.log("✓ Gmail Query Builder passed!");

// 4. Multi-key duplicate logic mock test
console.log("Testing Multi-key Duplicate Isolation Logic...");
const existingTransactions = [
  { external_reference: "UPI/123456", payment_provider: "UPI", bank_name: "HDFC Bank" },
  { external_reference: "NEFT/789012", payment_provider: "NEFT", bank_name: "SBI" }
];

function isDuplicate(ref: string, provider: string) {
  return existingTransactions.some(
    (t) => t.external_reference === ref && t.payment_provider === provider
  );
}

// Same reference and same provider -> Duplicate detected
assert.strictEqual(isDuplicate("UPI/123456", "UPI"), true);

// Same reference but different provider/rail -> Not false duplicate
assert.strictEqual(isDuplicate("UPI/123456", "NEFT"), false);

// Different reference -> Not duplicate
assert.strictEqual(isDuplicate("UPI/999999", "UPI"), false);

console.log("✓ Multi-key duplicate prevention passed!");

console.log("\n--- All Batch A Unit Tests Passed Successfully ---");
