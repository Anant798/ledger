export function resolveOwnerId(relation: unknown): string | null {
  const row = Array.isArray(relation) ? relation[0] : relation;
  if (!row || typeof row !== "object") return null;
  const userId = (row as { user_id?: unknown }).user_id;
  return typeof userId === "string" ? userId : null;
}

export function reminderIdempotencyKey(expenseShareId: string, sequence: number): string {
  return `${expenseShareId}:${sequence}`;
}

export function nextReminderTime(now: Date, settings: { initial_message_enabled: boolean; frequency_hours: number; preferred_send_time: string; timezone: string }, sequence: number): Date | null {
  if (sequence === 1 && !settings.initial_message_enabled) return null;
  const minimum = sequence > 1
    ? new Date(now.getTime() + settings.frequency_hours * 60 * 60 * 1000)
    : now;
  const [hours = 0, minutes = 0, rawSeconds] = settings.preferred_send_time.split(":").map(Number);
  const seconds = rawSeconds ?? 0;
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: settings.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const localParts = (instant: Date) => formatter.formatToParts(instant).reduce<Record<string, number>>((result, entry) => { if (entry.type !== "literal") result[entry.type] = Number(entry.value); return result; }, {});
  const localMinimum = localParts(minimum);
  const toInstant = (year: number, month: number, day: number) => {
    const wallTime = Date.UTC(year, month - 1, day, hours, minutes, seconds);
    const probe = new Date(wallTime);
    const actual = localParts(probe);
    return new Date(wallTime + wallTime - Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second));
  };
  let target = toInstant(localMinimum.year, localMinimum.month, localMinimum.day);
  if (target < minimum) {
    const followingDay = new Date(Date.UTC(localMinimum.year, localMinimum.month - 1, localMinimum.day + 1));
    target = toInstant(followingDay.getUTCFullYear(), followingDay.getUTCMonth() + 1, followingDay.getUTCDate());
  }
  return target;
}

export async function withAudit<T>(write: () => Promise<T>, audit: (row: T) => Promise<void>, rollback: (row: T) => Promise<void>): Promise<T> {
  const row = await write();
  try { await audit(row); return row; }
  catch (error) { await rollback(row); throw error; }
}

export function formatConversationHistory(messages: Array<{ role: string; content: string }>, limit = 20) {
  return messages.slice(-limit).map((message) => ({ role: message.role === "assistant" ? "assistant" : "user", content: message.content }));
}
