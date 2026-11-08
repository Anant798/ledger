import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { generateAuthUrl } from "@/lib/gmail/client";
import { createGmailOAuthState } from "@/lib/gmail/oauth-state";

export async function GET() {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const stateSecret = process.env.TOKEN_ENCRYPTION_KEY;
    if (!stateSecret) throw new Error("Gmail token encryption is not configured.");
    const state = createGmailOAuthState(user.id, stateSecret);
    const authUrl = generateAuthUrl(state);

    return NextResponse.json({ authUrl });
  } catch (error: unknown) {
    console.error("Gmail OAuth Init Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to initialize Gmail OAuth" },
      { status: 500 }
    );
  }
}
