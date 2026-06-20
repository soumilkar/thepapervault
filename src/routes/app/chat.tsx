import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Sparkles, Send, Lock } from "lucide-react";
import { toast } from "sonner";
import { askCompanion } from "@/lib/companion.functions";
import { Markdown } from "@/components/Markdown";
import { supabase } from "@/integrations/supabase/client";
import { useVault } from "@/lib/vault";
import { decryptText } from "@/lib/crypto";


export const Route = createFileRoute("/app/chat")({
  component: ChatPage,
});

type Msg = { role: "user" | "assistant"; content: string };

const PROMPTS = [
  "What recurring themes appear in my recent diary entries?",
  "How has my mood shifted over the past few weeks?",
  "Give me a journaling prompt based on what I've written lately.",
  "What do I seem most grateful for?",
];

async function buildContext(userId: string, key: CryptoKey): Promise<string> {
  type DiaryRow = { content: string; iv: string | null; entry_date: string };
  type BlogRow = { title: string; content: string; tags: string[] | null; created_at: string };
  const [diary, blog] = await Promise.all([
    supabase.from("diary_entries").select("content,iv,entry_date" as never)
      .eq("user_id", userId).order("entry_date", { ascending: false }).limit(50),
    supabase.from("blog_posts").select("title,content,tags,created_at")
      .eq("user_id", userId).order("created_at", { ascending: false }).limit(30),
  ]);
  const diaryRows = (diary.data ?? []) as unknown as DiaryRow[];
  const blogRows = (blog.data ?? []) as unknown as BlogRow[];

  const diaryDecoded: string[] = [];
  for (const row of diaryRows) {
    if (row.iv) {
      try {
        const plain = await decryptText(key, row.content, row.iv);
        const obj = JSON.parse(plain) as { t?: string; c?: string; m?: string };
        diaryDecoded.push(`[${row.entry_date}${obj.m ? ` · ${obj.m}` : ""}] ${obj.t || "Untitled"}\n${obj.c ?? ""}`);
      } catch { /* skip */ }
    } else {
      diaryDecoded.push(`[${row.entry_date}] ${row.content}`);
    }
  }
  const diaryText = diaryDecoded.join("\n\n---\n\n") || "(no diary entries)";
  const blogText = blogRows.map((b) =>
    `# ${b.title}${b.tags?.length ? ` (${b.tags.join(", ")})` : ""}\n${b.content}`
  ).join("\n\n---\n\n") || "(no blog posts)";

  return `=== DIARY ENTRIES ===\n${diaryText}\n\n=== BLOG POSTS ===\n${blogText}`;
}

function ChatPage() {
  const { user } = Route.useRouteContext();
  const { key } = useVault();
  const ask = useServerFn(askCompanion);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  const send = async (question: string) => {
    if (!question.trim() || loading) return;
    if (!key) { toast.error("Unlock your vault first"); return; }
    setMessages((m) => [...m, { role: "user", content: question }]);
    setInput("");
    setLoading(true);
    try {
      const context = await buildContext(user.id, key);
      const name = user.user_metadata?.display_name || user.email?.split("@")[0] || "the writer";
      const res = await ask({ data: { question, context, name } });
      setMessages((m) => [...m, { role: "assistant", content: res.answer }]);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Could not reach the companion");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <p className="font-hand text-2xl text-sepia">a quiet conversation</p>
        <h1 className="font-serif text-4xl text-primary flex items-center gap-2">
          <Sparkles className="size-7 text-accent" /> Your companion
        </h1>
        <p className="mt-2 flex items-center gap-1 text-sm text-muted-foreground">
          <Lock className="size-3.5" /> Entries are decrypted in your browser and sent to the AI just for this answer. They aren't stored.
        </p>
      </div>

      {messages.length === 0 && (
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

      <div className="space-y-3">
        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "flex justify-end" : ""}>
            {m.role === "user" ? (
              <div className="max-w-[80%] rounded-2xl bg-primary px-4 py-2.5 text-primary-foreground">
                <Markdown>{m.content}</Markdown>
              </div>
            ) : (
              <div className="paper-card max-w-[90%] p-4">
                <p className="mb-2 font-hand text-sepia text-lg leading-none">companion</p>
                <Markdown>{m.content}</Markdown>
              </div>
            )}
          </div>
        ))}
        {loading && <p className="font-hand text-sepia">thinking...</p>}

      </div>

      <div className="h-24" aria-hidden />
      <form
        onSubmit={(e) => { e.preventDefault(); send(input); }}
        className="paper-card fixed bottom-4 left-4 right-4 z-30 mx-auto flex max-w-3xl items-center gap-2 p-2 shadow-lg"
      >
        <input
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
