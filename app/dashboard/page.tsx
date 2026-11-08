import { ArrowLeftRight, CreditCard, PiggyBank, UsersRound } from "lucide-react";
import Link from "next/link";
import Transactions from "@/components/transactions";
import PageHeading from "@/components/page-heading";
import { createClient } from "@/lib/supabase/server";

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const { data: profile } = user ? await supabase.from("profiles").select("full_name").eq("id", user.id).maybeSingle() : { data: null };
  const name = profile?.full_name?.trim() || user?.user_metadata?.full_name || user?.user_metadata?.name || "";

  return <div>
    <PageHeading eyebrow="YOUR BOOK OF ACCOUNTS" title="Your money summary" description={name ? `Welcome, ${name}.` : "A clear view of your money, all in one place."} hi={{ eyebrow: "आपके पैसों का हिसाब", title: "आपके पैसों का सार", description: name ? `नमस्ते, ${name}।` : "अपने पैसों का साफ़ हिसाब, एक जगह।" }}/>
    <Transactions summaryOnly />
    <section className="mt-8">
      <h2 className="text-xl">Go to a page</h2>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <HomeLink href="/dashboard/banking" icon={<CreditCard size={19}/>} title="Money In & Out" note="See, add, and update your transactions"/>
        <HomeLink href="/dashboard/groups" icon={<UsersRound size={19}/>} title="Group Payments" note="Track shared costs and money owed"/>
        <HomeLink href="/dashboard/savings" icon={<PiggyBank size={19}/>} title="Savings Goals" note="See how your savings are growing"/>
      </div>
    </section>
  </div>;
}

function HomeLink({ href, icon, title, note }: { href: string; icon: React.ReactNode; title: string; note: string }) {
  return <Link href={href} className="ledger-page group flex items-start gap-4 p-5 transition hover:bg-[#f7f1e5]"><span className="grid h-10 w-10 shrink-0 place-items-center border border-[#d1c3a7] text-[#806b45]">{icon}</span><span><strong className="font-serif text-lg text-[#302b22]">{title}</strong><span className="mt-1 block text-sm text-[#756c5d]">{note}</span></span><ArrowLeftRight className="ml-auto mt-1 shrink-0 text-[#9b8966]" size={17}/></Link>;
}
