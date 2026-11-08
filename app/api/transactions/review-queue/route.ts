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

// POST: Approve or reject an item in import_review_queue with atomic transaction
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
      // Rejection updates review_status atomically
      const { data: updatedItem, error: updateErr } = await supabase
        .from("import_review_queue")
        .update({
          review_status: "rejected",
          resolved_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", reviewId)
        .eq("user_id", user.id)
        .eq("review_status", "pending") // ensures only pending item is rejected
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
    // Use atomic RPC function 'approve_review_queue_item'
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

    // If RPC is available, use its result directly
    if (!rpcError && rpcResult) {
      if (!rpcResult.success) {
        return NextResponse.json(
          { error: rpcResult.error, ...rpcResult },
          { status: rpcResult.status || 400 }
        );
      }
      return NextResponse.json(rpcResult);
    }

    // Fallback if RPC function is not yet migrated in database environment:
    // Execute atomic claim query via conditional update (review_status = 'pending')
    const { data: item, error: claimErr } = await supabase
      .from("import_review_queue")
      .select("*")
      .eq("id", reviewId)
      .eq("user_id", user.id)
      .single();

    if (claimErr || !item) {
      return NextResponse.json({ error: "Review item not found" }, { status: 404 });
    }

    if (item.review_status !== "pending") {
      return NextResponse.json(
        {
          error: `Review item has already been ${item.review_status}.`,
          reviewStatus: item.review_status,
          transactionId: item.created_transaction_id || undefined,
        },
        { status: 409 }
      );
    }

    const finalAmount = updates?.amount || item.amount;
    const finalDirection = updates?.direction || item.direction;
    const finalMerchant = updates?.merchant_name ?? item.merchant_name;
    const finalBank = updates?.bank_name ?? item.bank_name;
    const finalProvider = updates?.payment_provider ?? item.payment_provider;
    const finalDescription = updates?.description ?? item.description;

    const { data: newTxn, error: insertTxnErr } = await supabase
      .from("transactions")
      .insert({
        user_id: user.id,
        transaction_type: item.transaction_type || "payment",
        direction: finalDirection,
        amount: finalAmount,
        currency_code: item.currency_code || "INR",
        status: "completed",
        description: finalDescription,
        merchant_name: finalMerchant,
        bank_name: finalBank,
        payment_provider: finalProvider,
        account_last4: item.account_last4,
        external_reference: item.external_reference,
        occurred_at: item.occurred_at,
      })
      .select()
      .single();

    if (insertTxnErr) throw insertTxnErr;

    // Atomically mark approved
    await supabase
      .from("import_review_queue")
      .update({
        review_status: "approved",
        resolved_at: new Date().toISOString(),
        created_transaction_id: newTxn.id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", reviewId)
      .eq("user_id", user.id);

    // Update processed_emails with created transaction_id
    if (item.email_message_id) {
      await supabase
        .from("processed_emails")
        .update({
          status: "parsed",
          transaction_id: newTxn.id,
        })
        .eq("user_id", user.id)
        .eq("message_id", item.email_message_id);
    }

    // Insert audit ledger event
    await supabase.from("ledger_events").insert({
      transaction_id: newTxn.id,
      user_id: user.id,
      event_type: "review_queue_approved",
      event_source: "manual",
      description: `Transaction approved from review queue item ${reviewId}`,
      metadata: {
        review_id: reviewId,
        original_confidence: item.confidence,
        corrections: updates || null,
      },
      occurred_at: new Date().toISOString(),
    });

    // Mark review alerts resolved
    await supabase
      .from("alerts")
      .update({ is_resolved: true, resolved_at: new Date().toISOString() })
      .eq("user_id", user.id)
      .eq("alert_type", "transaction_review")
      .ilike("message", `%${item.amount}%`);

    return NextResponse.json({
      message: "Transaction approved and confirmed",
      transaction: newTxn,
    });
  } catch (error: any) {
    console.error("Resolve review item error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to resolve review item" },
      { status: 500 }
    );
  }
}
