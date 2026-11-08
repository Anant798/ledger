import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { SharedExpensesService } from "@/lib/shared-expenses/service";
import { archiveExpenseGroupSchema, updateExpenseGroupSchema } from "@/lib/shared-expenses/validation";

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
    const expense = await SharedExpensesService.getById(user.id, id);

    if (!expense) {
      return NextResponse.json({ error: "Shared expense not found" }, { status: 404 });
    }

    return NextResponse.json({ expense });
  } catch (error: unknown) {
    console.error("Get shared expense error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch shared expense" },
      { status: 500 }
    );
  }
}

export async function PATCH(request: Request, context: RouteParams) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    let body: unknown;
    try { body = await request.json(); }
    catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
    const { id } = await context.params;
    const archiveValidation = archiveExpenseGroupSchema.safeParse(body);
    if (archiveValidation.success) {
      const expense = await SharedExpensesService.setArchived(user.id, id, archiveValidation.data.archived);
      return NextResponse.json({ expense });
    }
    const validation = updateExpenseGroupSchema.safeParse(body);
    if (!validation.success) return NextResponse.json({ error: "Invalid shared expense update", details: validation.error.flatten() }, { status: 400 });
    const expense = await SharedExpensesService.update(user.id, id, validation.data);
    return NextResponse.json({ expense });
  } catch (error: unknown) {
    console.error("Update shared expense error:", error instanceof Error ? error.name : "unknown error");
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to update shared expense" }, { status: 400 });
  }
}

export async function DELETE(request: Request, context: RouteParams) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { id } = await context.params;
    const expense = await SharedExpensesService.setArchived(user.id, id, true);
    return NextResponse.json({ message: "Expense group archived", expense });
  } catch (error: unknown) {
    console.error("Archive shared expense error:", error instanceof Error ? error.name : "unknown error");
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to archive shared expense" }, { status: 400 });
  }
}
