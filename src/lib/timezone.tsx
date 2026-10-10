import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

const Timezone = createContext("UTC");
export const useTimezone = () => useContext(Timezone);
export function dayInZone(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
export function formatDate(value: string, timeZone: string) {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: dateOnly ? "UTC" : timeZone }).format(new Date(dateOnly ? `${value}T00:00:00Z` : value));
}
export function TimezoneProvider({ children }: { children: ReactNode }) {
  const [zone, setZone] = useState("UTC");
  useEffect(() => {
    let active = true;
    fetch("/api/public/timezone").then((r) => r.json()).then((data) => {
      const value = data.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
      new Intl.DateTimeFormat("en", { timeZone: value });
      if (active) setZone(value);
    }).catch(() => { if (active) setZone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"); });
    return () => { active = false; };
  }, []);
  return <Timezone.Provider value={zone}>{children}</Timezone.Provider>;
}