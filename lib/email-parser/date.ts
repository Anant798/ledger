export type NormalizedTransactionDate = {
  value: string | null;
  precision: "date" | "datetime" | "unknown";
};

/**
 * Normalizes transaction dates from bank emails.
 * IMPORTANT:
 * - If only a date (without time) is provided, it returns "YYYY-MM-DD" with precision "date".
 *   Never fabricate a fake time or convert to UTC datetime, which causes date-shifting across timezones.
 * - If time is present, it anchors with timezone offset (defaulting Indian bank emails to IST +05:30).
 */
export function normalizeTransactionDate(
  input: string | null
): NormalizedTransactionDate {
  if (!input) {
    return { value: null, precision: "unknown" };
  }

  const value = input.trim();

  // 1. Try ISO format already: YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss...
  const isoMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/i);
  if (isoMatch) {
    const [, year, month, day, hour, minute, second, tz] = isoMatch;
    if (!hour) {
      return { value: `${year}-${month}-${day}`, precision: "date" };
    }
    const offset = tz || "+05:30";
    return {
      value: `${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`,
      precision: "datetime",
    };
  }

  // 2. Match DD-MM-YY or DD-MM-YYYY or DD/MM/YYYY, optionally with time and timezone.
  const match = value.match(
    /^(\d{2})[-/](\d{2})[-/](\d{2}|\d{4})(?:[,\s]+(\d{2}):(\d{2})(?::(\d{2}))?\s*(IST|UTC|GMT|[+-]\d{2}:?\d{2})?)?$/i
  );

  if (!match) {
    // 3. Match format like "08 Nov 2026", "08-Nov-2026", optionally with time
    const monthNameMatch = value.match(
      /^(\d{1,2})[-/\s]+([a-zA-Z]{3,9})[-/\s]+(\d{2}|\d{4})(?:[,\s]+(\d{2}):(\d{2})(?::(\d{2}))?\s*(IST|UTC|GMT)?)?$/i
    );
    if (!monthNameMatch) {
      return { value: null, precision: "unknown" };
    }

    const months: Record<string, string> = {
      jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
      jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12"
    };
    const [, rawDay, rawMonthName, rawYr, hr, min, sec, tz] = monthNameMatch;
    const mKey = rawMonthName.toLowerCase().slice(0, 3);
    const mNum = months[mKey];
    if (!mNum) return { value: null, precision: "unknown" };

    const dStr = rawDay.padStart(2, "0");
    const yNum = rawYr.length === 2 ? 2000 + Number(rawYr) : Number(rawYr);
    const dateStr = `${yNum}-${mNum}-${dStr}`;

    if (!hr || !min) {
      return { value: dateStr, precision: "date" };
    }

    const sStr = sec || "00";
    const offset = !tz || tz.toUpperCase() === "IST" ? "+05:30" : "Z";
    return {
      value: `${dateStr}T${hr}:${min}:${sStr}${offset}`,
      precision: "datetime",
    };
  }

  const [, day, month, rawYear, hour, minute, second, timezone] = match;

  const year =
    rawYear.length === 2
      ? Number(rawYear) >= 70
        ? 1900 + Number(rawYear)
        : 2000 + Number(rawYear)
      : Number(rawYear);

  const date = `${year}-${month}-${day}`;

  // Validate the calendar date.
  const check = new Date(`${date}T00:00:00.000Z`);

  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() + 1 !== Number(month) ||
    check.getUTCDate() !== Number(day)
  ) {
    return { value: null, precision: "unknown" };
  }

  // Date-only values MUST remain date-only (never append T00:00:00Z)
  if (!hour || !minute) {
    return { value: date, precision: "date" };
  }

  const sec = second || "00";

  if (
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(sec) > 59
  ) {
    return { value: null, precision: "unknown" };
  }

  let offset = "+05:30"; // Default for Indian banking transactions
  if (timezone) {
    const tzUpper = timezone.toUpperCase();
    if (tzUpper === "UTC" || tzUpper === "GMT") offset = "Z";
    else if (tzUpper === "IST") offset = "+05:30";
    else if (/^[+-]\d{2}:?\d{2}$/.test(timezone)) offset = timezone;
  }

  const normalized = `${date}T${hour}:${minute}:${sec}${offset}`;

  return {
    value: normalized,
    precision: "datetime",
  };
}
