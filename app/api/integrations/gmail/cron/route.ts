import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { syncUserGmail } from "@/lib/gmail/service";

const CRON_SECRET = process.env.CRON_SECRET;

export async function POST(request: Request) {
  try {
    const authHeader = request.headers.get("authorization");

    if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
      return NextResponse.json({ error: "Unauthorized cron trigger" }, { status: 401 });
    }

    const supabase = createAdminClient();

    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    const { data: integrations, error } = await supabase
      .from("server_oauth_tokens")
      .select("user_id, last_synced_at")
      .eq("provider", "gmail")
      .or(`last_synced_at.is.null,last_synced_at.lt.${thirtyMinutesAgo}`)
      .limit(10);

    if (error) throw error;

    const results = [];

    for (const item of integrations || []) {
      try {
        const res = await syncUserGmail(item.user_id, { maxResults: 15 });
        results.push({ userId: item.user_id, status: "success", res });
      } catch (err: any) {
        results.push({ userId: item.user_id, status: "error", error: err.message });
      }
    }

    return NextResponse.json({
      message: `Processed ${results.length} integrations`,
      results,
    });
  } catch (error: any) {
    console.error("Cron sync error:", error);
    return NextResponse.json(
      { error: error.message || "Failed scheduled sync" },
      { status: 500 }
    );
  }
}
