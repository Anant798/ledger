import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { SharedExpensesService } from "@/lib/shared-expenses/service";

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
