// Shared Gemini caller with automatic model fallback.
// Tries each model in order; moves to the next on any API error
// (unavailable model, quota/429, overload 5xx, etc.).

export const GEMINI_MODEL_FALLBACKS = [
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
] as const;

export type GeminiResponse = {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
};

export async function callGeminiWithFallback(
  apiKey: string,
  body: Record<string, unknown>,
): Promise<{ json: GeminiResponse; model: string }> {
  const errors: string[] = [];

  for (const model of GEMINI_MODEL_FALLBACKS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errText = await res.text();
        errors.push(`${model}: ${res.status} ${errText.slice(0, 200)}`);
        continue;
      }
      const json = (await res.json()) as GeminiResponse;
      return { json, model };
    } catch (e) {
      errors.push(`${model}: ${e instanceof Error ? e.message : "network error"}`);
    }
  }

  throw new Error(`All AI models unavailable. ${errors.join(" | ")}`.slice(0, 600));
}
