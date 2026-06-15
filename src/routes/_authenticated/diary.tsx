import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";

export const Route = createFileRoute("/_authenticated/diary")({
  component: DiaryPage,
});

function DiaryPage() {
  const { user } = Route.useRouteContext();
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [mood, setMood] = useState("");

  const entries = useQuery({
    queryKey: ["diary", user.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("diary_entries").select("*")
        .order("entry_date", { ascending: false }).order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("diary_entries").insert({
        user_id: user.id, title: title || null, content, mood: mood || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setTitle(""); setContent(""); setMood("");
      toast.success("Entry saved");
      qc.invalidateQueries({ queryKey: ["diary"] });
      qc.invalidateQueries({ queryKey: ["dashboard-counts"] });
      qc.invalidateQueries({ queryKey: ["recent-diary"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("diary_entries").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["diary"] }),
  });

  return (
    <div className="space-y-8">
      <div>
        <p className="font-hand text-2xl text-sepia">today's page</p>
        <h1 className="font-serif text-4xl text-primary">Diary</h1>
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); if (content.trim()) create.mutate(); }}
        className="paper-card space-y-3 p-6"
      >
        <input
          value={title} onChange={(e) => setTitle(e.target.value)}
          placeholder="Title (optional)"
          className="w-full bg-transparent font-serif text-2xl outline-none placeholder:text-muted-foreground/60"
        />
        <input
          value={mood} onChange={(e) => setMood(e.target.value)}
          placeholder="How are you feeling? (e.g. peaceful, anxious, joyful)"
          className="w-full bg-transparent text-sm text-accent outline-none placeholder:text-muted-foreground/60"
        />
        <textarea
          value={content} onChange={(e) => setContent(e.target.value)}
          placeholder="Pour it out..."
          rows={6}
          className="w-full resize-none bg-transparent leading-relaxed outline-none placeholder:text-muted-foreground/60"
        />
        <div className="flex justify-end">
          <button
            type="submit" disabled={!content.trim() || create.isPending}
            className="rounded-md bg-primary px-5 py-2 text-sm text-primary-foreground disabled:opacity-50"
          >
            {create.isPending ? "Saving..." : "Save entry"}
          </button>
        </div>
      </form>

      <div className="space-y-4">
        {entries.data?.length === 0 && <p className="text-muted-foreground">Your diary is a blank page. Start above.</p>}
        {entries.data?.map((e) => (
          <article key={e.id} className="paper-card p-6">
            <header className="flex items-baseline justify-between">
              <h3 className="font-serif text-xl text-primary">{e.title || "Untitled"}</h3>
              <div className="flex items-center gap-3">
                <span className="font-hand text-sepia">{new Date(e.entry_date).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}</span>
                <button onClick={() => remove.mutate(e.id)} className="text-muted-foreground hover:text-destructive">
                  <Trash2 className="size-4" />
                </button>
              </div>
            </header>
            {e.mood && <p className="mt-1 text-sm text-accent">Feeling: {e.mood}</p>}
            <p className="mt-3 whitespace-pre-wrap leading-relaxed">{e.content}</p>
          </article>
        ))}
      </div>
    </div>
  );
}
