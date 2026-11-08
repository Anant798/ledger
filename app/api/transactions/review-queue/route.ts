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
      description: z.string().optional(),
      category: z.string().optional(),
    })
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
  } catch (error: any) {
    console.error("Fetch review queue error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to fetch review queue" },
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

    if (action === "reject") {
      const { data: updatedItem, error: updateErr } = await supabase
        .from("import_review_queue")
        .update({
          review_status: "rejected",
          resolved_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", reviewId)
        .eq("user_id", user.id)
        .eq("review_status", "pending")
        .select()
        .maybeSingle();

      if (updateErr) throw updateErr;

      if (!updatedItem) {
        return NextResponse.json(
          { error: "Review item not found or already processed" },
          { status: 409 }
        );
      }

      await supabase
        .from("alerts")
        .update({ is_resolved: true, resolved_at: new Date().toISOString() })
        .eq("user_id", user.id)
        .eq("alert_type", "transaction_review")
        .ilike("message", `%${updatedItem.amount}%`);

      return NextResponse.json({
        message: "Import item rejected",
        item: updatedItem,
      });
    }

    // Action === 'approve':
    // Must be executed atomically via the approve_review_queue_item SQL RPC.
    // Non-atomic fallback removed to guarantee consistency and eliminate partial writes.
    const { data: rpcResult, error: rpcError } = await supabase.rpc(
      "approve_review_queue_item",
      {
        p_user_id: user.id,
        p_review_id: reviewId,
        p_amount: updates?.amount || null,
        p_direction: updates?.direction || null,
        p_merchant_name: updates?.merchant_name || null,
        p_bank_name: updates?.bank_name || null,
        p_payment_provider: updates?.payment_provider || null,
        p_description: updates?.description || null,
      }
    );

    if (rpcError) {
      console.error("Atomic approval RPC error:", rpcError);
      return NextResponse.json(
        {
          error: "Atomic transaction approval is temporarily unavailable. Please run the required database migration for approve_review_queue_item.",
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
  } catch (error: any) {
    console.error("Resolve review item error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to resolve review item" },
      { status: 500 }
    );
  }
}
