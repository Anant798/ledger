import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const supabase = await createClient();
  const { error } = await supabase.auth.signOut();
  if (error) {
    console.error("Sign-out failed:", error.message);
    return NextResponse.redirect(new URL("/?error=signout-failed", request.url), 303);
  }
  return NextResponse.redirect(new URL("/", request.url), 303);
}
