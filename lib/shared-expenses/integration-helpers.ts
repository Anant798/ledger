export function resolveOwnerId(relation: unknown): string | null {
  const row = Array.isArray(relation) ? relation[0] : relation;
  if (!row || typeof row !== "object") return null;
  const userId = (row as { user_id?: unknown }).user_id;
  return typeof userId === "string" ? userId : null;
}

export function nextReminderTime(now: Date, settings: { initial_message_enabled: boolean; frequency_hours: number; preferred_send_time: string; timezone: string }, sequence: number): Date | null {
  if (sequence === 1 && !settings.initial_message_enabled) return null;
  if (sequence > 1) return new Date(now.getTime() + settings.frequency_hours * 60 * 60 * 1000);
  const [hours, minutes, seconds = "0"] = settings.preferred_send_time.split(":").map(Number);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: settings.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value);
  const year = part("year"), month = part("month"), day = part("day");
  const wallTime = Date.UTC(year, month - 1, day, hours, minutes, seconds);
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: settings.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const localParts = (instant: Date) => formatter.formatToParts(instant).reduce<Record<string, number>>((result, entry) => { if (entry.type !== "literal") result[entry.type] = Number(entry.value); return result; }, {});
  let target = new Date(wallTime);
  const actual = localParts(target);
  const actualWall = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
  target = new Date(target.getTime() + wallTime - actualWall);
  if (target <= now) {
    const nextDay = new Date(Date.UTC(year, month - 1, day + 1, hours, minutes, seconds));
    const nextActual = localParts(nextDay);
    target = new Date(nextDay.getTime() + nextDay.getTime() - Date.UTC(nextActual.year, nextActual.month - 1, nextActual.day, nextActual.hour, nextActual.minute, nextActual.second));
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
