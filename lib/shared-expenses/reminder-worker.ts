import { reminderIdempotencyKey } from "./integration-helpers.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

async function getAdminClient() {
  const { createAdminClient } = await import("../supabase/admin.ts");
  return createAdminClient();
}

const LEASE_SECONDS = 300;
const BASE_RETRY_MS = 60_000;

export async function deliverReminder(payload: Record<string, unknown>): Promise<void> {
  const endpoint = process.env.REMINDER_DELIVERY_URL;
  const secret = process.env.REMINDER_DELIVERY_SECRET;
  if (!endpoint || !secret) throw new Error("Reminder delivery is not configured");
  const idempotencyKey = String(payload.idempotencyKey || payload.reminderId || "");
  if (!idempotencyKey) throw new Error("Reminder idempotency key is required");
  const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${secret}`, "idempotency-key": idempotencyKey }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Reminder delivery returned HTTP ${response.status}`);
}

export async function runReminderWorker(limit = 25, database?: SupabaseClient, deliver = deliverReminder) {
  const db = database || await getAdminClient();
  const { error: scheduleError } = await db.rpc("schedule_all_expense_reminders");
  if (scheduleError) throw scheduleError;
  const { data: due, error: claimError } = await db.rpc("claim_due_expense_reminders", { p_limit: Math.min(Math.max(limit, 1), 100), p_lease_seconds: LEASE_SECONDS });
  if (claimError) throw claimError;
  const results = [];
  for (const item of due || []) {
    try {
      const { data: share, error: shareError } = await db.from("expense_shares").select("id,user_id,amount_owed,participant_name,email,group:expense_groups!inner(id,title,currency_code),repayments(amount,payment_status)").eq("id", item.expense_share_id).eq("user_id", item.user_id).maybeSingle();
      if (shareError) throw shareError;
      const confirmed = (share?.repayments || []).filter((p: { payment_status: string }) => p.payment_status === "confirmed");
      const balance = Math.max(0, Number(share?.amount_owed || 0) - confirmed.reduce((sum: number, p: { amount: number | string }) => sum + Number(p.amount), 0));
      if (!share || balance <= 0.01) {
        const { error: finishError } = await db.rpc("finish_expense_reminder_attempt", {
          p_reminder_id: item.id, p_outcome: "cancelled", p_error: "Share settled or removed", p_next_attempt_at: null,
        });
        if (finishError) throw finishError;
        results.push({ id: item.id, status: "cancelled" });
        continue;
      }
      const group = Array.isArray(share.group) ? share.group[0] : share.group;
      if (!group) throw new Error("Expense group not found");
      const stableKey = String(item.idempotency_key || reminderIdempotencyKey(item.expense_share_id, item.reminder_sequence));
      const { data: claimed } = await db.from("reminder_logs").select("delivery_status").eq("id", item.id).maybeSingle();
      if (claimed?.delivery_status !== "sending") {
        results.push({ id: item.id, status: "cancelled" });
        continue;
      }
      await deliver({ reminderId: item.id, idempotencyKey: stableKey, userId: item.user_id, to: share.email, participantName: share.participant_name, groupTitle: group.title, currencyCode: group.currency_code, outstandingBalance: balance });
      const { data: recorded, error: finishError } = await db.rpc("finish_expense_reminder_attempt", {
        p_reminder_id: item.id, p_outcome: "sent", p_error: null, p_next_attempt_at: null,
      });
      if (finishError) throw finishError;
      if (recorded === false) {
        results.push({ id: item.id, status: "state_changed_after_delivery" });
        continue;
      }
      results.push({ id: item.id, status: "sent" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Delivery failed";
      const nextAt = new Date(Date.now() + Math.min(BASE_RETRY_MS * 2 ** Math.max(0, item.attempt_count - 1), 86_400_000)).toISOString();
      const exhausted = item.attempt_count >= item.max_attempts;
      const { data: recorded, error: finishError } = await db.rpc("finish_expense_reminder_attempt", {
        p_reminder_id: item.id, p_outcome: "failed", p_error: message, p_next_attempt_at: exhausted ? null : nextAt,
      });
      if (finishError) {
        results.push({ id: item.id, status: "recovery_pending", error: message });
        continue;
      }
      if (recorded === false) {
        results.push({ id: item.id, status: "state_changed_during_attempt" });
        continue;
      }
      results.push({ id: item.id, status: exhausted ? "failed" : "scheduled", error: message });
    }
  }
  return { processed: results.length, results };
}
