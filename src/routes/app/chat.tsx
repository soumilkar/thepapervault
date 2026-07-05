import { createFileRoute, Outlet, Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useState, useCallback } from "react";
import { Sparkles, Plus, Trash2, MessageSquare } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export const Route = createFileRoute("/app/chat")({
  component: ChatLayout,
});

type SessionRow = { id: string; title: string; last_message_at: string };

const MAX_SESSIONS = 7;
const PRUNE_DAYS = 14;

function ChatLayout() {
  const { user } = Route.useRouteContext();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const activeId = pathname.startsWith("/app/chat/") ? pathname.slice("/app/chat/".length) : null;

  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    // Prune anything older than 14 days
    const cutoff = new Date(Date.now() - PRUNE_DAYS * 24 * 3600 * 1000).toISOString();
    await supabase.from("chat_sessions").delete().eq("user_id", user.id).lt("last_message_at", cutoff);

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

  useEffect(() => { void refresh(); }, [refresh]);

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
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-hand text-2xl text-sepia">a quiet conversation</p>
          <h1 className="font-serif text-4xl text-primary flex items-center gap-2">
            <Sparkles className="size-7 text-accent" /> Your companion
          </h1>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
        <aside className="paper-card p-3 h-fit">
          <button
            onClick={startNew}
            className="mb-3 flex w-full items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground hover:opacity-90"
          >
            <Plus className="size-4" /> New chat
          </button>
          <p className="mb-2 px-1 text-xs uppercase tracking-wide text-muted-foreground">
            Recent (last {MAX_SESSIONS}, kept {PRUNE_DAYS} days)
          </p>
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
                      className={`flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-sm ${
                        isActive ? "bg-secondary text-primary" : "text-foreground/80 hover:bg-secondary/60"
                      }`}
                    >
                      <MessageSquare className="size-3.5 shrink-0 opacity-70" />
                      <span className="truncate">{s.title || "Untitled"}</span>
                    </Link>
                    <button
                      onClick={() => remove(s.id)}
                      title="Delete"
                      className="rounded-md p-1.5 text-muted-foreground opacity-0 hover:bg-secondary hover:text-destructive group-hover:opacity-100"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        <div className="min-w-0">
          <Outlet />
        </div>
      </div>
    </div>
  );
}

export const CHAT_SESSIONS_UPDATED = "chat-sessions-updated";

