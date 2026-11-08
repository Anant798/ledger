import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { SharedExpensesService } from "@/lib/shared-expenses/service";
import { repaymentActionSchema } from "@/lib/shared-expenses/validation";

type RouteParams = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteParams) {
  try {
    const db = await createClient();
    const { data: { user }, error: authError } = await db.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    let body: unknown;
    try { body = await request.json(); }
    catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
    const parsed = repaymentActionSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "Invalid repayment action", details: parsed.error.flatten() }, { status: 400 });

    const { id } = await context.params;
    const result = parsed.data.action === "edit"
      ? await SharedExpensesService.updateRepayment(user.id, id, parsed.data)
      : await SharedExpensesService.reverseRepayment(user.id, id, parsed.data.reason);
    return NextResponse.json({ result });
  } catch (error: unknown) {
    console.error("Update repayment error:", error instanceof Error ? error.name : "unknown error");
    const message = error instanceof Error ? error.message : "Failed to update repayment";
    const status = message.toLowerCase().includes("not found") ? 404 : 409;
    return NextResponse.json({ error: message }, { status });
  }
}
