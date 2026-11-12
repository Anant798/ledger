import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import DashboardShell from "@/components/dashboard-shell";
import { createClient } from "@/lib/supabase/server";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<main className="chronexa-loading" role="status" aria-live="polite" aria-label="Loading Chronexa"><div className="chronexa-loader-mark" aria-hidden="true" /><p className="chronexa-loading-label">Preparing your financial timeline</p></main>}>
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
