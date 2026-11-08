import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";

const resolveReviewSchema = z.object({
  reviewId: z.string().uuid(),
  action: z.enum(["approve", "reject"]),
  updates: z
    .object({
      merchant_name: z.string().optional(),
      bank_name: z.string().optional(),
      payment_provider: z.string().optional(),
      amount: z.number().positive().optional(),
      direction: z.enum(["debit", "credit"]).optional(),
      currency_code: z.string().regex(/^[A-Za-z]{3}$/).optional(),
      transaction_type: z.enum(["payment", "refund", "reversal", "shared_expense", "repayment", "manual", "other"]).optional(),
      category: z.string().max(100).optional(),
      occurred_at: z.string().datetime().optional(),
      description: z.string().optional(),
    }).strict()
    .optional(),
});

// GET: Fetch pending import review items
export async function GET() {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data, error } = await supabase
      .from("import_review_queue")
      .select("*")
      .eq("user_id", user.id)
      .eq("review_status", "pending")
      .order("occurred_at", { ascending: false });

    if (error) throw error;

    return NextResponse.json({ reviewQueue: data || [] });
  } catch (error: unknown) {
    console.error("Fetch review queue error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch review queue" },
      { status: 500 }
    );
  }
}

// POST: Approve or reject an item in import_review_queue
export async function POST(request: Request) {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const parsed = resolveReviewSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid action payload", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { reviewId, action, updates } = parsed.data;

    const { data: rpcResult, error: rpcError } = await supabase.rpc("resolve_gmail_import_review", {
      p_user_id: user.id,
      p_review_id: reviewId,
      p_action: action,
      p_corrections: updates ? {
        ...updates,
        ...(updates.bank_name?.trim() && !updates.payment_provider?.trim()
          ? { payment_provider: updates.bank_name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") }
          : {}),
      } : {},
    });

    if (rpcError) {
      console.error("Atomic approval RPC error:", rpcError);
      return NextResponse.json(
        {
          error: "Atomic Gmail review resolution is temporarily unavailable. Apply the pending Gmail integration migration.",
          details: rpcError.message,
        },
        { status: 503 }
      );
    }

    if (!rpcResult || !rpcResult.success) {
      return NextResponse.json(
        { error: rpcResult?.error || "Failed to approve review item", ...rpcResult },
        { status: rpcResult?.status || 400 }
      );
    }

    return NextResponse.json(rpcResult);
  } catch (error: unknown) {
    console.error("Resolve review item error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to resolve review item" },
      { status: 500 }
    );
  }
}
