// Dynamic Groq Model Auto-Discovery & Self-Healing Fallback Engine (/v1/models).
// Queries Groq's live model catalog (cached in memory for 1 hour), filters out deprecated
// or non-chat models (whisper, tts, guard, embeddings), and dynamically ranks active Chat and Vision models
// so PaperVault continues working even years in the future if every current model ID is retired.

export const DEFAULT_CHAT_MODELS = [
  "qwen/qwen3.8-27b",
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "llama-3.3-70b-versatile",
  "qwen/qwen3-32b",
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "llama-3.1-8b-instant",
] as const;

export const DEFAULT_VISION_MODELS = [
  "qwen/qwen3.8-27b",
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "meta-llama/llama-4-maverick-17b-128e-instruct",
] as const;

interface GroqCatalogModel {
  id: string;
  active?: boolean;
  context_window?: number;
}

interface GroqModelsResponse {
  data?: GroqCatalogModel[];
}

const CATALOG_TTL_MS = 60 * 60 * 1000; // 1 hour cache
let cachedCatalogIds: Set<string> | null = null;
let cachedCatalogRaw: GroqCatalogModel[] = [];
let catalogExpiresAt = 0;
let catalogFetchPromise: Promise<GroqCatalogModel[] | null> | null = null;

// Models that returned 404 / model_decommissioned during runtime
const deprecatedModels = new Map<string, number>();
const DEPRECATED_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export function markGroqModelUnavailable(modelId: string) {
  deprecatedModels.set(modelId, Date.now() + DEPRECATED_TTL_MS);
}

function isModelMarkedDeprecated(modelId: string): boolean {
  const exp = deprecatedModels.get(modelId);
  if (!exp) return false;
  if (Date.now() > exp) {
    deprecatedModels.delete(modelId);
    return false;
  }
  return true;
}

function isNonChatModel(id: string): boolean {
  const lower = id.toLowerCase();
  return (
    lower.includes("whisper") ||
    lower.includes("tts") ||
    lower.includes("playai") ||
    lower.includes("orpheus") ||
    lower.includes("guard") ||
    lower.includes("safeguard") ||
    lower.includes("prompt-guard") ||
    lower.includes("embed") ||
    lower.includes("rerank") ||
    lower.includes("distil-whisper")
  );
}

function scoreChatModel(model: GroqCatalogModel): number {
  const id = model.id.toLowerCase();
  let score = 0;

  // Prefer flagship model families
  if (id.includes("llama-4") || id.includes("llama-5") || id.includes("llama-6")) score += 45;
  else if (id.includes("llama-3.3") || id.includes("llama-3.2") || id.includes("llama-3.1"))
    score += 40;
  else if (id.includes("qwen")) score += 42;
  else if (id.includes("gpt-oss")) score += 42;
  else if (id.includes("deepseek")) score += 35;
  else if (id.includes("gemma")) score += 28;
  else if (id.includes("mixtral") || id.includes("mistral")) score += 25;

  // Prefer larger parameter sizes for rich empathetic conversation
  if (id.includes("120b") || id.includes("90b") || id.includes("72b") || id.includes("70b"))
    score += 30;
  else if (id.includes("32b") || id.includes("27b") || id.includes("20b") || id.includes("17b"))
    score += 22;
  else if (id.includes("14b") || id.includes("12b") || id.includes("9b") || id.includes("8b"))
    score += 12;

  if (id.includes("versatile") || id.includes("instruct")) score += 10;
  if ((model.context_window ?? 0) >= 32768) score += 8;

  return score;
}

function isLikelyVisionModel(id: string): boolean {
  const lower = id.toLowerCase();
  if (isNonChatModel(lower)) return false;
  return (
    lower.includes("vision") ||
    lower.includes("-vl") ||
    lower.includes("scout") ||
    lower.includes("maverick") ||
    lower.includes("qwen3.8") ||
    lower.includes("qwen4") ||
    lower.includes("llama-4") ||
    lower.includes("llama-5") ||
    lower.includes("pixtral") ||
    lower.includes("llava") ||
    lower.includes("omni") ||
    lower.includes("multimodal")
  );
}

