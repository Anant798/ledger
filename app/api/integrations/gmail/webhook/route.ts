import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { syncUserGmail } from "@/lib/gmail/service";

export async function POST(request: Request) {
  try {
    const body = await request.json();

    if (!body?.message?.data) {
      return NextResponse.json({ error: "Invalid pub/sub message payload" }, { status: 400 });
    }

    const decodedData = Buffer.from(body.message.data, "base64").toString("utf-8");
    const pushNotification = JSON.parse(decodedData);

    const emailAddress = pushNotification.emailAddress;
    const historyId = pushNotification.historyId;

    const supabase = createAdminClient();

    // Log the incoming event into webhook_events table
    await supabase.from("webhook_events").insert({
      provider: "google_pubsub",
      provider_event_id: body.message.messageId || `msg_${Date.now()}`,
      event_type: "gmail_push_notification",
      processing_status: "received",
      payload: pushNotification,
      received_at: new Date().toISOString(),
    });

    if (!emailAddress) {
      return NextResponse.json({ error: "Missing email address in push payload" }, { status: 400 });
    }

    // Find user in server_oauth_tokens
    const { data: tokenRecord } = await supabase
      .from("server_oauth_tokens")
      .select("user_id")
      .eq("provider", "gmail")
      .eq("email_address", emailAddress)
      .maybeSingle();

    if (!tokenRecord) {
      return NextResponse.json({ message: "No matching integration for mailbox" });
    }

    // Trigger sync
    await syncUserGmail(tokenRecord.user_id, { maxResults: 10 });

    // Update webhook status
    await supabase
      .from("webhook_events")
      .update({
        processing_status: "processed",
        processed_at: new Date().toISOString(),
      })
      .eq("provider_event_id", body.message.messageId || "");

    return NextResponse.json({
      message: "Webhook processed and sync triggered",
      emailAddress,
      historyId,
    });
  } catch (error: any) {
    console.error("Gmail Pub/Sub webhook error:", error);
    return NextResponse.json(
      { error: error.message || "Failed processing webhook" },
      { status: 200 }
    );
  }
}
