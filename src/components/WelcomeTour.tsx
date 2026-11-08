import { useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { X, ArrowRight } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

const PENDING_SIGNUP_PREFIX = "papervault:first_signup_tour:";
const COMPLETED_TOUR_PREFIX = "papervault:tour_done:";

let memoryPendingTourUserId: string | null = null;

export function markFirstTimeSignup(userId: string) {
  if (!userId) return;
  memoryPendingTourUserId = userId;
  if (typeof window === "undefined") return;
  try {
    if (window.localStorage.getItem(`${COMPLETED_TOUR_PREFIX}${userId}`) === "1") {
      return;
    }
    window.localStorage.setItem(`${PENDING_SIGNUP_PREFIX}${userId}`, "1");
  } catch {
    // ignore storage errors
  }
}

function hasPendingFirstTimeTour(userId: string): boolean {
  if (!userId) return false;
  if (typeof window !== "undefined") {
    try {
      if (window.localStorage.getItem(`${COMPLETED_TOUR_PREFIX}${userId}`) === "1") {
        return false;
      }
      if (window.localStorage.getItem(`${PENDING_SIGNUP_PREFIX}${userId}`) === "1") {
        return true;
      }
    } catch {
      // ignore storage errors
    }
  }
  return memoryPendingTourUserId === userId;
}

function markTourCompletedLocally(userId: string) {
  if (memoryPendingTourUserId === userId) {
    memoryPendingTourUserId = null;
  }
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(`${PENDING_SIGNUP_PREFIX}${userId}`);
    window.localStorage.setItem(`${COMPLETED_TOUR_PREFIX}${userId}`, "1");
  } catch {
    // ignore storage errors
  }
}

const ESSENTIALS = [
  {
    number: "01",
    title: "Locked with your passphrase",
    body: "Your private diary, notes, photos, and companion chats are encrypted on your device before saving. Keep your passphrase safe—no one else can read or reset it.",
  },
  {
    number: "02",
    title: "Private by default, shared when you choose",
    body: "Everything stays strictly yours unless you toggle anonymous community sharing on a diary entry or publish a piece in the Blog.",
  },
  {
    number: "03",
    title: "A quiet desk that remembers",
    body: "Group pages into nested folders, scan handwritten notes from a photo, pair entries with a song, or ask Companion to reflect on your own writing.",
  },
] as const;

export function WelcomeTour({ userId }: { userId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(() => hasPendingFirstTimeTour(userId));

  useEffect(() => {
    setOpen(hasPendingFirstTimeTour(userId));
  }, [userId]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        markTourCompletedLocally(userId);
        setOpen(false);
        void supabase.from("profiles").update({ tour_completed: true }).eq("id", userId);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, userId]);

  if (!open) return null;

  const dismiss = () => {
    markTourCompletedLocally(userId);
    setOpen(false);
    void supabase.from("profiles").update({ tour_completed: true }).eq("id", userId);
  };

  const startFirstEntry = () => {
    dismiss();
    void router.navigate({ to: "/app/diary" });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="welcome-tour-heading"
      onClick={(e) => {
        if (e.target === e.currentTarget) dismiss();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px]"
    >
      <div className="paper-card relative w-full max-w-lg p-6 sm:p-8">
        <button
          type="button"
          onClick={dismiss}
          aria-label="Close welcome guide"
          className="absolute right-3 top-3 flex size-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary/70 hover:text-primary"
        >
          <X className="size-4" />
        </button>

        <header className="pr-8">
          <p className="font-hand text-2xl text-sepia">your journal is ready</p>
          <h2
            id="welcome-tour-heading"
            className="mt-0.5 font-serif text-2xl text-primary sm:text-3xl [text-wrap:balance]"
          >
            Three things to know before you begin
          </h2>
        </header>

        <div className="mt-5 divide-y divide-border/70 border-y border-border/70">
          {ESSENTIALS.map((item) => (
            <div key={item.number} className="grid grid-cols-[28px_1fr] gap-3 py-4">
              <span className="font-serif text-sm text-accent tabular-nums pt-0.5">
                {item.number}.
              </span>
              <div>
                <h3 className="font-serif text-base text-primary">{item.title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{item.body}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            onClick={dismiss}
            className="rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-primary whitespace-nowrap shrink-0"
          >
            Explore dashboard
          </button>
          <button
            type="button"
            onClick={startFirstEntry}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 whitespace-nowrap shrink-0"
          >
            <span>Write first entry</span>
            <ArrowRight className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
