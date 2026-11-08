import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { SavingsService } from "@/lib/savings/service";
import { createSavingsGoalSchema } from "@/lib/savings/validation";

// GET: List all savings goals with progress
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

    const goals = await SavingsService.list(user.id);
    return NextResponse.json({ goals });
  } catch (error: unknown) {
    console.error("List savings goals error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list savings goals" },
      { status: 500 }
    );
  }
}

// POST: Create a new savings goal
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
    const validation = createSavingsGoalSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { error: "Invalid savings goal data", details: validation.error.flatten() },
        { status: 400 }
      );
    }

    const goal = await SavingsService.create(user.id, validation.data);

    return NextResponse.json(
      {
        message: "Savings goal created successfully",
        goal,
      },
      { status: 201 }
    );
  } catch (error: unknown) {
    console.error("Create savings goal error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create savings goal" },
      { status: 500 }
    );
  }
}
