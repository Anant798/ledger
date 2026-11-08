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

    // Fetch review item
    const { data: item, error: fetchErr } = await supabase
      .from("import_review_queue")
      .select("*")
      .eq("id", reviewId)
      .eq("user_id", user.id)
      .single();

    if (fetchErr || !item) {
      return NextResponse.json({ error: "Review item not found" }, { status: 404 });
    }

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
        .select()
        .single();

      if (updateErr) throw updateErr;

      return NextResponse.json({
        message: "Import item rejected",
        item: updatedItem,
      });
    }

    // Action === 'approve': Create standard confirmed transaction in transactions table
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

    // Log to ledger_events
    await supabase.from("ledger_events").insert({
      transaction_id: newTxn.id,
      user_id: user.id,
      event_type: "review_queue_approved",
      event_source: "manual",
      description: `Transaction approved from review queue item ${reviewId}`,
      metadata: { review_id: reviewId, original_confidence: item.confidence },
      occurred_at: new Date().toISOString(),
    });

    // Update review item state
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
