import {
  createFileRoute,
  Outlet,
  redirect,
  Link,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  BookOpen,
  Image as ImageIcon,
  PenLine,
  Sparkles,
  LogOut,
  Home,
  ChevronDown,
  Lock,
  StickyNote,
  Moon,
  Sun,
} from "lucide-react";
import { VaultProvider, useVault } from "@/lib/vault";
import { ThemeToggleButton, useTheme } from "@/lib/theme";
import { clearCryptoCache } from "@/lib/crypto";
import { VaultGate } from "@/components/VaultGate";
import { SecurityQuestionsOnboardingModal } from "@/components/SecurityQuestionsOnboardingModal";
import { clearSecurityPanelEmailVerified } from "@/components/SecuritySettingsDialog";
import { toast } from "sonner";
import {
  clearAllOfflineUserData,
  getCachedAuthSession,
  OFFLINE_DATA_UPDATED_EVENT,
  OFFLINE_SYNC_SUCCESS_EVENT,
  resetSessionSyncCache,
  syncAllToBackblazeB2,
  triggerAutoSync,
} from "@/lib/offline-supabase";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { User } from "@supabase/supabase-js";

let memAuthedUser: User | null = null;
let memProfileDisplayName: string | null = null;

function getStoredProfileName(userId: string): string | null {
  if (memProfileDisplayName) return memProfileDisplayName;
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(`papervault:profile_name:${userId}`);
  } catch {
    return null;
  }
}

function setStoredProfileName(userId: string, name: string | null) {
  memProfileDisplayName = name;
  if (typeof window === "undefined") return;
  try {
    if (name) {
      window.localStorage.setItem(`papervault:profile_name:${userId}`, name);
    }
  } catch {
    // ignore storage errors
  }
}

export const Route = createFileRoute("/app")({
  ssr: false,
  beforeLoad: async () => {
    // Fast path: use in-memory or cached session for 0ms route transitions
    if (memAuthedUser) {
      return {
        user: memAuthedUser,
        profileDisplayName: getStoredProfileName(memAuthedUser.id),
      };
    }

    const cached = getCachedAuthSession() as { user?: User } | null;
    if (cached?.user) {
      memAuthedUser = cached.user;
      return {
        user: cached.user,
        profileDisplayName: getStoredProfileName(cached.user.id),
      };
    }

    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session?.user) throw redirect({ to: "/auth" });
    const user = data.session.user;
    memAuthedUser = user;
    return {
      user,
      profileDisplayName: getStoredProfileName(user.id),
    };
  },
  component: AuthedLayout,
});

const NAV: { to: string; icon: typeof Home; label: string; exact?: boolean }[] = [
  { to: "/app", icon: Home, label: "Home", exact: true },
  { to: "/app/diary", icon: PenLine, label: "Diary" },
  { to: "/app/notes", icon: StickyNote, label: "Notes" },
  { to: "/app/blog", icon: BookOpen, label: "Blog" },
  { to: "/app/gallery", icon: ImageIcon, label: "Gallery" },
  { to: "/app/chat", icon: Sparkles, label: "Companion" },
];

