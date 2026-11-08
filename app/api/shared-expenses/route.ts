import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { SharedExpensesService } from "@/lib/shared-expenses/service";
import { createExpenseGroupSchema } from "@/lib/shared-expenses/validation";

// GET: List all expense groups
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

    const expenses = await SharedExpensesService.list(user.id);
    return NextResponse.json({ expenses });
  } catch (error: unknown) {
    console.error("List shared expenses error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch shared expenses" },
      { status: 500 }
    );
  }
}

// POST: Create a new expense group with shares
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
    const validation = createExpenseGroupSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { error: "Invalid shared expense payload", details: validation.error.flatten() },
        { status: 400 }
      );
    }

    const expense = await SharedExpensesService.create(user.id, validation.data);

    return NextResponse.json(
      {
        message: "Shared expense created successfully",
        expense,
      },
      { status: 201 }
    );
  } catch (error: unknown) {
    console.error("Create shared expense error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create shared expense" },
      { status: 500 }
    );
  }
}
