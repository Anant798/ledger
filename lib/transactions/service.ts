import { createClient } from "@/lib/supabase/server";
import {
  CreateTransactionInput,
  UpdateTransactionInput,
  TransactionQueryParams,
} from "./validation";

export class TransactionService {
  /**
   * List transactions with filters, search, and pagination
   */
  static async list(userId: string, params: TransactionQueryParams) {
    const supabase = await createClient();

    let query = supabase
      .from("transactions")
      .select("*", { count: "exact" })
      .eq("user_id", userId);

    if (params.direction) {
      query = query.eq("direction", params.direction);
    }

    if (params.status) {
      query = query.eq("status", params.status);
    }

    if (params.payment_provider) {
      query = query.eq("payment_provider", params.payment_provider);
    }

    if (params.startDate) {
      query = query.gte("occurred_at", params.startDate);
    }

    if (params.endDate) {
      query = query.lte("occurred_at", params.endDate);
    }

    if (params.search) {
      query = query.or(
        `merchant_name.ilike.%${params.search}%,description.ilike.%${params.search}%,external_reference.ilike.%${params.search}%`
      );
    }

    const from = (params.page - 1) * params.limit;
    const to = from + params.limit - 1;

    const { data, count, error } = await query
      .order("occurred_at", { ascending: false })
      .range(from, to);

    if (error) throw error;

    return {
      transactions: data || [],
      pagination: {
        page: params.page,
        limit: params.limit,
        total: count || 0,
        totalPages: count ? Math.ceil(count / params.limit) : 0,
      },
    };
  }

  /**
   * Get single transaction
   */
  static async getById(userId: string, id: string) {
    const supabase = await createClient();

    const { data, error } = await supabase
      .from("transactions")
      .select("*")
      .eq("id", id)
      .eq("user_id", userId)
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Create manual transaction and log ledger event
   */
  static async create(userId: string, input: CreateTransactionInput) {
    const supabase = await createClient();

    const { data: txn, error } = await supabase
      .from("transactions")
      .insert({
        user_id: userId,
        transaction_type: input.transaction_type,
        direction: input.direction,
        amount: input.amount,
        currency_code: input.currency_code,
        status: input.status,
        description: input.description,
        merchant_name: input.merchant_name,
        bank_name: input.bank_name,
        payment_provider: input.payment_provider,
        account_last4: input.account_last4,
        external_reference: input.external_reference,
        related_transaction_id: input.related_transaction_id,
        occurred_at: input.occurred_at || new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw error;

    // Log to ledger_events
    await supabase.from("ledger_events").insert({
      transaction_id: txn.id,
      user_id: userId,
      event_type: "transaction_created",
      event_source: "manual",
      description: `Manual transaction of ${txn.amount} ${txn.currency_code} created`,
      metadata: { input },
      occurred_at: txn.occurred_at,
    });

    return txn;
  }

  /**
   * Update transaction and log state change
   */
  static async update(userId: string, id: string, input: UpdateTransactionInput) {
    const supabase = await createClient();

    const { data: updated, error } = await supabase
      .from("transactions")
      .update({
        ...input,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("user_id", userId)
      .select()
      .single();

    if (error) throw error;

    // Log update event
    await supabase.from("ledger_events").insert({
      transaction_id: id,
      user_id: userId,
      event_type: "transaction_updated",
      event_source: "manual",
      description: `Transaction ${id} updated`,
      metadata: { updates: input },
      occurred_at: new Date().toISOString(),
    });

    return updated;
  }

  /**
   * Delete transaction
   */
  static async delete(userId: string, id: string) {
    const supabase = await createClient();

    const { error } = await supabase
      .from("transactions")
      .delete()
      .eq("id", id)
      .eq("user_id", userId);

    if (error) throw error;
    return { success: true };
  }
}
