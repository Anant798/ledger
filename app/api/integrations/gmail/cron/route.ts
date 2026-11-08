import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { syncUserGmail, setupGmailWatch } from "@/lib/gmail/service";

const CRON_SECRET = process.env.CRON_SECRET;
const GOOGLE_PUBSUB_TOPIC = process.env.GOOGLE_PUBSUB_TOPIC;

export async function POST(request: Request) {
  try {
    const authHeader = request.headers.get("authorization");

    if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
      return NextResponse.json({ error: "Unauthorized cron trigger" }, { status: 401 });
    }

    const supabase = createAdminClient();

    // 1. Identify integrations that need synchronization (not synced in the last 30 minutes)
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    const { data: integrations, error } = await supabase
      .from("server_oauth_tokens")
      .select("user_id, last_synced_at, watch_expiration")
      .eq("provider", "gmail")
      .or(`last_synced_at.is.null,last_synced_at.lt.${thirtyMinutesAgo}`)
      .limit(10);

    if (error) throw error;

    const syncResults = [];
    const watchRenewals = [];

    const now = Date.now();
    const twentyFourHoursFromNow = new Date(now + 24 * 60 * 60 * 1000).toISOString();

    for (const item of integrations || []) {
      // Execute incremental or query sync
      try {
        const res = await syncUserGmail(item.user_id, { maxResults: 15 });
        syncResults.push({ userId: item.user_id, status: "success", res });
      } catch (err: any) {
        syncResults.push({ userId: item.user_id, status: "error", error: err.message });
      }

      // Check if Gmail Pub/Sub watch is expiring within 24 hours (or expired) and renew it automatically
      if (GOOGLE_PUBSUB_TOPIC) {
        const isWatchExpiringSoon =
          !item.watch_expiration ||
          new Date(item.watch_expiration).toISOString() < twentyFourHoursFromNow;

        if (isWatchExpiringSoon) {
          try {
            const watchRes = await setupGmailWatch(item.user_id, GOOGLE_PUBSUB_TOPIC);
            watchRenewals.push({
              userId: item.user_id,
              status: "renewed",
              expiration: watchRes.expiration,
            });
          } catch (wErr: any) {
            watchRenewals.push({
              userId: item.user_id,
              status: "renewal_failed",
              error: wErr.message,
            });
          }
        }
      }
    }

    return NextResponse.json({
      message: `Processed ${syncResults.length} sync integrations and ${watchRenewals.length} watch renewals`,
      syncResults,
      watchRenewals,
    });
  } catch (error: any) {
    console.error("Cron sync error:", error);
    return NextResponse.json(
      { error: error.message || "Failed scheduled sync" },
      { status: 500 }
    );
  }
}
