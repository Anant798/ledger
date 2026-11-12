import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import DashboardShell from "@/components/dashboard-shell";
import { createClient } from "@/lib/supabase/server";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<div className="mx-auto min-h-80 w-full max-w-6xl px-4 py-8 sm:px-7 lg:px-10" role="status" aria-live="polite"><p className="text-sm text-[#756C5D]">Loading your Chronexa workspace…</p></div>}>
    <AuthenticatedDashboardLayout>{children}</AuthenticatedDashboardLayout>
  </Suspense>;
}

async function AuthenticatedDashboardLayout({ children }: { children: React.ReactNode }) {
  await connection();
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) redirect("/");

  const { data: profile } = await supabase.from("profiles")
    .select("full_name,preferred_language")
    .eq("id", user.id)
    .maybeSingle();
  const name = profile?.full_name?.trim() || user.user_metadata?.full_name || user.user_metadata?.name || "Your account";
  const language = profile?.preferred_language === "hi" ? "hi" : "en";

  return <DashboardShell name={name} language={language}>{children}</DashboardShell>;
}
