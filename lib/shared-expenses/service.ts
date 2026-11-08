import { createClient } from "@/lib/supabase/server";
import {
  CreateExpenseGroupInput,
  RecordRepaymentInput,
  toDatabaseParticipantType,
  toDatabaseSplitMethod,
} from "./validation";
import { calculateShareBalance, calculateSplit } from "./calculations";
import { resolveOwnerId } from "./integration-helpers";
type ShareRow = { amount_owed: number | string; repayments?: Array<{ amount: number | string | null; payment_status: string }>; totalRepaid?: number; outstandingBalance?: number; isSettled?: boolean; [key: string]: unknown };
type RepaymentRow = { amount: number | string | null; payment_status: string };

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

      shares.forEach((share: ShareRow) => {
        totalOwed += Number(share.amount_owed || 0);
        (share.repayments || []).forEach((rep) => {
          if (rep.payment_status === "confirmed") {
            totalRepaid += Number(rep.amount || 0);
          }
        });
      });

      const outstandingBalance = Math.max(0, totalOwed - totalRepaid);
      const sharesWithBalances = shares.map((share: ShareRow) => {
        return { ...share, ...calculateShareBalance(Number(share.amount_owed || 0), share.repayments || []) };
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
    const shares = (group.shares || []).map((share: ShareRow) => {
      return { ...share, ...calculateShareBalance(Number(share.amount_owed || 0), share.repayments || []) };
    });
    return { ...group, shares, totalOwed: shares.reduce((sum: number, share: ShareRow) => sum + Number(share.amount_owed || 0), 0), totalRepaid: shares.reduce((sum: number, share: ShareRow) => sum + Number(share.totalRepaid || 0), 0), outstandingBalance: shares.reduce((sum: number, share: ShareRow) => sum + Number(share.outstandingBalance || 0), 0), isFullySettled: shares.every((share: ShareRow) => share.isSettled === true) };
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

    const amounts = calculateSplit(total_amount, split_method, participants.map((p) => p.amount_owed || 0));
    const computedShares = participants.map((p, index) => ({ ...p, amount_owed: amounts[index] }));

    // 1. Insert into expense_groups (RLS: auth.uid() = user_id)
    const { data: group, error: groupErr } = await supabase
      .from("expense_groups")
      .insert({
        user_id: userId,
        transaction_id: transaction_id || null,
        title,
        total_amount,
        currency_code,
        split_method: toDatabaseSplitMethod(split_method),
      })
      .select()
      .single();

    if (groupErr) throw groupErr;

    // 2. Insert into expense_shares (RLS: auth.uid() = user_id and group belongs to user)
    const sharesToInsert = computedShares.map((p) => ({
      expense_group_id: group.id,
      user_id: userId,
      participant_type: toDatabaseParticipantType(p.participant_type),
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

    if (shareErr || !share || resolveOwnerId(share.group) !== userId) {
      throw new Error("Expense share not found or access denied.");
    }

    if (input.amount <= 0) {
      throw new Error("Repayment amount must be positive.");
    }
    const { data, error } = await supabase.rpc("record_shared_expense_repayment", {
      p_user_id: userId,
      p_share_id: input.expense_share_id,
      p_amount: input.amount,
      p_currency_code: input.currency_code,
      p_payment_method: input.payment_method,
      p_payment_provider: input.payment_provider || null,
      p_external_reference: input.idempotency_key || input.external_reference || null,
    });
    if (error) throw error;
    if (!data?.success) throw new Error(data?.error || "Unable to record repayment");
    return data.result;
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
        const totalRepaid = ((share.repayments || []) as RepaymentRow[])
          .filter((r) => r.payment_status === "confirmed")
          .reduce((sum, r) => sum + Number(r.amount || 0), 0);

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
