import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

const notificationActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("read"), id: z.string().uuid() }),
  z.object({ action: z.literal("read_all") }),
]);

export async function GET() {
  try {
    const db = await createClient();
    const { data: { user }, error: authError } = await db.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { data, error } = await db.from("alerts").select("id,alert_type,title,message,is_read,is_resolved,created_at")
      .eq("user_id", user.id).order("created_at", { ascending: false }).limit(25);
    if (error) throw error;
    return NextResponse.json({ notifications: data || [] });
  } catch (error: unknown) {
    console.error("List notifications error:", error instanceof Error ? error.name : "unknown error");
    return NextResponse.json({ error: "Could not load notifications" }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const db = await createClient();
    const { data: { user }, error: authError } = await db.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    let body: unknown;
    try { body = await request.json(); }
    catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
    const parsed = notificationActionSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "Invalid notification action" }, { status: 400 });
    let query = db.from("alerts").update({ is_read: true }).eq("user_id", user.id).eq("is_read", false);
    if (parsed.data.action === "read") query = query.eq("id", parsed.data.id);
    const { error } = await query;
    if (error) throw error;
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    console.error("Update notification error:", error instanceof Error ? error.name : "unknown error");
    return NextResponse.json({ error: "Could not update notification" }, { status: 500 });
  }
}
