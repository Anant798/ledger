import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { TransactionService } from "@/lib/transactions/service";
import {
  createTransactionSchema,
  transactionQuerySchema,
} from "@/lib/transactions/validation";

// GET: List transactions with query filters & pagination
export async function GET(request: Request) {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const parsedQuery = transactionQuerySchema.safeParse({
      direction: searchParams.get("direction") || undefined,
      status: searchParams.get("status") || undefined,
      transaction_type: searchParams.get("transaction_type") || undefined,
      category: searchParams.get("category") || undefined,
      payment_method: searchParams.get("payment_method") || undefined,
      payment_provider: searchParams.get("payment_provider") || undefined,
      source: searchParams.get("source") || undefined,
      startDate: searchParams.get("startDate") || undefined,
      endDate: searchParams.get("endDate") || undefined,
      search: searchParams.get("search") || undefined,
      sort: searchParams.get("sort") || undefined,
      sortDirection: searchParams.get("sortDirection") || undefined,
      page: searchParams.get("page") || undefined,
      limit: searchParams.get("limit") || undefined,
    });

    if (!parsedQuery.success) {
      return NextResponse.json(
        { error: "Invalid query parameters", details: parsedQuery.error.flatten() },
        { status: 400 }
      );
    }

    const result = await TransactionService.list(user.id, parsedQuery.data);
    return NextResponse.json(result);
  } catch (error: unknown) {
    console.error("Transaction fetch error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to fetch transactions" },
      { status: 500 }
    );
  }
}

// POST: Create a new manual transaction
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

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const validation = createTransactionSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        {
          error: "Invalid transaction data",
          details: validation.error.flatten(),
        },
        { status: 400 }
      );
    }

    const transaction = await TransactionService.create(user.id, validation.data);

    return NextResponse.json(
      {
        message: "Transaction created successfully",
        transaction,
      },
      { status: 201 }
    );
  } catch (error: unknown) {
    console.error("Transaction creation error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to create transaction" },
      { status: 500 }
    );
  }
}
