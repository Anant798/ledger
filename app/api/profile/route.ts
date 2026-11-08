import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

const profileSchema = z.object({
  full_name: z.string().trim().min(1).max(200),
  date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  preferred_language: z.enum(["en", "hi"]),
}).refine((value) => {
  if (!value.date_of_birth) return true;
  const parsedDate = new Date(`${value.date_of_birth}T00:00:00.000Z`);
  return !Number.isNaN(parsedDate.getTime())
    && parsedDate.toISOString().slice(0, 10) === value.date_of_birth
    && value.date_of_birth <= new Date().toISOString().slice(0, 10);
}, {
  path: ["date_of_birth"],
  message: "Date of birth must be today or earlier.",
});

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });

  const { data: profile, error } = await supabase.from("profiles")
    .select("full_name,date_of_birth,preferred_language")
    .eq("id", user.id)
    .maybeSingle();
  if (error) {
    console.error("Profile lookup failed:", error.message);
    return NextResponse.json({ error: "Could not load your profile." }, { status: 500 });
  }

  return NextResponse.json({ profile: {
    full_name: profile?.full_name || user.user_metadata?.full_name || user.user_metadata?.name || "",
    date_of_birth: profile?.date_of_birth || user.user_metadata?.date_of_birth || "",
    preferred_language: profile?.preferred_language || "en",
    email: user.email || "",
  } });
}

export async function PATCH(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });

  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Please check the details and try again." }, { status: 400 }); }
  const parsed = profileSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message || "Please check the details and try again." }, { status: 400 });

  const values = {
    full_name: parsed.data.full_name,
    date_of_birth: parsed.data.date_of_birth,
    preferred_language: parsed.data.preferred_language,
  };
  const { data: existing, error: lookupError } = await supabase.from("profiles").select("id").eq("id", user.id).maybeSingle();
  if (lookupError) {
    console.error("Profile lookup failed:", lookupError.message);
    return NextResponse.json({ error: "Could not save your profile." }, { status: 500 });
  }
  const result = existing
    ? await supabase.from("profiles").update(values).eq("id", user.id)
    : await supabase.from("profiles").insert({ id: user.id, ...values });
  if (result.error) {
    console.error("Profile save failed:", result.error.message);
    return NextResponse.json({ error: "Could not save your profile." }, { status: 500 });
  }

  return NextResponse.json({ profile: { ...values, email: user.email || "" } });
}
