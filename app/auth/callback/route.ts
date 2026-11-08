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
      const admin = createAdminClient();
      const { error: profileError } = await admin.from("profiles").upsert({
        id: user.id,
        full_name: typeof metadata.full_name === "string" ? metadata.full_name.slice(0, 200) :
          typeof metadata.name === "string" ? metadata.name.slice(0, 200) : null,
        avatar_url: typeof metadata.avatar_url === "string" ? metadata.avatar_url.slice(0, 2000) :
          typeof metadata.picture === "string" ? metadata.picture.slice(0, 2000) : null,
      }, { onConflict: "id", ignoreDuplicates: true });
      if (profileError) {
        console.error("Google sign-in profile initialization failed:", profileError.message);
        return NextResponse.redirect(`${origin}/?error=profile-initialization-failed`);
      }
      const { data: profile, error: profileReadError } = await admin.from("profiles")
        .select("id,full_name,avatar_url")
        .eq("id", user.id)
        .maybeSingle();
      if (profileReadError || !profile) {
        console.error("Google sign-in profile lookup failed:", profileReadError?.message || "profile missing");
        return NextResponse.redirect(`${origin}/?error=profile-initialization-failed`);
      }
      return NextResponse.redirect(`${origin}/dashboard`);
    }
  }

  return NextResponse.redirect(`${origin}/?error=auth-callback-failed`);
}
