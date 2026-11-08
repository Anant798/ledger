import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { SharedExpensesService } from "@/lib/shared-expenses/service";
import { reminderSettingSchema } from "@/lib/shared-expenses/validation";

// GET: Fetch pending reminders for unsettled shares
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

    const pendingReminders = await SharedExpensesService.getPendingReminders(user.id);

    // Also fetch user's reminder settings
    const { data: settings } = await supabase
      .from("reminder_settings")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();

    if (settings?.enabled) {
      const { error: scheduleError } = await supabase.rpc("schedule_expense_reminders", { p_user_id: user.id });
      if (scheduleError) throw scheduleError;
    }
    const { data: scheduled, error: queueError } = await supabase.from("reminder_logs").select("*,attempts:reminder_attempts(*)").eq("user_id", user.id).order("created_at", { ascending: false }).limit(200);
    if (queueError) throw queueError;

    return NextResponse.json({
      settings: settings || null,
      pendingReminders,
      scheduledReminders: (scheduled || []).map((reminder) => ({ ...reminder, status: reminder.delivery_status, attempts: reminder.attempt_count, next_attempt_at: reminder.scheduled_for })),
    });
  } catch (error) {
    console.error("Fetch pending reminders error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch reminders" },
      { status: 500 }
    );
  }
}

// POST: Configure reminder settings (upserts in reminder_settings)
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
    const validation = reminderSettingSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { error: "Invalid reminder settings payload", details: validation.error.flatten() },
        { status: 400 }
      );
    }

    const { data: updated, error } = await supabase
      .from("reminder_settings")
      .upsert(
        {
          user_id: user.id,
          ...validation.data,
          updated_at: new Date().toISOString(),
        },
        {
          onConflict: "user_id",
        }
      )
      .select()
      .single();

    if (error) throw error;

    const { error: scheduleError } = validation.data.enabled
      ? await supabase.rpc("schedule_expense_reminders", { p_user_id: user.id })
      : await supabase.rpc("cancel_user_expense_reminders", { p_user_id: user.id });
    if (scheduleError) throw scheduleError;

    return NextResponse.json({
      message: "Reminder settings updated successfully",
      settings: updated,
    });
  } catch (error) {
    console.error("Update reminder settings error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update reminder settings" },
      { status: 500 }
    );
  }
}
