import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { SavingsService } from "@/lib/savings/service";
import { updateContributionSchema } from "@/lib/savings/validation";

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: Context) {
  try {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const parsed = updateContributionSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Invalid contribution update", details: parsed.error.flatten() }, { status: 400 });
    const { id } = await context.params;
    const contribution = await SavingsService.updateContribution(user.id, id, parsed.data);
    return NextResponse.json({ contribution });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to update contribution" }, { status: 400 });
  }
}

export async function DELETE(request: Request, context: Context) {
  try {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { id } = await context.params;
    const reason = new URL(request.url).searchParams.get("reason") || undefined;
    const contribution = await SavingsService.reverseContribution(user.id, id, reason);
    return NextResponse.json({ contribution });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to reverse contribution" }, { status: 400 });
  }
}
