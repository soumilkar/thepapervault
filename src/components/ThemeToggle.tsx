import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ThemeToggle() {
  const [light, setLight] = useState(false);
  useEffect(() => {
    try { setLight(localStorage.getItem("papervault:theme") === "light"); } catch { /* storage unavailable */ }
  }, []);
  useEffect(() => { document.documentElement.classList.toggle("light", light); document.documentElement.classList.toggle("dark", !light); }, [light]);
  const toggle = () => {
    const next = !light;
    setLight(next);
    try { localStorage.setItem("papervault:theme", next ? "light" : "dark"); } catch { /* storage unavailable */ }
  };
  return <Button variant="ghost" size="icon" onClick={toggle} title={light ? "Switch to dark mode" : "Switch to light mode"} aria-label={light ? "Switch to dark mode" : "Switch to light mode"}>{light ? <Moon /> : <Sun />}</Button>;
}
