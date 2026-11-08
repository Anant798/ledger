"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

type Language = "en" | "hi";
type LanguageContextValue = { language: Language; setLanguage: (language: Language) => void; text: (english: string, hindi: string) => string };
const LanguageContext = createContext<LanguageContextValue>({ language: "en", setLanguage: () => {}, text: (english) => english });

export function LanguageProvider({ initialLanguage, children }: { initialLanguage: Language; children: ReactNode }) {
  const [language, setLanguage] = useState<Language>(initialLanguage);
  useEffect(() => { document.documentElement.lang = language; }, [language]);
  const text = (english: string, hindi: string) => language === "hi" ? hindi : english;
  return <LanguageContext.Provider value={{ language, setLanguage, text }}>{children}</LanguageContext.Provider>;
}

export function useLanguage() { return useContext(LanguageContext); }
