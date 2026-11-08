import { NextResponse } from "next/server";
import { google } from "googleapis";
import { createAdminClient } from "@/lib/supabase/admin";
import { syncUserGmail } from "@/lib/gmail/service";
import { verifyGooglePubSubPush } from "@/lib/gmail/pubsub-auth";

type PushBody = { message?: { data?: string; messageId?: string } };

async function verifyPushToken(token: string, audience: string) {
  const ticket = await new google.auth.OAuth2().verifyIdToken({ idToken: token, audience });
  const payload = ticket.getPayload();
  return { aud: payload?.aud, email: payload?.email, email_verified: payload?.email_verified };
}

export async function POST(request: Request) {
  let eventId: string | undefined;
  let eventClaimed = false;
  const supabase = createAdminClient();
  try {
    const authorized = await verifyGooglePubSubPush(
      request.headers.get("authorization"),
      process.env.GOOGLE_PUBSUB_AUDIENCE,
      process.env.GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL,
      verifyPushToken
    );
    if (!authorized) return NextResponse.json({ error: "Unauthorized Pub/Sub push" }, { status: 401 });

    let body: PushBody;
    try { body = await request.json() as PushBody; }
    catch { return NextResponse.json({ error: "Invalid Pub/Sub message payload" }, { status: 400 }); }
    const encoded = body.message?.data;
    eventId = body.message?.messageId;
    if (!encoded || !eventId) return NextResponse.json({ error: "Pub/Sub data and message ID are required" }, { status: 400 });

    let pushNotification: { emailAddress?: string; historyId?: string };
    try { pushNotification = JSON.parse(Buffer.from(encoded, "base64").toString("utf-8")); }
    catch { return NextResponse.json({ error: "Invalid Gmail notification data" }, { status: 400 }); }
    if (!pushNotification.emailAddress || !pushNotification.historyId) {
      return NextResponse.json({ error: "Gmail notification is missing its mailbox or history ID" }, { status: 400 });
    }

    const { data: claimed, error: claimError } = await supabase.rpc("claim_gmail_webhook_event", {
      p_provider: "google_pubsub",
      p_event_id: eventId,
      p_event_type: "gmail_push_notification",
      p_payload: pushNotification,
    });
    if (claimError) throw claimError;
    if (!claimed) return NextResponse.json({ message: "Duplicate or currently processing push acknowledged" });
    eventClaimed = true;

    const { data: tokenRecord, error: tokenError } = await supabase
      .from("server_oauth_tokens")
      .select("user_id")
      .eq("provider", "gmail")
      .eq("email_address", pushNotification.emailAddress)
      .maybeSingle();
    if (tokenError) throw tokenError;

    if (tokenRecord) await syncUserGmail(tokenRecord.user_id, { maxResults: 10 });

    const { error: finishError } = await supabase.rpc("finish_gmail_webhook_event", {
      p_provider: "google_pubsub", p_event_id: eventId, p_status: "processed", p_error: null,
    });
    if (finishError) throw finishError;
    return NextResponse.json({ message: tokenRecord ? "Gmail push processed" : "No matching mailbox integration" });
  } catch (error) {
    if (eventClaimed && eventId) {
      const { error: finishError } = await supabase.rpc("finish_gmail_webhook_event", {
        p_provider: "google_pubsub", p_event_id: eventId, p_status: "failed", p_error: "Webhook processing failed",
      });
      if (finishError) console.error("Failed to record Pub/Sub delivery failure:", finishError.message);
    }
    console.error("Gmail Pub/Sub webhook processing failed:", error instanceof Error ? error.name : "unknown error");
    return NextResponse.json({ error: "Gmail push processing failed; Pub/Sub may retry" }, { status: 500 });
  }
}
