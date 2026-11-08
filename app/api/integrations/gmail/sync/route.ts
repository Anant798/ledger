import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { syncUserGmail } from "@/lib/gmail/service";

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
  } catch (error: any) {
    console.error("Manual sync endpoint error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to synchronize Gmail" },
      { status: 500 }
    );
  }
}
