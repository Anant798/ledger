import { NextResponse } from "next/server";
import { getOAuth2Client } from "@/lib/gmail/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptToken } from "@/lib/gmail/encryption";
import { google } from "googleapis";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const code = searchParams.get("code");
    const state = searchParams.get("state");
    const error = searchParams.get("error");

    if (error) {
      return NextResponse.json(
        { error: `Google OAuth error: ${error}` },
        { status: 400 }
      );
    }

    if (!code || !state) {
      return NextResponse.json(
        { error: "Missing authorization code or state." },
        { status: 400 }
      );
    }

    let parsedState: { userId: string };
    try {
      parsedState = JSON.parse(
        Buffer.from(state, "base64url").toString("utf-8")
      );
    } catch {
      return NextResponse.json({ error: "Invalid state parameter." }, { status: 400 });
    }

    const oauth2Client = getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Fetch user profile email
    const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();
    const emailAddress = userInfo.data.email || null;

    const supabase = createAdminClient();

    const tokenExpiry = tokens.expiry_date
      ? new Date(tokens.expiry_date).toISOString()
      : null;

    // Encrypt sensitive access and refresh tokens before storing on server
    const encryptedAccess = encryptToken(tokens.access_token!);
    const encryptedRefresh = tokens.refresh_token
      ? encryptToken(tokens.refresh_token)
      : null;

    // 1. Store encrypted tokens in server_oauth_tokens (backend-only table, no client RLS)
    const { error: upsertError } = await supabase
      .from("server_oauth_tokens")
      .upsert(
        {
          user_id: parsedState.userId,
          provider: "gmail",
          email_address: emailAddress,
          access_token: encryptedAccess,
          refresh_token: encryptedRefresh,
          token_expiry: tokenExpiry,
          scope: tokens.scope || null,
          sync_status: "idle",
          updated_at: new Date().toISOString(),
        },
        {
          onConflict: "user_id,provider",
        }
      );

    if (upsertError) {
      console.error("Failed to store encrypted Gmail tokens:", upsertError);
      return NextResponse.json(
        { error: "Failed to store integration tokens." },
        { status: 500 }
      );
    }

    // 2. Also register in payment_sources WITHOUT exposing tokens (metadata only contains non-sensitive connection info)
    await supabase.from("payment_sources").upsert(
      {
        user_id: parsedState.userId,
        provider: "gmail",
        provider_account_reference: emailAddress,
        display_name: emailAddress ? `Gmail (${emailAddress})` : "Gmail Account",
        connection_status: "connected",
        consent_granted: true,
        consent_granted_at: new Date().toISOString(),
        connected_at: new Date().toISOString(),
        metadata: {
          email_address: emailAddress,
          scopes: tokens.scope,
        },
      },
      {
        onConflict: "user_id,provider",
      }
    );

    return NextResponse.redirect(
      new URL("/dashboard?integration=gmail_connected", request.url)
    );
  } catch (err: any) {
    console.error("Gmail OAuth Callback Exception:", err);
    return NextResponse.json(
      { error: err.message || "Failed to process OAuth callback." },
      { status: 500 }
    );
  }
}
