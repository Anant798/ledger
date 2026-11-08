"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { calculateSplit } from "@/lib/shared-expenses/calculations";
import { useLanguage } from "@/components/language-provider";

type Participant = {
  id: string;
  participant_name: string;
  participant_type: "owner" | "contact";
  amount_owed: number | string;
  email?: string | null;
  phone_number?: string | null;
  is_active?: boolean;
  repayments?: Array<{ id: string; amount: number | string; payment_status: string; payment_method?: string; confirmed_at?: string | null; created_at?: string; reversal_reason?: string | null; events?: Array<{ id: string; event_type: string; event_source: string; metadata: Record<string, unknown>; created_at: string }> }>;
  settlementHistory?: Array<{ id: string; amount: number | string; payment_status: string; confirmed_at?: string | null; created_at?: string }>;
  totalRepaid?: number;
  outstandingBalance?: number;
  isSettled?: boolean;
}

type ExpenseGroup = {
  id: string;
  title: string;
  total_amount: number | string;
  currency_code: string;
  split_method: "equal" | "custom";
  transaction_id?: string | null;
  archived_at?: string | null;
  shares: Participant[];
  totalOwed: number;
  totalRepaid: number;
  outstandingBalance: number;
  isFullySettled: boolean;
}

type Transaction = { id: string; description?: string | null; merchant_name?: string | null; amount: number | string; currency_code: string; occurred_at: string };
type DraftParticipant = { id?: string; name: string; type: "self" | "external"; email: string; phone: string; amount: string };
type ExpenseForm = { title: string; total: string; currency: string; split: "equal" | "custom" | "percentage"; transactionId: string; participants: DraftParticipant[] };

const blankParticipant = (): DraftParticipant => ({ name: "", type: "external", email: "", phone: "", amount: "" });
const blankForm = (): ExpenseForm => ({ title: "", total: "", currency: "INR", split: "equal", transactionId: "", participants: [blankParticipant()] });

function money(value: number | string, currency = "INR") {
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(Number(value) || 0); }
  catch { return `${currency} ${Number(value || 0).toFixed(2)}`; }
}

function paymentHistory(group: ExpenseGroup) {
  return group.shares.flatMap((share) => share.repayments || []);
}

