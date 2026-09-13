import { createFileRoute, Outlet, Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useState, useCallback } from "react";
import { Sparkles, Plus, Trash2, MessageSquare, Menu } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

export const Route = createFileRoute("/app/chat")({
  component: ChatLayout,
});

type SessionRow = { id: string; title: string; last_message_at: string };

const MAX_SESSIONS = 7;
export const CHAT_SESSIONS_UPDATED = "chat-sessions-updated";

function ChatLayout() {
  const { user } = Route.useRouteContext();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const activeId = pathname.startsWith("/app/chat/") ? pathname.slice("/app/chat/".length) : null;

  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);

  const refresh = useCallback(async () => {
    const { data, error } = await supabase
      .from("chat_sessions")
      .select("id,title,last_message_at")
      .eq("user_id", user.id)
      .order("last_message_at", { ascending: false })
      .limit(MAX_SESSIONS);
    if (error) {
      toast.error("Could not load conversations");
      setSessions([]);
    } else {
      setSessions(data ?? []);
    }
    setLoading(false);
  }, [user.id]);

  useEffect(() => {
    void refresh();
    const h = () => { void refresh(); };
    window.addEventListener(CHAT_SESSIONS_UPDATED, h);
    return () => window.removeEventListener(CHAT_SESSIONS_UPDATED, h);
  }, [refresh]);

  // Close side menu after navigation
  useEffect(() => {
    setMenuOpen(false);
  }, [activeId]);

  const startNew = async () => {
    const { data, error } = await supabase
      .from("chat_sessions")
      .insert({ user_id: user.id, title: "New conversation" })
      .select("id,title,last_message_at")
      .single();
    if (error || !data) {
      toast.error("Could not start a new chat");
      return;
    }
    setSessions((s) => [data, ...s].slice(0, MAX_SESSIONS));
    setMenuOpen(false);
    navigate({ to: "/app/chat/$sessionId", params: { sessionId: data.id } });
  };

  const remove = async (id: string) => {
    const prev = sessions;
    setSessions((s) => s.filter((x) => x.id !== id));
    const { error } = await supabase.from("chat_sessions").delete().eq("id", id);
    if (error) {
      setSessions(prev);
      toast.error("Could not delete");
      return;
    }
    if (activeId === id) navigate({ to: "/app/chat" });
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3">
        <Popover open={menuOpen} onOpenChange={setMenuOpen}>
          <PopoverTrigger asChild>
            <button
              aria-label="Open conversations menu"
              className="mt-1 inline-flex size-10 items-center justify-center rounded-xl border border-primary/30 bg-primary/10 text-primary shadow-sm backdrop-blur-md transition hover:bg-primary/20"
            >
              <Menu className="size-5" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            side="bottom"
            align="start"
            sideOffset={10}
            className="w-[min(20rem,calc(100vw-1.5rem))] rounded-2xl border border-primary/25 bg-primary/15 p-0 text-foreground shadow-xl backdrop-blur-xl backdrop-saturate-150 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95 data-[state=open]:slide-in-from-top-2 data-[state=closed]:slide-out-to-top-2 data-[state=open]:duration-200 data-[state=closed]:duration-150"
          >
            <div className="flex items-center justify-between gap-2 border-b border-primary/20 px-4 py-3">
              <p className="font-serif text-base text-primary">Conversations</p>
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                saved history
              </span>
            </div>
            <div className="flex max-h-[min(70vh,26rem)] flex-col p-3">
              <button
                onClick={startNew}
                className="mb-3 flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-3 py-2 text-sm text-primary-foreground shadow-sm transition hover:opacity-90"
              >
                <Plus className="size-4" /> New chat
              </button>
              <p className="mb-1.5 px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                Recent (up to {MAX_SESSIONS})
              </p>
              <div className="min-h-0 flex-1 overflow-y-auto pr-1">
                {loading ? (
                  <p className="px-1 py-2 text-sm text-muted-foreground">Loading…</p>
                ) : sessions.length === 0 ? (
                  <p className="px-1 py-2 text-sm text-muted-foreground">No conversations yet.</p>
                ) : (
                  <ul className="space-y-1">
                    {sessions.map((s) => {
                      const isActive = s.id === activeId;
                      return (
                        <li key={s.id} className="group flex items-center gap-1">
                          <Link
                            to="/app/chat/$sessionId"
                            params={{ sessionId: s.id }}
                            className={`flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition ${
                              isActive
                                ? "bg-primary/25 text-primary"
                                : "text-foreground/80 hover:bg-primary/10"
                            }`}
                          >
                            <MessageSquare className="size-3.5 shrink-0 opacity-70" />
                            <span className="truncate">{s.title || "Untitled"}</span>
                          </Link>
                          <button
                            onClick={() => remove(s.id)}
                            title="Delete"
                            aria-label="Delete conversation"
                            className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-primary/15 hover:text-destructive"
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          </PopoverContent>
        </Popover>

        <div className="min-w-0">
          <p className="font-hand text-2xl text-sepia">a quiet conversation</p>
          <h1 className="flex items-center gap-2 font-serif text-3xl text-primary sm:text-4xl">
            <Sparkles className="size-6 shrink-0 text-accent sm:size-7" />
            <span className="truncate">Your companion</span>
          </h1>
        </div>
      </div>

      <div className="min-w-0">
        <Outlet />
      </div>
    </div>
  );
}
