// Single source of truth for browser local time & timestamps across The PaperVault.
// Ensures all timestamps, entry dates, streaks, and AI Companion messages use the user's browser clock.

export type BrowserTimeSnapshot = {
  date: Date;
  iso: string;
  localDate: string; // YYYY-MM-DD in browser local timezone
  localTime: string; // e.g. "11:56 AM"
  localDateTime: string; // e.g. "Wed, Nov 4, 2026, 11:56 AM PST"
  timeZone: string;
};

export function toBrowserLocalDate(input: Date | string | number = new Date()): string {
  if (typeof input === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input)) {
    return input;
  }
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) {
    const fallback = new Date();
    return `${fallback.getFullYear()}-${String(fallback.getMonth() + 1).padStart(2, "0")}-${String(fallback.getDate()).padStart(2, "0")}`;
  }
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function formatBrowserTimeOnly(input: Date | string | number = new Date()): string {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatBrowserFullDateTime(input: Date | string | number = new Date()): string {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

export function formatBrowserMessageTimestamp(input?: Date | string | number | null): string {
  if (!input) return "";
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const isToday = toBrowserLocalDate(d) === toBrowserLocalDate(now);
  const timeStr = formatBrowserTimeOnly(d);
  if (isToday) {
    return timeStr;
  }
  const sameYear = d.getFullYear() === now.getFullYear();
  const dateStr = d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  return `${dateStr} · ${timeStr}`;
}

export function getChatGapSeparatorLabel(
  prevInput?: Date | string | number | null,
  currInput?: Date | string | number | null,
  gapThresholdMinutes = 30,
): string | null {
  if (!currInput) return null;
  const curr = currInput instanceof Date ? currInput : new Date(currInput);
  if (Number.isNaN(curr.getTime())) return null;

  const now = new Date();
  const todayDay = toBrowserLocalDate(now);
  const currDay = toBrowserLocalDate(curr);
  const timeStr = formatBrowserTimeOnly(curr);

  const formatDateAndTime = () => {
    if (currDay === todayDay) {
      return `Today · ${timeStr}`;
    }
    const sameYear = curr.getFullYear() === now.getFullYear();
    const dateStr = curr.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      ...(sameYear ? {} : { year: "numeric" }),
    });
    return `${dateStr} · ${timeStr}`;
  };

  // Always display the horizontal time bar above the first message in a chat
  if (!prevInput) {
    return formatDateAndTime();
  }

  const prev = prevInput instanceof Date ? prevInput : new Date(prevInput);
  if (Number.isNaN(prev.getTime())) {
    return formatDateAndTime();
  }

  const diffMs = curr.getTime() - prev.getTime();
  const prevDay = toBrowserLocalDate(prev);
  const dayChanged = prevDay !== currDay;

  if (!dayChanged && diffMs < gapThresholdMinutes * 60 * 1000) {
    return null;
  }

  if (dayChanged || currDay !== todayDay) {
    return formatDateAndTime();
  }

  return timeStr;
}

export function getBrowserNow(): BrowserTimeSnapshot {
  const date = new Date();
  let timeZone = "Local";
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Local";
  } catch {
    // ignore
  }
  return {
    date,
    iso: date.toISOString(),
    localDate: toBrowserLocalDate(date),
    localTime: formatBrowserTimeOnly(date),
    localDateTime: formatBrowserFullDateTime(date),
    timeZone,
  };
}