export default function ExpenseGroups() {
  const { text } = useLanguage();
  const [groups, setGroups] = useState<ExpenseGroup[]>([]);
  const [archived, setArchived] = useState(false);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingLocked, setEditingLocked] = useState(false);
  const [form, setForm] = useState<ExpenseForm>(blankForm);
  const [repayingShare, setRepayingShare] = useState<string | null>(null);
  const [repaymentAmount, setRepaymentAmount] = useState("");
  const repaymentKeys = useRef<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [groupResponse, transactionResponse] = await Promise.all([
        fetch(`/api/shared-expenses${archived ? "?archived=true" : ""}`, { cache: "no-store" }),
        fetch("/api/transactions?limit=50&page=1", { cache: "no-store" }),
      ]);
      const groupBody = await groupResponse.json();
      if (!groupResponse.ok) throw new Error(groupBody.error || "Could not load shared expenses");
      setGroups(groupBody.expenses || []);
      if (transactionResponse.ok) {
        const transactionBody = await transactionResponse.json();
        setTransactions(transactionBody.transactions || []);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load shared expenses");
    } finally {
      setLoading(false);
    }
  }, [archived]);

  useEffect(() => {
    const handle = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(handle);
  }, [load]);

  const formTotal = Number(form.total) || 0;
  const splitInputs = form.participants.map((participant) => Number(participant.amount) || 0);
  const preview = (() => {
    if (!formTotal || !form.participants.length) return [];
    const method = form.split === "percentage" ? "percentage" : form.split;
    try { return calculateSplit(formTotal, method, splitInputs); }
    catch { return []; }
  })();

  function openCreate() {
    setEditingId(null);
    setEditingLocked(false);
    setForm(blankForm());
    setFormOpen(true);
    setError("");
  }

  function openEdit(group: ExpenseGroup) {
    const hasRepayments = paymentHistory(group).length > 0;
    setEditingId(group.id);
    setEditingLocked(hasRepayments);
    setForm({
      title: group.title,
      total: String(group.total_amount),
      currency: group.currency_code,
      split: group.split_method,
      transactionId: group.transaction_id || "",
      participants: group.shares.filter((share) => share.is_active !== false).map((share) => ({
        id: share.id,
        name: share.participant_name,
        type: share.participant_type === "owner" ? "self" : "external",
        email: share.email || "",
        phone: share.phone_number || "",
        amount: String(share.amount_owed),
      })),
    });
    setFormOpen(true);
    setError(hasRepayments ? "This expense has payment history. Its total, currency, linked transaction, and participants are locked to preserve the repayment record; you can update the title." : "");
  }

  function changeParticipant(index: number, field: keyof DraftParticipant, value: string) {
    setForm((current) => ({
      ...current,
      participants: current.participants.map((participant, participantIndex) => participantIndex === index ? { ...participant, [field]: value } : participant),
    }));
  }

  async function submitExpense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const payload = {
        title: form.title,
        total_amount: Number(form.total),
        currency_code: form.currency,
        split_method: form.split,
        transaction_id: form.transactionId || null,
        participants: form.participants.map((participant) => ({
          ...(participant.id ? { id: participant.id } : {}),
          participant_name: participant.name,
          participant_type: participant.type,
          email: participant.email || null,
          phone_number: participant.phone || null,
          amount_owed: form.split === "equal" ? undefined : Number(participant.amount),
        })),
      };
      const response = await fetch(editingId ? `/api/shared-expenses/${editingId}` : "/api/shared-expenses", {
        method: editingId ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not save expense");
      setFormOpen(false);
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save expense");
    } finally {
      setSaving(false);
    }
  }

  async function archiveGroup(group: ExpenseGroup, restore = false) {
    const confirmed = restore || window.confirm(`Archive “${group.title}”? Its repayment and reminder history will be retained.`);
    if (!confirmed) return;
    setError("");
    try {
      const response = await fetch(`/api/shared-expenses/${group.id}`, {
        method: restore ? "PATCH" : "DELETE",
        headers: restore ? { "content-type": "application/json" } : undefined,
        body: restore ? JSON.stringify({ archived: false }) : undefined,
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not update expense group");
      await load();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Could not update expense group");
    }
  }

  async function recordRepayment(group: ExpenseGroup, share: Participant) {
    const amount = Number(repaymentAmount);
    if (!amount || amount <= 0) return;
    setSaving(true);
    setError("");
    const idempotencyKey = repaymentKeys.current[share.id] || (repaymentKeys.current[share.id] = crypto.randomUUID());
    try {
      const response = await fetch("/api/shared-expenses/repayments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expense_share_id: share.id,
          amount,
          currency_code: group.currency_code,
          payment_method: "other",
          idempotency_key: idempotencyKey,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not record repayment");
      delete repaymentKeys.current[share.id];
      setRepayingShare(null);
      setRepaymentAmount("");
      await load();
    } catch (repaymentError) {
      setError(repaymentError instanceof Error ? repaymentError.message : "Could not record repayment");
    } finally {
      setSaving(false);
    }
  }

  async function updateRepayment(id: string, input: { amount: number; payment_method: string; idempotency_key: string }) {
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/shared-expenses/repayments/${id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "edit", ...input }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not update repayment");
      await load();
      return true;
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "Could not update repayment");
      return false;
    } finally { setSaving(false); }
  }

  async function reverseRepayment(id: string, reason: string) {
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/shared-expenses/repayments/${id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "reverse", reason }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not reverse repayment");
      await load();
      return true;
    } catch (reverseError) {
      setError(reverseError instanceof Error ? reverseError.message : "Could not reverse repayment");
      return false;
    } finally { setSaving(false); }
  }

  const activeBalance = groups.reduce((sum, group) => sum + group.outstandingBalance, 0);

  return (
    <section className="mx-auto max-w-6xl border border-[#C9BDA6] bg-[#FBF8F0] p-4 sm:p-6">
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
            <p className="text-xs font-semibold uppercase tracking-[0.25em] text-[#8B754F]">{text("SHARED COSTS", "साझा खर्च")}</p>
          <h2 className="mt-2 font-serif text-3xl text-[#302B22]">{text("Group Payments", "साझा भुगतान")}</h2>
          <p className="mt-2 max-w-xl text-sm text-[#756C5D]">{text("Split shared costs and see how much money you are waiting to get back.", "साझा खर्च बाँटें और देखें कि कितने पैसे वापस मिलने हैं।")}</p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => setArchived((value) => !value)} className="border border-[#C9BDA6] bg-[#FAF7EF] px-4 py-2.5 text-sm text-[#51452F] hover:bg-[#F0EBDD]">
            {archived ? text("Open costs", "चालू खर्च") : text("Closed costs", "बंद खर्च")}
          </button>
          {!archived && <button onClick={openCreate} className="bg-[#51452F] px-5 py-2.5 text-sm font-medium text-white hover:bg-[#6B593B]">+ {text("Add shared cost", "साझा खर्च जोड़ें")}</button>}
        </div>
      </div>

      {error && <div role="alert" className="mb-5 border border-[#C98D78] bg-[#FBF0EA] px-4 py-3 text-sm text-[#7B3E2E]">{error}</div>}

      {!archived && <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <SummaryCard label={text("Money still owed you", "आपको मिलने वाले पैसे")} value={money(activeBalance)} />
        <SummaryCard label={text("Open costs", "चालू खर्च")} value={String(groups.length)} />
        <SummaryCard label={text("Paid in full", "पूरा भुगतान हुआ")} value={String(groups.filter((group) => group.isFullySettled).length)} />
      </div>}

      {loading ? <div className="border border-[#DDD3C0] bg-[#FAF7EF] p-8 text-center text-sm text-[#756C5D]">Loading expenses…</div>
        : groups.length === 0 ? <div className="border border-dashed border-[#C9BDA6] bg-[#FAF7EF] p-10 text-center">
          <h3 className="font-serif text-xl text-[#302B22]">{archived ? "No archived expenses" : "No shared expenses yet"}</h3>
          <p className="mx-auto mt-2 max-w-md text-sm text-[#756C5D]">{archived ? "Archived expenses stay here with their participant and repayment history." : "Add an expense, choose who shared it, and Ledger will track the amount each person owes you."}</p>
          {!archived && <button onClick={openCreate} className="mt-5 bg-[#51452F] px-5 py-2.5 text-sm text-white hover:bg-[#6B593B]">Create your first expense</button>}
        </div>
        : <div className="grid gap-5 lg:grid-cols-2">
          {groups.map((group) => <ExpenseCard key={group.id} group={group} archived={archived} onEdit={() => openEdit(group)} onArchive={() => void archiveGroup(group)} onRestore={() => void archiveGroup(group, true)} repayingShare={repayingShare} setRepayingShare={setRepayingShare} repaymentAmount={repaymentAmount} setRepaymentAmount={setRepaymentAmount} onRepayment={(share) => void recordRepayment(group, share)} onUpdateRepayment={updateRepayment} onReverseRepayment={reverseRepayment} saving={saving} />)}
        </div>}

      {formOpen && <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-[#1D1A14]/60 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setFormOpen(false); }}>
        <div role="dialog" aria-modal="true" aria-labelledby="expense-form-title" className="my-6 max-h-[92vh] w-full max-w-2xl overflow-y-auto border border-[#C9BDA6] bg-[#FAF7EF] shadow-2xl">
          <form onSubmit={submitExpense}>
            <div className="sticky top-0 z-10 flex items-start justify-between border-b border-[#DDD3C0] bg-[#FAF7EF] px-6 py-5">
              <div><p className="text-xs uppercase tracking-[0.2em] text-[#8B754F]">Shared expense</p><h3 id="expense-form-title" className="mt-1 font-serif text-2xl">{editingId ? "Edit expense" : "Add expense"}</h3></div>
              <button type="button" aria-label="Close" onClick={() => setFormOpen(false)} className="px-2 py-1 text-xl text-[#756C5D]">×</button>
            </div>
            <div className="space-y-5 px-6 py-5">
              <label className="block text-sm font-medium text-[#51452F]">Expense name
                <input required maxLength={200} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} className="mt-1.5 w-full border border-[#CFC3AE] bg-white px-3 py-2.5 outline-none focus:border-[#8B754F]" placeholder="Dinner, trip, utilities…" />
              </label>
              <div className="grid gap-4 sm:grid-cols-[1fr_130px]">
              <label className="block text-sm font-medium text-[#51452F]">Total expense
                  <input required type="number" min="0.01" step="0.01" disabled={editingLocked} value={form.total} onChange={(event) => setForm({ ...form, total: event.target.value })} className="mt-1.5 w-full border border-[#CFC3AE] bg-white px-3 py-2.5 outline-none focus:border-[#8B754F] disabled:bg-[#F0EBDD]" placeholder="0.00" />
                </label>
                <label className="block text-sm font-medium text-[#51452F]">Currency
                  <select disabled={editingLocked} value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value })} className="mt-1.5 w-full border border-[#CFC3AE] bg-white px-3 py-2.5 disabled:bg-[#F0EBDD]">
                    {["INR", "USD", "EUR", "GBP", "CAD", "AUD", "SGD"].map((currency) => <option key={currency}>{currency}</option>)}
                  </select>
                </label>
              </div>
              <label className="block text-sm font-medium text-[#51452F]">Link a transaction <span className="font-normal text-[#8A8174]">(optional)</span>
                <select disabled={editingLocked} value={form.transactionId} onChange={(event) => setForm({ ...form, transactionId: event.target.value })} className="mt-1.5 w-full border border-[#CFC3AE] bg-white px-3 py-2.5 disabled:bg-[#F0EBDD]">
                  <option value="">No linked transaction</option>
                  {transactions.map((transaction) => <option value={transaction.id} key={transaction.id}>{transaction.merchant_name || transaction.description || "Transaction"} · {money(transaction.amount, transaction.currency_code)} · {new Date(transaction.occurred_at).toLocaleDateString()}</option>)}
                </select>
              </label>
              <div>
                <label className="block text-sm font-medium text-[#51452F]">Split method</label>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  {(["equal", "custom", "percentage"] as const).map((split) => <button key={split} disabled={editingLocked} type="button" onClick={() => setForm({ ...form, split })} className={`border px-3 py-2 text-sm capitalize disabled:opacity-50 ${form.split === split ? "border-[#51452F] bg-[#51452F] text-white" : "border-[#C9BDA6] bg-white text-[#51452F]"}`}>{split === "custom" ? "Amounts" : split}</button>)}
                </div>
                <p className="mt-2 text-xs text-[#817766]">Include yourself if you want your portion listed. Other participants’ balances show as owed to you.</p>
              </div>
              <div className="space-y-3">
                <div className="flex items-center justify-between"><h4 className="text-sm font-semibold text-[#51452F]">Participants</h4><button type="button" disabled={editingLocked} onClick={() => setForm({ ...form, participants: [...form.participants, blankParticipant()] })} className="text-sm font-medium text-[#715B37] underline disabled:opacity-50">+ Add person</button></div>
                {form.participants.map((participant, index) => <div key={participant.id || `person-${index}`} className="grid gap-2 border border-[#DDD3C0] bg-white p-3 sm:grid-cols-[1fr_125px_1fr_auto]">
                  <div className="space-y-2">
                    <input required maxLength={100} value={participant.name} onChange={(event) => changeParticipant(index, "name", event.target.value)} className="w-full border border-[#DED5C6] px-2.5 py-2 text-sm" placeholder="Name" />
                    <select disabled={editingLocked} value={participant.type} onChange={(event) => changeParticipant(index, "type", event.target.value)} className="w-full border border-[#DED5C6] px-2.5 py-2 text-sm disabled:bg-[#F0EBDD]"><option value="external">Participant</option><option value="self">You (payer)</option></select>
                  </div>
                  <div className="space-y-2">
                    {form.split !== "equal" && <input required disabled={editingLocked} type="number" min="0.01" step="0.01" value={participant.amount} onChange={(event) => changeParticipant(index, "amount", event.target.value)} className="w-full border border-[#DED5C6] px-2.5 py-2 text-sm disabled:bg-[#F0EBDD]" placeholder={form.split === "percentage" ? "% share" : "Amount"} />}
                    <span className="block text-xs text-[#756C5D]">Share: {preview[index] === undefined ? "—" : money(preview[index], form.currency)}</span>
                  </div>
                  <div className="space-y-2"><input type="email" value={participant.email} onChange={(event) => changeParticipant(index, "email", event.target.value)} className="w-full border border-[#DED5C6] px-2.5 py-2 text-sm" placeholder="Email (optional)" /><input type="tel" value={participant.phone} onChange={(event) => changeParticipant(index, "phone", event.target.value)} className="w-full border border-[#DED5C6] px-2.5 py-2 text-sm" placeholder="Phone (optional)" /></div>
                  <button type="button" disabled={editingLocked || form.participants.length <= 1} aria-label={`Remove ${participant.name || "participant"}`} onClick={() => setForm({ ...form, participants: form.participants.filter((_, participantIndex) => participantIndex !== index) })} className="self-start px-2 py-1 text-sm text-[#9A4E3D] disabled:opacity-30">Remove</button>
                </div>)}
              </div>
            </div>
            <div className="sticky bottom-0 flex justify-end gap-3 border-t border-[#DDD3C0] bg-[#FAF7EF] px-6 py-4">
              <button type="button" onClick={() => setFormOpen(false)} className="border border-[#C9BDA6] px-4 py-2.5 text-sm text-[#51452F]">Cancel</button>
              <button disabled={saving} type="submit" className="bg-[#51452F] px-5 py-2.5 text-sm font-medium text-white disabled:opacity-50">{saving ? "Saving…" : editingId ? "Save changes" : "Create expense"}</button>
            </div>
          </form>
        </div>
      </div>}
    </section>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return <div className="border border-[#DDD3C0] bg-[#FAF7EF] px-5 py-4"><p className="text-xs uppercase tracking-wider text-[#817766]">{label}</p><p className="mt-2 font-serif text-2xl text-[#302B22]">{value}</p></div>;
}

