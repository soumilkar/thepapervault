import { createFileRoute, Outlet, redirect, Link, useRouter, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { BookOpen, Image as ImageIcon, PenLine, MessageCircle, LogOut, Home, ChevronDown, Lock, StickyNote } from "lucide-react";
import { VaultProvider, useVault } from "@/lib/vault";
import { VaultGate } from "@/components/VaultGate";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

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
  { to: "/app/diary", icon: PenLine, label: "Diary", exact: false },
  { to: "/app/notes", icon: StickyNote, label: "Notes", exact: false },
  { to: "/app/blog", icon: BookOpen, label: "Blog", exact: false },
  { to: "/app/gallery", icon: ImageIcon, label: "Gallery", exact: false },
  { to: "/app/chat", icon: MessageCircle, label: "Companion", exact: false },
  { to: "/app/lock", icon: Lock, label: "Lock", exact: false },
] as const;
function AuthedLayout() {
  const { user } = Route.useRouteContext();
  return <VaultProvider userId={user.id}><Workspace userId={user.id} /></VaultProvider>;
}
function Workspace({ userId }: { userId: string }) {
  const router = useRouter();
  const pathname = useRouterState({ select: s => s.location.pathname });
  const { lock } = useVault();
  const current = NAV.find(n => n.exact ? pathname === n.to : pathname.startsWith(n.to)) ?? NAV[0];
  useEffect(() => { if (pathname === "/app/lock") lock(); }, [pathname]);
  const signOut = async () => { await supabase.auth.signOut(); router.navigate({ to: "/auth", replace: true }); };
  return <div className="min-h-screen w-full overflow-x-clip">
    <header className="workspace-header fixed inset-x-0 top-0 z-50 border-b border-border">
      <div className="mx-auto grid max-w-7xl grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-4 sm:px-6 xl:flex xl:justify-between">
        <Link to="/app" className="min-w-0 shrink-0 truncate font-serif text-xl font-semibold text-foreground">The PaperVault</Link>
        <nav aria-label="Workspace navigation" className="hidden min-w-0 items-center gap-0.5 xl:flex">
          {NAV.map(n => <Button key={n.to} variant="ghost" asChild className="px-2.5"><Link to={n.to} activeOptions={{ exact: n.exact }} className="workspace-nav"><n.icon />{n.label}</Link></Button>)}
        </nav>
        <div className="flex shrink-0 items-center gap-1">
          <ThemeToggle />
          <Button variant="ghost" className="hidden sm:inline-flex" onClick={signOut}><LogOut />Sign Out</Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="outline" className="xl:hidden"><current.icon /><span className="hidden min-[360px]:inline">{current.label}</span><ChevronDown /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {NAV.map(n => <DropdownMenuItem key={n.to} asChild><Link to={n.to} className="flex items-center gap-2"><n.icon className="size-4" />{n.label}</Link></DropdownMenuItem>)}
              <DropdownMenuSeparator /><DropdownMenuItem onClick={signOut}><LogOut className="size-4" />Sign Out</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
    <main className="workspace-main mx-auto max-w-6xl px-4 pb-24 pt-28 sm:px-6 sm:pt-32"><VaultGate userId={userId}><Outlet /></VaultGate></main>
  </div>;
}
