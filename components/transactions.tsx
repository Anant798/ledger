"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useLanguage } from "@/components/language-provider";
import { formatLedgerDateTime } from "@/lib/date-format";

type Transaction = {
  id: string; transaction_type: string; direction: "debit" | "credit"; amount: number | string;
  currency_code: string; status: string; description?: string | null; merchant_name?: string | null;
  bank_name?: string | null; payment_provider?: string | null; payment_method?: string | null;
  category?: string | null; external_reference?: string | null; occurred_at: string;
  history?: Array<{ id: string; event_type: string; event_source: string; description?: string | null; metadata: Record<string, unknown>; occurred_at: string }>;
};
type Summary = { currencies: Array<{ currency_code: string; income: number | string; expenses: number | string; refunds: number | string; net: number | string }>; postedCount: number; pendingCount: number };
type FormData = { direction: "debit" | "credit"; transaction_type: string; amount: string; currency_code: string; status: string; category: string; merchant_name: string; description: string; payment_method: string; payment_provider: string; occurred_at: string; external_reference: string };
const blankForm = (): FormData => ({ direction: "debit", transaction_type: "manual", amount: "", currency_code: "INR", status: "completed", category: "", merchant_name: "", description: "", payment_method: "", payment_provider: "manual", occurred_at: new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16), external_reference: "" });
const fieldClass = "w-full rounded border border-[#C9BDA6] bg-white px-3 py-2 text-sm text-[#302B22]";
const money = (amount: number | string, currency: string) => {
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(Number(amount) || 0); }
  catch { return `${currency} ${Number(amount || 0).toFixed(2)}`; }
};

