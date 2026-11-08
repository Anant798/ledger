"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useLanguage } from "@/components/language-provider";

type Profile = { full_name: string; date_of_birth: string; preferred_language: "en" | "hi"; email: string };

export default function SettingsPage() {
  const { text, setLanguage } = useLanguage();
  const [profile, setProfile] = useState<Profile>({ full_name: "", date_of_birth: "", preferred_language: "en", email: "" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    void fetch("/api/profile", { cache: "no-store" }).then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not load your profile.");
      if (alive) {
        setProfile({ ...body.profile, date_of_birth: body.profile.date_of_birth || "", preferred_language: body.profile.preferred_language === "hi" ? "hi" : "en" });
        setLanguage(body.profile.preferred_language === "hi" ? "hi" : "en");
      }
    }).catch((reason: unknown) => { if (alive) setError(reason instanceof Error ? reason.message : "Could not load your profile."); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [setLanguage]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/profile", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ full_name: profile.full_name, date_of_birth: profile.date_of_birth || null, preferred_language: profile.preferred_language }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not save your changes.");
      setProfile({ ...profile, ...body.profile, date_of_birth: body.profile.date_of_birth || "" });
      setLanguage(profile.preferred_language);
      setMessage(text("Your changes are saved.", "आपके बदलाव सेव हो गए हैं।"));
    } catch (reason) { setError(reason instanceof Error ? reason.message : text("Could not save your changes.", "बदलाव सेव नहीं हो सके।")); }
    finally { setSaving(false); }
  }

  return <div>
    <div className="mb-7 border-b border-[#c9bda6] pb-6"><p className="text-[10px] tracking-[0.26em] text-[#897653]">YOUR ACCOUNT</p><h1 className="mt-2 text-3xl sm:text-4xl">{text("Settings", "सेटिंग्स")}</h1><p className="mt-2 text-sm text-[#756c5d]">{text("Update your details and choose the language you prefer.", "अपनी जानकारी बदलें और पसंदीदा भाषा चुनें।")}</p></div>
    <section className="max-w-2xl border border-[#C9BDA6] bg-[#FBF8F0] p-5 sm:p-7">
      <h2 className="text-2xl">{text("Your profile", "आपकी जानकारी")}</h2>
      <p className="mt-1 text-sm text-[#756c5d]">{text("Only you can see and change these details.", "यह जानकारी सिर्फ़ आप देख और बदल सकते हैं।")}</p>
      {loading ? <p className="mt-6 text-sm text-[#756c5d]">{text("Loading your details…", "जानकारी लोड हो रही है…")}</p> : <form className="mt-6 space-y-4" onSubmit={save}>
        <label className="block text-sm font-medium text-[#51452f]">{text("Full name", "पूरा नाम")}<input required maxLength={200} autoComplete="name" className="mt-1.5 w-full border border-[#CFC3AE] px-3 py-2.5" value={profile.full_name} onChange={(event) => setProfile({ ...profile, full_name: event.target.value })}/></label>
        <label className="block text-sm font-medium text-[#51452f]">{text("Date of birth", "जन्म की तारीख")}<input type="date" max={new Date().toISOString().slice(0, 10)} autoComplete="bday" className="mt-1.5 w-full border border-[#CFC3AE] px-3 py-2.5" value={profile.date_of_birth} onChange={(event) => setProfile({ ...profile, date_of_birth: event.target.value })}/></label>
        <label className="block text-sm font-medium text-[#51452f]">{text("Email address", "ईमेल पता")}<input type="email" readOnly className="mt-1.5 w-full border border-[#CFC3AE] bg-[#f0ebdf] px-3 py-2.5 text-[#756c5d]" value={profile.email}/><span className="mt-1 block text-xs font-normal text-[#817766]">{text("Your email is used to sign in.", "आप इसी ईमेल से साइन इन करते हैं।")}</span></label>
        <label className="block text-sm font-medium text-[#51452f]">{text("Language", "भाषा")}<select className="mt-1.5 w-full border border-[#CFC3AE] px-3 py-2.5" value={profile.preferred_language} onChange={(event) => setProfile({ ...profile, preferred_language: event.target.value as Profile["preferred_language"] })}><option value="en">English</option><option value="hi">हिन्दी</option></select><span className="mt-1 block text-xs font-normal text-[#817766]">{text("This choice is saved to your account.", "यह पसंद आपके खाते में सेव होगी।")}</span></label>
        {error && <p role="alert" className="text-sm text-red-800">{error}</p>}{message && <p role="status" className="text-sm text-green-900">{message}</p>}
        <button disabled={saving} className="bg-[#51452F] px-5 py-2.5 text-sm text-[#FAF7EF] hover:bg-[#6B593B] disabled:opacity-50">{saving ? text("Saving…", "सेव हो रहा है…") : text("Save changes", "बदलाव सेव करें")}</button>
      </form>}
    </section>
  </div>;
}
