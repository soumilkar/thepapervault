import { createFileRoute, Outlet, redirect, Link, useRouter, useRouterState } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { BookOpen, Image as ImageIcon, PenLine, Sparkles, LogOut, Home, ChevronDown, Lock, StickyNote } from "lucide-react";
import { VaultProvider, useVault } from "@/lib/vault";
import { VaultGate } from "@/components/VaultGate";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export const Route = createFileRoute("/app")({
  ssr: false,
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth" });
    return { user: data.user };
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
  const { user } = Route.useRouteContext();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const current =
    NAV.find((n) => (n.exact ? pathname === n.to : pathname.startsWith(n.to))) ?? NAV[0];

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    router.navigate({ to: "/auth", replace: true });
  };

  return (
    <VaultProvider userId={user.id}>
      <div className="min-h-screen w-full overflow-x-hidden">
        <header className="fixed top-4 left-4 right-4 z-50 rounded-2xl border border-border/60 bg-card/80 shadow-lg backdrop-blur sm:left-6 sm:right-6 lg:left-1/2 lg:right-auto lg:w-full lg:max-w-6xl lg:-translate-x-1/2">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6 sm:py-4">
            <Link to="/app" className="flex min-w-0 items-center gap-2">
              <span className="truncate font-serif text-xl text-primary sm:text-2xl">The PaperVault</span>
            </Link>

            <nav className="hidden items-center gap-1 text-sm lg:flex">
              {NAV.map((n) => (
                <NavLink key={n.to} to={n.to} exact={n.exact} icon={<n.icon className="size-4" />} label={n.label} />
              ))}
              <VaultLockButton />
              <button onClick={handleSignOut} className="ml-2 flex items-center gap-1.5 rounded-md px-3 py-2 text-muted-foreground hover:text-primary">
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
          <VaultGate userId={user.id}>
            <Outlet />
          </VaultGate>
        </main>
      </div>
    </VaultProvider>
  );
}

function VaultLockButton() {
  const { status, lock } = useVault();
  if (status !== "unlocked") return null;
  return (
    <button onClick={lock} title="Lock" className="ml-1 flex items-center gap-1.5 rounded-md px-3 py-2 text-muted-foreground hover:text-primary">
      <Lock className="size-4" /> Lock
    </button>
  );
}

function VaultLockMenuItem() {
  const { status, lock } = useVault();
  if (status !== "unlocked") return null;
  return (
    <DropdownMenuItem onClick={lock} className="text-muted-foreground">
      <Lock className="size-4" /> Lock
    </DropdownMenuItem>
  );
}

function NavLink({ to, icon, label, exact }: { to: string; icon: React.ReactNode; label: string; exact?: boolean }) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: !!exact }}
      className="flex items-center gap-1.5 rounded-md px-3 py-2 text-foreground/70 transition-colors hover:bg-secondary hover:text-primary [&.active]:bg-secondary [&.active]:text-primary"
    >
      {icon}{label}
    </Link>
  );
}
