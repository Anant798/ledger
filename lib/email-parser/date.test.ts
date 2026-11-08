
import { normalizeTransactionDate } from "./date";

const testDates = [
  "01-11-26, 21:24:36 IST",
  "03-11-2026",
  "31-02-2026",
  null,
];

for (const date of testDates) {
  console.log(date, "=>", normalizeTransactionDate(date));
}
