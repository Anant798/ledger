import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { TransactionService } from "@/lib/transactions/service";

export async function GET() {
  try {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ summary: await TransactionService.summary(user.id) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load financial summary" }, { status: 500 });
  }
}
