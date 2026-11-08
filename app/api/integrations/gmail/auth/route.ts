import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { generateAuthUrl } from "@/lib/gmail/client";

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

    // State carries user id securely to match on callback
    const state = Buffer.from(JSON.stringify({ userId: user.id })).toString("base64url");
    const authUrl = generateAuthUrl(state);

    return NextResponse.json({ authUrl });
  } catch (error: any) {
    console.error("Gmail OAuth Init Error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to initialize Gmail OAuth" },
      { status: 500 }
    );
  }
}
