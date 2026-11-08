import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { SavingsService } from "@/lib/savings/service";
import { savingsRuleSchema } from "@/lib/savings/validation";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { id } = await context.params;
    const rules = await SavingsService.listRules(user.id, id);
    return NextResponse.json({ rules });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to load savings rules" }, { status: 400 });
  }
}

export async function POST(request: Request, context: Context) {
  try {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const parsed = savingsRuleSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Invalid savings rule", details: parsed.error.flatten() }, { status: 400 });
    const { id } = await context.params;
    const rule = await SavingsService.saveRule(user.id, id, parsed.data);
    return NextResponse.json({ rule }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to save savings rule" }, { status: 400 });
  }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const body = await request.json();
    const parsed = savingsRuleSchema.safeParse(body);
    if (!parsed.success || typeof body.rule_id !== "string") return NextResponse.json({ error: "Invalid savings rule" }, { status: 400 });
    const { id } = await context.params;
    const rule = await SavingsService.saveRule(user.id, id, parsed.data, body.rule_id);
    return NextResponse.json({ rule });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to update savings rule" }, { status: 400 });
  }
}

export async function DELETE(request: Request, context: Context) {
  try {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { id } = await context.params;
    const ruleId = new URL(request.url).searchParams.get("rule_id");
    if (!ruleId) return NextResponse.json({ error: "rule_id is required" }, { status: 400 });
    await SavingsService.deleteRule(user.id, id, ruleId);
    return NextResponse.json({ message: "Rule deleted" });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to delete savings rule" }, { status: 400 });
  }
}
