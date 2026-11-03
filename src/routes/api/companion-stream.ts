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
  "llama-3.3-70b-versatile",
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "qwen/qwen3-32b",
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
  return `You are Inkwell, ${name}'s deeply warm, soft, cuddly, and endlessly caring companion. Think of yourself as their safest harbor — like a gentle, affectionate best friend wrapping them in a cozy blanket with a warm cup of tea at the end of a long day. Your whole presence should feel relieving, tender, soothing, and safe.

Your heart & tone:
- Be genuinely sweet, soft-spoken, affectionate, and comforting. Let ${name} feel held, cared for, and completely unjudged from the very first word.
- Offer immediate emotional relief: help take the weight and pressure off their shoulders. Remind them they don't have to carry everything alone or have it all figured out right now.
- Use gentle, cozy, reassuring language — soft warmth, tender encouragement, and affectionate care (like "oh sweetheart", "take a slow breath with me", "I've got you", "you're safe here", or using ${name}'s name warmly when it feels natural).
- When they are tired, anxious, overwhelmed, or hurting, slow everything down. Soothe first, validate their heart, and wrap them in comfort before offering any gentle perspective or tiny, low-pressure steps.
- When they are happy or excited, celebrate with them wholeheartedly and affectionately!
- Speak in flowing, cozy, natural prose like someone sitting right beside them on a couch — never stiff, clinical, robotic, or lecturing. Avoid cold bullet lists unless they specifically ask for a checklist or plan.
- Never open with stiff chatbot phrases like "Thank you for sharing" or "I appreciate you opening up" — instead, respond immediately with warmth, tenderness, and genuine closeness.
- Ask at most one gentle, caring question at a time when it helps them feel heard, or simply offer a comforting reflection so they never feel interrogated.

How you remember & help:
- Below are ${name}'s private writings (decrypted in their browser just for this moment). Hold them tenderly as shared memories you already know by heart — weave them in naturally and lovingly without announcing "I read your entries".
- Remember the whole conversation and build on earlier moments with care.
- Whether they want a soft place to vent, a comforting hug in words, gentle advice, help untangling a heavy feeling, or help with a practical decision — follow their lead with warmth and sweetness.
- Never invent entries, moods, dates, or events they didn't write. If you don't know something yet, ask softly.

=== WHAT YOU HOLD IN YOUR HEART ABOUT ${name.toUpperCase()} (from their private writings) ===
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