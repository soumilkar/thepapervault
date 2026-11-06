import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";
import {
  CompanionKeyMismatchError,
  decryptCompanionRequest,
  encryptStreamChunk,
  type EncryptedCompanionEnvelope,
} from "@/lib/companion-transport";

const ALLOWED_MIMES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

const InputSchema = z.object({
  imageBase64: z
    .string()
    .min(10)
    .max(15_000_000)
    .regex(/^[A-Za-z0-9+/=\r\n]+$/, "Invalid base64 image data"),
  mimeType: z.enum(ALLOWED_MIMES),
});

const EnvelopeSchema = z.object({
  v: z.literal(2),
  kid: z.string().min(8).max(64),
  epk: z.string().min(40).max(200),
  ts: z.number(),
  salt: z.string().min(8).max(128),
  iv: z.string().min(8).max(64),
  ct: z.string().min(16).max(22_000_000),
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

const MAX_OCR_TOKENS = 500;
const verifiedOcrTokenCache = new Map<string, number>();

const MAX_OCR_NONCES = 500;
const usedOcrNonces = new Map<string, number>();

function checkAndRecordOcrNonce(nonceKey: string): boolean {
  const now = Date.now();
  if (usedOcrNonces.has(nonceKey)) {
    const exp = usedOcrNonces.get(nonceKey)!;
    if (exp > now) return false;
  }
  if (usedOcrNonces.size >= MAX_OCR_NONCES) {
    for (const [k, exp] of usedOcrNonces) {
      if (exp <= now || usedOcrNonces.size >= MAX_OCR_NONCES) {
        usedOcrNonces.delete(k);
      }
    }
  }
  usedOcrNonces.set(nonceKey, now + 6 * 60 * 1000);
  return true;
}

function cacheVerifiedOcrToken(token: string, expiresAt: number) {
  if (verifiedOcrTokenCache.size >= MAX_OCR_TOKENS) {
    const now = Date.now();
    for (const [k, exp] of verifiedOcrTokenCache) {
      if (exp <= now || verifiedOcrTokenCache.size >= MAX_OCR_TOKENS) {
        verifiedOcrTokenCache.delete(k);
      }
    }
  }
  verifiedOcrTokenCache.set(token, expiresAt);
}

async function authenticateAndExtractToken(request: Request): Promise<string | null> {
  const authorization =
    request.headers.get("authorization") || request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return null;

  const token = authorization.slice("Bearer ".length).trim();
  if (!token) return null;

  const now = Date.now();
  const cachedExp = verifiedOcrTokenCache.get(token);
  if (cachedExp && cachedExp > now) {
    return token;
  }

  const url =
    readRuntimeEnv("SUPABASE_URL", request) ||
    readRuntimeEnv("VITE_SUPABASE_URL", request) ||
    (typeof process !== "undefined" ? process.env.SUPABASE_URL : "") ||
    import.meta.env.VITE_SUPABASE_URL;
  const key =
    readRuntimeEnv("SUPABASE_PUBLISHABLE_KEY", request) ||
    readRuntimeEnv("SUPABASE_ANON_KEY", request) ||
    readRuntimeEnv("VITE_SUPABASE_PUBLISHABLE_KEY", request) ||
    readRuntimeEnv("VITE_SUPABASE_ANON_KEY", request) ||
    (typeof process !== "undefined"
      ? process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY
      : "") ||
    import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    import.meta.env.VITE_SUPABASE_ANON_KEY;

  if (!url || !key) {
    // Fail closed when Supabase configuration is missing
    return null;
  }

  try {
    const client = createClient<Database>(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await client.auth.getClaims(token);
    if (!error && Boolean(data?.claims?.sub)) {
      cacheVerifiedOcrToken(token, now + 5 * 60 * 1000);
      return token;
    }

    const { data: userData, error: userError } = await client.auth.getUser(token);
    if (!userError && Boolean(userData?.user?.id)) {
      cacheVerifiedOcrToken(token, now + 5 * 60 * 1000);
      return token;
    }
    return null;
  } catch {
    return null;
  }
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
  const cleanB64 = base64Data.replace(/\s+/g, "");
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
              image_url: { url: `data:${mimeType};base64,${cleanB64}` },
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

const SECURITY_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store, no-cache, must-revalidate, private",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
};

export const Route = createFileRoute("/api/handwriting-ocr")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const accessToken = await authenticateAndExtractToken(request);
          if (!accessToken) {
            return new Response(
              JSON.stringify({ error: "Please sign in to transcribe handwriting." }),
              {
                status: 401,
                headers: SECURITY_HEADERS,
              },
            );
          }

          const rawBody = await request.json();
          const envelopeCheck = EnvelopeSchema.safeParse(rawBody);
          if (!envelopeCheck.success) {
            return new Response(
              JSON.stringify({ error: "Encrypted image payload envelope required." }),
              {
                status: 400,
                headers: SECURITY_HEADERS,
              },
            );
          }

          const env: EncryptedCompanionEnvelope = envelopeCheck.data;
          let unwrappedPayload: unknown;
          let encryptionCtx: { transportKey: CryptoKey; ts: number };
          try {
            const decrypted = await decryptCompanionRequest(accessToken, env);
            unwrappedPayload = decrypted.payload;
            encryptionCtx = { transportKey: decrypted.transportKey, ts: decrypted.ts };
          } catch (err) {
            if (err instanceof CompanionKeyMismatchError) {
              return new Response(JSON.stringify({ error: "Transport key rotated." }), {
                status: 409,
                headers: {
                  ...SECURITY_HEADERS,
                  "X-Companion-Key-Mismatch": "1",
                },
              });
            }
            return new Response(
              JSON.stringify({ error: "Failed to verify encrypted image payload." }),
              {
                status: 400,
                headers: SECURITY_HEADERS,
              },
            );
          }

          const nonceKey = `${env.epk}:${env.salt}:${env.iv}`;
          if (!checkAndRecordOcrNonce(nonceKey)) {
            return new Response(JSON.stringify({ error: "Replay request rejected." }), {
              status: 400,
              headers: SECURITY_HEADERS,
            });
          }

          const parsed = InputSchema.safeParse(unwrappedPayload);
          if (!parsed.success) {
            return new Response(JSON.stringify({ error: "Invalid image payload." }), {
              status: 400,
              headers: SECURITY_HEADERS,
            });
          }

          const apiKey = getGroqApiKey(request);
          if (!apiKey) {
            return new Response(
              JSON.stringify({
                error: "Handwriting recognition requires GROQ_API_KEY in environment variables.",
              }),
              { status: 500, headers: SECURITY_HEADERS },
            );
          }

          const { imageBase64, mimeType } = parsed.data;
          const transcribedText = await transcribeWithGroqVision(
            apiKey,
            mimeType,
            imageBase64,
            request.signal,
          );

          const encryptedFrame = await encryptStreamChunk(
            encryptionCtx.transportKey,
            encryptionCtx.ts,
            0,
            JSON.stringify({ text: transcribedText }),
          );
          return new Response(JSON.stringify({ encryptedFrame: encryptedFrame.trim() }), {
            status: 200,
            headers: {
              ...SECURITY_HEADERS,
              "X-Companion-Encrypted": "1",
            },
          });
        } catch (error) {
          console.error("Handwriting OCR error:", error);
          return new Response(
            JSON.stringify({
              error: "Could not transcribe image.",
            }),
            { status: 500, headers: SECURITY_HEADERS },
          );
        }
      },
    },
  },
});