function AuthedLayout() {
  const router = useRouter();
  const qc = useQueryClient();
  const { user, profileDisplayName } = Route.useRouteContext();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const current =
    NAV.find((n) => (n.exact ? pathname === n.to : pathname.startsWith(n.to))) ?? NAV[0];

  // Preload all main app route chunks right after layout mounts so tab switching is instant
  useEffect(() => {
    const timer = window.setTimeout(() => {
      for (const item of NAV) {
        void router.preloadRoute({ to: item.to }).catch(() => {});
      }
    }, 150);
    return () => window.clearTimeout(timer);
  }, [router]);

  // Warm the user-profile query in background without blocking route navigation
  useQuery({
    queryKey: ["user-profile", user.id],
    placeholderData: profileDisplayName
      ? { id: user.id, display_name: profileDisplayName }
      : undefined,
    queryFn: async () => {
      const { data } = await supabase
        .from("profiles")
        .select("id, display_name")
        .eq("id", user.id)
        .maybeSingle();
      const trimmed = data?.display_name?.trim() || null;
      if (trimmed) {
        setStoredProfileName(user.id, trimmed);
      }
      return data;
    },
  });

  useEffect(() => {
    const refreshAllDeviceQueries = () => {
      qc.invalidateQueries({ queryKey: ["notes"] });
      qc.invalidateQueries({ queryKey: ["note-folders"] });
      qc.invalidateQueries({ queryKey: ["diary"] });
      qc.invalidateQueries({ queryKey: ["diary-folders"] });
      qc.invalidateQueries({ queryKey: ["diary-metrics"] });
      qc.invalidateQueries({ queryKey: ["public-diary-feed"] });
      qc.invalidateQueries({ queryKey: ["blog"] });
      qc.invalidateQueries({ queryKey: ["likes"] });
      qc.invalidateQueries({ queryKey: ["comments"] });
      qc.invalidateQueries({ queryKey: ["cvotes"] });
      qc.invalidateQueries({ queryKey: ["gallery"] });
      qc.invalidateQueries({ queryKey: ["gallery-folders"] });
      qc.invalidateQueries({ queryKey: ["vault-trackers"] });
      qc.invalidateQueries({ queryKey: ["dashboard-counts"] });
      qc.invalidateQueries({ queryKey: ["heatmap-activity"] });
      qc.invalidateQueries({ queryKey: ["user-profile"] });

      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("chat-sessions-updated"));
        window.dispatchEvent(new Event("chat-messages-updated"));
      }
    };

    const handleSyncSuccess = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | {
            syncedCount: number;
            tables: string[];
            remainingCount: number;
          }
        | undefined;

      refreshAllDeviceQueries();

      if (detail && detail.syncedCount > 0) {
        toast.success(
          detail.syncedCount === 1
            ? "Offline change synced"
            : `Synced ${detail.syncedCount} offline changes`,
          { id: "offline-sync-toast", duration: 3000 },
        );
      }
    };

    const handleDataUpdated = (e: Event) => {
      const detail = (e as CustomEvent).detail as { table?: string } | undefined;
      const t = detail?.table;
      if (!t) return;
      if (t === "notes") {
        qc.invalidateQueries({ queryKey: ["notes"] });
        qc.invalidateQueries({ queryKey: ["gallery"] });
        qc.invalidateQueries({ queryKey: ["dashboard-counts"] });
      } else if (t === "note_folders") {
        qc.invalidateQueries({ queryKey: ["note-folders"] });
        qc.invalidateQueries({ queryKey: ["gallery"] });
      } else if (t === "diary_entries") {
        qc.invalidateQueries({ queryKey: ["diary"] });
        qc.invalidateQueries({ queryKey: ["diary-metrics"] });
        qc.invalidateQueries({ queryKey: ["public-diary-feed"] });
        qc.invalidateQueries({ queryKey: ["gallery"] });
        qc.invalidateQueries({ queryKey: ["dashboard-counts"] });
        qc.invalidateQueries({ queryKey: ["heatmap-activity"] });
      } else if (t === "diary_folders") {
        qc.invalidateQueries({ queryKey: ["diary-folders"] });
      } else if (t === "gallery_images") {
        qc.invalidateQueries({ queryKey: ["gallery"] });
        qc.invalidateQueries({ queryKey: ["dashboard-counts"] });
      } else if (
        t === "blog_posts" ||
        t === "blog_comments" ||
        t === "blog_likes" ||
        t === "comment_votes"
      ) {
        qc.invalidateQueries({ queryKey: ["blog"] });
        qc.invalidateQueries({ queryKey: ["likes"] });
        qc.invalidateQueries({ queryKey: ["comments"] });
        qc.invalidateQueries({ queryKey: ["cvotes"] });
        qc.invalidateQueries({ queryKey: ["dashboard-counts"] });
      } else if (t === "profiles") {
        qc.invalidateQueries({ queryKey: ["user-profile"] });
        qc.invalidateQueries({ queryKey: ["dashboard-counts"] });
      } else if (t === "chat_sessions") {
        window.dispatchEvent(new Event("chat-sessions-updated"));
      } else if (t === "chat_messages") {
        window.dispatchEvent(new Event("chat-messages-updated"));
        window.dispatchEvent(new Event("chat-sessions-updated"));
      }
    };

    const handleFocusOrVisible = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      if (typeof navigator !== "undefined" && navigator.onLine) {
        resetSessionSyncCache();
        triggerAutoSync(0);
        refreshAllDeviceQueries();
      }
    };

    const periodicSyncInterval =
      typeof window !== "undefined"
        ? window.setInterval(() => {
            if (
              typeof document !== "undefined" &&
              document.visibilityState === "visible" &&
              typeof navigator !== "undefined" &&
              navigator.onLine
            ) {
              triggerAutoSync(0);
              refreshAllDeviceQueries();
            }
          }, 20000)
        : undefined;

    if (typeof window !== "undefined") {
      window.addEventListener(OFFLINE_SYNC_SUCCESS_EVENT, handleSyncSuccess);
      window.addEventListener(OFFLINE_DATA_UPDATED_EVENT, handleDataUpdated);
      window.addEventListener("focus", handleFocusOrVisible);
      document.addEventListener("visibilitychange", handleFocusOrVisible);
    }
    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener(OFFLINE_SYNC_SUCCESS_EVENT, handleSyncSuccess);
        window.removeEventListener(OFFLINE_DATA_UPDATED_EVENT, handleDataUpdated);
        window.removeEventListener("focus", handleFocusOrVisible);
        document.removeEventListener("visibilitychange", handleFocusOrVisible);
        if (periodicSyncInterval !== undefined) {
          window.clearInterval(periodicSyncInterval);
        }
      }
    };
  }, [qc]);

  const handleSignOut = async () => {
    clearSecurityPanelEmailVerified(user.id);
    memAuthedUser = null;
    memProfileDisplayName = null;
    clearCryptoCache();
    clearAllOfflineUserData();
    qc.clear();
    await supabase.auth.signOut();
    window.location.href = "/auth";
  };

  return (
    <VaultProvider userId={user.id}>
      <div className="min-h-screen w-full overflow-x-hidden">
        <header className="fixed top-4 left-4 right-4 z-50 rounded-2xl border border-border/60 bg-card/80 shadow-lg backdrop-blur sm:left-6 sm:right-6 lg:left-1/2 lg:right-auto lg:w-full lg:max-w-6xl lg:-translate-x-1/2">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6 sm:py-4">
            <Link to="/app" className="flex min-w-0 items-center gap-2">
              <span className="truncate font-serif text-xl text-primary sm:text-2xl">
                The PaperVault
              </span>
            </Link>

            <nav className="hidden items-center gap-1 text-sm lg:flex">
              {NAV.map((n) => (
                <NavLink
                  key={n.to}
                  to={n.to}
                  exact={n.exact}
                  icon={<n.icon className="size-4" />}
                  label={n.label}
                />
              ))}
              <ThemeToggleButton />
              <VaultLockButton />
              <button
                onClick={handleSignOut}
                className="ml-1 flex items-center gap-1.5 rounded-md px-3 py-2 text-muted-foreground hover:text-primary"
              >
                <LogOut className="size-4" /> Sign out
              </button>
            </nav>

            <div className="lg:hidden">
              <DropdownMenu>
                <DropdownMenuTrigger className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm text-primary">
                  <current.icon className="size-4" />
                  <span>{current.label}</span>
                  <ChevronDown className="size-4 opacity-70" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  {NAV.map((n) => (
                    <DropdownMenuItem key={n.to} asChild>
                      <Link to={n.to} className="flex w-full items-center gap-2">
                        <n.icon className="size-4" /> {n.label}
                      </Link>
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <ThemeMenuItem />
                  <VaultLockMenuItem />
                  <DropdownMenuItem onClick={handleSignOut} className="text-muted-foreground">
                    <LogOut className="size-4" /> Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 pb-10 pt-28 sm:px-6 sm:pt-32">
          <VaultOfflineWarmer userId={user.id} />
          <VaultGate userId={user.id}>
            <SecurityQuestionsOnboardingModal userId={user.id} />
            <Outlet />
          </VaultGate>
        </main>
      </div>
    </VaultProvider>
  );
}

function VaultOfflineWarmer({ userId }: { userId: string }) {
  const { status, key } = useVault();
  const hasWarmed = useRef(false);

  useEffect(() => {
    if (status !== "unlocked" || !key || typeof window === "undefined" || !navigator.onLine) return;
    triggerAutoSync(1500);
    if (hasWarmed.current) return;
    hasWarmed.current = true;

    // Wait until the app has been open and idle for 15+ seconds before warming metadata
    const scheduleWarm = (fn: () => Promise<unknown>, delayMs: number) => {
      return window.setTimeout(() => {
        if (typeof window !== "undefined" && "requestIdleCallback" in window) {
          window.requestIdleCallback(() => void fn(), { timeout: 10000 });
        } else {
          void fn();
        }
      }, delayMs);
    };

    const timers: number[] = [];

    timers.push(
      scheduleWarm(async () => {
        await supabase.from("note_folders").select("id,name,parent_id").eq("user_id", userId);
        await supabase.from("diary_folders").select("id,name,parent_id").eq("user_id", userId);
        await syncAllToBackblazeB2().catch(() => {});
      }, 6000),
    );

    return () => {
      for (const t of timers) window.clearTimeout(t);
    };
  }, [status, key, userId]);

  return null;
}

function VaultLockButton() {
  const { status, lock } = useVault();
  if (status !== "unlocked") return null;
  return (
    <button
      onClick={() => {
        clearSecurityPanelEmailVerified();
        lock();
      }}
      title="Lock"
      className="ml-1 flex items-center gap-1.5 rounded-md px-3 py-2 text-muted-foreground hover:text-primary"
    >
      <Lock className="size-4" /> Lock
    </button>
  );
}

function ThemeMenuItem() {
  const { isDark, toggleTheme } = useTheme();
  return (
    <DropdownMenuItem onClick={toggleTheme} className="text-muted-foreground">
      {isDark ? <Sun className="size-4 text-accent" /> : <Moon className="size-4" />}
      <span>{isDark ? "Day mode" : "Night mode"}</span>
    </DropdownMenuItem>
  );
}

function VaultLockMenuItem() {
  const { status, lock } = useVault();
  if (status !== "unlocked") return null;
  return (
    <DropdownMenuItem
      onClick={() => {
        clearSecurityPanelEmailVerified();
        lock();
      }}
      className="text-muted-foreground"
    >
      <Lock className="size-4" /> Lock
    </DropdownMenuItem>
  );
}

function NavLink({
  to,
  icon,
  label,
  exact,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
  exact?: boolean;
}) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: !!exact }}
      className="flex items-center gap-1.5 rounded-md px-3 py-2 text-foreground/70 transition-colors hover:bg-secondary hover:text-primary [&.active]:bg-secondary [&.active]:text-primary"
    >
      {icon}
      {label}
    </Link>
  );
}
