import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Send } from "lucide-react";
import { toast } from "sonner";
import { Markdown } from "@/components/Markdown";
import { supabase } from "@/integrations/supabase/client";
import { useVault } from "@/lib/vault";
import { decryptText, encryptText } from "@/lib/crypto";
import { decryptStreamChunk, postEncryptedCompanionRequest } from "@/lib/companion-transport";
import { AppSelect } from "@/components/AppSelect";
import { CHAT_SESSIONS_UPDATED } from "./chat";
import { useBrowserDraft } from "@/lib/browser-drafts";
import {
  formatBrowserFullDateTime,
  getBrowserNow,
  getChatGapSeparatorLabel,
  toBrowserLocalDate,
} from "@/lib/browser-time";

export const Route = createFileRoute("/app/chat/$sessionId")({
  component: SessionChat,
});

type Msg = { role: "user" | "assistant"; content: string; createdAt?: string };
type Source = "both" | "diary" | "blog";

const PROMPTS = [
  "I just need a soft, comforting place to rest my thoughts today.",
  "Help me feel a little lighter about what's been on my mind lately.",
  "What gentle patterns or bright spots do you notice in my recent entries?",
  "Give me a cozy, low-pressure reflection prompt for tonight.",
];

function isoDay(d: Date) {
  return toBrowserLocalDate(d);
}

async function buildContext(
  userId: string,
  key: CryptoKey | null,
  source: Source,
  startDate: string,
  endDate: string,
): Promise<string> {
  if (!key) return "";
  type DiaryRow = { content: string; iv: string | null; entry_date: string };
  type BlogRow = { title: string; content: string; tags: string[] | null; created_at: string };
  const startIso = new Date(startDate).toISOString();
  const endIso = new Date(new Date(endDate).getTime() + 24 * 3600 * 1000 - 1).toISOString();

  const wantsDiary = source !== "blog";
  const wantsBlog = source !== "diary";

  const [diary, blog] = await Promise.all([
    wantsDiary
      ? supabase
          .from("diary_entries")
          .select("content,iv,entry_date" as never)
          .eq("user_id", userId)
          .gte("entry_date", startDate)
          .lte("entry_date", endDate)
          .order("entry_date", { ascending: false })
          .limit(60)
      : Promise.resolve({ data: [] as unknown as DiaryRow[] }),
    wantsBlog
      ? supabase
          .from("blog_posts")
          .select("title,content,tags,created_at")
          .eq("user_id", userId)
          .gte("created_at", startIso)
          .lte("created_at", endIso)
          .order("created_at", { ascending: false })
          .limit(40)
      : Promise.resolve({ data: [] as unknown as BlogRow[] }),
  ]);

  const diaryRows = (diary.data ?? []) as unknown as DiaryRow[];
  const blogRows = (blog.data ?? []) as unknown as BlogRow[];

  // Keep the total context within the model's limits: newest entries first,
  // each entry trimmed, and a hard overall budget so large diaries still work.
  const DIARY_ENTRY_MAX = 1500;
  const BLOG_POST_MAX = 800;
  const CONTEXT_BUDGET = 90_000;
  const trim = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);

  const diaryDecoded = (
    await Promise.all(
      diaryRows.map(async (row) => {
        if (row.iv && key) {
          try {
            const plain = await decryptText(key, row.content, row.iv);
            const obj = JSON.parse(plain) as { t?: string; c?: string; m?: string };
            return `[${row.entry_date}${obj.m ? ` · ${obj.m}` : ""}] ${obj.t || "Untitled"}\n${trim(obj.c ?? "", DIARY_ENTRY_MAX)}`;
          } catch {
            return null;
          }
        }
        return null;
      }),
    )
  ).filter((item): item is string => item !== null);
  const diaryText = wantsDiary
    ? diaryDecoded.join("\n\n---\n\n") || "(no diary entries in this range)"
    : "";
  const blogText = wantsBlog
    ? blogRows
        .map(
          (b) =>
            `# ${b.title}${b.tags?.length ? ` (${b.tags.join(", ")})` : ""}\n${trim(b.content, BLOG_POST_MAX)}`,
        )
        .join("\n\n---\n\n") || "(no blog posts in this range)"
    : "";

  const parts: string[] = [];
  if (wantsDiary) parts.push(`=== DIARY ENTRIES (${startDate} → ${endDate}) ===\n${diaryText}`);
  if (wantsBlog) parts.push(`=== BLOG POSTS (${startDate} → ${endDate}) ===\n${blogText}`);
  let combined = parts.join("\n\n");
  if (combined.length > CONTEXT_BUDGET) {
    combined = `${combined.slice(0, CONTEXT_BUDGET)}\n\n(older entries trimmed to fit)`;
  }
  return combined;
}

