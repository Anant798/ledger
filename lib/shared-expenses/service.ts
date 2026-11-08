import { createClient } from "@/lib/supabase/server";
import {
  CreateExpenseGroupInput,
  RecordRepaymentInput,
} from "./validation";

export class SharedExpensesService {
  /**
   * List all expense groups for the user with calculated outstanding balances
   */
  static async list(userId: string) {
    const supabase = await createClient();

    const { data: groups, error } = await supabase
      .from("expense_groups")
      .select(`
        *,
        shares:expense_shares(
          *,
          repayments(*)
        )
      `)
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (error) throw error;

    const enriched = (groups || []).map((grp) => {
      const shares = grp.shares || [];

      let totalOwed = 0;
      let totalRepaid = 0;

      shares.forEach((share: any) => {
        totalOwed += Number(share.amount_owed || 0);
        (share.repayments || []).forEach((rep: any) => {
          if (rep.payment_status === "confirmed") {
            totalRepaid += Number(rep.amount || 0);
          }
        });
      });

      const outstandingBalance = Math.max(0, totalOwed - totalRepaid);
      const sharesWithBalances = shares.map((share: any) => {
        const confirmed = (share.repayments || []).filter((rep: any) => rep.payment_status === "confirmed");
        const repaid = confirmed.reduce((sum: number, rep: any) => sum + Number(rep.amount || 0), 0);
        const balance = Math.max(0, Number(share.amount_owed || 0) - repaid);
        return { ...share, totalRepaid: repaid, outstandingBalance: balance, isSettled: balance <= 0.01, settlementHistory: confirmed };
      });

      return {
        ...grp,
        shares: sharesWithBalances,
        totalOwed,
        totalRepaid,
        outstandingBalance,
        isFullySettled: outstandingBalance <= 0,
      };
    });

    return enriched;
  }

  /**
   * Get single expense group details
   */
  static async getById(userId: string, groupId: string) {
    const supabase = await createClient();

    const { data: group, error } = await supabase
      .from("expense_groups")
      .select(`
        *,
        shares:expense_shares(
          *,
          repayments(*)
        )
      `)
      .eq("id", groupId)
      .eq("user_id", userId)
      .single();

    if (error) throw error;
    if (!group) return null;
    const shares = (group.shares || []).map((share: any) => {
      const confirmed = (share.repayments || []).filter((rep: any) => rep.payment_status === "confirmed");
      const totalRepaid = confirmed.reduce((sum: number, rep: any) => sum + Number(rep.amount || 0), 0);
      const outstandingBalance = Math.max(0, Number(share.amount_owed || 0) - totalRepaid);
      return { ...share, totalRepaid, outstandingBalance, isSettled: outstandingBalance <= 0.01, settlementHistory: confirmed };
    });
    return { ...group, shares, totalOwed: shares.reduce((s: number, x: any) => s + Number(x.amount_owed || 0), 0), totalRepaid: shares.reduce((s: number, x: any) => s + x.totalRepaid, 0), outstandingBalance: shares.reduce((s: number, x: any) => s + x.outstandingBalance, 0), isFullySettled: shares.every((x: any) => x.isSettled) };
  }

  /**
   * Create an expense group and shares
   */
  static async create(userId: string, input: CreateExpenseGroupInput) {
    const supabase = await createClient();

    const {
      title,
      total_amount,
      currency_code,
      split_method,
      transaction_id,
      participants,
    } = input;

    const count = participants.length;
    const computedShares = participants.map((p, index) => {
      if (split_method === "percentage") {
        const shareAmount = index === participants.length - 1
          ? Number((total_amount - participants.slice(0, -1).reduce((sum, prior) => sum + Number((total_amount * (prior.amount_owed || 0) / 100).toFixed(2)), 0)).toFixed(2))
          : Number((total_amount * (p.amount_owed || 0) / 100).toFixed(2));
        return { ...p, amount_owed: shareAmount };
      }
      if (split_method === "equal") {
        const base = Math.floor((total_amount / count) * 100) / 100;
        return {
          ...p,
          amount_owed: index === count - 1 ? Number((total_amount - base * (count - 1)).toFixed(2)) : base,
        };
      }
      return {
        ...p,
        amount_owed: p.amount_owed || 0,
      };
    });

    // 1. Insert into expense_groups (RLS: auth.uid() = user_id)
    const { data: group, error: groupErr } = await supabase
      .from("expense_groups")
      .insert({
        user_id: userId,
        transaction_id: transaction_id || null,
        title,
        total_amount,
        currency_code,
        split_method,
      })
      .select()
      .single();

    if (groupErr) throw groupErr;

    // 2. Insert into expense_shares (RLS: auth.uid() = user_id and group belongs to user)
    const sharesToInsert = computedShares.map((p) => ({
      expense_group_id: group.id,
      user_id: userId,
      participant_type: p.participant_type,
      participant_name: p.participant_name,
      email: p.email || null,
      phone_number: p.phone_number || null,
      amount_owed: p.amount_owed,
    }));

    const { data: insertedShares, error: sharesErr } = await supabase
      .from("expense_shares")
      .insert(sharesToInsert)
      .select();

    if (sharesErr) throw sharesErr;

    return {
      ...group,
      shares: insertedShares,
    };
  }

