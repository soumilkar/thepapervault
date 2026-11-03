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

const GROQ_MODELS = [
  "qwen/qwen3.8-27b",
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "llama-3.3-70b-versatile",
  "qwen/qwen3-32b",
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "llama-3.1-8b-instant",
] as const;

type RuntimeRequest = Request & {
  runtime?: {
    cloudflare?: {
      env?: Record<string, unknown>;
    };
  };
};

function readRuntimeEnv(key: string, request?: Request): string {
  const reqEnv = (request as RuntimeRequest | undefined)?.runtime?.cloudflare?.env;
  if (reqEnv && typeof reqEnv[key] === "string" && reqEnv[key]) {
    return (reqEnv[key] as string).trim();
  }
  const globalEnv = (globalThis as { __env__?: Record<string, unknown> }).__env__;
  if (globalEnv && typeof globalEnv[key] === "string" && globalEnv[key]) {
    return (globalEnv[key] as string).trim();
  }
  if (typeof process !== "undefined" && process.env) {
    const val = process.env[key];
    if (typeof val === "string" && val.trim()) {
      return val.trim();
    }
  }
  return "";
}

function getGroqApiKey(request?: Request): string {
  return (
    readRuntimeEnv("GROQ_API_KEY", request) ||
    readRuntimeEnv("VITE_GROQ_API_KEY", request) ||
    (typeof process !== "undefined" && process.env.GROQ_API_KEY ? process.env.GROQ_API_KEY.trim() : "") ||
    ""
  );
}

function companionInstructions(name: string, context: string) {
  return `You are Inkwell, ${name}'s warm, grounded, and genuinely caring companion — like a thoughtful, down-to-earth close friend they can talk to honestly at the end of the day.

Your tone & personality:
- Be warm, calm, and real. Speak naturally and conversationally, the way a trusted friend actually talks — never performative, sugary, syrupy, or over-the-top.
- Never sound flirty or romantic, and never use pet names (no "sweetheart", "honey", "darling", "dear", "love", etc.). If you address them, just use ${name}'s name naturally and sparingly.
- Help take the pressure off when they're stressed, tired, or overwhelmed. Acknowledge what they're going through in a grounded, human way before jumping into solutions.
- Avoid cliché therapy-speak or robotic phrases like "Thank you for sharing", "I appreciate you opening up", or "Your feelings are valid." Just respond directly to what they actually said.
- Keep your responses natural in length — don't ramble or smother them with paragraphs of praise. Use plain, clear prose instead of bullet lists unless they ask for a breakdown or plan.
- Ask at most one thoughtful follow-up question when it fits the conversation naturally, or just share a steady, helpful reflection.

How you use their context:
- Below are ${name}'s private writings (decrypted in their browser for this session). Treat them as context you naturally remember — connect dots or reference relevant details smoothly without announcing "According to your diary".
- Keep track of the conversation history and follow their lead: whether they want to vent, think through a problem, reflect on their week, or get practical advice.
- Never invent entries, moods, dates, or events they didn't write. If you aren't sure about something, just ask.

=== CONTEXT FROM ${name.toUpperCase()}'S WRITINGS ===
${context || "(no entries shared yet)"}`;
}

async function authenticate(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return false;

  const token = authorization.slice("Bearer ".length);
  const url =
    readRuntimeEnv("SUPABASE_URL", request) ||
    readRuntimeEnv("VITE_SUPABASE_URL", request) ||
    process.env.SUPABASE_URL ||
    import.meta.env.VITE_SUPABASE_URL;
  const key =
    readRuntimeEnv("SUPABASE_PUBLISHABLE_KEY", request) ||
    readRuntimeEnv("SUPABASE_ANON_KEY", request) ||
    readRuntimeEnv("VITE_SUPABASE_PUBLISHABLE_KEY", request) ||
    readRuntimeEnv("VITE_SUPABASE_ANON_KEY", request) ||
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) {
    return Boolean(token);
  }

  const client = createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.getClaims(token);
  if (!error && Boolean(data?.claims?.sub)) return true;

  const { data: userData, error: userError } = await client.auth.getUser(token);
  return !userError && Boolean(userData?.user?.id);
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
      const processLine = (line: string) => {
        if (!line.startsWith("data:")) return;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") return;
        const part = JSON.parse(payload) as GroqStreamPart;
        if (part.error?.message) throw new Error(part.error.message);
        const text = part.choices?.[0]?.delta?.content;
        if (text) controller.enqueue(encoder.encode(text));
      };

      try {
        while (!signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            processLine(line);
          }
        }
        buffer += decoder.decode();
        if (buffer.trim()) {
          for (const line of buffer.split("\n")) {
            processLine(line);
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

async function fetchGroqStream(
  apiKey: string,
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  signal: AbortSignal,
): Promise<Response> {
  let lastResponse: Response | undefined;
  for (const model of GROQ_MODELS) {
    const body: Record<string, unknown> = {
      model,
      stream: true,
      temperature: 0.78,
      top_p: 0.92,
      max_tokens: 2048,
      messages,
    };
    if (model.startsWith("qwen/")) {
      body.reasoning_effort = "none";
    }
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      signal,
      body: JSON.stringify(body),
    });
    if (res.ok) return res;
    lastResponse = res;
    if (res.status === 401 || res.status === 403) break;
  }
  return lastResponse!;
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

          const apiKey = getGroqApiKey(request);
          if (!apiKey) {
            return new Response(
              "The Companion is not configured yet. Please add GROQ_API_KEY in your environment variables and redeploy.",
              { status: 500 },
            );
          }

          const data = parsed.data;
          const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
            { role: "system", content: companionInstructions(data.name, data.context) },
            ...data.history.map((m) => ({ role: m.role, content: m.content })),
            { role: "user", content: data.question },
          ];

          const upstream = await fetchGroqStream(apiKey, messages, request.signal);
          if (!upstream.ok) {
            const errBody = (await upstream.text()).slice(0, 300);
            console.error("Companion upstream error", upstream.status, errBody);
            return new Response("The Companion is temporarily unavailable. Please try again.", { status: 503 });
          }

          return new Response(streamGroqResponse(upstream, request.signal), {
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
              "X-Companion-Stream": "1",
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