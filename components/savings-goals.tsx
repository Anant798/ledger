"use client";

import { useCallback, useEffect, useState } from "react";

type Contribution = { id: string; amount: number | string; notes: string | null; contribution_source: string; contribution_status: string; contributed_at: string; transaction_id?: string | null };
type Goal = { id: string; title: string; description?: string | null; target_amount: number | string; currency_code: string; target_date?: string | null; status: string; current_amount: number; remainingAmount: number; progressPercent: number; isGoalMet: boolean; contributions: Contribution[] };
type Rule = { id: string; amount: number | string; frequency: "weekly" | "monthly"; enabled: boolean; next_run_at: string };
const inputClass = "w-full rounded border border-[#C9BDA6] bg-white px-3 py-2 text-sm text-[#302B22]";

export default function SavingsGoals() {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [rules, setRules] = useState<Record<string, Rule | undefined>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ title: "", description: "", target_amount: "", target_date: "" });
  const [contribution, setContribution] = useState<Record<string, { amount: string; notes: string; transaction_id: string }>>({});
  const [ruleForm, setRuleForm] = useState<Record<string, { amount: string; frequency: "weekly" | "monthly" }>>({});

  const load = useCallback(async () => {
    const response = await fetch("/api/savings/goals", { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Unable to load savings goals");
    setGoals(body.goals || []);
    const nextRules: Record<string, Rule | undefined> = {};
    await Promise.all((body.goals || []).map(async (goal: Goal) => {
      const ruleResponse = await fetch(`/api/savings/goals/${goal.id}/rules`, { cache: "no-store" });
      if (ruleResponse.ok) nextRules[goal.id] = (await ruleResponse.json()).rules?.[0];
    }));
    setRules(nextRules);
  }, []);
  useEffect(() => { void load().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Unable to load savings goals")); }, [load]);
  async function request(url: string, method: string, data?: unknown) {
    const response = await fetch(url, { method, headers: data ? { "Content-Type": "application/json" } : undefined, body: data ? JSON.stringify(data) : undefined });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Request failed");
    return body;
  }
  async function perform(action: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { await action(); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Request failed"); }
    finally { setBusy(false); }
  }

  return <section className="mt-12 rounded-xl border border-[#C9BDA6] bg-[#FBF8F0] p-6">
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div><p className="text-xs tracking-[0.25em] text-[#897653]">SAVE WITH INTENTION</p><h2 className="mt-2 font-serif text-3xl">Savings goals</h2></div>
      <form className="grid w-full gap-2 md:max-w-2xl md:grid-cols-2" onSubmit={(event) => { event.preventDefault(); void perform(async () => { await request("/api/savings/goals", "POST", { ...form, target_amount: Number(form.target_amount), target_date: form.target_date || null }); setForm({ title: "", description: "", target_amount: "", target_date: "" }); }); }}>
        <input required className={inputClass} placeholder="Goal name" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        <input required min="0.01" step="0.01" type="number" className={inputClass} placeholder="Target amount" value={form.target_amount} onChange={(e) => setForm({ ...form, target_amount: e.target.value })} />
        <input className={inputClass} placeholder="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <div className="flex gap-2"><input type="date" className={inputClass} value={form.target_date} onChange={(e) => setForm({ ...form, target_date: e.target.value })} /><button disabled={busy} className="shrink-0 rounded bg-[#715B37] px-4 py-2 text-sm text-white">Create goal</button></div>
      </form>
    </div>
    {error && <p role="alert" className="mt-4 text-sm text-red-700">{error}</p>}
    <div className="mt-6 grid gap-4 lg:grid-cols-2">
      {goals.map((goal) => <article key={goal.id} className="rounded-lg border border-[#D8CEBC] bg-white p-5">
        <div className="flex items-start justify-between gap-3"><div><h3 className="font-serif text-2xl">{goal.title}</h3>{goal.description && <p className="mt-1 text-sm text-[#756C5D]">{goal.description}</p>}<p className="mt-2 text-xs text-[#897653]">{goal.target_date ? `Target date ${goal.target_date}` : "No target date"} · {goal.status}</p></div><span className="flex gap-3"><button disabled={busy} className="text-sm text-[#715B37] underline" onClick={() => { const title = window.prompt("Goal name", goal.title); if (title === null) return; const target = window.prompt("Target amount", String(goal.target_amount)); if (target === null) return; const description = window.prompt("Description", goal.description || ""); if (description === null) return; const date = window.prompt("Target date (YYYY-MM-DD, blank for none)", goal.target_date || ""); if (date === null) return; void perform(() => request(`/api/savings/goals/${goal.id}`, "PATCH", { title, target_amount: Number(target), description: description || null, target_date: date || null })); }}>Edit</button><button disabled={busy} className="text-sm text-red-700 underline" onClick={() => { if (window.confirm("Archive this goal? Its contribution history will be retained.")) void perform(() => request(`/api/savings/goals/${goal.id}`, "DELETE")); }}>Delete</button></span></div>
        <div className="mt-4 flex justify-between text-sm"><span>{goal.currency_code} {Number(goal.current_amount).toFixed(2)} saved</span><span>{goal.currency_code} {Number(goal.target_amount).toFixed(2)} target</span></div>
        <div className="mt-2 h-2 overflow-hidden rounded bg-[#E8E0D2]"><div className="h-full bg-[#8B744A]" style={{ width: `${goal.progressPercent}%` }} /></div><p className="mt-1 text-right text-xs text-[#756C5D]">{goal.progressPercent}% · {goal.currency_code} {Number(goal.remainingAmount).toFixed(2)} remaining</p>
        <form className="mt-4 grid gap-2 sm:grid-cols-3" onSubmit={(event) => { event.preventDefault(); const values = contribution[goal.id] || { amount: "", notes: "", transaction_id: "" }; void perform(async () => { await request("/api/savings/contributions", "POST", { goal_id: goal.id, amount: Number(values.amount), notes: values.notes || null, ...(values.transaction_id ? { transaction_id: values.transaction_id } : {}) }); setContribution({ ...contribution, [goal.id]: { amount: "", notes: "", transaction_id: "" } }); }); }}>
          <input required min="0.01" step="0.01" type="number" className={inputClass} placeholder="Contribution" value={contribution[goal.id]?.amount || ""} onChange={(e) => setContribution({ ...contribution, [goal.id]: { ...contribution[goal.id], amount: e.target.value, notes: contribution[goal.id]?.notes || "", transaction_id: contribution[goal.id]?.transaction_id || "" } })} />
          <input className={inputClass} placeholder="Note" value={contribution[goal.id]?.notes || ""} onChange={(e) => setContribution({ ...contribution, [goal.id]: { ...contribution[goal.id], notes: e.target.value, amount: contribution[goal.id]?.amount || "", transaction_id: contribution[goal.id]?.transaction_id || "" } })} /><button disabled={busy} className="rounded border border-[#8B744A] px-3 py-2 text-sm text-[#715B37]">Add contribution</button>
          <input className={`${inputClass} sm:col-span-3`} aria-label="Optional owned transaction UUID" placeholder="Optional transaction ID to link this contribution" value={contribution[goal.id]?.transaction_id || ""} onChange={(e) => setContribution({ ...contribution, [goal.id]: { ...contribution[goal.id], transaction_id: e.target.value, amount: contribution[goal.id]?.amount || "", notes: contribution[goal.id]?.notes || "" } })} />
        </form>
        <details className="mt-4"><summary className="cursor-pointer text-sm font-medium text-[#715B37]">Automated contributions</summary><form className="mt-3 flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); const value = ruleForm[goal.id] || { amount: String(rules[goal.id]?.amount || ""), frequency: "monthly" as const }; void perform(() => request(`/api/savings/goals/${goal.id}/rules`, rules[goal.id] ? "PATCH" : "POST", { ...(rules[goal.id] ? { rule_id: rules[goal.id]?.id } : {}), amount: Number(value.amount), frequency: value.frequency, enabled: true })); }}>
          <input required min="0.01" step="0.01" type="number" className={`${inputClass} max-w-40`} placeholder="Amount" value={ruleForm[goal.id]?.amount ?? String(rules[goal.id]?.amount ?? "")} onChange={(e) => setRuleForm({ ...ruleForm, [goal.id]: { amount: e.target.value, frequency: ruleForm[goal.id]?.frequency || rules[goal.id]?.frequency || "monthly" } })} />
          <select className={inputClass + " max-w-36"} value={ruleForm[goal.id]?.frequency || rules[goal.id]?.frequency || "monthly"} onChange={(e) => setRuleForm({ ...ruleForm, [goal.id]: { amount: ruleForm[goal.id]?.amount || String(rules[goal.id]?.amount || ""), frequency: e.target.value as "weekly" | "monthly" } })}><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select><button disabled={busy} className="rounded bg-[#715B37] px-3 py-2 text-sm text-white">{rules[goal.id] ? "Update rule" : "Schedule"}</button>
          {rules[goal.id] && <><span className="self-center text-xs text-[#756C5D]">Next {new Date(rules[goal.id]!.next_run_at).toLocaleString()}</span><button type="button" className="text-xs text-red-700 underline" onClick={() => void perform(() => request(`/api/savings/goals/${goal.id}/rules?rule_id=${rules[goal.id]!.id}`, "DELETE"))}>Remove</button></>}
        </form></details>
        <details className="mt-4"><summary className="cursor-pointer text-sm font-medium text-[#715B37]">Contribution history ({goal.contributions?.length || 0})</summary><ul className="mt-2 divide-y divide-[#E8E0D2]">{(goal.contributions || []).map((item) => <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"><span>{goal.currency_code} {Number(item.amount).toFixed(2)} · {item.contribution_source} · {item.contribution_status}<small className="block text-xs text-[#897653]">{new Date(item.contributed_at).toLocaleDateString()} {item.notes || ""}</small></span>{item.contribution_source === "manual" && item.contribution_status === "confirmed" && <span className="flex gap-2"><button className="text-xs underline" onClick={() => { const amount = window.prompt("New contribution amount", String(item.amount)); if (amount) void perform(() => request(`/api/savings/contributions/${item.id}`, "PATCH", { amount: Number(amount) })); }}>Edit</button><button className="text-xs text-red-700 underline" onClick={() => { if (window.confirm("Reverse this contribution? The audit history will be preserved.")) void perform(() => request(`/api/savings/contributions/${item.id}`, "DELETE")); }}>Reverse</button></span>}</li>)}</ul></details>
        {goal.isGoalMet && goal.status !== "completed" && <button disabled={busy} className="mt-4 rounded bg-[#715B37] px-3 py-2 text-sm text-white" onClick={() => void perform(() => request(`/api/savings/goals/${goal.id}`, "POST"))}>Complete goal</button>}
      </article>)}
    </div>
  </section>;
}
