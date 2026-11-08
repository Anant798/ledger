import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptToken } from "@/lib/gmail/encryption";
import { getOAuth2Client } from "@/lib/gmail/client";

async function authenticatedUser() {
  const client = await createClient();
  const { data: { user }, error } = await client.auth.getUser();
  return error || !user ? null : user;
}

export async function GET() {
  const user = await authenticatedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const admin = createAdminClient();
  const { data, error } = await admin.from("server_oauth_tokens")
    .select("email_address,sync_status,last_error,last_synced_at,initial_sync_completed,watch_expiration")
    .eq("user_id", user.id).eq("provider", "gmail").maybeSingle();
  if (error) return NextResponse.json({ error: "Unable to load Gmail status" }, { status: 500 });
  return NextResponse.json({
    connected: Boolean(data),
    connection: data ? {
      emailAddress: data.email_address,
      syncStatus: data.sync_status,
      lastError: data.last_error,
      lastSyncedAt: data.last_synced_at,
      initialSyncCompleted: data.initial_sync_completed,
      watchExpiration: data.watch_expiration,
    } : null,
  });
}

export async function DELETE() {
  const user = await authenticatedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const admin = createAdminClient();
  const { data: token, error: readError } = await admin.from("server_oauth_tokens")
    .select("refresh_token,access_token").eq("user_id", user.id).eq("provider", "gmail").maybeSingle();
  if (readError) return NextResponse.json({ error: "Unable to disconnect Gmail" }, { status: 500 });

  let remoteRevoked = false;
  if (token) {
    try {
      const oauth = getOAuth2Client();
      const encrypted = token.refresh_token || token.access_token;
      await oauth.revokeToken(decryptToken(encrypted));
      remoteRevoked = true;
    } catch {
      // Local disconnection must still succeed when Google revocation is unavailable.
    }
  }
  const { error: deleteError } = await admin.from("server_oauth_tokens")
    .delete().eq("user_id", user.id).eq("provider", "gmail");
  if (deleteError) return NextResponse.json({ error: "Unable to disconnect Gmail" }, { status: 500 });
  return NextResponse.json({ disconnected: true, remoteRevoked });
}
