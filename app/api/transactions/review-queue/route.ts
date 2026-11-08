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

// POST: Approve or reject an item in import_review_queue with idempotency protection
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

    // IDEMPOTENCY CHECK: Prevent repeated approvals or actions from creating duplicate transactions
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

      // Update related alert if any
      await supabase
        .from("alerts")
        .update({ is_resolved: true, resolved_at: new Date().toISOString() })
        .eq("user_id", user.id)
        .eq("alert_type", "transaction_review")
        .ilike("message", `%${item.amount}%`);

      return NextResponse.json({
        message: "Import item rejected",
        item: updatedItem,
      });
    }

    // Action === 'approve':
    // 1. Double check external_reference duplicate if present
    if (item.external_reference) {
      const { data: existingTxn } = await supabase
        .from("transactions")
        .select("id")
        .eq("user_id", user.id)
        .eq("external_reference", item.external_reference)
        .maybeSingle();

      if (existingTxn) {
        await supabase
          .from("import_review_queue")
          .update({
            review_status: "approved",
            resolved_at: new Date().toISOString(),
            created_transaction_id: existingTxn.id,
            updated_at: new Date().toISOString(),
          })
          .eq("id", reviewId);

        return NextResponse.json({
          message: "Transaction already exists with this reference. Review marked as approved.",
          transactionId: existingTxn.id,
        });
      }
    }

    // 2. Create confirmed transaction in transactions table
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

    // 3. Atomically update review item
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

    // 4. Update processed_emails record with created transaction_id
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

    // 5. Log ledger event
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

    // 6. Mark review alerts as resolved
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
