import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";

const InputSchema = z.object({
  imageBase64: z.string().min(10).max(15_000_000),
  mimeType: z.string().min(3).max(60),
});

const GROQ_VISION_MODELS = [
  "qwen/qwen3.8-27b",
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "meta-llama/llama-4-maverick-17b-128e-instruct",
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
    (typeof process !== "undefined" && process.env.GROQ_API_KEY
      ? process.env.GROQ_API_KEY.trim()
      : "") ||
    ""
  );
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

const OCR_PROMPT = `Carefully transcribe all handwritten and printed text visible in this image with maximum accuracy.
Rules:
1. Output ONLY the exact transcribed text—no introductory commentary, no explanations, and no markdown code fences around the response.
2. Preserve original paragraph breaks, line structure, bullet points, numbered lists, headings, and indentation faithfully.
3. Read cursive, messy handwriting, margin notes, and underlined words carefully using surrounding context to resolve ambiguous characters accurately.
4. If the image contains no legible text at all, return an empty string.`;

async function transcribeWithGroqVision(
  apiKey: string,
  mimeType: string,
  base64Data: string,
  signal: AbortSignal,
): Promise<string> {
  let lastErr = "Groq vision OCR failed";
  for (const model of GROQ_VISION_MODELS) {
    const body: Record<string, unknown> = {
      model,
      temperature: 0.1,
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: OCR_PROMPT },
            {
              type: "image_url",
              image_url: { url: `data:${mimeType};base64,${base64Data}` },
            },
          ],
        },
      ],
    };
    if (model.startsWith("qwen/")) {
      body.reasoning_effort = "none";
    }

    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal,
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const json = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      return (json.choices?.[0]?.message?.content ?? "").trim();
    }
    lastErr = await res.text().catch(() => `HTTP ${res.status}`);
    if (res.status === 401 || res.status === 403) break;
  }
  throw new Error(lastErr);
}

export const Route = createFileRoute("/api/handwriting-ocr")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          if (!(await authenticate(request))) {
            return new Response(
              JSON.stringify({ error: "Please sign in to transcribe handwriting." }),
              {
                status: 401,
                headers: { "Content-Type": "application/json" },
              },
            );
          }

          const parsed = InputSchema.safeParse(await request.json());
          if (!parsed.success) {
            return new Response(JSON.stringify({ error: "Invalid image payload." }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }

          const apiKey = getGroqApiKey(request);
          if (!apiKey) {
            return new Response(
              JSON.stringify({
                error: "Handwriting recognition requires GROQ_API_KEY in environment variables.",
              }),
              { status: 500, headers: { "Content-Type": "application/json" } },
            );
          }

          const { imageBase64, mimeType } = parsed.data;
          const transcribedText = await transcribeWithGroqVision(
            apiKey,
            mimeType,
            imageBase64,
            request.signal,
          );

          return new Response(JSON.stringify({ text: transcribedText }), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "no-store",
            },
          });
        } catch (error) {
          console.error("Handwriting OCR error:", error);
          return new Response(
            JSON.stringify({
              error: error instanceof Error ? error.message : "Could not transcribe image.",
            }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }
      },
    },
  },
});