function ExpenseCard({ group, archived, onEdit, onArchive, onRestore, repayingShare, setRepayingShare, repaymentAmount, setRepaymentAmount, onRepayment, onUpdateRepayment, onReverseRepayment, saving }: {
  group: ExpenseGroup; archived: boolean; onEdit: () => void; onArchive: () => void; onRestore: () => void;
  repayingShare: string | null; setRepayingShare: (id: string | null) => void; repaymentAmount: string; setRepaymentAmount: (value: string) => void;
  onRepayment: (share: Participant) => void;
  onUpdateRepayment: (id: string, input: { amount: number; payment_method: string; idempotency_key: string }) => Promise<boolean>;
  onReverseRepayment: (id: string, reason: string) => Promise<boolean>; saving: boolean;
}) {
  const { text } = useLanguage();
  const [editingRepayment, setEditingRepayment] = useState<string | null>(null);
  const [editedAmount, setEditedAmount] = useState("");
  const [editedMethod, setEditedMethod] = useState("other");
  const editKeys = useRef<Record<string, string>>({});
  const activeShares = group.shares.filter((share) => share.is_active !== false);
  const selfShare = activeShares.find((share) => share.participant_type === "owner");
  const debtShares = activeShares.filter((share) => share.participant_type !== "owner");
  const paidCount = paymentHistory(group).length;
  return <article className="border border-[#D8CEBB] bg-[#FAF7EF] shadow-sm">
    <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#E5DCCB] px-5 py-4">
      <div><div className="flex flex-wrap items-center gap-2"><h3 className="font-serif text-xl text-[#302B22]">{group.title}</h3><span className={`px-2 py-0.5 text-[10px] uppercase tracking-wider ${group.isFullySettled ? "bg-[#E6EBDD] text-[#4E6942]" : "bg-[#F2E7CD] text-[#805F22]"}`}>{archived ? "Archived" : group.isFullySettled ? "Settled" : "Open"}</span></div><p className="mt-1 text-xs text-[#817766]">Expense total {money(group.total_amount, group.currency_code)} · {activeShares.length} participant{activeShares.length === 1 ? "" : "s"}</p></div>
      <div className="flex gap-2"><button onClick={onEdit} className="border border-[#C9BDA6] px-3 py-1.5 text-xs text-[#51452F]">Edit</button>{archived ? <button onClick={onRestore} className="border border-[#C9BDA6] px-3 py-1.5 text-xs text-[#51452F]">Restore</button> : <button onClick={onArchive} className="border border-[#C9BDA6] px-3 py-1.5 text-xs text-[#805F22]">Archive</button>}</div>
    </div>
    <div className="grid grid-cols-3 divide-x divide-[#E5DCCB] border-b border-[#E5DCCB]">
      <MiniMetric label="Owed to you" value={money(group.totalOwed, group.currency_code)} />
      <MiniMetric label="Repaid" value={money(group.totalRepaid, group.currency_code)} />
      <MiniMetric label="Still owed" value={money(group.outstandingBalance, group.currency_code)} />
    </div>
    <div className="divide-y divide-[#EAE2D4]">
      {selfShare && <div className="flex items-center justify-between px-5 py-3 text-sm"><div><p className="font-medium text-[#51452F]">Your share <span className="ml-1 text-xs font-normal text-[#817766]">(payer)</span></p><p className="text-xs text-[#817766]">Not counted as money owed back to you</p></div><p className="font-medium text-[#51452F]">{money(selfShare.amount_owed, group.currency_code)}</p></div>}
      {debtShares.map((share) => <div key={share.id} className="px-5 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="font-medium text-[#51452F]">{share.participant_name}</p><p className="text-xs text-[#817766]">{text("Share", "हिस्सा")} {money(share.amount_owed, group.currency_code)} · {text("paid back", "वापस मिले")} {money(share.totalRepaid || 0, group.currency_code)}</p>{share.email && <p className="text-xs text-[#817766]">{share.email}</p>}</div><div className="flex items-center gap-3"><div className="text-right"><p className="text-xs text-[#817766]">{text("Money still owed", "अभी मिलने वाले पैसे")}</p><p className={`font-semibold ${Number(share.outstandingBalance || 0) > 0.01 ? "text-[#805F22]" : "text-[#4E6942]"}`}>{money(share.outstandingBalance || 0, group.currency_code)}</p></div>{!archived && Number(share.outstandingBalance || 0) > 0.01 && <button onClick={() => { setRepayingShare(repayingShare === share.id ? null : share.id); setRepaymentAmount(String(share.outstandingBalance)); }} className="border border-[#C9BDA6] px-3 py-1.5 text-xs text-[#51452F]">{text("Add payment", "भुगतान जोड़ें")}</button>}</div></div>
        {repayingShare === share.id && <div className="mt-3 flex flex-wrap items-end gap-2"><label className="text-xs text-[#756C5D]">Amount received<input autoFocus type="number" min="0.01" max={Number(share.outstandingBalance || 0)} step="0.01" value={repaymentAmount} onChange={(event) => setRepaymentAmount(event.target.value)} className="mt-1 block w-36 border border-[#CFC3AE] bg-white px-2.5 py-2 text-sm" /></label><button disabled={saving} onClick={() => onRepayment(share)} className="bg-[#51452F] px-3 py-2 text-xs text-white disabled:opacity-50">{saving ? "Saving…" : "Confirm received"}</button><button onClick={() => setRepayingShare(null)} className="px-2 py-2 text-xs text-[#756C5D]">Cancel</button></div>}
        {share.repayments?.length ? <details className="mt-2 text-xs text-[#756C5D]"><summary className="cursor-pointer">{share.repayments.length} repayment record{share.repayments.length === 1 ? "" : "s"}</summary><ul className="mt-2 space-y-2">{[...share.repayments].sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || ""))).map((repayment) => <li key={repayment.id} className="border-l-2 border-[#C9BDA6] pl-3"><p><strong>{share.participant_name}</strong> paid you {money(repayment.amount, group.currency_code)}{repayment.payment_method ? ` via ${repayment.payment_method.replaceAll("_", " ")}` : ""} · {repayment.payment_status} · {repayment.confirmed_at || repayment.created_at ? new Date(repayment.confirmed_at || repayment.created_at!).toLocaleDateString() : "date unavailable"}</p>{repayment.reversal_reason && <p className="mt-1 text-[#9A4E3D]">Reversal: {repayment.reversal_reason}</p>}{!archived && repayment.payment_status === "confirmed" && <div className="mt-1 flex gap-3"><button type="button" onClick={() => { setEditingRepayment(repayment.id); setEditedAmount(String(repayment.amount)); setEditedMethod(repayment.payment_method || "other"); }} className="text-[#715B37] underline">Edit</button><button type="button" onClick={() => { const reason = window.prompt("Why are you reversing this repayment?"); if (reason?.trim()) void onReverseRepayment(repayment.id, reason.trim()); }} className="text-[#9A4E3D] underline">Reverse</button></div>}{editingRepayment === repayment.id && <div className="mt-2 flex flex-wrap items-end gap-2"><label>Amount<input type="number" min="0.01" step="0.01" value={editedAmount} onChange={(event) => setEditedAmount(event.target.value)} className="mt-1 block w-28 border border-[#CFC3AE] px-2 py-1.5" /></label><label>Method<select value={editedMethod} onChange={(event) => setEditedMethod(event.target.value)} className="mt-1 block border border-[#CFC3AE] bg-white px-2 py-1.5">{["upi", "paypal", "cash", "bank_transfer", "other"].map((method) => <option key={method} value={method}>{method.replaceAll("_", " ")}</option>)}</select></label><button type="button" disabled={saving} onClick={async () => { const key = editKeys.current[repayment.id] || (editKeys.current[repayment.id] = crypto.randomUUID()); const ok = await onUpdateRepayment(repayment.id, { amount: Number(editedAmount), payment_method: editedMethod, idempotency_key: key }); if (ok) { delete editKeys.current[repayment.id]; setEditingRepayment(null); } }} className="bg-[#51452F] px-3 py-2 text-white disabled:opacity-50">Save</button><button type="button" onClick={() => setEditingRepayment(null)} className="px-2 py-2">Cancel</button></div>}</li>)}</ul></details> : null}
        {share.repayments?.some((repayment) => repayment.events?.length) && <details className="mt-2 text-[11px] text-[#817766]"><summary className="cursor-pointer">Audit trail</summary><ul className="mt-1 space-y-1">{share.repayments.flatMap((repayment) => (repayment.events || []).map((event) => <li key={event.id}>{new Date(event.created_at).toLocaleString()} · {event.event_type === "updated" ? `Edited ${money(event.metadata.amount as number | string, group.currency_code)} (was ${money(event.metadata.previous_amount as number | string, group.currency_code)})` : event.event_type === "reversed" ? `Reversed${event.metadata.reason ? `: ${String(event.metadata.reason)}` : ""}` : `Repayment ${event.event_type}`} · {event.event_source}</li>))}</ul></details>}
      </div>)}
      {debtShares.length === 0 && !selfShare && <p className="px-5 py-4 text-sm text-[#817766]">No active participants.</p>}
    </div>
    {group.shares.some((share) => share.is_active === false) && <div className="border-t border-[#E5DCCB] px-5 py-3 text-xs text-[#817766]">{group.shares.filter((share) => share.is_active === false).length} removed participant record(s) retained for history.</div>}
    {paidCount > 0 && <div className="border-t border-[#E5DCCB] px-5 py-2 text-[11px] text-[#968A76]">Repayment records are retained if this expense is archived.</div>}
  </article>;
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return <div className="px-4 py-3"><p className="text-[10px] uppercase tracking-wider text-[#817766]">{label}</p><p className="mt-1 text-sm font-semibold text-[#51452F]">{value}</p></div>;
}
