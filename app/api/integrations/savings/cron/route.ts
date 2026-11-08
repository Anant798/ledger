import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(request: Request) {
  const secret = process.env.SAVINGS_CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase.rpc("run_due_savings_goal_rules", { p_limit: 100 });
    if (error) throw error;
    return NextResponse.json({ processed: data });
  } catch (error) {
    console.error("Savings scheduler failed:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Savings scheduler failed" }, { status: 500 });
  }
}
