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
import { getGroqVisionModels, markGroqModelUnavailable } from "@/lib/groq-models";

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

function getGroqVisionModelOverride(request?: Request): string {
  return (
    readRuntimeEnv("GROQ_OCR_MODEL", request) ||
    readRuntimeEnv("GROQ_VISION_MODEL", request) ||
    readRuntimeEnv("VITE_GROQ_OCR_MODEL", request) ||
    readRuntimeEnv("GROQ_MODEL", request) ||
    (typeof process !== "undefined" &&
    (process.env.GROQ_OCR_MODEL || process.env.GROQ_VISION_MODEL || process.env.GROQ_MODEL)
      ? (
          process.env.GROQ_OCR_MODEL ||
          process.env.GROQ_VISION_MODEL ||
          process.env.GROQ_MODEL ||
          ""
        ).trim()
      : "") ||
    ""
  );
}

const MAX_OCR_TOKENS = 500;
const verifiedOcrTokenCache = new Map<string, { userId: string; expiresAt: number }>();

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

function cacheVerifiedOcrToken(token: string, userId: string, expiresAt: number) {
  if (verifiedOcrTokenCache.size >= MAX_OCR_TOKENS) {
    const now = Date.now();
    for (const [k, val] of verifiedOcrTokenCache) {
      if (val.expiresAt <= now || verifiedOcrTokenCache.size >= MAX_OCR_TOKENS) {
        verifiedOcrTokenCache.delete(k);
      }
    }
  }
  verifiedOcrTokenCache.set(token, { userId, expiresAt });
}

async function authenticateAndExtractToken(
  request: Request,
): Promise<{ token: string; userId: string } | null> {
  const authorization =
    request.headers.get("authorization") || request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return null;

  const token = authorization.slice("Bearer ".length).trim();
  if (!token) return null;

  const now = Date.now();
  const cached = verifiedOcrTokenCache.get(token);
  if (cached && cached.expiresAt > now) {
    return { token, userId: cached.userId };
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
    const claimSub = typeof data?.claims?.sub === "string" ? data.claims.sub : "";
    if (!error && claimSub) {
      cacheVerifiedOcrToken(token, claimSub, now + 5 * 60 * 1000);
      return { token, userId: claimSub };
    }

    const { data: userData, error: userError } = await client.auth.getUser(token);
    const uid = userData?.user?.id || "";
    if (!userError && uid) {
      cacheVerifiedOcrToken(token, uid, now + 5 * 60 * 1000);
      return { token, userId: uid };
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
  modelOverride?: string,
): Promise<string> {
  const candidateModels = await getGroqVisionModels(apiKey, modelOverride);
  let lastErr = "Groq vision OCR failed";
  const cleanB64 = base64Data.replace(/\s+/g, "");
  for (const model of candidateModels) {
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
    if (res.status === 404 || res.status === 400) {
      markGroqModelUnavailable(model);
    }
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

const OCR_RATE_WINDOW_MS = 60_000;
const OCR_RATE_MAX_REQUESTS = 20;
const ocrRateBuckets = new Map<string, { count: number; resetAt: number }>();

function checkOcrRateLimit(userId: string): boolean {
  const now = Date.now();
  if (ocrRateBuckets.size > 1000) {
    for (const [k, v] of ocrRateBuckets) {
      if (v.resetAt <= now) ocrRateBuckets.delete(k);
    }
  }
  const existing = ocrRateBuckets.get(userId);
  if (!existing || existing.resetAt <= now) {
    ocrRateBuckets.set(userId, { count: 1, resetAt: now + OCR_RATE_WINDOW_MS });
    return true;
  }
  existing.count += 1;
  return existing.count <= OCR_RATE_MAX_REQUESTS;
}

const MAX_OCR_BODY_BYTES = 18 * 1024 * 1024;

export const Route = createFileRoute("/api/handwriting-ocr")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const auth = await authenticateAndExtractToken(request);
          if (!auth) {
            return new Response(
              JSON.stringify({ error: "Please sign in to transcribe handwriting." }),
              {
                status: 401,
                headers: SECURITY_HEADERS,
              },
            );
          }

          if (!checkOcrRateLimit(auth.userId)) {
            return new Response(
              JSON.stringify({
                error: "Too many handwriting scan requests. Please wait a moment.",
              }),
              {
                status: 429,
                headers: {
                  ...SECURITY_HEADERS,
                  "Retry-After": "15",
                },
              },
            );
          }

          const rawBodyText = await request.text();
          if (rawBodyText.length > MAX_OCR_BODY_BYTES) {
            return new Response(JSON.stringify({ error: "Image payload exceeds safety limit." }), {
              status: 413,
              headers: SECURITY_HEADERS,
            });
          }
          const rawBody = JSON.parse(rawBodyText) as unknown;
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
            const decrypted = await decryptCompanionRequest(auth.token, env);
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

          const nonceKey = `${auth.userId}:${env.epk}:${env.salt}:${env.iv}`;
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
          const modelOverride = getGroqVisionModelOverride(request);
          const transcribedText = await transcribeWithGroqVision(
            apiKey,
            mimeType,
            imageBase64,
            request.signal,
            modelOverride,
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
        } catch {
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
