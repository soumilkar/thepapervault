import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const Input = z.object({ question: z.string().min(1).max(2000) });

export const askCompanion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => Input.parse(d))
  .handler(async ({ data, context }) => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("AI is not configured");

    const { supabase, userId } = context;
    const [diary, blog, profile] = await Promise.all([
      supabase.from("diary_entries").select("title,content,mood,entry_date").order("entry_date", { ascending: false }).limit(50),
      supabase.from("blog_posts").select("title,content,tags,created_at").order("created_at", { ascending: false }).limit(30),
      supabase.from("profiles").select("display_name,bio").eq("id", userId).maybeSingle(),
    ]);

    const name = profile.data?.display_name || "the writer";
    const diaryText = (diary.data ?? []).map((d) =>
      `[${d.entry_date}${d.mood ? ` · ${d.mood}` : ""}] ${d.title || "Untitled"}\n${d.content}`
    ).join("\n\n---\n\n") || "(no diary entries)";
    const blogText = (blog.data ?? []).map((b) =>
      `# ${b.title}${b.tags?.length ? ` (${b.tags.join(", ")})` : ""}\n${b.content}`
    ).join("\n\n---\n\n") || "(no blog posts)";

    const system = `You are Inkwell, a warm, thoughtful AI companion for ${name}. You have read all of their private diary entries and blog posts (shown below). Answer questions about their life, thoughts, patterns and feelings with care. When fitting, offer gentle reflections, observations about recurring themes or moods, and journaling prompts. Be kind, specific, and grounded only in what they've actually written. If something isn't in the writings, say so.

=== DIARY ENTRIES ===
${diaryText}

=== BLOG POSTS ===
${blogText}`;

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
