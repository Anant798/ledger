import { reminderIdempotencyKey } from "./integration-helpers.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

async function getAdminClient() {
  const { createAdminClient } = await import("../supabase/admin.ts");
  return createAdminClient();
}

const LEASE_SECONDS = 300;
const BASE_RETRY_MS = 60_000;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] || character);
}

function formatAmount(amount: number, currencyCode: string): string {
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency: currencyCode, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${currencyCode} ${amount.toFixed(2)}`;
  }
}

function normalizeIndianMobile(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return digits;
  if (digits.length >= 11 && digits.length <= 15) return digits;
  throw new Error("Participant phone number must include a valid country code (or be a 10-digit Indian mobile number)");
}

async function sendEmail(payload: Record<string, unknown>, idempotencyKey: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  const to = String(payload.to || "");
  if (!apiKey || !from) throw new Error("Email reminders require RESEND_API_KEY and RESEND_FROM_EMAIL");
  if (!to) throw new Error("Participant email address is missing");

  const participant = escapeHtml(String(payload.participantName || "there"));
  const group = escapeHtml(String(payload.groupTitle || "your shared expense"));
  const currency = String(payload.currencyCode || "INR");
  const balance = formatAmount(Number(payload.outstandingBalance || 0), currency);
  const subject = `Reminder: ${String(payload.groupTitle || "shared expense")} payment pending`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#30291f;line-height:1.6"><h2 style="color:#7b5b35">A quick payment reminder</h2><p>Hi ${participant},</p><p>This is a friendly reminder that your share for <strong>${group}</strong> still has an outstanding balance of <strong>${escapeHtml(balance)}</strong>.</p><p>Please settle it with the person who organized the expense. If you have already paid, you can ignore this message.</p><p style="color:#766d60;font-size:12px">Sent automatically by Chronexa on behalf of the expense group organizer.</p></div>`;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "Idempotency-Key": `${idempotencyKey}:email` },
    body: JSON.stringify({ from, to: [to], subject, html }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Resend email delivery returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
}

async function sendSms(payload: Record<string, unknown>, idempotencyKey: string): Promise<void> {
  const authKey = process.env.MSG91_AUTHKEY;
  const templateId = process.env.MSG91_SMS_TEMPLATE_ID;
  const phone = String(payload.phone || "");
  if (!authKey || !templateId) throw new Error("SMS reminders require MSG91_AUTHKEY and MSG91_SMS_TEMPLATE_ID");
  if (!phone) throw new Error("Participant phone number is missing");

  const currency = String(payload.currencyCode || "INR");
  const balance = formatAmount(Number(payload.outstandingBalance || 0), currency);
  const response = await fetch("https://control.msg91.com/api/v5/flow", {
    method: "POST",
    headers: { authkey: authKey, accept: "application/json", "content-type": "application/json", "idempotency-key": `${idempotencyKey}:sms` },
    body: JSON.stringify({
      template_id: templateId,
      short_url: "0",
      recipients: [{
        mobiles: normalizeIndianMobile(phone),
        VAR1: String(payload.participantName || "there").slice(0, 30),
        VAR2: String(payload.groupTitle || "shared expense").slice(0, 50),
        VAR3: balance.slice(0, 20),
      }],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const responseText = await response.text();
  if (!response.ok) throw new Error(`MSG91 SMS delivery returned HTTP ${response.status}: ${responseText.slice(0, 300)}`);
  try {
    const body = JSON.parse(responseText) as { status?: string; hasError?: boolean; errors?: unknown };
    if (body.hasError === true || body.status?.toLowerCase() === "error") {
      throw new Error(`MSG91 rejected SMS: ${JSON.stringify(body.errors || body).slice(0, 300)}`);
    }
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("MSG91 returned a non-JSON response");
    throw error;
  }
}

export async function deliverReminder(payload: Record<string, unknown>): Promise<void> {
  const idempotencyKey = String(payload.idempotencyKey || payload.reminderId || "");
  if (!idempotencyKey) throw new Error("Reminder idempotency key is required");

  const email = String(payload.to || "").trim();
  const phone = String(payload.phone || "").trim();
  const tasks: Promise<void>[] = [];
  if (email) {
    if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM_EMAIL) throw new Error("Email reminder provider is not configured");
    tasks.push(sendEmail(payload, idempotencyKey));
  }
  if (phone) {
    if (!process.env.MSG91_AUTHKEY || !process.env.MSG91_SMS_TEMPLATE_ID) throw new Error("SMS reminder provider is not configured");
    tasks.push(sendSms(payload, idempotencyKey));
  }
  if (!tasks.length) throw new Error("Participant needs at least an email address or phone number");
  const results = await Promise.allSettled(tasks);
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length) throw new Error(failures.map((failure) => failure.reason instanceof Error ? failure.reason.message : "Reminder channel failed").join("; "));
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
      const { data: share, error: shareError } = await db.from("expense_shares").select("id,user_id,amount_owed,participant_name,email,phone_number,group:expense_groups!inner(id,title,currency_code),repayments(amount,payment_status)").eq("id", item.expense_share_id).eq("user_id", item.user_id).maybeSingle();
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
      await deliver({ reminderId: item.id, idempotencyKey: stableKey, userId: item.user_id, to: share.email, phone: share.phone_number, participantName: share.participant_name, groupTitle: group.title, currencyCode: group.currency_code, outstandingBalance: balance });
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
