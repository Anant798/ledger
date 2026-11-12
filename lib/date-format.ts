/**
 * Ledger-wide date formatting.
 * Display dates in Indian day-month-year order: DD-MM-YYYY.
 * Date-only ISO values are parsed as local calendar dates to avoid UTC day shifts.
 */
function parseLedgerDate(value: string | Date): Date {
  if (value instanceof Date) return value;
  const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
  return new Date(value);
}

export function formatLedgerDate(value: string | Date): string {
  const date = parseLedgerDate(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  const parts = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.day}-${values.month}-${values.year}`;
}

export function formatLedgerDateTime(value: string | Date): string {
  const date = parseLedgerDate(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  const parts = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.day}-${values.month}-${values.year}, ${values.hour}:${values.minute}`;
}
