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
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("AI is not configured");

    const system = `You are Inkwell, a warm, thoughtful AI companion for ${data.name}. They have decrypted their private diary entries and blog posts in their browser and shared them with you for this single answer. Reflect with care, point out recurring themes or moods, and offer gentle journaling prompts when fitting. Stay grounded only in what they've actually written. If something isn't in the writings, say so.

=== WRITINGS ===
${data.context || "(no entries shared)"}`;

    const { createLovableAiGatewayProvider } = await import("@/lib/ai-gateway.server");
    const { generateText } = await import("ai");
    const gateway = createLovableAiGatewayProvider(key);

    const result = await generateText({
      model: gateway("google/gemini-3-flash-preview"),
      messages: [
        { role: "system", content: system },
        { role: "user", content: data.question },
      ],
    });

    return { answer: result.text };
  });
