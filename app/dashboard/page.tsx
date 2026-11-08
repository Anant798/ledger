
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { createClient } from "@/lib/supabase/server";

export default async function DashboardPage() {
  // Wait for an incoming request before rendering.
  await connection();

  const supabase = await createClient();

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    redirect("/");
  }

  return (
    <main className="min-h-screen bg-[#F3EEDF] p-8 text-[#302B22]">
      <header className="border-b border-[#C9BDA6] pb-6">
        <p className="text-xs tracking-[0.3em] text-[#897653]">
          PERSONAL FINANCIAL LEDGER
        </p>

        <h1 className="mt-3 font-serif text-4xl">Ledger</h1>
      </header>

      <section className="mt-12">
        <h2 className="font-serif text-3xl">
          Welcome to your ledger.
        </h2>

        <p className="mt-3 text-[#756C5D]">
          Signed in as {user.email}
        </p>

        <p className="mt-6 text-sm text-[#897653]">
          Your financial workspace is being prepared.
        </p>
      </section>
    </main>
  );
}
