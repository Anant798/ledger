import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { SavingsService } from "@/lib/savings/service";
import { updateSavingsGoalSchema } from "@/lib/savings/validation";

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
    const goal = await SavingsService.getById(user.id, id);

    if (!goal) {
      return NextResponse.json({ error: "Savings goal not found" }, { status: 404 });
    }

    return NextResponse.json({ goal });
  } catch (error: unknown) {
    console.error("Get savings goal error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch savings goal" },
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
    const body = await request.json();
    const validation = updateSavingsGoalSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { error: "Invalid update data", details: validation.error.flatten() },
        { status: 400 }
      );
    }

    const updated = await SavingsService.update(user.id, id, validation.data);

    return NextResponse.json({
      message: "Savings goal updated successfully",
      goal: updated,
    });
  } catch (error: unknown) {
    console.error("Update savings goal error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update savings goal" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request, context: RouteParams) {
  try {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { id } = await context.params;
    await SavingsService.delete(user.id, id);
    return NextResponse.json({ message: "Savings goal archived" });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to archive savings goal" }, { status: 500 });
  }
}

export async function POST(request: Request, context: RouteParams) {
  try {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { id } = await context.params;
    const result = await SavingsService.complete(user.id, id);
    return NextResponse.json({ message: "Savings goal completed", result });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to complete savings goal" }, { status: 400 });
  }
}
