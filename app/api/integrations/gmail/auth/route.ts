import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  generateAuthUrl,
  getGmailOAuthConfig,
  getGmailTokenEncryptionKey,
  GmailOAuthConfigurationError,
} from "@/lib/gmail/client";
import { createGmailOAuthState } from "@/lib/gmail/oauth-state";

export async function GET(request: Request) {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const configurationErrors: string[] = [];
    const appOrigin = new URL(request.url).origin;
    try {
      getGmailOAuthConfig(process.env, process.env.NODE_ENV, appOrigin);
    } catch (error) {
      if (error instanceof GmailOAuthConfigurationError) configurationErrors.push(error.message);
      else throw error;
    }
    let stateSecret: string | undefined;
    try {
      stateSecret = getGmailTokenEncryptionKey();
    } catch (error) {
      if (error instanceof GmailOAuthConfigurationError) configurationErrors.push(error.message);
      else throw error;
    }
    if (configurationErrors.length) {
      throw new GmailOAuthConfigurationError(configurationErrors.join(" "));
    }

    const state = createGmailOAuthState(user.id, stateSecret!);
    const authUrl = generateAuthUrl(state, appOrigin);

    return NextResponse.json({ authUrl });
  } catch (error: unknown) {
    if (error instanceof GmailOAuthConfigurationError) {
      console.error("Gmail OAuth initialization configuration error:", error.code);
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 503 },
      );
    }
    console.error("Gmail OAuth initialization failed:", error instanceof Error ? error.name : "unknown error");
    return NextResponse.json(
      { error: "Failed to initialize Gmail OAuth." },
      { status: 500 }
    );
  }
}
