import { NextResponse } from "next/server";
import { runReminderWorker } from "@/lib/shared-expenses/reminder-worker";

async function handle(request: Request) {
  const secret = process.env.REMINDER_CRON_SECRET || process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json(await runReminderWorker());
  } catch (error) {
    console.error("Reminder worker failed:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Reminder worker failed" }, { status: 500 });
  }
}

// Vercel Cron invokes scheduled routes with GET.
export async function GET(request: Request) {
  return handle(request);
}

// POST remains available for a protected manual invocation.
export async function POST(request: Request) {
  return handle(request);
}
