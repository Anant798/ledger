"use client";

import { useCallback, useEffect, useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { formatLedgerDateTime } from "@/lib/date-format";

type Review = {
  id: string; amount: number | null; direction: "debit" | "credit" | null;
  currency_code: string | null; transaction_type: string; occurred_at: string;
  occurred_at_source: "bank_provided" | "email_received_fallback" | null;
  category: string | null;
  merchant_name: string | null; bank_name: string | null; payment_provider: string | null;
  external_reference: string | null; description: string | null; uncertain_reason: string | null;
  raw_snippet: string | null;
  confidence: number | null;
};
type Connection = { emailAddress: string | null; syncStatus: string; lastError: string | null; lastSyncedAt: string | null; initialSyncCompleted: boolean };
type Corrections = { amount: string; direction: string; currency_code: string; transaction_type: string; occurred_at: string; merchant_name: string; bank_name: string; payment_provider: string; external_reference: string; description: string; category: string };
const inputClass = "w-full rounded border border-[#C9BDA6] bg-white px-2 py-1.5 text-sm";
const toLocalInput = (date: string) => {
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? "" : new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

export default function GmailBankAlerts() {
  const { text } = useLanguage();
  const [connected, setConnected] = useState(false);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [corrections, setCorrections] = useState<Record<string, Corrections>>({});
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const [statusResponse, reviewResponse] = await Promise.all([
      fetch("/api/integrations/gmail/connection", { cache: "no-store" }),
      fetch("/api/transactions/review-queue", { cache: "no-store" }),
    ]);
    const statusBody = await statusResponse.json();
    const reviewBody = await reviewResponse.json();
    if (!statusResponse.ok) throw new Error(statusBody.error || "Unable to load Gmail status");
    if (!reviewResponse.ok) throw new Error(reviewBody.error || "Unable to load review queue");
    setConnected(statusBody.connected);
    setConnection(statusBody.connection);
    setReviews(reviewBody.reviewQueue || []);
    setCorrections((current) => {
      const next = { ...current };
      for (const row of reviewBody.reviewQueue || []) if (!next[row.id]) next[row.id] = {
        amount: row.amount == null ? "" : String(row.amount), direction: row.direction || "debit",
        currency_code: row.currency_code || "", transaction_type: row.transaction_type || "payment",
        category: row.category || "Uncategorized",
        occurred_at: row.occurred_at_source ? toLocalInput(row.occurred_at) : row.uncertain_reason?.includes("transaction date/time needs confirmation") ? "" : toLocalInput(row.occurred_at), merchant_name: row.merchant_name || "",
        bank_name: row.bank_name || "", payment_provider: row.payment_provider || "",
        external_reference: row.external_reference || "", description: row.description || "",
      };
      return next;
    });
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refresh().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Unable to load Gmail status"));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  function update(id: string, field: keyof Corrections, value: string) {
    setCorrections((current) => ({ ...current, [id]: { ...current[id], [field]: value } }));
  }

  async function connect() {
    setBusy("connect"); setError("");
    try {
      const response = await fetch("/api/integrations/gmail/auth"); const body = await response.json();
      if (!response.ok || !body.authUrl) throw new Error(body.error || "Unable to connect Gmail");
      window.location.assign(body.authUrl);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to connect Gmail"); setBusy(""); }
  }

  async function sync(full = false) {
    setBusy(full ? "full-sync" : "sync"); setError(""); setMessage("");
    try {
      const response = await fetch("/api/integrations/gmail/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ forceFullSync: full, fetchAllPages: false, maxResults: 50 }) });
      const responseText = await response.text();
      let body: { error?: string; result?: { importedCount: number; reviewQueuedCount: number; ignoredCount: number; errorsCount: number } };
      try {
        body = JSON.parse(responseText) as typeof body;
      } catch {
        const detail = responseText.trim().slice(0, 240) || "Empty response";
        throw new Error(`Gmail sync returned a non-JSON response (HTTP ${response.status}): ${detail}`);
      }
      if (!response.ok) throw new Error(body.error || `Gmail sync failed (HTTP ${response.status})`);
      if (!body.result) throw new Error("Gmail sync response did not include a result.");
      const result = body.result;
      setMessage(`Sync finished: ${result.importedCount} imported, ${result.reviewQueuedCount} to review, ${result.ignoredCount} ignored, ${result.errorsCount} errors.`);
      window.dispatchEvent(new Event("ledger:transactions-updated"));
      await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Gmail sync failed"); }
    finally { setBusy(""); }
  }

  async function resolve(row: Review, action: "approve" | "reject") {
    setBusy(row.id); setError("");
    try {
      const fields = corrections[row.id];
      if (action === "approve" && (!fields.amount || !fields.occurred_at || !fields.currency_code || !fields.direction)) throw new Error("Amount, direction, currency and date/time are required.");
      const updates = action === "approve" ? {
        ...fields, amount: Number(fields.amount), occurred_at: new Date(fields.occurred_at).toISOString(),
        merchant_name: fields.merchant_name.trim(), bank_name: fields.bank_name.trim(),
        payment_provider: fields.payment_provider.trim(), external_reference: fields.external_reference.trim(),
        description: fields.description.trim(),
        category: fields.category.trim(),
      } : undefined;
      const response = await fetch("/api/transactions/review-queue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reviewId: row.id, action, updates }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Unable to resolve this alert");
      setMessage(action === "approve" ? "Transaction approved and added to your ledger." : "Alert rejected.");
      if (action === "approve") window.dispatchEvent(new Event("ledger:transactions-updated"));
      await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to resolve this alert"); }
    finally { setBusy(""); }
  }

  async function disconnect() {
    if (!window.confirm("Disconnect Gmail? Imported transactions and review history will remain in your ledger.")) return;
    setBusy("disconnect"); setError("");
    try {
      const response = await fetch("/api/integrations/gmail/connection", { method: "DELETE" }); const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Unable to disconnect Gmail");
      setMessage(body.remoteRevoked ? "Gmail disconnected and Google access revoked." : "Gmail disconnected locally. Google access could not be revoked automatically.");
      await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to disconnect Gmail"); }
    finally { setBusy(""); }
  }

  return <section className="rounded-xl border border-[#C9BDA6] bg-[#FBF8F0] p-4 sm:p-6">
    <div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-xs tracking-[0.25em] text-[#897653]">{text("BANK EMAILS", "बैंक के ईमेल")}</p><h2 className="mt-2 font-serif text-3xl">{text("Bank email alerts", "बैंक के ईमेल अलर्ट")}</h2><p className="mt-1 text-sm text-[#756C5D]">{text("Connect Gmail to find bank alerts. You can check and edit each record.", "बैंक के अलर्ट देखने के लिए Gmail जोड़ें। आप हर रिकॉर्ड जाँच और बदल सकते हैं।")}</p></div>
      {!connected ? <button disabled={Boolean(busy)} onClick={() => void connect()} className="rounded bg-[#715B37] px-4 py-2 text-sm text-white">{text("Connect Gmail", "Gmail जोड़ें")}</button> : <div className="flex flex-wrap gap-2"><button disabled={Boolean(busy)} onClick={() => void sync()} className="rounded bg-[#715B37] px-4 py-2 text-sm text-white">{busy === "sync" ? text("Checking…", "देख रहे हैं…") : text("Check now", "अभी देखें")}</button><button disabled={Boolean(busy)} onClick={() => void sync(true)} className="rounded border border-[#C9BDA6] px-3 py-2 text-sm">{text("Check all again", "सभी फिर से देखें")}</button><button disabled={Boolean(busy)} onClick={() => void disconnect()} className="px-3 py-2 text-sm text-red-700 underline">{text("Disconnect Gmail", "Gmail हटाएँ")}</button></div>}
    </div>
    {connected && connection && <p className="mt-3 text-xs text-[#756C5D]">Connected as {connection.emailAddress || "Gmail account"} · Sync: {connection.syncStatus}{connection.lastSyncedAt ? ` · Last synced ${formatLedgerDateTime(connection.lastSyncedAt)}` : connection.initialSyncCompleted ? "" : " · Initial sync pending"}</p>}
    {connection?.lastError && <p className="mt-2 text-sm text-amber-800">Last sync issue: {connection.lastError}</p>}
    {message && <p role="status" className="mt-3 text-sm text-green-800">{message}</p>}{error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
    {reviews.length > 0 && <div className="mt-6 space-y-4"><h3 className="font-serif text-2xl">Needs review ({reviews.length})</h3>{reviews.map((row) => {
      const value = corrections[row.id]; if (!value) return null;
      return <article key={row.id} className="rounded-lg border border-[#DED5C6] bg-white p-4"><div className="flex flex-wrap justify-between gap-2"><strong>{row.bank_name || "Bank alert"} {row.confidence != null && <span className="text-xs font-normal text-[#756C5D]">· {Math.round(row.confidence * 100)}% extraction confidence</span>}</strong><span className="text-xs text-[#756C5D]">{row.uncertain_reason}</span></div>{row.occurred_at_source === "email_received_fallback" && <p className="mt-2 text-xs text-amber-800">Transaction date is from the bank email. Time is from the email received timestamp and is not bank-confirmed.</p>}{row.occurred_at_source === "bank_provided" && <p className="mt-2 text-xs text-[#756C5D]">Date and time were provided in the bank email.</p>}{row.raw_snippet && <p className="mt-2 whitespace-pre-wrap rounded bg-[#FBF8F0] p-2 text-xs text-[#756C5D]">{row.raw_snippet}</p>}
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {([ ["amount","Amount"], ["direction","Direction"], ["currency_code","Currency"], ["transaction_type","Kind"], ["category","Category"], ["occurred_at","Date and time"], ["merchant_name","Merchant / sender"], ["bank_name","Bank"], ["payment_provider","Provider"], ["external_reference","Reference"], ["description","Description"] ] as const).map(([field,label]) => <label key={field} className="text-xs text-[#756C5D]">{label}{field === "direction" ? <select className={`${inputClass} mt-1`} value={value.direction} onChange={(e) => update(row.id, field, e.target.value)}><option value="debit">Debit / expense</option><option value="credit">Credit / income</option></select> : field === "transaction_type" ? <select className={`${inputClass} mt-1`} value={value.transaction_type} onChange={(e) => update(row.id, field, e.target.value)}>{["payment","refund","reversal","other"].map((kind) => <option key={kind} value={kind}>{kind}</option>)}</select> : <input className={`${inputClass} mt-1`} type={field === "amount" ? "number" : field === "occurred_at" ? "datetime-local" : "text"} min={field === "amount" ? "0.01" : undefined} step={field === "amount" ? "0.01" : undefined} maxLength={field === "currency_code" ? 3 : field === "category" ? 100 : undefined} value={value[field]} onChange={(e) => update(row.id, field, field === "currency_code" ? e.target.value.toUpperCase() : e.target.value)} />}</label>)}
        </div><div className="mt-3 flex gap-3"><button disabled={Boolean(busy)} onClick={() => void resolve(row,"approve")} className="rounded bg-[#715B37] px-3 py-2 text-sm text-white">{busy === row.id ? "Saving…" : "Approve transaction"}</button><button disabled={Boolean(busy)} onClick={() => void resolve(row,"reject")} className="rounded border border-[#C9BDA6] px-3 py-2 text-sm">Reject alert</button></div>
      </article>;
    })}</div>}
  </section>;
}
