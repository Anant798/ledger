import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { setupGmailWatch, stopGmailWatch } from "@/lib/gmail/service";

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

    const body = await request.json();
    const action = body?.action; // "start" | "stop"
    const topicName = body?.topicName || process.env.GOOGLE_PUBSUB_TOPIC;

    if (action === "stop") {
      await stopGmailWatch(user.id);
      return NextResponse.json({ message: "Gmail watch stopped successfully" });
    }

    if (!topicName) {
      return NextResponse.json(
        { error: "GOOGLE_PUBSUB_TOPIC is not configured." },
        { status: 400 }
      );
    }

    const watchResult = await setupGmailWatch(user.id, topicName);

    return NextResponse.json({
      message: "Gmail watch started successfully",
      watchResult,
    });
  } catch (error: unknown) {
    console.error("Gmail watch setup error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to configure watch" },
      { status: 500 }
    );
  }
}
