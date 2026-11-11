import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { ThemeContext } from "./contexts.ts";
import { detectLanguage, LanguageContext, type Language } from "./i18n.ts";
import { applyTheme, loadThemePreference, saveThemePreference, type ThemePreference } from "./theme.ts";
import { useRoute } from "./router.ts";
import { HomePage } from "./pages/HomePage.tsx";
import { JoinPage } from "./pages/JoinPage.tsx";
import { RoomShell } from "./pages/RoomShell.tsx";

function App() {
  const [lang, setLangState] = useState<Language>(detectLanguage);
  const [theme, setTheme] = useState<ThemePreference>(loadThemePreference);
  const route = useRoute();

  useEffect(() => applyTheme(theme), [theme]);
  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  }, [lang]);

  const setLang = (l: Language) => {
    setLangState(l);
    try {
      localStorage.setItem("banyan.lang", l);
    } catch {
      // Applies to this page view only.
    }
  };
  const setPref = (p: ThemePreference) => {
    saveThemePreference(p);
    setTheme(p);
  };

  return (
    <LanguageContext.Provider value={{ lang, setLang }}>
      <ThemeContext.Provider value={{ pref: theme, setPref }}>
        {route.page === "home" && <HomePage />}
        {route.page === "join" && <JoinPage roomId={route.roomId} />}
        {route.page !== "home" && route.page !== "join" && <RoomShell key={route.roomId} route={route} />}
      </ThemeContext.Provider>
    </LanguageContext.Provider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
