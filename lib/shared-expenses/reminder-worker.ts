import { createAdminClient } from "@/lib/supabase/admin";

const LEASE_SECONDS = 300;
const BASE_RETRY_MS = 60_000;

export async function deliverReminder(payload: Record<string, unknown>): Promise<void> {
  const endpoint = process.env.REMINDER_DELIVERY_URL;
  const secret = process.env.REMINDER_DELIVERY_SECRET;
  if (!endpoint || !secret) throw new Error("Reminder delivery is not configured");
  const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${secret}` }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Reminder delivery returned HTTP ${response.status}`);
}

export async function runReminderWorker(limit = 25) {
  const db = createAdminClient();
  const { data: due, error: claimError } = await db.rpc("claim_due_expense_reminders", { p_limit: Math.min(Math.max(limit, 1), 100), p_lease_seconds: LEASE_SECONDS });
  if (claimError) throw claimError;
  const results = [];
  for (const item of due || []) {
    const { data: share, error: shareError } = await db.from("expense_shares").select("id,user_id,amount_owed,participant_name,email,group:expense_groups!inner(id,title,currency_code),repayments(amount,payment_status)").eq("id", item.expense_share_id).eq("user_id", item.user_id).maybeSingle();
    if (shareError) throw shareError;
    const confirmed = (share?.repayments || []).filter((p: { payment_status: string }) => p.payment_status === "confirmed");
    const balance = Math.max(0, Number(share?.amount_owed || 0) - confirmed.reduce((sum: number, p: { amount: number | string }) => sum + Number(p.amount), 0));
    if (!share || balance <= 0.01) {
      await db.from("expense_reminders").update({ status: "cancelled", next_attempt_at: null, lease_until: null, updated_at: new Date().toISOString() }).eq("id", item.id);
      await db.from("expense_reminder_attempts").upsert({ reminder_id: item.id, user_id: item.user_id, attempt_number: item.attempts, outcome: "cancelled", error: "Share settled or removed" }, { onConflict: "reminder_id,attempt_number" });
      results.push({ id: item.id, status: "cancelled" });
      continue;
    }
    try {
      const group = Array.isArray(share.group) ? share.group[0] : share.group;
      if (!group) throw new Error("Expense group not found");
      await deliverReminder({ reminderId: item.id, userId: item.user_id, to: share.email, participantName: share.participant_name, groupTitle: group.title, currencyCode: group.currency_code, outstandingBalance: balance });
      await db.from("expense_reminders").update({ status: "sent", sent_at: new Date().toISOString(), next_attempt_at: null, lease_until: null, last_error: null, updated_at: new Date().toISOString() }).eq("id", item.id);
      await db.from("expense_reminder_attempts").upsert({ reminder_id: item.id, user_id: item.user_id, attempt_number: item.attempts, outcome: "sent" }, { onConflict: "reminder_id,attempt_number" });
      results.push({ id: item.id, status: "sent" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Delivery failed";
      const nextAt = new Date(Date.now() + Math.min(BASE_RETRY_MS * 2 ** Math.max(0, item.attempts - 1), 86_400_000)).toISOString();
      const exhausted = item.attempts >= item.max_attempts;
      await db.from("expense_reminders").update({ status: exhausted ? "failed" : "scheduled", next_attempt_at: exhausted ? null : nextAt, lease_until: null, last_error: message, updated_at: new Date().toISOString() }).eq("id", item.id);
      await db.from("expense_reminder_attempts").upsert({ reminder_id: item.id, user_id: item.user_id, attempt_number: item.attempts, outcome: "failed", error: message, next_attempt_at: exhausted ? null : nextAt }, { onConflict: "reminder_id,attempt_number" });
      results.push({ id: item.id, status: exhausted ? "failed" : "scheduled", error: message });
    }
  }
  return { processed: results.length, results };
}