export default function Transactions({ summaryOnly = false }: { summaryOnly?: boolean }) {
  const { text } = useLanguage();
  const pageLimit = 20;
  const [items, setItems] = useState<Transaction[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [pagination, setPagination] = useState({ page: 1, limit: 20, total: 0, totalPages: 0 });
  const [search, setSearch] = useState("");
  const [direction, setDirection] = useState("");
  const [status, setStatus] = useState("");
  const [category, setCategory] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("");
  const [sort, setSort] = useState("occurred_at");
  const [sortDirection, setSortDirection] = useState("desc");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [form, setForm] = useState<FormData>(blankForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [history, setHistory] = useState<Record<string, Transaction["history"]>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (page = 1) => {
    setLoading(true); setError("");
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(pageLimit), sort, sortDirection });
      if (search.trim()) params.set("search", search.trim());
      if (direction) params.set("direction", direction);
      if (status) params.set("status", status);
      if (category) params.set("category", category);
      if (paymentMethod) params.set("payment_method", paymentMethod);
      if (startDate) params.set("startDate", startDate);
      if (endDate) params.set("endDate", endDate);
      const [listResponse, summaryResponse] = await Promise.all([
        fetch(`/api/transactions?${params}`, { cache: "no-store" }),
        fetch("/api/transactions/summary", { cache: "no-store" }),
      ]);
      const listBody = await listResponse.json();
      if (!listResponse.ok) throw new Error(listBody.error || "Unable to load transactions");
      setItems(listBody.transactions || []); setPagination(listBody.pagination);
      if (summaryResponse.ok) setSummary((await summaryResponse.json()).summary);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to load transactions"); }
    finally { setLoading(false); }
  }, [search, direction, status, category, paymentMethod, sort, sortDirection, startDate, endDate]);

  useEffect(() => {
    const handle = window.setTimeout(() => { void load(1); }, 0);
    return () => window.clearTimeout(handle);
  }, [search, direction, status, category, paymentMethod, sort, sortDirection, startDate, endDate, load]);

  useEffect(() => {
    const refreshAfterImport = () => { void load(1); };
    window.addEventListener("ledger:transactions-updated", refreshAfterImport);
    return () => window.removeEventListener("ledger:transactions-updated", refreshAfterImport);
  }, [load]);

  function openCreate() { setEditingId(null); setForm(blankForm()); setFormOpen(true); setError(""); }
  function openEdit(item: Transaction) {
    setEditingId(item.id);
    setForm({ direction: item.direction, transaction_type: item.transaction_type, amount: String(item.amount), currency_code: item.currency_code, status: item.status, category: item.category || "", merchant_name: item.merchant_name || "", description: item.description || "", payment_method: item.payment_method || "", payment_provider: item.payment_provider || "manual", occurred_at: new Date(new Date(item.occurred_at).getTime() - new Date(item.occurred_at).getTimezoneOffset() * 60_000).toISOString().slice(0, 16), external_reference: item.external_reference || "" });
    setFormOpen(true); setError("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError("");
    const payload = { ...form, amount: Number(form.amount), occurred_at: new Date(form.occurred_at).toISOString(), category: form.category.trim() || null, merchant_name: form.merchant_name.trim() || null, description: form.description.trim() || null, payment_method: form.payment_method || null, payment_provider: form.payment_provider || "manual", external_reference: form.external_reference.trim() || null };
    try {
      const response = await fetch(editingId ? `/api/transactions/${editingId}` : "/api/transactions", { method: editingId ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Unable to save transaction");
      setFormOpen(false); await load(1);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to save transaction"); }
    finally { setSaving(false); }
  }

  async function archive(item: Transaction) {
    if (!window.confirm("Archive this transaction? It will be removed from active totals, while its audit history and linked records are retained.")) return;
    setSaving(true); setError("");
    try {
      const response = await fetch(`/api/transactions/${item.id}`, { method: "DELETE" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Unable to archive transaction");
      await load(1);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to archive transaction"); }
    finally { setSaving(false); }
  }

  async function loadHistory(item: Transaction) {
    if (history[item.id]) return;
    const response = await fetch(`/api/transactions/${item.id}`, { cache: "no-store" });
    const body = await response.json();
    if (response.ok) setHistory((current) => ({ ...current, [item.id]: body.transaction.history || [] }));
  }

  const summaryCards = summary && <><div className="mt-5 grid gap-px overflow-hidden border border-[#DED5C6] bg-[#DED5C6] sm:grid-cols-2 xl:grid-cols-4"><SummaryCard label={text("Money in", "आए हुए पैसे")} value={summary.currencies.map((row) => money(row.income, row.currency_code)).join(" · ") || money(0, "INR")} /><SummaryCard label={text("Money out", "खर्च हुए पैसे")} value={summary.currencies.map((row) => money(row.expenses, row.currency_code)).join(" · ") || money(0, "INR")} /><SummaryCard label={text("Refunds", "वापस मिले पैसे")} value={summary.currencies.map((row) => money(row.refunds, row.currency_code)).join(" · ") || money(0, "INR")} /><SummaryCard label={text("Left over", "बाकी पैसे")} value={summary.currencies.map((row) => money(row.net, row.currency_code)).join(" · ") || money(0, "INR")} /></div><p className="mt-1 text-right text-[11px] text-[#897653]">{text("Amounts are shown by currency. Pending payments are not counted.", "रकम मुद्रा के अनुसार दिखाई गई है। बाकी भुगतान अभी नहीं गिने गए हैं।")}</p></>;
  if (summaryOnly) return <section className="border border-[#C9BDA6] bg-[#FBF8F0] p-4 sm:p-6"><div className="flex items-end justify-between gap-3"><div><p className="text-[10px] tracking-[0.25em] text-[#897653]">{text("A QUICK LOOK", "एक नज़र में")}</p><h2 className="mt-2 text-2xl">{text("Money in & out", "आए और खर्च हुए पैसे")}</h2></div><span className="ledger-number text-xs">{loading ? "…" : `${summary?.postedCount ?? 0} ${text("entries", "लेन-देन")}`}</span></div>{summaryCards || <p className="mt-5 text-sm text-[#756C5D]">{loading ? text("Loading your totals…", "आपकी रकम देख रहे हैं…") : error || text("Your totals are not available right now.", "आपकी रकम अभी नहीं दिख पा रही है।")}</p>}</section>;

  return <section className="rounded-xl border border-[#C9BDA6] bg-[#FBF8F0] p-4 sm:p-6">
    <div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-xs tracking-[0.25em] text-[#897653]">{text("YOUR FINANCIAL ACTIVITY", "आपके पैसों का हिसाब")}</p><h2 className="mt-2 text-3xl">{text("Money In & Out", "पैसे आए और गए")}</h2></div><button onClick={openCreate} className="rounded bg-[#715B37] px-4 py-2 text-sm text-white">{text("Add a record", "लेन-देन जोड़ें")}</button></div>
    {summaryCards}
    <div className="mt-5 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      <input className={fieldClass} placeholder={text("Search name, note, or type", "नाम, नोट या किस्म खोजें")} value={search} onChange={(e) => setSearch(e.target.value)} />
      <select className={fieldClass} aria-label={text("Show money in or out", "आए या खर्च हुए पैसे दिखाएँ")} value={direction} onChange={(e) => setDirection(e.target.value)}><option value="">{text("Money in and out", "आए और खर्च हुए पैसे")}</option><option value="credit">{text("Money in", "आए हुए पैसे")}</option><option value="debit">{text("Money out", "खर्च हुए पैसे")}</option></select>
      <select className={fieldClass} aria-label={text("Payment status", "भुगतान की स्थिति")} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">{text("Any status", "सभी स्थितियाँ")}</option>{["completed", "pending", "failed", "cancelled", "partially_refunded", "refunded"].map((s) => <option key={s} value={s}>{s.replaceAll("_", " ")}</option>)}</select>
      <input className={fieldClass} placeholder={text("Find a type", "किस्म खोजें")} value={category} onChange={(e) => setCategory(e.target.value)} />
      <select className={fieldClass} aria-label={text("Payment method", "भुगतान का तरीका")} value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}><option value="">{text("Any payment method", "कोई भी तरीका")}</option>{["cash", "upi", "card", "bank_transfer", "wallet", "cheque", "other"].map((m) => <option key={m} value={m}>{m.replaceAll("_", " ")}</option>)}</select>
      <label className="text-xs text-[#756C5D]">{text("From", "से")}<input aria-label={text("Start date", "शुरू की तारीख")} type="date" className={`${fieldClass} mt-1`} value={startDate} onChange={(e) => setStartDate(e.target.value)} /></label>
      <label className="text-xs text-[#756C5D]">{text("To", "तक")}<input aria-label={text("End date", "आख़िरी तारीख")} type="date" className={`${fieldClass} mt-1`} value={endDate} onChange={(e) => setEndDate(e.target.value)} /></label>
      <select className={fieldClass} aria-label={text("Sort records", "लेन-देन क्रम से दिखाएँ")} value={sort} onChange={(e) => setSort(e.target.value)}><option value="occurred_at">{text("By date", "तारीख़ से")}</option><option value="amount">{text("By amount", "रकम से")}</option><option value="merchant_name">{text("By name", "नाम से")}</option><option value="created_at">{text("By date added", "जोड़ने की तारीख़ से")}</option></select>
      <select className={fieldClass} aria-label={text("Order", "क्रम")} value={sortDirection} onChange={(e) => setSortDirection(e.target.value)}><option value="desc">{text("Newest / highest first", "नया / ज़्यादा पहले")}</option><option value="asc">{text("Oldest / lowest first", "पुराना / कम पहले")}</option></select>
    </div>
    {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
    {formOpen && <form onSubmit={submit} className="mt-5 rounded-lg border border-[#C9BDA6] bg-white p-4">
      <div className="flex items-center justify-between"><h3 className="font-serif text-xl">{editingId ? text("Edit record", "लेन-देन बदलें") : text("Add a record", "लेन-देन जोड़ें")}</h3><button type="button" onClick={() => setFormOpen(false)} className="text-sm underline">{text("Close", "बंद करें")}</button></div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-xs text-[#756C5D]">{text("Money in or out", "पैसे आए या खर्च हुए")}<select className={`${fieldClass} mt-1`} value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value as FormData["direction"] })}><option value="debit">{text("Money out", "खर्च हुए पैसे")}</option><option value="credit">{text("Money in", "आए हुए पैसे")}</option></select></label>
        <label className="text-xs text-[#756C5D]">{text("Amount", "रकम")}<input required min="0.01" step="0.01" type="number" className={`${fieldClass} mt-1`} value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></label>
        <label className="text-xs text-[#756C5D]">{text("Currency code", "मुद्रा का कोड")}<input required maxLength={3} className={`${fieldClass} mt-1 uppercase`} value={form.currency_code} onChange={(e) => setForm({ ...form, currency_code: e.target.value.toUpperCase() })} /></label>
        <label className="text-xs text-[#756C5D]">Transaction kind<select className={`${fieldClass} mt-1`} value={form.transaction_type} onChange={(e) => setForm({ ...form, transaction_type: e.target.value })}>{["manual", "payment", "refund", "reversal", "other"].map((t) => <option key={t} value={t}>{t.replaceAll("_", " ")}</option>)}</select></label>
        <label className="text-xs text-[#756C5D]">{text("Type", "किस्म")}<input maxLength={100} className={`${fieldClass} mt-1`} placeholder={text("Food, pay, travel…", "खाना, वेतन, सफ़र…")} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} /></label>
        <label className="text-xs text-[#756C5D]">{text("Who was it paid to?", "किसे पैसे दिए?")}<input maxLength={200} className={`${fieldClass} mt-1`} value={form.merchant_name} onChange={(e) => setForm({ ...form, merchant_name: e.target.value })} /></label>
        <label className="text-xs text-[#756C5D]">Payment method<select className={`${fieldClass} mt-1`} value={form.payment_method} onChange={(e) => setForm({ ...form, payment_method: e.target.value })}><option value="">Not specified</option>{["cash", "upi", "card", "bank_transfer", "wallet", "cheque", "other"].map((m) => <option key={m} value={m}>{m.replaceAll("_", " ")}</option>)}</select></label>
        <label className="text-xs text-[#756C5D]">{text("Status", "स्थिति")}<select className={`${fieldClass} mt-1`} value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>{["completed", "pending", "failed", "cancelled", "partially_refunded", "refunded"].map((s) => <option key={s} value={s}>{s.replaceAll("_", " ")}</option>)}</select></label>
        <label className="text-xs text-[#756C5D]">{text("Date and time", "तारीख़ और समय")}<input required type="datetime-local" className={`${fieldClass} mt-1`} value={form.occurred_at} onChange={(e) => setForm({ ...form, occurred_at: e.target.value })} /></label>
        <label className="text-xs text-[#756C5D]">Source / provider<input maxLength={100} className={`${fieldClass} mt-1`} value={form.payment_provider} onChange={(e) => setForm({ ...form, payment_provider: e.target.value })} /></label>
        <label className="text-xs text-[#756C5D] sm:col-span-2">{text("Note", "नोट")}<input maxLength={500} className={`${fieldClass} mt-1`} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
        <label className="text-xs text-[#756C5D]">Reference<input maxLength={100} className={`${fieldClass} mt-1`} value={form.external_reference} onChange={(e) => setForm({ ...form, external_reference: e.target.value })} /></label>
      </div>
      <button disabled={saving} className="mt-4 rounded bg-[#715B37] px-4 py-2 text-sm text-white disabled:opacity-50">{saving ? text("Saving…", "सेव हो रहा है…") : editingId ? text("Save changes", "बदलाव सेव करें") : text("Add record", "लेन-देन जोड़ें")}</button>
    </form>}
    <div className="mt-5 overflow-hidden rounded-lg border border-[#DED5C6] bg-white">
      {loading ? <p className="p-5 text-sm text-[#756C5D]">Loading transactions…</p> : items.length === 0 ? <p className="p-5 text-sm text-[#756C5D]">No transactions match these filters.</p> : items.map((item) => <details key={item.id} className="border-b border-[#E8E0D2] last:border-0" onToggle={(e) => { if (e.currentTarget.open) void loadHistory(item); }}>
        <summary className="grid cursor-pointer list-none gap-2 p-4 sm:grid-cols-[1fr_auto_auto] sm:items-center"><span><strong className="block text-sm">{item.merchant_name || item.description || "Transaction"}</strong><small className="text-xs text-[#897653]">{item.category || "Uncategorized"} · {formatLedgerDateTime(item.occurred_at)} · {item.payment_method || item.payment_provider || "Payment method unspecified"}</small></span><span className={`text-sm font-semibold ${item.direction === "credit" ? "text-green-800" : "text-[#51452F]"}`}>{item.direction === "credit" ? "+" : "−"}{money(item.amount, item.currency_code)}</span><span className="text-xs capitalize text-[#756C5D]">{item.status.replaceAll("_", " ")}</span></summary>
        <div className="bg-[#FBF8F0] px-4 pb-4"><div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[#756C5D]"><span>Kind: {item.transaction_type.replaceAll("_", " ")}</span>{item.bank_name && <span>Bank: {item.bank_name}</span>}{item.external_reference && <span>Reference: {item.external_reference}</span>}</div>
          <div className="mt-3 flex flex-wrap gap-4"><button className="text-xs text-[#715B37] underline" onClick={() => openEdit(item)}>Edit</button>{item.direction === "debit" && item.status === "completed" && <button className="text-xs text-[#715B37] underline" onClick={() => { window.location.href = `/dashboard/groups?transactionId=${encodeURIComponent(item.id)}`; }}>Convert to expense group</button>}<button disabled={saving} className="text-xs text-red-700 underline" onClick={() => void archive(item)}>Archive</button></div>
          <h4 className="mt-3 text-xs font-semibold uppercase tracking-wide text-[#897653]">History</h4>{history[item.id] ? <ul className="mt-1 space-y-1">{history[item.id]?.map((entry) => <li key={entry.id} className="text-xs text-[#756C5D]">{formatLedgerDateTime(entry.occurred_at)} · {entry.description || entry.event_type} · {entry.event_source}{typeof entry.metadata?.changes === "object" && entry.metadata.changes !== null ? <span className="block">Changed: {Object.keys(entry.metadata.changes as object).join(", ")}</span> : null}</li>)}</ul> : <p className="mt-1 text-xs text-[#897653]">Loading event history…</p>}
        </div>
      </details>)}
    </div>
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm"><span className="text-[#756C5D]">{pagination.total} transactions · page {pagination.page} of {Math.max(1, pagination.totalPages)}</span><div className="flex gap-2"><button disabled={loading || pagination.page <= 1} className="rounded border border-[#C9BDA6] px-3 py-1.5 disabled:opacity-40" onClick={() => void load(pagination.page - 1)}>Previous</button><button disabled={loading || pagination.page >= pagination.totalPages} className="rounded border border-[#C9BDA6] px-3 py-1.5 disabled:opacity-40" onClick={() => void load(pagination.page + 1)}>Next</button></div></div>
  </section>;
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return <div className="bg-[#FBF8F0] px-4 py-3"><p className="text-[10px] uppercase tracking-wider text-[#817766]">{label}</p><p className="ledger-amount mt-1 text-lg font-semibold text-[#51452F]">{value}</p></div>;
}
