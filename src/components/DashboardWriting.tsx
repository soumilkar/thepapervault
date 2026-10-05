import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, ArrowUpRight } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { decryptText } from "@/lib/crypto";
import { useVault } from "@/lib/vault";
import { useBrowserDraft } from "@/lib/browser-drafts";
import { DiaryText } from "@/components/DiaryText";
import { Button } from "@/components/ui/button";
export function DashboardWriting({ userId }: { userId: string }) {
  const { key } = useVault();
  const qc = useQueryClient();
  const [text, setText, clearDraft] = useBrowserDraft(`papervault:quick-note-draft:${userId}`, "");
  const [expanded, setExpanded] = useState(false);
  const recent = useQuery({ queryKey: ["recent-diary", userId], enabled: !!key, queryFn: async () => {
    const { data, error } = await supabase.from("diary_entries").select("title,content,iv,entry_date").eq("user_id", userId).order("entry_date", { ascending: false }).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    if (!data.iv) return { title: data.title || "Untitled", content: data.content, date: data.entry_date };
    if (!key) return null;
    const decoded = JSON.parse(await decryptText(key, data.content, data.iv)) as { t?: string; c?: string };
    return { title: decoded.t || "Untitled", content: decoded.c || "", date: data.entry_date };
  } });
  const save = useMutation({ mutationFn: async () => {
    const { error } = await supabase.from("notes").insert({ user_id: userId, title: null, content: text } as never);
    if (error) throw error;
  }, onSuccess: () => { clearDraft(); qc.invalidateQueries({ queryKey: ["notes"] }); toast.success("Note saved"); }, onError: () => toast.error("Could not save your note") });
  return <section className="grid gap-6 md:grid-cols-2">
    <div className="min-w-0 border-t border-border pt-6">
      <div className="flex items-center justify-between gap-3"><h2 className="text-2xl text-foreground">Recent diary</h2><Button asChild variant="ghost" size="icon"><Link to="/app/diary" aria-label="Open diary" title="Open diary"><ArrowUpRight /></Link></Button></div>
      {recent.data ? <><p className="mt-2 text-xs text-muted-foreground">{recent.data.date}</p><h3 className="mt-2 text-lg">{recent.data.title}</h3><DiaryText content={recent.data.content} expanded={expanded} />{recent.data.content.length > 220 && <Button variant="link" className="px-0" onClick={() => setExpanded(v => !v)}>{expanded ? "Show less" : "Read more →"}</Button>}</> : <p className="mt-4 text-sm text-muted-foreground">{recent.isLoading ? "Opening your latest entry…" : "Your next page is waiting."}</p>}
    </div>
    <form className="min-w-0 border-t border-border pt-6" onSubmit={e => { e.preventDefault(); if (text.trim()) save.mutate(); }}>
      <h2 className="text-2xl text-foreground">Quick note</h2><textarea aria-label="Quick note" placeholder="What's on your mind?" value={text} onChange={e => setText(e.target.value)} rows={4} className="mt-4 w-full resize-none rounded-lg border border-input bg-card p-3 text-sm outline-none focus:border-ring" /><div className="mt-3 flex justify-end"><Button disabled={!text.trim() || save.isPending} type="submit"><Plus />{save.isPending ? "Saving…" : "Save note"}</Button></div>
    </form>
  </section>;
}
