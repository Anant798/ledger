
export type NormalizedTransactionDate = {
  value: string | null;
  precision: "date" | "datetime" | "unknown";
};

export function normalizeTransactionDate(
  input: string | null
): NormalizedTransactionDate {
  if (!input) {
    return { value: null, precision: "unknown" };
  }

  const value = input.trim();

  // Match DD-MM-YY or DD-MM-YYYY, optionally with time and timezone.
  const match = value.match(
    /^(\d{2})-(\d{2})-(\d{2}|\d{4})(?:[,\s]+(\d{2}):(\d{2}):(\d{2})\s*(IST|UTC|GMT))?$/i
  );

  if (!match) {
    return { value: null, precision: "unknown" };
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

  // Date-only values must remain date-only.
  if (!hour || !minute || !second || !timezone) {
    return { value: date, precision: "date" };
  }

  if (
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59
  ) {
    return { value: null, precision: "unknown" };
  }

  const offset =
    timezone.toUpperCase() === "IST"
      ? "+05:30"
      : "Z";

  const normalized =
    `${date}T${hour}:${minute}:${second}${offset}`;

  return {
    value: normalized,
    precision: "datetime",
  };
}
