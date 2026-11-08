import { createClient } from "@/lib/supabase/server";
import {
  CreateTransactionInput,
  UpdateTransactionInput,
  TransactionQueryParams,
} from "./validation";

export class TransactionService {
  /**
   * List transactions with filters, search, and pagination.
   * Resolves the source vs payment_provider mismatch cleanly.
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

    // Resolve source vs payment_provider:
    // If payment_provider is passed, use it. If source is passed, map it to payment_provider.
    const providerFilter = params.payment_provider || params.source;
    if (providerFilter) {
      query = query.eq("payment_provider", providerFilter);
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
    const { data, error } = await supabase.rpc("create_manual_transaction_with_event", {
      p_user_id: userId,
      p_transaction: {
        ...input,
        payment_provider: input.payment_provider || "manual",
        occurred_at: input.occurred_at || new Date().toISOString(),
      },
    });
    if (error) throw error;
    return data;
  }

  /**
   * Update transaction and log state change
   */
  static async update(userId: string, id: string, input: UpdateTransactionInput) {
    const supabase = await createClient();

    const { data, error } = await supabase.rpc("update_manual_transaction_with_event", {
      p_user_id: userId,
      p_transaction_id: id,
      p_updates: input,
    });
    if (error) throw error;
    return data;
  }

  /**
   * Delete transaction and its corresponding ledger events
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
