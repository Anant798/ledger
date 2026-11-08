import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { TransactionService } from "@/lib/transactions/service";
import { updateTransactionSchema } from "@/lib/transactions/validation";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: RouteParams) {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await context.params;
    const transaction = await TransactionService.getById(user.id, id);

    if (!transaction) {
      return NextResponse.json({ error: "Transaction not found" }, { status: 404 });
    }

    return NextResponse.json({ transaction });
  } catch (error: unknown) {
    console.error("Get transaction error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch transaction" },
      { status: 500 }
    );
  }
}

export async function PATCH(request: Request, context: RouteParams) {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await context.params;
    let body: unknown;

    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const validation = updateTransactionSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { error: "Invalid transaction data", details: validation.error.flatten() },
        { status: 400 }
      );
    }

    const transaction = await TransactionService.update(
      user.id,
      id,
      validation.data
    );

    return NextResponse.json({
      message: "Transaction updated successfully",
      transaction,
    });
  } catch (error: unknown) {
    console.error("Update transaction error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update transaction" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request, context: RouteParams) {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await context.params;
    await TransactionService.delete(user.id, id);

    return NextResponse.json({
      message: "Transaction deleted successfully",
    });
  } catch (error: unknown) {
    console.error("Delete transaction error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete transaction" },
      { status: 500 }
    );
  }
}
