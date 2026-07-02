import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

// With end-to-end encryption, the server can't read diary/blog content from the database.
// The client decrypts entries locally and passes the assembled context here.
const Input = z.object({
  question: z.string().min(1).max(2000),
  context: z.string().max(120_000).default(""),
  name: z.string().max(120).default("the writer"),
});

export const askCompanion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => Input.parse(d))
  .handler(async ({ data }) => {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("AI is not configured");

    const system = `You are Inkwell, a warm, thoughtful AI companion for ${data.name}. They have decrypted their private diary entries and blog posts in their browser and shared them with you for this single answer. Reflect with care, point out recurring themes or moods, and offer gentle journaling prompts when fitting. Stay grounded only in what they've actually written. If something isn't in the writings, say so.

=== WRITINGS ===
${data.context || "(no entries shared)"}`;

    // Call Google Gemini API directly using the user's own free-tier key.
    const model = "gemini-2.5-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: data.question }] }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini error ${res.status}: ${errText.slice(0, 300)}`);
    }

    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const answer =
      json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ??
      "";

    return { answer: answer || "(no response)" };
  });