function isCorruptedWarmupMessage(content: string): boolean {
  const trimmed = content.trimStart().toLowerCase();
  return (
    content.includes('sessionStorage.setItem("warmup_') ||
    content.includes('sessionStorage.removeItem("warmup_') ||
    content.includes('window.parent.postMessage({ type: "warmup') ||
    trimmed.startsWith("<!doctype html") ||
    trimmed.startsWith("<html")
  );
}

function SessionChat() {
  const { user, profileDisplayName } = Route.useRouteContext();
  const { sessionId } = Route.useParams();
  const { key } = useVault();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput, clearDraft] = useBrowserDraft(
    `papervault:companion-draft:${user.id}:${sessionId}`,
    "",
  );
  const [loading, setLoading] = useState(false);
  const [hydrating, setHydrating] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = (behavior: ScrollBehavior = "smooth") => {
    requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ behavior, block: "end" });
    });
  };

  const today = useMemo(() => new Date(), []);
  const monthAgo = useMemo(() => new Date(today.getTime() - 30 * 24 * 3600 * 1000), [today]);
  const [source, setSource] = useState<Source>("both");
  const [startDate, setStartDate] = useState<string>(isoDay(monthAgo));
  const [endDate, setEndDate] = useState<string>(isoDay(today));

  // Scroll to bottom only when opening a session, not while the AI streams or finishes its reply
  const didInitialScrollRef = useRef(false);
  useEffect(() => {
    didInitialScrollRef.current = false;
  }, [sessionId]);

  useEffect(() => {
    if (hydrating || didInitialScrollRef.current) return;
    didInitialScrollRef.current = true;
    if (messages.length > 0) {
      scrollToBottom("auto");
    }
  }, [hydrating, messages.length]);

  // Load prior messages for this session
  useEffect(() => {
    let cancelled = false;
    setHydrating(true);
    setMessages([]);
    (async () => {
      const { data, error } = await supabase
        .from("chat_messages")
        .select("id,role,content,iv,created_at")
        .eq("session_id", sessionId)
        .eq("user_id", user.id)
        .order("created_at", { ascending: true });
      if (cancelled) return;
      if (error) {
        toast.error("Could not load this conversation");
      } else {
        const decoded = await Promise.all(
          (data ?? []).map(async (r) => {
            let content = r.content;
            if (r.iv) {
              if (!key) return null;
              try {
                content = await decryptText(key, r.content, r.iv);
              } catch {
                return null;
              }
            } else if (key) {
              const enc = await encryptText(key, r.content);
              void supabase
                .from("chat_messages")
                .update({ content: enc.ct, iv: enc.iv })
                .eq("id", r.id)
                .eq("user_id", user.id);
            }
            if (r.role === "assistant" && isCorruptedWarmupMessage(content)) {
              void supabase.from("chat_messages").delete().eq("id", r.id).eq("user_id", user.id);
              return null;
            }
            return {
              role: r.role as "user" | "assistant",
              content,
              createdAt: r.created_at,
            };
          }),
        );
        if (cancelled) return;
        setMessages(decoded.filter((m): m is Msg => m !== null));
      }
      setHydrating(false);
      setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 0);
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, user.id, key]);

  const send = async (rawQuestion: string) => {
    const question = rawQuestion.trim();
    if (!question || loading) return;
    clearDraft();
    if (inputRef.current) {
      inputRef.current.value = "";
      inputRef.current.blur();
    }
    const sentSnap = getBrowserNow();
    const priorHistory = messages.filter((m) => !isCorruptedWarmupMessage(m.content));
    const userMsg: Msg = { role: "user", content: question, createdAt: sentSnap.iso };
    setMessages((m) => [...m, userMsg]);
    setLoading(true);
    scrollToBottom("smooth");
    try {
      if (!key) throw new Error("Unlock your vault to continue");
      // Persist user message with browser timestamp, encrypted
      const encQ = await encryptText(key, question);
      const { error: userMessageError } = await supabase.from("chat_messages").insert({
        session_id: sessionId,
        user_id: user.id,
        role: "user",
        content: encQ.ct,
        iv: encQ.iv,
        created_at: sentSnap.iso,
      });
      if (userMessageError) throw userMessageError;
      void supabase
        .from("chat_sessions")
        .update({ last_message_at: sentSnap.iso })
        .eq("id", sessionId)
        .eq("user_id", user.id);

      const context = await buildContext(user.id, key, source, startDate, endDate);
      const emailPrefix = user.email?.split("@")[0]?.toLowerCase() ?? "";
      const rawName =
        profileDisplayName ||
        (user.user_metadata?.display_name as string | undefined) ||
        (user.user_metadata?.full_name as string | undefined) ||
        (user.user_metadata?.name as string | undefined) ||
        "";
      const name =
        rawName.trim() && rawName.trim().toLowerCase() !== emailPrefix
          ? rawName.trim()
          : "the writer";

      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;
      if (!accessToken) throw new Error("Please sign in again to continue");

      const { response, transportKey, envelope } = await postEncryptedCompanionRequest(
        "/api/companion-stream",
        accessToken,
        {
          question,
          sentAt: sentSnap.localDateTime,
          browserTime: sentSnap.localDateTime,
          context,
          name,
          history: priorHistory.map((m) => ({
            role: m.role,
            content: m.content,
            sentAt: m.createdAt ? formatBrowserFullDateTime(m.createdAt) : undefined,
          })),
        },
      );
      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      if (!response.ok) {
        const message = await response.text();
        if (contentType.includes("text/html") || isCorruptedWarmupMessage(message)) {
          throw new Error(
            "The server is warming up — please try sending your message again in a moment.",
          );
        }
        throw new Error(message || "Could not reach the companion");
      }
      if (contentType.includes("text/html")) {
        throw new Error(
          "The server is warming up — please try sending your message again in a moment.",
        );
      }

      const isEncryptedStream = response.headers.get("x-companion-encrypted") === "1";
      const reader = response.body?.getReader();
      if (!reader) throw new Error("The Companion returned an empty response");

      const decoder = new TextDecoder();
      let answer = "";
      let frameBuffer = "";
      let expectedSeq = 0;
      const streamStartSnap = getBrowserNow();
      setMessages((current) => [
        ...current,
        { role: "assistant", content: "", createdAt: streamStartSnap.iso },
      ]);

      const processEncryptedLines = async (lines: string[]) => {
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;
          const chunk = await decryptStreamChunk(transportKey, envelope.ts, expectedSeq, line);
          expectedSeq++;
          answer += chunk;
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const decodedPart = decoder.decode(value, { stream: true });
        if (isEncryptedStream) {
          frameBuffer += decodedPart;
          const lines = frameBuffer.split("\n");
          frameBuffer = lines.pop() ?? "";
          if (lines.length > 0) {
            await processEncryptedLines(lines);
          }
        } else {
          answer += decodedPart;
        }
        if (isCorruptedWarmupMessage(answer)) {
          void reader.cancel();
          throw new Error(
            "The server is warming up — please try sending your message again in a moment.",
          );
        }
        setMessages((current) => [
          ...current.slice(0, -1),
          { role: "assistant", content: answer, createdAt: streamStartSnap.iso },
        ]);
      }

      const tail = decoder.decode();
      if (isEncryptedStream) {
        frameBuffer += tail;
        if (frameBuffer.trim()) {
          await processEncryptedLines(frameBuffer.split("\n"));
        }
      } else {
        answer += tail;
      }

      if (!answer.trim() || isCorruptedWarmupMessage(answer)) {
        throw new Error("The Companion returned an empty response");
      }

      const replySnap = getBrowserNow();
      setMessages((current) => [
        ...current.slice(0, -1),
        { role: "assistant", content: answer, createdAt: replySnap.iso },
      ]);

      const encA = await encryptText(key, answer);
      await supabase.from("chat_messages").insert({
        session_id: sessionId,
        user_id: user.id,
        role: "assistant",
        content: encA.ct,
        iv: encA.iv,
        created_at: replySnap.iso,
      });

      // If this is the first exchange, title the session from the question
      const patch: { last_message_at: string; title?: string; title_iv?: string } = {
        last_message_at: replySnap.iso,
      };
      if (priorHistory.length === 0) {
        const encT = await encryptText(key, question.slice(0, 60));
        patch.title = encT.ct;
        patch.title_iv = encT.iv;
      }
      await supabase.from("chat_sessions").update(patch).eq("id", sessionId).eq("user_id", user.id);
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
          <span className="mb-1 block text-xs uppercase tracking-wide text-muted-foreground">
            Source
          </span>
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
          <span className="mb-1 block text-xs uppercase tracking-wide text-muted-foreground">
            From
          </span>
          <input
            type="date"
            value={startDate}
            max={endDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="w-full rounded-md border border-input bg-card px-2 py-1.5"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs uppercase tracking-wide text-muted-foreground">
            To
          </span>
          <input
            type="date"
            value={endDate}
            min={startDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="w-full rounded-md border border-input bg-card px-2 py-1.5"
          />
        </label>
        <div className="flex items-end">
          <button
            onClick={resetToDefault}
            className="w-full rounded-md border border-border bg-secondary/50 px-3 py-1.5 text-sm hover:bg-secondary"
          >
            Last 30 days
          </button>
        </div>
      </div>

      {!hydrating && messages.length === 0 && (
        <div className="paper-card p-6">
          <p className="text-sm text-muted-foreground mb-3">Try asking:</p>
          <div className="flex flex-wrap gap-2">
            {PROMPTS.map((p) => (
              <button
                key={p}
                onClick={() => send(p)}
                className="rounded-full border border-border bg-secondary/60 px-3 py-1.5 text-sm text-secondary-foreground hover:bg-secondary"
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-3">
        {hydrating && <p className="font-hand text-sepia">loading conversation...</p>}
        {messages.map((m, i) => {
          const prevCreatedAt = i > 0 ? messages[i - 1]?.createdAt : null;
          const gapSeparator = getChatGapSeparatorLabel(prevCreatedAt, m.createdAt);
          return (
            <div key={i} className="space-y-3">
              {gapSeparator && (
                <div className="my-4 flex items-center gap-3">
                  <div className="h-px flex-1 bg-border/70" />
                  <span className="shrink-0 text-[11px] font-medium tracking-wide text-muted-foreground">
                    {gapSeparator}
                  </span>
                  <div className="h-px flex-1 bg-border/70" />
                </div>
              )}
              <div className={m.role === "user" ? "flex justify-end" : ""}>
                {m.role === "user" ? (
                  <div className="max-w-[80%] rounded-2xl bg-primary px-4 py-2.5 text-primary-foreground">
                    <Markdown>{m.content}</Markdown>
                  </div>
                ) : (
                  <div className="paper-card max-w-[90%] p-4">
                    <p className="mb-2 font-hand text-lg leading-none text-sepia">companion</p>
                    <Markdown>{m.content}</Markdown>
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {loading && messages.at(-1)?.role !== "assistant" && (
          <p className="font-hand text-sepia">thinking...</p>
        )}
      </div>

      <div ref={bottomRef} className="h-32" aria-hidden />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="glass-card fixed bottom-4 left-4 right-4 z-30 mx-auto flex max-w-3xl items-center gap-2 p-2"
      >
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about your story..."
          className="flex-1 bg-transparent px-3 py-2 outline-none placeholder:text-muted-foreground/60"
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="flex items-center gap-1 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
        >
          <Send className="size-4" /> Send
        </button>
      </form>
    </div>
  );
}
