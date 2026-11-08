
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { createClient } from "@/lib/supabase/server";
import ExpenseGroups from "@/components/expense-groups";
import NotificationCenter from "@/components/notification-center";
import SavingsGoals from "@/components/savings-goals";

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
        <div className="mt-4 flex items-center gap-4">
          <NotificationCenter />
          <form action="/auth/signout" method="post">
          <button type="submit" className="text-sm text-[#715B37] underline underline-offset-4">
            Sign out
          </button>
          </form>
        </div>
      </header>

      <section className="mt-12">
        <h2 className="font-serif text-3xl">
          Welcome to your ledger.
        </h2>

        <p className="mt-3 text-[#756C5D]">
          Signed in as {user.email}
        </p>

        <p className="mt-6 text-sm text-[#897653]">
          Keep shared costs clear and repayment history together.
        </p>
      </section>

      <ExpenseGroups />
      <SavingsGoals />
    </main>
  );
}
