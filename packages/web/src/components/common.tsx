// Small shared UI pieces.
import { useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ThemeContext } from "../contexts.ts";
import { LanguageContext, useT } from "../i18n.ts";
import type { Agent } from "@banyan/shared";

export const ROLE_MARK: Record<Agent["role"], string> = { leader: "★", monitor: "◎", worker: "" };

export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export type MenuItem = { label: string; onSelect: () => void; checked?: boolean; danger?: boolean } | { heading: string } | "separator";

// A small menu at a point on the screen, such as where the person right-clicked. It closes on
// a choice, a click elsewhere, Escape or scrolling.
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ x, y });
  // Kept inside the window when opened near its right or bottom edge.
  useLayoutEffect(() => {
    const r = ref.current!.getBoundingClientRect();
    setAt({ x: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)), y: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) });
  }, [x, y]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);
  return (
    <div ref={ref} className="menu" role="menu" style={{ left: at.x, top: at.y }}>
      {items.map((item, i) => {
        if (item === "separator") return <div key={i} className="menu-separator" />;
        if ("heading" in item)
          return (
            <div key={i} className="menu-heading">
              {item.heading}
            </div>
          );
        return (
          <button
            key={i}
            role={item.checked === undefined ? "menuitem" : "menuitemradio"}
            aria-checked={item.checked}
            className={item.danger ? "danger-text" : ""}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            <span className="menu-check">{item.checked ? "✓" : ""}</span>
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

// Runs an async action, exposing busy and error state for forms and buttons.
export function useAction(): { busy: boolean; error: string | null; run: (fn: () => Promise<void>) => Promise<boolean> } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return {
    busy,
    error,
    run: async (fn) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        return true;
      } catch (e) {
        setError((e as Error).message);
        return false;
      } finally {
        setBusy(false);
      }
    },
  };
}

export function Preferences() {
  const t = useT();
  const { lang, setLang } = useContext(LanguageContext);
  const { pref, setPref } = useContext(ThemeContext);
  return (
    <div className="row">
      <button className="ghost" onClick={() => setLang(lang === "zh" ? "en" : "zh")}>
        {t("top.language")}
      </button>
      <select value={pref} onChange={(e) => setPref(e.target.value as typeof pref)} aria-label="theme" style={{ width: "auto" }}>
        <option value="system">{t("theme.system")}</option>
        <option value="light">{t("theme.light")}</option>
        <option value="dark">{t("theme.dark")}</option>
      </select>
    </div>
  );
}

export function timeAgo(ts: number, now: number, lang: "zh" | "en"): string {
  const minutes = Math.max(0, Math.round((now - ts) / 60_000));
  if (minutes < 1) return lang === "zh" ? "刚刚" : "just now";
  if (minutes < 60) return lang === "zh" ? `${minutes} 分钟前` : `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return lang === "zh" ? `${hours} 小时前` : `${hours} h ago`;
  return new Date(ts).toLocaleDateString(lang === "zh" ? "zh-CN" : "en");
}

// Re-renders periodically so relative times and stall detection stay current.
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
