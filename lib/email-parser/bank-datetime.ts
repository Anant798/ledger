export type OccurredAtSource = "bank_provided" | "email_received_fallback";
export type BankDateTime = { transactionDate: string; occurredAt: string; occurredAtSource: OccurredAtSource };

type DateParts = { date: string; index: number; end: number };

function findIndianDate(body: string): DateParts | null {
  const pattern = /(?<!\d)(\d{1,2})[-/]([A-Za-z]{3,9}|\d{1,2})[-/, ]+(\d{2}|\d{4})(?!\d)/g;
  const monthNames = new Map([
    ["jan", 1], ["feb", 2], ["mar", 3], ["apr", 4], ["may", 5], ["jun", 6],
    ["jul", 7], ["aug", 8], ["sep", 9], ["oct", 10], ["nov", 11], ["dec", 12],
  ]);
  for (const match of body.matchAll(pattern)) {
    const day = Number(match[1]);
    const month = /^\d+$/.test(match[2]) ? Number(match[2]) : monthNames.get(match[2].slice(0, 3).toLowerCase()) ?? 0;
    const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
    const check = new Date(Date.UTC(year, month - 1, day));
    if (month < 1 || month > 12 || day < 1 || check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) continue;
    return { date: `${year.toString().padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, index: match.index ?? 0, end: (match.index ?? 0) + match[0].length };
  }
  return null;
}

function offsetText(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: values.year, month: values.month, day: values.day, hour: values.hour, minute: values.minute, second: values.second };
}

function offsetAt(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  const localAsUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return offsetText(Math.round((localAsUtc - date.getTime()) / 60_000));
}

function offsetAtLocal(date: string, hour: number, minute: number, second: number, timeZone: string): string {
  const wallAsUtc = new Date(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}Z`);
  return offsetAt(wallAsUtc, timeZone);
}

function validDate(value: string): boolean {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function extractBankDateTime(
  body: string,
  options: { internalDate?: string | null; dateHeader?: string | null; timeZone?: string } = {},
): BankDateTime | null {
  const found = findIndianDate(body);
  if (!found) return null;
  const timeZone = options.timeZone || process.env.LEDGER_TIME_ZONE || "Asia/Kolkata";
  const context = body.slice(found.end, Math.min(body.length, found.end + 60));
  const explicitTime = context.match(/\b(?:at\s*)?(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|IST|UTC|GMT|[+-]\d{2}:?\d{2})?\b/i);
  if (explicitTime) {
    let hour = Number(explicitTime[1]);
    const minute = Number(explicitTime[2]);
    const second = Number(explicitTime[3] || 0);
    const marker = explicitTime[4]?.toUpperCase();
    if (marker === "AM" || marker === "PM") {
      if (hour < 1 || hour > 12) return null;
      hour = (hour % 12) + (marker === "PM" ? 12 : 0);
    }
    if (hour > 23 || minute > 59 || second > 59) return null;
    const offset = marker === "UTC" || marker === "GMT" ? "Z" : marker === "IST" ? "+05:30" : marker && /^[+-]/.test(marker) ? marker : offsetAtLocal(found.date, hour, minute, second, timeZone);
    return { transactionDate: found.date, occurredAt: `${found.date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}${offset}`, occurredAtSource: "bank_provided" };
  }

  let received: Date | null = null;
  if (options.internalDate) {
    const millis = Number(options.internalDate);
    const candidate = Number.isFinite(millis) ? new Date(millis) : new Date(options.internalDate);
    if (!Number.isNaN(candidate.getTime())) received = candidate;
  }
  if (!received && options.dateHeader) {
    const candidate = new Date(options.dateHeader);
    if (!Number.isNaN(candidate.getTime())) received = candidate;
  }
  if (!received) return null;
  const p = zonedParts(received, timeZone);
  const occurredAt = `${found.date}T${p.hour}:${p.minute}:${p.second}${offsetAt(received, timeZone)}`;
  if (!validDate(found.date)) return null;
  return { transactionDate: found.date, occurredAt, occurredAtSource: "email_received_fallback" };
}
