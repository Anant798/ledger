export type ReminderState = { status: "scheduled" | "sending" | "sent" | "cancelled" | "failed"; attempts: number; maxAttempts: number; dueAt: number; leaseUntil?: number };

export function isSettled(amountOwed: number, confirmedPayments: number[]): boolean {
  return Math.max(0, amountOwed - confirmedPayments.reduce((total, amount) => total + amount, 0)) <= 0.01;
}

export function claimReminder(state: ReminderState, now: number, leaseMs: number): ReminderState | null {
  if (state.status === "sent" || state.status === "cancelled" || state.status === "failed") return null;
  if (state.status === "sending" && (state.leaseUntil || 0) > now) return null;
  if (state.dueAt > now || state.attempts >= state.maxAttempts) return null;
  return { ...state, status: "sending", attempts: state.attempts + 1, leaseUntil: now + leaseMs };
}

export function retryReminder(state: ReminderState, now: number, maxAttempts: number, baseDelayMs: number): ReminderState {
  return { ...state, status: state.attempts >= maxAttempts ? "failed" : "scheduled", dueAt: now + Math.min(baseDelayMs * 2 ** Math.max(0, state.attempts - 1), 24 * 60 * 60 * 1000), leaseUntil: undefined, maxAttempts };
}

export function cancelIfSettled(state: ReminderState, amountOwed: number, confirmedPayments: number[]): ReminderState {
  return isSettled(amountOwed, confirmedPayments) && state.status !== "sent" ? { ...state, status: "cancelled", leaseUntil: undefined } : state;
}
