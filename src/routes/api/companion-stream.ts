import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";

const MessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(20_000),
});

const InputSchema = z.object({
  question: z.string().min(1).max(4000),
  context: z.string().max(120_000).default(""),
  name: z.string().max(120).default("the writer"),
  history: z.array(MessageSchema).max(60).default([]),
});

type GroqStreamPart = {
  choices?: { delta?: { content?: string } }[];
  error?: { message?: string };
};

const GROQ_MODEL = "qwen/qwen3.8-27b";

function companionInstructions(name: string, context: string) {
  return `You are Inkwell, a warm, thoughtful companion for ${name} — think of yourself as a close friend who's also part-therapist and part-counsellor. Your job is to help them navigate their life: their thoughts, feelings, decisions, relationships, patterns, and anything else they bring up.

How to talk:
- Speak like a real friend, not a chatbot. Be direct, curious, warm, and human. Use their name occasionally when it feels natural, never mechanically.
- Do NOT open with "Thank you for sharing", "Thanks for opening up", "I appreciate you sharing", or any variation. Never thank them for their entries or for confiding in you. Just engage with what they said.
- Skip preambles that summarize what they just told you. Get to the substance.
- Don't lecture. Don't moralize. Don't dump bullet lists on every reply — use prose when a friend would, use structure only when it truly helps.
- Ask a real question back when it will help them think, but don't interrogate. Sometimes reflection or a small observation is better than a question.
- Match their register. If they're casual, be casual. If they're hurting, be gentle and slow down.

How to think:
- You've been given their private diary/blog context below (they decrypted it in their browser to share with you). Treat it as memory you already hold about them — reference it naturally, don't re-announce that "you shared entries with me".
- Remember the whole conversation. Earlier turns in this chat are yours to build on.
- You are not limited to journaling prompts. If they ask for advice, opinions, a plan, a rant partner, a devil's advocate, help drafting a message, help thinking through a decision, or anything else — do that. Follow their lead.
- When something isn't in what you know about them, say so honestly instead of guessing.
- Never invent entries, moods, dates, or events they didn't actually write.

=== WHAT YOU KNOW ABOUT ${name.toUpperCase()} (from their private writings) ===
${context || "(no entries shared yet)"}`;
}

async function authenticate(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return false;

  const token = authorization.slice("Bearer ".length);
  const url = process.env["SUPABASE_URL"] || process.env["VITE_SUPABASE_URL"];
  const key = process.env["SUPABASE_PUBLISHABLE_KEY"] || process.env["VITE_SUPABASE_PUBLISHABLE_KEY"];
  if (!url || !key) {
    return Boolean(token);
  }

  const client = createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.getClaims(token);
  return !error && Boolean(data?.claims?.sub);
}

function streamGroqResponse(response: Response, signal: AbortSignal) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = response.body?.getReader();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      if (!reader) {
        controller.error(new Error("The AI returned an empty stream"));
        return;
      }

      let buffer = "";
      try {
        while (!signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            const part = JSON.parse(payload) as GroqStreamPart;
            if (part.error?.message) throw new Error(part.error.message);
            const text = part.choices?.[0]?.delta?.content;
            if (text) controller.enqueue(encoder.encode(text));
          }
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
    cancel() {
      void reader?.cancel();
    },
  });
}

export const Route = createFileRoute("/api/companion-stream")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          if (!(await authenticate(request))) {
            return new Response("Please sign in again to continue", { status: 401 });
          }

          const parsed = InputSchema.safeParse(await request.json());
          if (!parsed.success) {
            return new Response("The Companion request is invalid", { status: 400 });
          }

          const apiKey = process.env["GROQ_API_KEY"];
          if (!apiKey) {
            return new Response("The Companion is not configured yet", { status: 500 });
          }

          const data = parsed.data;
          const upstream = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
            signal: request.signal,
            body: JSON.stringify({
              model: GROQ_MODEL,
              stream: true,
              temperature: 0.7,
              max_tokens: 2048,
              reasoning_effort: "none",
              messages: [
                { role: "system", content: companionInstructions(data.name, data.context) },
                ...data.history.map((m) => ({ role: m.role, content: m.content })),
                { role: "user", content: data.question },
              ],
            }),
          });
          if (!upstream.ok) {
            console.error("Companion upstream error", upstream.status, (await upstream.text()).slice(0, 300));
            return new Response("The Companion is temporarily unavailable. Please try again.", { status: 503 });
          }

          return new Response(streamGroqResponse(upstream, request.signal), {
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
            },
          });
        } catch (error) {
          console.error("Companion stream failed", error);
          return new Response(
            error instanceof SyntaxError ? "The Companion request is invalid" : "Could not start the Companion",
            { status: error instanceof SyntaxError ? 400 : 500 },
          );
        }
      },
    },
  },
});