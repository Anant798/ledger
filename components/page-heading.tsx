"use client";

import { useLanguage } from "@/components/language-provider";

export default function PageHeading({ eyebrow, title, description, hi }: { eyebrow: string; title: string; description: string; hi: { eyebrow: string; title: string; description: string } }) {
  const { text } = useLanguage();
  return <div className="mb-7 border-b border-[#c9bda6] pb-6"><p className="text-[10px] tracking-[0.26em] text-[#897653]">{text(eyebrow, hi.eyebrow)}</p><h1 className="mt-2 text-3xl sm:text-4xl">{text(title, hi.title)}</h1><p className="mt-2 text-sm text-[#756c5d]">{text(description, hi.description)}</p></div>;
}
