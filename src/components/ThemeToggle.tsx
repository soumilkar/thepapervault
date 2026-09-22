import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

type Theme = "light" | "dark";

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
}

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    const saved = window.localStorage.getItem("papervault:theme");
    const initial =
      saved === "dark" || saved === "light"
        ? saved
        : window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
    setTheme(initial);
    applyTheme(initial);
  }, []);

  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    window.localStorage.setItem("papervault:theme", next);
    applyTheme(next);
  };

  const label = theme === "dark" ? "Use light theme" : "Use dark theme";

  return (
    <Button
      type="button"
      variant="ghost"
      size={compact ? "default" : "icon"}
      onClick={toggle}
      title={label}
      aria-label={label}
      className={
        compact
          ? "w-full justify-start text-muted-foreground"
          : "shrink-0 text-muted-foreground hover:text-primary"
      }
    >
      {theme === "dark" ? <Sun aria-hidden /> : <Moon aria-hidden />}
      {compact && <span>{theme === "dark" ? "Light theme" : "Dark theme"}</span>}
    </Button>
  );
}
