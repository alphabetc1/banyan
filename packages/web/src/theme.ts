// Theme preference: follow the system or force light/dark. The resolved theme is written to
// <html data-theme>, which the CSS tokens key off.
export type ThemePreference = "system" | "light" | "dark";

const media = () => window.matchMedia("(prefers-color-scheme: dark)");

export function loadThemePreference(): ThemePreference {
  try {
    const saved = localStorage.getItem("banyan.theme");
    if (saved === "light" || saved === "dark" || saved === "system") return saved;
  } catch {
    // Storage may be unavailable; follow the system.
  }
  return "system";
}

export function saveThemePreference(pref: ThemePreference): void {
  try {
    localStorage.setItem("banyan.theme", pref);
  } catch {
    // Not persisted; the choice still applies for this page view.
  }
}

// Applies the preference and keeps following system changes; returns a cleanup function.
export function applyTheme(pref: ThemePreference): () => void {
  const apply = () => {
    const dark = pref === "dark" || (pref === "system" && media().matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  };
  apply();
  if (pref !== "system") return () => {};
  const m = media();
  m.addEventListener("change", apply);
  return () => m.removeEventListener("change", apply);
}
