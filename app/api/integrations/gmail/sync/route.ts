import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { syncUserGmail } from "@/lib/gmail/service";
import { GeminiConfigurationError } from "@/lib/email-parser/gemini";

export async function POST(request: Request) {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let forceFullSync = false;
    let fetchAllPages = false;
    let maxResults = 25;

    try {
      const body = await request.json();
      if (typeof body?.forceFullSync === "boolean") {
        forceFullSync = body.forceFullSync;
      }
      if (typeof body?.fetchAllPages === "boolean") {
        fetchAllPages = body.fetchAllPages;
      }
      if (typeof body?.maxResults === "number") {
        maxResults = Math.min(Math.max(body.maxResults, 1), 50);
      }
    } catch {
      // Body is optional
    }

    const syncResult = await syncUserGmail(user.id, {
      forceFullSync,
      fetchAllPages,
      maxResults,
    });

    return NextResponse.json({
      message: "Sync completed successfully",
      result: syncResult,
    });
  } catch (error: unknown) {
    if (error instanceof GeminiConfigurationError) {
      console.error("Manual Gmail sync configuration error: GEMINI_API_KEY_MISSING");
      return NextResponse.json({ error: error.message, code: error.code }, { status: 503 });
    }
    console.error("Manual Gmail sync failed:", error instanceof Error ? error.name : "unknown error");
    return NextResponse.json(
      { error: "Failed to synchronize Gmail." },
      { status: 500 }
    );
  }
}
