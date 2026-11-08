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
      .eq("user_id", userId)
      .is("deleted_at", null);

    if (params.direction) {
      query = query.eq("direction", params.direction);
    }

    if (params.status) {
      query = query.eq("status", params.status);
    }

    if (params.transaction_type) query = query.eq("transaction_type", params.transaction_type);
    if (params.category) query = query.eq("category", params.category);
    if (params.payment_method) query = query.eq("payment_method", params.payment_method);

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
      const endDate = /^\d{4}-\d{2}-\d{2}$/.test(params.endDate)
        ? `${params.endDate}T23:59:59.999Z`
        : params.endDate;
      query = query.lte("occurred_at", endDate);
    }

    if (params.search) {
      const search = params.search.replace(/[(),%_*]/g, " ").trim().slice(0, 100);
      if (search) {
      query = query.or(
        `merchant_name.ilike.%${search}%,description.ilike.%${search}%,category.ilike.%${search}%,external_reference.ilike.%${search}%`
      );
      }
    }

    const from = (params.page - 1) * params.limit;
    const to = from + params.limit - 1;

    const { data, count, error } = await query
      .order(params.sort, { ascending: params.sortDirection === "asc", nullsFirst: false })
      .order("id", { ascending: true })
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
      .is("deleted_at", null)
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;
    const { data: events, error: historyError } = await supabase
      .from("ledger_events")
      .select("id,event_type,event_source,description,metadata,occurred_at,created_at")
      .eq("transaction_id", id)
      .eq("user_id", userId)
      .order("occurred_at", { ascending: true });
    if (historyError) throw historyError;
    return { ...data, history: events || [] };
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

  /** Archive a transaction in place so linked financial/audit records survive. */
  static async delete(userId: string, id: string) {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("archive_transaction_with_event", {
      p_user_id: userId,
      p_transaction_id: id,
    });
    if (error) throw error;
    return data;
  }

  static async summary(userId: string) {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("get_transaction_summary", { p_user_id: userId });
    if (error) throw error;
    return data;
  }
}
