import { NextResponse } from "next/server";
import { getOAuth2Client } from "@/lib/gmail/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptToken } from "@/lib/gmail/encryption";
import { google } from "googleapis";
import { verifyGmailOAuthState } from "@/lib/gmail/oauth-state";
import { GMAIL_SCOPES } from "@/lib/gmail/client";

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
      const stateSecret = process.env.TOKEN_ENCRYPTION_KEY;
      if (!stateSecret) throw new Error("Gmail token encryption is not configured.");
      parsedState = verifyGmailOAuthState(state, stateSecret);
    } catch {
      return NextResponse.json({ error: "Invalid state parameter." }, { status: 400 });
    }

    const oauth2Client = getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);
    if (!tokens.access_token || !tokens.scope?.split(/\s+/).includes(GMAIL_SCOPES[0])) {
      return NextResponse.json({ error: "Google did not grant Gmail read-only access." }, { status: 400 });
    }
    oauth2Client.setCredentials(tokens);

    // Use the read-only Gmail profile endpoint; account sign-in OAuth is separate.
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });
    const gmailProfile = await gmail.users.getProfile({ userId: "me" });
    const emailAddress = gmailProfile.data.emailAddress || null;
    if (!emailAddress) throw new Error("Google did not return the connected Gmail address.");

    const supabase = createAdminClient();
    const { data: priorToken, error: priorTokenError } = await supabase
      .from("server_oauth_tokens")
      .select("refresh_token")
      .eq("user_id", parsedState.userId)
      .eq("provider", "gmail")
      .maybeSingle();
    if (priorTokenError) throw priorTokenError;
    if (!tokens.refresh_token && !priorToken?.refresh_token) {
      return NextResponse.json({ error: "Google did not return a refresh token. Revoke Ledger access in Google and reconnect." }, { status: 400 });
    }

    const tokenExpiry = tokens.expiry_date
      ? new Date(tokens.expiry_date).toISOString()
      : null;

    // Encrypt sensitive access and refresh tokens before storing on server
    const encryptedAccess = encryptToken(tokens.access_token);
    const encryptedRefresh = tokens.refresh_token
      ? encryptToken(tokens.refresh_token)
      : priorToken?.refresh_token || null;

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

    return NextResponse.redirect(
      new URL("/dashboard?integration=gmail_connected", request.url)
    );
  } catch (err: unknown) {
    console.error("Gmail OAuth Callback Exception:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to process OAuth callback." },
      { status: 500 }
    );
  }
}
