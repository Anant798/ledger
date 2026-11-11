import assert from "node:assert/strict";
import test from "node:test";
import { extractBankDateTime } from "./bank-datetime.ts";

test("Indian DD-MM-YY transaction date is parsed day first", () => {
  const parsed = extractBankDateTime(
    "Rs.40.00 has been debited from account 7970 to VPA q159579222@ybl HOSTEL H BOYS NEW HOSTEL on 01-04-26.\nYour UPI transaction reference number is 120927837436.",
    { internalDate: String(Date.parse("2026-04-01T15:23:40Z")), timeZone: "Asia/Kolkata" },
  );
  assert.equal(parsed?.transactionDate, "2026-04-01");
  assert.equal(parsed?.occurredAt, "2026-04-01T20:53:40+05:30");
  assert.equal(parsed?.occurredAtSource, "email_received_fallback");
});

test("Indian DD/MM/YYYY and bank DD-MMM-YYYY dates are parsed day first", () => {
  const numeric = extractBankDateTime("Debited on 01/04/2026", { internalDate: "1775040000000" });
  const named = extractBankDateTime("Debited on 10-Feb-2026", { internalDate: "1775040000000" });
  assert.equal(numeric?.transactionDate, "2026-04-01");
  assert.equal(named?.transactionDate, "2026-02-10");
});

test("date-only bank alert combines body date with internalDate clock without date shift", () => {
  const parsed = extractBankDateTime("Debit on 01-04-26", { internalDate: "1775040000000", dateHeader: "Sun, 05 Apr 2026 10:00:00 +0530", timeZone: "Asia/Kolkata" });
  assert.ok(parsed);
  assert.equal(parsed.transactionDate, "2026-04-01");
  assert.equal(parsed.occurredAtSource, "email_received_fallback");
  assert.equal(new Date(parsed.occurredAt).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }), "2026-04-01");
});

test("explicit body transaction time wins over email receipt time", () => {
  const parsed = extractBankDateTime("Transaction on 01-04-26 at 11:53 AM", { internalDate: "1775040000000", timeZone: "Asia/Kolkata" });
  assert.equal(parsed?.occurredAt, "2026-04-01T11:53:00+05:30");
  assert.equal(parsed?.occurredAtSource, "bank_provided");
});

test("Date header is used only when Gmail internalDate is unavailable", () => {
  const parsed = extractBankDateTime("Credited on 01/04/2026", { dateHeader: "Wed, 01 Apr 2026 07:00:00 +0530", timeZone: "Asia/Kolkata" });
  assert.equal(parsed?.occurredAt, "2026-04-01T07:00:00+05:30");
  assert.equal(parsed?.occurredAtSource, "email_received_fallback");
});

test("receipt timestamp alone is never treated as the transaction date", () => {
  assert.equal(extractBankDateTime("Your account alert arrived", { internalDate: "1775040000000" }), null);
});
