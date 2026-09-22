import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Send } from "lucide-react";
import { toast } from "sonner";
import { Markdown } from "@/components/Markdown";
import { supabase } from "@/integrations/supabase/client";
import { useVault } from "@/lib/vault";
import { decryptText } from "@/lib/crypto";
import { AppSelect } from "@/components/AppSelect";
import { CHAT_SESSIONS_UPDATED } from "./chat";
import { useBrowserDraft } from "@/lib/browser-drafts";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";

export const Route = createFileRoute("/app/chat/$sessionId")({
  component: SessionChat,
});

type Msg = { role: "user" | "assistant"; content: string };
type Source = "both" | "diary" | "blog";

const PROMPTS = [
  "What recurring themes appear in my recent diary entries?",
  "How has my mood shifted over the past few weeks?",
  "Give me a journaling prompt based on what I've written lately.",
  "What do I seem most grateful for?",
];

function isoDay(d: Date) { return d.toISOString().slice(0, 10); }

async function buildContext(
  userId: string,
  key: CryptoKey | null,
  source: Source,
  startDate: string,
  endDate: string,
): Promise<string> {
  type DiaryRow = { content: string; iv: string | null; entry_date: string };
  type BlogRow = { title: string; content: string; tags: string[] | null; created_at: string };
  const startIso = new Date(startDate).toISOString();
  const endIso = new Date(new Date(endDate).getTime() + 24 * 3600 * 1000 - 1).toISOString();

  const wantsDiary = source !== "blog";
  const wantsBlog = source !== "diary";

  const [diary, blog] = await Promise.all([
    wantsDiary
      ? supabase.from("diary_entries").select("content,iv,entry_date" as never)
          .eq("user_id", userId).gte("entry_date", startDate).lte("entry_date", endDate)
          .order("entry_date", { ascending: false }).limit(100)
      : Promise.resolve({ data: [] as unknown as DiaryRow[] }),
    wantsBlog
      ? supabase.from("blog_posts").select("title,content,tags,created_at")
          .eq("user_id", userId).gte("created_at", startIso).lte("created_at", endIso)
          .order("created_at", { ascending: false }).limit(60)
      : Promise.resolve({ data: [] as unknown as BlogRow[] }),
  ]);

  const diaryRows = (diary.data ?? []) as unknown as DiaryRow[];
  const blogRows = (blog.data ?? []) as unknown as BlogRow[];

  const diaryDecoded: string[] = [];
  for (const row of diaryRows) {
    if (row.iv && key) {
      try {
        const plain = await decryptText(key, row.content, row.iv);
        const obj = JSON.parse(plain) as { t?: string; c?: string; m?: string };
        diaryDecoded.push(`[${row.entry_date}${obj.m ? ` · ${obj.m}` : ""}] ${obj.t || "Untitled"}\n${obj.c ?? ""}`);
      } catch { /* skip */ }
    } else if (!row.iv) {
      diaryDecoded.push(`[${row.entry_date}] ${row.content}`);
    }
  }
  const diaryText = wantsDiary ? (diaryDecoded.join("\n\n---\n\n") || "(no diary entries in this range)") : "";
  const blogText = wantsBlog
    ? (blogRows.map((b) => `# ${b.title}${b.tags?.length ? ` (${b.tags.join(", ")})` : ""}\n${b.content}`).join("\n\n---\n\n") || "(no blog posts in this range)")
    : "";

  const parts: string[] = [];
  if (wantsDiary) parts.push(`=== DIARY ENTRIES (${startDate} → ${endDate}) ===\n${diaryText}`);
  if (wantsBlog) parts.push(`=== BLOG POSTS (${startDate} → ${endDate}) ===\n${blogText}`);
  return parts.join("\n\n");
}

