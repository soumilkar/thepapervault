import { createFileRoute, Outlet, redirect, Link, useRouter, useRouterState } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { BookOpen, Image as ImageIcon, PenLine, Sparkles, LogOut, Home, ChevronDown } from "lucide-react";
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

const NAV = [
  { to: "/app", icon: Home, label: "Home", exact: true },
  { to: "/app/diary", icon: PenLine, label: "Diary" },
  { to: "/app/blog", icon: BookOpen, label: "Blog" },
  { to: "/app/gallery", icon: ImageIcon, label: "Gallery" },
  { to: "/app/chat", icon: Sparkles, label: "Companion" },
] as const;

function AuthedLayout() {
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const current =
    NAV.find((n) => (n.exact ? pathname === n.to : pathname.startsWith(n.to))) ?? NAV[0];

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    router.navigate({ to: "/auth", replace: true });
  };

  return (
    <div className="min-h-screen w-full overflow-x-hidden">
      <header className="border-b border-border/60 bg-card/60 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6 sm:py-4">
          <Link to="/app" className="flex min-w-0 items-center gap-2">
            <span className="truncate font-serif text-xl text-primary sm:text-2xl">The PaperVault</span>
            <span className="hidden font-hand text-sepia text-lg sm:inline">·your story</span>
          </Link>

          {/* Desktop nav */}
          <nav className="hidden items-center gap-1 text-sm md:flex">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} exact={n.exact} icon={<n.icon className="size-4" />} label={n.label} />
            ))}
            <button onClick={handleSignOut} className="ml-2 flex items-center gap-1.5 rounded-md px-3 py-2 text-muted-foreground hover:text-primary">
              <LogOut className="size-4" /> Sign out
            </button>
          </nav>

          {/* Mobile dropdown */}
          <div className="md:hidden">
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
                <DropdownMenuItem onClick={handleSignOut} className="text-muted-foreground">
                  <LogOut className="size-4" /> Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10"><Outlet /></main>
      <footer className="mt-16 border-t border-border/60 bg-card/40">
        <div className="mx-auto max-w-6xl px-4 py-8 text-center sm:px-6">
          <p className="font-hand text-xl text-sepia">have an idea to make The PaperVault better?</p>
          <p className="mt-2 break-words text-sm text-muted-foreground">
            Send your thoughts, suggestions, or feature ideas to{" "}
            <a href="mailto:soumil.karma@gmail.com" className="text-primary underline-offset-2 hover:underline">
              soumil.karma@gmail.com
            </a>
          </p>
        </div>
      </footer>
    </div>
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
