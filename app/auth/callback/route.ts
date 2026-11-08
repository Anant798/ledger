import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");

  if (code) {
    const supabase = await createClient();

    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      const { data: { user }, error: userError } = await supabase.auth.getUser();
      if (userError || !user) return NextResponse.redirect(`${origin}/?error=auth-callback-failed`);

      // Supabase may have created this profile with an auth trigger already.
      // Ignore conflicts so Google sign-in never overwrites an existing profile.
      const metadata = user.user_metadata || {};
      const fullName = typeof metadata.full_name === "string" ? metadata.full_name.trim().slice(0, 200) :
        typeof metadata.name === "string" ? metadata.name.trim().slice(0, 200) : null;
      const dateOfBirth = typeof metadata.date_of_birth === "string" && /^\d{4}-\d{2}-\d{2}$/.test(metadata.date_of_birth)
        ? metadata.date_of_birth
        : null;
      const admin = createAdminClient();
      const { error: profileError } = await admin.from("profiles").upsert({
        id: user.id,
        full_name: fullName,
        avatar_url: typeof metadata.avatar_url === "string" ? metadata.avatar_url.slice(0, 2000) :
          typeof metadata.picture === "string" ? metadata.picture.slice(0, 2000) : null,
        date_of_birth: dateOfBirth,
      }, { onConflict: "id", ignoreDuplicates: true });
      if (profileError) {
        console.error("Google sign-in profile initialization failed:", profileError.message);
        return NextResponse.redirect(`${origin}/?error=profile-initialization-failed`);
      }
      const { data: profile, error: profileReadError } = await admin.from("profiles")
        .select("id,full_name,avatar_url,date_of_birth")
        .eq("id", user.id)
        .maybeSingle();
      if (profileReadError || !profile) {
        console.error("Google sign-in profile lookup failed:", profileReadError?.message || "profile missing");
        return NextResponse.redirect(`${origin}/?error=profile-initialization-failed`);
      }
      // Fill only missing fields so a returning user's saved profile is preserved.
      const missingProfileFields: Record<string, string> = {};
      if (!profile.full_name && fullName) missingProfileFields.full_name = fullName;
      if (!profile.date_of_birth && dateOfBirth) missingProfileFields.date_of_birth = dateOfBirth;
      if (Object.keys(missingProfileFields).length > 0) {
        const { error: profileUpdateError } = await admin.from("profiles").update(missingProfileFields).eq("id", user.id);
        if (profileUpdateError) {
          console.error("Profile details could not be saved:", profileUpdateError.message);
          return NextResponse.redirect(`${origin}/?error=profile-initialization-failed`);
        }
      }
      return NextResponse.redirect(`${origin}/dashboard`);
    }
  }

  return NextResponse.redirect(`${origin}/?error=auth-callback-failed`);
}
