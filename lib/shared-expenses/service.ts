import { createClient } from "@/lib/supabase/server";
import {
  CreateExpenseGroupInput,
  UpdateExpenseGroupInput,
  RecordRepaymentInput,
  UpdateRepaymentInput,
  toDatabaseParticipantType,
  toDatabaseSplitMethod,
} from "./validation";
import { calculateExpenseGroupBalance, calculateShareBalance, calculateSplit } from "./calculations";
import { resolveOwnerId } from "./integration-helpers";
import { accessibleExpenseGroupFilter } from "./participant-access";
type ShareRow = { id: string; amount_owed: number | string; participant_type?: string; is_active?: boolean | null; repayments?: Array<{ amount: number | string | null; payment_status: string }>; totalRepaid?: number; outstandingBalance?: number; isSettled?: boolean; [key: string]: unknown };
type RepaymentRow = { amount: number | string | null; payment_status: string };

export class SharedExpensesService {
  /**
   * List all expense groups for the user with calculated outstanding balances
   */
  static async list(userId: string, archived = false) {
    const supabase = await createClient();
    const { data: participantShares, error: participantError } = await supabase
      .from("expense_shares")
      .select("expense_group_id")
      .eq("participant_user_id", userId);
    if (participantError) throw participantError;
    const groupFilter = accessibleExpenseGroupFilter(userId, (participantShares || []).map((share) => share.expense_group_id));

    const { data: groups, error } = await supabase
      .from("expense_groups")
      .select(`
        *,
        shares:expense_shares(
          *,
          repayments(*, events:repayment_events(*))
        )
      `)
      .or(groupFilter)
      .order("created_at", { ascending: false });

    if (error) throw error;

    return (groups || [])
      .filter((group) => Boolean(group.archived_at) === archived)
      .map((group) => this.withBalances(group));
  }

  /**
   * Get single expense group details
   */
  static async getById(userId: string, groupId: string) {
    const supabase = await createClient();
    const { data: participantShares, error: participantError } = await supabase
      .from("expense_shares")
      .select("expense_group_id")
      .eq("participant_user_id", userId);
    if (participantError) throw participantError;
    const groupFilter = accessibleExpenseGroupFilter(userId, (participantShares || []).map((share) => share.expense_group_id));

    const { data: group, error } = await supabase
      .from("expense_groups")
      .select(`
        *,
        shares:expense_shares(
          *,
          repayments(*, events:repayment_events(*))
        )
      `)
      .eq("id", groupId)
      .or(groupFilter)
      .maybeSingle();

    if (error) throw error;
    if (!group) return null;
    return this.withBalances(group);
  }

  private static withBalances<T extends { shares?: ShareRow[] }>(group: T) {
    const shares = (group.shares || []).map((share) => ({
      ...share,
      ...calculateShareBalance(Number(share.amount_owed || 0), share.repayments || []),
    }));
    return {
      ...group,
      shares,
      ...calculateExpenseGroupBalance(shares),
      activeShares: shares.filter((share) => share.is_active !== false),
    };
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

    const { data, error } = await supabase.rpc("create_shared_expense_group", {
      p_user_id: userId,
      p_group: {
        transaction_id: transaction_id || null,
        title,
        total_amount,
        currency_code,
        split_method: toDatabaseSplitMethod(split_method),
      },
      p_shares: computedShares.map((participant) => ({
        participant_type: toDatabaseParticipantType(participant.participant_type),
        participant_name: participant.participant_name,
        participant_user_id: participant.participant_type === "self" ? userId : participant.user_id || null,
        email: participant.email || null,
        phone_number: participant.phone_number || null,
        amount_owed: participant.amount_owed,
      })),
    });
    if (error) throw error;
    return data;
  }

  static async update(userId: string, groupId: string, input: UpdateExpenseGroupInput) {
    if (input.archived !== undefined) return this.setArchived(userId, groupId, input.archived);
    const supabase = await createClient();
    const amounts = calculateSplit(input.total_amount, input.split_method, input.participants.map((participant) => participant.amount_owed || 0));
    const { data, error } = await supabase.rpc("update_shared_expense_group", {
      p_user_id: userId,
      p_group_id: groupId,
      p_group: {
        title: input.title,
        total_amount: input.total_amount,
        currency_code: input.currency_code,
        split_method: toDatabaseSplitMethod(input.split_method),
        transaction_id: input.transaction_id || null,
      },
      p_shares: input.participants.map((participant, index) => ({
        id: participant.id || null,
        participant_type: toDatabaseParticipantType(participant.participant_type),
        participant_name: participant.participant_name,
        participant_user_id: participant.participant_type === "self" ? userId : participant.user_id || null,
        email: participant.email || null,
        phone_number: participant.phone_number || null,
        amount_owed: amounts[index],
      })),
    });
    if (error) throw error;
    return data;
  }

  static async setArchived(userId: string, groupId: string, archived: boolean) {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("set_expense_group_archived", {
      p_user_id: userId,
      p_group_id: groupId,
      p_archived: archived,
    });
    if (error) throw error;
    return data;
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
        group:expense_groups!inner(user_id, id, title, archived_at),
        repayments(*)
      `)
      .eq("id", input.expense_share_id)
      .single();

    const relatedGroup = Array.isArray(share?.group) ? share.group[0] : share?.group;
    if (shareErr || !share || share.is_active === false || resolveOwnerId(share.group) !== userId || relatedGroup?.archived_at) {
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
      p_external_reference: input.external_reference || null,
      p_idempotency_key: input.idempotency_key,
    });
    if (error) throw error;
    if (!data?.success) throw new Error(data?.error || "Unable to record repayment");
    return data.result;
  }

  static async updateRepayment(userId: string, repaymentId: string, input: UpdateRepaymentInput) {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("update_shared_expense_repayment", {
      p_user_id: userId,
      p_repayment_id: repaymentId,
      p_amount: input.amount,
      p_payment_method: input.payment_method,
      p_payment_provider: input.payment_provider || null,
      p_idempotency_key: input.idempotency_key,
    });
    if (error) throw error;
    return data;
  }

  static async reverseRepayment(userId: string, repaymentId: string, reason: string) {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("reverse_shared_expense_repayment", {
      p_user_id: userId,
      p_repayment_id: repaymentId,
      p_reason: reason,
    });
    if (error) throw error;
    return data;
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
      .eq("user_id", userId)
      .is("archived_at", null);

    if (error) throw error;

    const pending = [];

    for (const grp of groups || []) {
      for (const share of grp.shares || []) {
        if (share.is_active === false || share.participant_type === "owner") continue;
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