async function fetchLiveGroqCatalog(apiKey: string): Promise<GroqCatalogModel[] | null> {
  const now = Date.now();
  if (cachedCatalogIds && now < catalogExpiresAt) {
    return cachedCatalogRaw;
  }
  if (catalogFetchPromise) {
    return catalogFetchPromise;
  }

  catalogFetchPromise = (async () => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3500);
      try {
        const res = await fetch("https://api.groq.com/openai/v1/models", {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          signal: controller.signal,
        });
        if (!res.ok) return null;
        const json = (await res.json()) as GroqModelsResponse;
        if (!Array.isArray(json?.data) || json.data.length === 0) return null;

        const activeModels = json.data.filter(
          (m) => typeof m?.id === "string" && m.id.trim().length > 0 && m.active !== false,
        );
        if (activeModels.length === 0) return null;

        cachedCatalogRaw = activeModels;
        cachedCatalogIds = new Set(activeModels.map((m) => m.id));
        catalogExpiresAt = Date.now() + CATALOG_TTL_MS;
        return activeModels;
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      return null;
    } finally {
      catalogFetchPromise = null;
    }
  })();

  return catalogFetchPromise;
}

/**
 * Returns an ordered, deduplicated list of Groq chat models to try:
 * 1. Optional `envOverride` (`GROQ_MODEL`) if configured.
 * 2. Known preferred models (`DEFAULT_CHAT_MODELS`) that are currently active in `/v1/models`.
 * 3. Any newly released active chat models discovered in `/v1/models` (ranked by capability).
 * 4. Fallback to `DEFAULT_CHAT_MODELS` if `/v1/models` was unreachable.
 */
export async function getGroqChatModels(apiKey: string, envOverride?: string): Promise<string[]> {
  const result: string[] = [];
  const pushUnique = (id?: string) => {
    const clean = id?.trim();
    if (!clean || isModelMarkedDeprecated(clean)) return;
    if (!result.includes(clean)) result.push(clean);
  };

  if (envOverride) {
    for (const part of envOverride.split(",")) {
      pushUnique(part);
    }
  }

  const catalog = await fetchLiveGroqCatalog(apiKey);
  if (catalog && cachedCatalogIds) {
    // 1. Preferred curated models that are still active on Groq
    for (const preferred of DEFAULT_CHAT_MODELS) {
      if (cachedCatalogIds.has(preferred)) {
        pushUnique(preferred);
      }
    }

    // 2. Dynamically discovered active chat models from /v1/models sorted by capability
    const discovered = catalog
      .filter((m) => !isNonChatModel(m.id))
      .sort((a, b) => scoreChatModel(b) - scoreChatModel(a));

    for (const m of discovered) {
      pushUnique(m.id);
    }
  }

  // 3. Always keep the hardcoded fallback chain at the end in case /v1/models was unreachable
  for (const fallback of DEFAULT_CHAT_MODELS) {
    pushUnique(fallback);
  }

  return result.length > 0 ? result : [...DEFAULT_CHAT_MODELS];
}

/**
 * Returns an ordered, deduplicated list of Groq vision/OCR models to try:
 * 1. Optional `envOverride` (`GROQ_OCR_MODEL` or `GROQ_VISION_MODEL`) if configured.
 * 2. Known preferred vision models (`DEFAULT_VISION_MODELS`) confirmed active in `/v1/models`.
 * 3. Any newly released vision/multimodal models discovered in `/v1/models`.
 * 4. Fallback to `DEFAULT_VISION_MODELS` if `/v1/models` was unreachable.
 */
export async function getGroqVisionModels(apiKey: string, envOverride?: string): Promise<string[]> {
  const result: string[] = [];
  const pushUnique = (id?: string) => {
    const clean = id?.trim();
    if (!clean || isModelMarkedDeprecated(clean)) return;
    if (!result.includes(clean)) result.push(clean);
  };

  if (envOverride) {
    for (const part of envOverride.split(",")) {
      pushUnique(part);
    }
  }

  const catalog = await fetchLiveGroqCatalog(apiKey);
  if (catalog && cachedCatalogIds) {
    // 1. Preferred vision models that are confirmed active in Groq's live catalog
    for (const preferred of DEFAULT_VISION_MODELS) {
      if (cachedCatalogIds.has(preferred)) {
        pushUnique(preferred);
      }
    }

    // 2. Dynamically discovered vision-capable models from /v1/models
    const discoveredVision = catalog
      .filter((m) => isLikelyVisionModel(m.id))
      .sort((a, b) => scoreChatModel(b) - scoreChatModel(a));

    for (const m of discoveredVision) {
      pushUnique(m.id);
    }
  }

  // 3. Fallback chain
  for (const fallback of DEFAULT_VISION_MODELS) {
    pushUnique(fallback);
  }

  return result.length > 0 ? result : [...DEFAULT_VISION_MODELS];
}
