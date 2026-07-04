import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

// Estimate a 1–5 mood/sentiment score for a batch of decrypted entry snippets.
// Runs on the server using Gemini; the client sends already-decrypted text
// for the current request only (nothing is stored server-side beyond the score).
const Item = z.object({
  id: z.string().min(1).max(64),
  text: z.string().min(1).max(4000),
});

const Input = z.object({
  items: z.array(Item).min(1).max(20),
});

export const estimateMoodScores = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => Input.parse(d))
  .handler(async ({ data }) => {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("AI is not configured");

    const model = "gemini-2.5-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

    const numbered = data.items
      .map(
        (it, i) =>
          `#${i + 1} (id=${it.id})\n${it.text.slice(0, 2000).replace(/\s+/g, " ").trim()}`
      )
      .join("\n\n---\n\n");

    const system = `You read short journal excerpts and rate the writer's emotional state on a 1–5 scale:
1 = very negative / hard (despair, hopelessness)
2 = negative (anxious, sad, stressed)
3 = neutral (flat, mixed, ordinary)
4 = positive (calm, content, hopeful)
5 = very positive (joyful, grateful, elated)
Return ONLY valid JSON in the exact shape:
{"scores":[{"id":"<id>","score":<1-5 integer>}, ...]}
No prose, no code fences.`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [
          {
            role: "user",
            parts: [{ text: `Rate these entries:\n\n${numbered}` }],
          },
        ],
        generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini error ${res.status}: ${errText.slice(0, 300)}`);
    }

    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const raw = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";

    let parsed: { scores?: { id?: string; score?: number }[] } = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) {
        try { parsed = JSON.parse(m[0]); } catch { /* ignore */ }
      }
    }

    const out: { id: string; score: number }[] = [];
    for (const s of parsed.scores ?? []) {
      if (!s?.id || typeof s.score !== "number") continue;
      const clamped = Math.max(1, Math.min(5, Math.round(s.score)));
      out.push({ id: s.id, score: clamped });
    }
    return { scores: out };
  });
