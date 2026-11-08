"use client";

import { useCallback, useEffect, useState } from "react";
import { useLanguage } from "@/components/language-provider";

type Notification = { id: string; title: string; message: string; alert_type: string; is_read: boolean; created_at: string };

export default function NotificationCenter() {
  const { text } = useLanguage();
  const [items, setItems] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/notifications", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not load notifications");
      setItems(body.notifications || []);
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load notifications");
    }
  }, []);

  useEffect(() => {
    const handle = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(handle);
  }, [load]);

  async function markRead(id?: string) {
    const response = await fetch("/api/notifications", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify(id ? { action: "read", id } : { action: "read_all" }),
    });
    if (!response.ok) {
      const body = await response.json();
      setError(body.error || "Could not update notification");
      return;
    }
    await load();
  }

  const unreadCount = items.filter((item) => !item.is_read).length;
  return <div className="relative">
    <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="relative border border-[#C9BDA6] px-3 py-2 text-sm text-[#51452F]">
      {text("Notifications", "सूचनाएँ")}{unreadCount > 0 && <span className="ml-2 rounded-full bg-[#805F22] px-1.5 py-0.5 text-[10px] text-white">{unreadCount}</span>}
    </button>
    {open && <div className="absolute right-0 top-full z-30 mt-2 w-[min(92vw,22rem)] border border-[#C9BDA6] bg-[#FAF7EF] p-3 shadow-xl">
      <div className="flex items-center justify-between gap-3 border-b border-[#DDD3C0] pb-2"><h2 className="font-serif text-lg text-[#302B22]">{text("Notifications", "सूचनाएँ")}</h2><button type="button" disabled={unreadCount === 0} onClick={() => void markRead()} className="text-xs text-[#715B37] underline disabled:opacity-40">{text("Mark all read", "सबको पढ़ा हुआ मानें")}</button></div>
      {error && <p role="alert" className="py-2 text-xs text-[#9A4E3D]">{error}</p>}
      <div className="max-h-80 divide-y divide-[#EAE2D4] overflow-y-auto">
        {items.length === 0 ? <p className="py-5 text-center text-sm text-[#817766]">{text("No notifications yet.", "अभी कोई सूचना नहीं है।")}</p> : items.map((item) => <button key={item.id} type="button" onClick={() => { if (!item.is_read) void markRead(item.id); }} className={`block w-full py-3 text-left ${item.is_read ? "opacity-70" : ""}`}>
          <span className="flex items-center justify-between gap-2"><span className="text-sm font-medium text-[#51452F]">{item.title}</span>{!item.is_read && <span className="h-2 w-2 rounded-full bg-[#805F22]" />}</span>
          <span className="mt-1 block text-xs leading-relaxed text-[#756C5D]">{item.message}</span>
          <span className="mt-1 block text-[10px] text-[#968A76]">{new Date(item.created_at).toLocaleString()}</span>
        </button>)}
      </div>
    </div>}
  </div>;
}
