import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const Input = z.object({
  imageDataUrl: z.string().regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/).max(7_000_000),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
});

export const transcribeHandwriting = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => Input.parse(d))
  .handler(async ({ data }) => {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("AI is not configured");

    const base64 = data.imageDataUrl.split(",", 2)[1];
    const model = "gemini-2.5-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{
            text: `You are a precise handwriting transcription assistant. Transcribe only the words visible in the image. Preserve the writer's wording, punctuation, spelling, paragraph breaks, and line breaks as closely as possible. Do not summarize, correct, interpret, or add anything. If a word cannot be read confidently, write [illegible] rather than guessing. If the image contains no handwriting, return an empty response. Return only the transcription text, with no introduction or code fences.`,
          }],
        },
        contents: [{
          role: "user",
          parts: [
            { text: "Transcribe this handwritten diary page exactly." },
            { inlineData: { mimeType: data.mimeType, data: base64 } },
          ],
        }],
        generationConfig: { temperature: 0 },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Handwriting conversion failed (${res.status}): ${errText.slice(0, 300)}`);
    }

    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = json.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim() ?? "";
    return { text };
  });