  /**
   * Secure repayment recording with strict ownership & balance validation.
   * Ledger only records repayments; it never executes payment transfers.
   */
  static async recordRepayment(userId: string, input: RecordRepaymentInput) {
    const supabase = await createClient();

    // Verify share exists and belongs to an expense_group owned by userId
    const { data: share, error: shareErr } = await supabase
      .from("expense_shares")
      .select(`
        *,
        group:expense_groups!inner(user_id, id, title),
        repayments(*)
      `)
      .eq("id", input.expense_share_id)
      .single();

    if (shareErr || !share || (share as any).group?.user_id !== userId) {
      throw new Error("Expense share not found or access denied.");
    }

    const amountOwed = Number(share.amount_owed || 0);
    const alreadyRepaid = (share.repayments || [])
      .filter((r: any) => r.payment_status === "confirmed")
      .reduce((sum: number, r: any) => sum + Number(r.amount || 0), 0);

    const remainingOwed = amountOwed - alreadyRepaid;

    if (input.amount <= 0) {
      throw new Error("Repayment amount must be positive.");
    }

    if (input.amount > remainingOwed + 0.01) {
      throw new Error(
        `Repayment amount (${input.amount}) exceeds outstanding balance (${remainingOwed.toFixed(2)}).`
      );
    }

    // Insert repayment
    const { data: repayment, error: repErr } = await supabase
      .from("repayments")
      .insert({
        expense_share_id: input.expense_share_id,
        user_id: userId,
        amount: input.amount,
        currency_code: input.currency_code,
        payment_method: input.payment_method,
        payment_status: "confirmed",
        confirmation_source: "manual_recorded",
        payment_provider: input.payment_provider || null,
        external_reference: input.external_reference || null,
        confirmed_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (repErr) throw repErr;

    // Log audit event to repayment_events
    await supabase.from("repayment_events").insert({
      repayment_id: repayment.id,
      user_id: userId,
      event_type: "repayment_confirmed",
      event_source: "manual",
      metadata: {
        expense_share_id: input.expense_share_id,
        amount: input.amount,
        remaining_balance: Math.max(0, remainingOwed - input.amount),
      },
    });

    return {
      repayment,
      remainingBalance: Math.max(0, remainingOwed - input.amount),
      isShareSettled: alreadyRepaid + input.amount >= amountOwed - 0.01,
    };
  }

  /**
   * Query overdue shares ready for reminder logging
   */
  static async getPendingReminders(userId: string) {
    const supabase = await createClient();

    const { data: groups, error } = await supabase
      .from("expense_groups")
      .select(`
        id,
        title,
        currency_code,
        shares:expense_shares(
          *,
          repayments(*)
        )
      `)
      .eq("user_id", userId);

    if (error) throw error;

    const pending = [];

    for (const grp of groups || []) {
      for (const share of grp.shares || []) {
        const amountOwed = Number(share.amount_owed || 0);
        const totalRepaid = (share.repayments || [])
          .filter((r: any) => r.payment_status === "confirmed")
          .reduce((sum: number, r: any) => sum + Number(r.amount || 0), 0);

        const balance = Math.max(0, amountOwed - totalRepaid);

        if (balance > 0.01) {
          pending.push({
            expenseGroupId: grp.id,
            expenseGroupTitle: grp.title,
            shareId: share.id,
            participantName: share.participant_name,
            email: share.email,
            phone: share.phone_number,
            amountOwed,
            totalRepaid,
            remainingBalance: balance,
          });
        }
      }
    }

    return pending;
  }
}
