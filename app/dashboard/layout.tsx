import { redirect } from "next/navigation";
import { connection } from "next/server";
import DashboardShell from "@/components/dashboard-shell";
import { createClient } from "@/lib/supabase/server";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
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
