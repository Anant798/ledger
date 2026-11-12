"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpen, ChartNoAxesCombined, CreditCard, Settings, UsersRound, WalletCards } from "lucide-react";
import type { ReactNode } from "react";
import NotificationCenter from "@/components/notification-center";
import { LanguageProvider, useLanguage } from "@/components/language-provider";

const links = [
  { href: "/dashboard", icon: ChartNoAxesCombined, en: "Your Money Summary", hi: "आपके पैसों का सार" },
  { href: "/dashboard/banking", icon: CreditCard, en: "Money In & Out", hi: "पैसे आए और गए" },
  { href: "/dashboard/groups", icon: UsersRound, en: "Group Payments", hi: "साझा भुगतान" },
  { href: "/dashboard/savings", icon: WalletCards, en: "Savings Goals", hi: "बचत के लक्ष्य" },
  { href: "/dashboard/settings", icon: Settings, en: "Settings", hi: "सेटिंग्स" },
];

export default function DashboardShell({ children, name, language }: { children: ReactNode; name: string; language: "en" | "hi" }) {
  return <LanguageProvider initialLanguage={language}><ShellContent name={name}>{children}</ShellContent></LanguageProvider>;
}

function ShellContent({ children, name }: { children: ReactNode; name: string }) {
  const pathname = usePathname();
  const { text } = useLanguage();
  return <div className="min-h-screen lg:grid lg:grid-cols-[250px_minmax(0,1fr)]">
    <aside className="border-b border-[#BFAF8D] bg-[#eee6d6]/90 px-4 py-4 lg:sticky lg:top-0 lg:flex lg:h-screen lg:flex-col lg:border-b-0 lg:border-r lg:px-5 lg:py-6">
      <Link href="/dashboard" className="flex items-center gap-3 px-2 py-1"><span className="grid h-10 w-10 place-items-center border border-[#B8A783] bg-[#F8F3E8] text-[#715B37]"><BookOpen size={20} strokeWidth={1.5}/></span><span><span className="block text-[9px] tracking-[0.22em] text-[#897653]">PERSONAL MONEY JOURNAL</span><span className="font-serif text-2xl text-[#302B22]">Chronexa</span></span></Link>
      <p className="mb-2 mt-7 px-3 text-[10px] uppercase tracking-[0.2em] text-[#897653]">{text("Your pages", "आपके पन्ने")}</p>
      <nav aria-label={text("Main navigation", "मुख्य नेविगेशन")} className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible">
        {links.map(({ href, icon: Icon, en, hi }) => {
          const active = pathname === href;
          return <Link key={href} href={href} aria-current={active ? "page" : undefined} className={`flex shrink-0 items-center gap-3 border px-3 py-2.5 text-sm transition lg:w-full ${active ? "border-[#b9a47c] bg-[#e5dac4] font-medium text-[#493d29] shadow-sm" : "border-transparent text-[#756c5d] hover:border-[#d6c9b0] hover:bg-[#f5f0e5]"}`}><Icon size={17} strokeWidth={1.7}/><span>{text(en, hi)}</span></Link>;
        })}
      </nav>
      <div className="mt-auto hidden border-t border-[#c9bda6] pt-4 lg:block"><p className="truncate px-3 text-sm font-medium text-[#51452f]">{name}</p></div>
    </aside>
    <div className="min-w-0">
      <header className="flex min-h-16 items-center justify-between gap-3 border-b border-[#C9BDA6] bg-[#f7f2e8]/80 px-4 py-3 sm:px-7 lg:px-10"><div className="min-w-0 lg:hidden"><p className="truncate text-sm font-medium text-[#51452f]">{name}</p></div><div className="hidden lg:block"/><div className="flex items-center gap-3"><NotificationCenter/><form action="/auth/signout" method="post"><button className="border border-[#C9BDA6] bg-[#FAF7EF] px-3 py-2 text-sm text-[#715B37] hover:bg-[#F0EBDD]">{text("Sign out", "लॉग आउट")}</button></form></div></header>
      <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-7 sm:py-8 lg:px-10">{children}</main>
    </div>
  </div>;
}
