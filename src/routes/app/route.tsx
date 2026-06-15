import { createFileRoute, Outlet, redirect, Link, useRouter } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { BookOpen, Image as ImageIcon, PenLine, Sparkles, LogOut, Home, Users } from "lucide-react";

export const Route = createFileRoute("/app")({
  ssr: false,
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth" });
    return { user: data.user };
  },
  component: AuthedLayout,
});

function AuthedLayout() {
  const router = useRouter();
  const handleSignOut = async () => {
    await supabase.auth.signOut();
    router.navigate({ to: "/auth", replace: true });
  };

  return (
    <div className="min-h-screen">
      <header className="border-b border-border/60 bg-card/60 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link to="/app" className="flex items-center gap-2">
            <span className="font-serif text-2xl text-primary">Inkwell</span>
            <span className="font-hand text-sepia text-lg">·your story</span>
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            <NavLink to="/app" icon={<Home className="size-4" />} label="Home" />
            <NavLink to="/app/diary" icon={<PenLine className="size-4" />} label="Diary" />
            <NavLink to="/app/blog" icon={<BookOpen className="size-4" />} label="Blog" />
            <NavLink to="/app/gallery" icon={<ImageIcon className="size-4" />} label="Gallery" />
            <NavLink to="/app/foryou" icon={<Users className="size-4" />} label="For You" />
            <NavLink to="/app/chat" icon={<Sparkles className="size-4" />} label="Companion" />
            <button onClick={handleSignOut} className="ml-2 flex items-center gap-1.5 rounded-md px-3 py-2 text-muted-foreground hover:text-primary">
              <LogOut className="size-4" /> Sign out
            </button>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-10"><Outlet /></main>
      <footer className="mt-16 border-t border-border/60 bg-card/40">
        <div className="mx-auto max-w-6xl px-6 py-8 text-center">
          <p className="font-hand text-xl text-sepia">have an idea to make Inkwell better?</p>
          <p className="mt-2 text-sm text-muted-foreground">
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

function NavLink({ to, icon, label }: { to: string; icon: React.ReactNode; label: string }) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: to === "/app" }}
      className="flex items-center gap-1.5 rounded-md px-3 py-2 text-foreground/70 transition-colors hover:bg-secondary hover:text-primary [&.active]:bg-secondary [&.active]:text-primary"
    >
      {icon}{label}
    </Link>
  );
}