function SessionChat() {
  const { user } = Route.useRouteContext();
  const { sessionId } = Route.useParams();
  const { key } = useVault();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput, clearDraft] = useBrowserDraft(`papervault:companion-draft:${user.id}:${sessionId}`, "");
  const [loading, setLoading] = useState(false);
  const [hydrating, setHydrating] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  const today = useMemo(() => new Date(), []);
  const monthAgo = useMemo(() => new Date(today.getTime() - 30 * 24 * 3600 * 1000), [today]);
  const [source, setSource] = useState<Source>("both");
  const [startDate, setStartDate] = useState<string>(isoDay(monthAgo));
  const [endDate, setEndDate] = useState<string>(isoDay(today));

  // Load prior messages for this session
  useEffect(() => {
    let cancelled = false;
    setHydrating(true);
    setMessages([]);
    (async () => {
      const { data, error } = await supabase
        .from("chat_messages")
        .select("role,content")
        .eq("session_id", sessionId)
        .order("created_at", { ascending: true });
      if (cancelled) return;
      if (error) {
        toast.error("Could not load this conversation");
      } else {
        setMessages(
          (data ?? []).map((r) => ({
            role: r.role as "user" | "assistant",
            content: r.content,
          })),
        );
      }
      setHydrating(false);
      setTimeout(() => inputRef.current?.focus(), 0);
    })();
    return () => { cancelled = true; };
  }, [sessionId]);

  const send = async (question: string) => {
    if (!question.trim() || loading) return;
    const priorHistory = messages;
    const userMsg: Msg = { role: "user", content: question };
    setMessages((m) => [...m, userMsg]);
    setLoading(true);
    try {
      // Persist user message
      const { error: userMessageError } = await supabase.from("chat_messages").insert({
        session_id: sessionId, user_id: user.id, role: "user", content: question,
      });
      if (userMessageError) throw userMessageError;
      clearDraft();

      const context = await buildContext(user.id, key, source, startDate, endDate);
      const name = user.user_metadata?.display_name || user.email?.split("@")[0] || "the writer";
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;
      if (!accessToken) throw new Error("Please sign in again to continue");

      const response = await fetch("/api/companion-stream", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ question, context, name, history: priorHistory }),
      });
      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || "Could not reach the companion");
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("The Companion returned an empty response");

      const decoder = new TextDecoder();
      let answer = "";
      setMessages((current) => [...current, { role: "assistant", content: "" }]);
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        answer += decoder.decode(value, { stream: true });
        setMessages((current) => [
          ...current.slice(0, -1),
          { role: "assistant", content: answer },
        ]);
      }
      answer += decoder.decode();
      if (!answer.trim()) throw new Error("The Companion returned an empty response");

      await supabase.from("chat_messages").insert({
        session_id: sessionId, user_id: user.id, role: "assistant", content: answer,
      });

      // If this is the first exchange, title the session from the question
      const patch: { last_message_at: string; title?: string } = {
        last_message_at: new Date().toISOString(),
      };
      if (priorHistory.length === 0) {
        patch.title = question.slice(0, 60);
      }
      await supabase.from("chat_sessions").update(patch).eq("id", sessionId);
      window.dispatchEvent(new Event(CHAT_SESSIONS_UPDATED));
    } catch (e: unknown) {
      setMessages((current) => {
        const last = current.at(-1);
        return last?.role === "assistant" && !priorHistory.includes(last)
          ? current.slice(0, -1)
          : current;
      });
      toast.error(e instanceof Error ? e.message : "Could not reach the companion");
    } finally {
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  };

  const resetToDefault = () => {
    setSource("both");
    setStartDate(isoDay(monthAgo));
    setEndDate(isoDay(today));
  };

  return (
    <div className="space-y-4">
      <div className="paper-card p-4 grid gap-3 sm:grid-cols-4">
        <label className="text-sm">
          <span className="mb-1 block text-xs uppercase tracking-wide text-muted-foreground">Source</span>
          <AppSelect
            value={source}
            onValueChange={(v) => setSource(v as Source)}
            triggerClassName="w-full h-9"
            options={[
              { value: "both", label: "Diary + Blog" },
              { value: "diary", label: "Diary only" },
              { value: "blog", label: "Blog only" },
            ]}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs uppercase tracking-wide text-muted-foreground">From</span>
          <input type="date" value={startDate} max={endDate} onChange={(e) => setStartDate(e.target.value)}
            className="w-full rounded-md border border-input bg-card px-2 py-1.5" />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs uppercase tracking-wide text-muted-foreground">To</span>
          <input type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)}
            className="w-full rounded-md border border-input bg-card px-2 py-1.5" />
        </label>
        <div className="flex items-end">
          <button onClick={resetToDefault} className="w-full rounded-md border border-border bg-secondary/50 px-3 py-1.5 text-sm hover:bg-secondary">
            Last 30 days
          </button>
        </div>
      </div>

      {!hydrating && messages.length === 0 && (
        <div className="paper-card p-6">
          <p className="text-sm text-muted-foreground mb-3">Try asking:</p>
          <div className="flex flex-wrap gap-2">
            {PROMPTS.map((p) => (
              <button key={p} onClick={() => send(p)} className="rounded-full border border-border bg-secondary/60 px-3 py-1.5 text-sm text-secondary-foreground hover:bg-secondary">
                {p}
              </button>
            ))}
          </div>
        </div>
      )}

      <Conversation className="min-h-80 max-h-[calc(100dvh-20rem)] overflow-y-auto rounded-md">
        <ConversationContent className="gap-3 px-0 py-1">
          {hydrating && <p className="font-hand text-sepia">loading conversation...</p>}
          {messages.map((m, i) => (
            <div key={i} className={m.role === "user" ? "flex justify-end" : ""}>
              {m.role === "user" ? (
                <div className="max-w-[80%] rounded-2xl bg-chat-user px-4 py-2.5 text-chat-user-foreground">
                  <Markdown className="[&_h1]:text-inherit [&_h2]:text-inherit [&_h3]:text-inherit [&_strong]:text-inherit [&_a]:text-inherit">{m.content}</Markdown>
                </div>
              ) : (
                <div className="paper-card max-w-[90%] p-4">
                  <p className="mb-2 font-hand text-sepia text-lg leading-none">companion</p>
                  <Markdown>{m.content}</Markdown>
                </div>
              )}
            </div>
          ))}
          {loading && messages.at(-1)?.role !== "assistant" && (
            <p className="font-hand text-sepia">thinking...</p>
          )}
        </ConversationContent>
        <ConversationScrollButton aria-label="Scroll to latest message" />
      </Conversation>

      <div className="h-32" aria-hidden />
      <form
        onSubmit={(e) => { e.preventDefault(); send(input); }}
        className="glass-card fixed bottom-4 left-4 right-4 z-30 mx-auto flex max-w-3xl items-center gap-2 p-2"
      >
        <input
          ref={inputRef}
          value={input} onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about your story..."
          className="flex-1 bg-transparent px-3 py-2 outline-none placeholder:text-muted-foreground/60"
        />
        <button type="submit" disabled={loading || !input.trim()} className="flex items-center gap-1 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50">
          <Send className="size-4" /> Send
        </button>
      </form>
    </div>
  );
}
