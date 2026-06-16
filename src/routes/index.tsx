import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { BookOpen, Image as ImageIcon, PenLine, Sparkles } from "lucide-react";

export const Route = createFileRoute("/")({
  ssr: false,
  beforeLoad: async () => {
    const { data } = await supabase.auth.getUser();
    if (data.user) throw redirect({ to: "/app" });
  },
  head: () => ({
    meta: [
      { title: "The PaperVault — Your warm personal journal" },
      { name: "description", content: "A private home for diaries, blogs, a personal gallery, and an AI companion that knows your story." },
    ],
  }),
  component: Landing,
});

function Landing() {
  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <div className="flex items-center gap-2">
          <span className="font-serif text-2xl text-primary">Inkwell</span>
          <span className="font-hand text-sepia text-lg">·your story</span>
        </div>
        <Link to="/auth" className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90">
          Sign in
        </Link>
      </header>

      <section className="mx-auto max-w-3xl px-6 pt-16 pb-12 text-center">
        <p className="font-hand text-2xl text-sepia">welcome to your quiet corner</p>
        <h1 className="mt-3 font-serif text-6xl leading-tight text-primary md:text-7xl">
          A warm home for<br />the things you write.
        </h1>
        <p className="mx-auto mt-6 max-w-xl text-lg text-muted-foreground">
          Private diary entries, thoughtful blogs, and a gallery of memories — all in one
          place, with an AI companion that gently reflects on your story.
        </p>
        <div className="mt-8 flex justify-center gap-3">
          <Link to="/auth" className="rounded-md bg-primary px-6 py-3 text-primary-foreground shadow-sm hover:opacity-90">
            Start your journal
          </Link>
        </div>
      </section>

      <section className="mx-auto grid max-w-5xl gap-4 px-6 pb-20 md:grid-cols-4">
        {[
          { icon: PenLine, title: "Diary", body: "Daily entries with mood and date." },
          { icon: BookOpen, title: "Blog", body: "Longer writing, polished and tagged." },
          { icon: ImageIcon, title: "Gallery", body: "Upload photos that matter." },
          { icon: Sparkles, title: "Companion", body: "Reflects on everything you've written." },
        ].map(({ icon: Icon, title, body }) => (
          <div key={title} className="paper-card p-6">
            <Icon className="size-5 text-accent" />
            <h3 className="mt-3 font-serif text-xl text-primary">{title}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{body}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
