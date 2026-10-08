import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, Check, Pencil, Plus, Target, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { AppSelect } from "@/components/AppSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";

type Goal = {
  id: string;
  title: string;
  progress: number;
  deadline: string | null;
  mood: string | null;
};

type GoalDraft = Omit<Goal, "id">;

const moods = ["Hopeful", "Excited", "Focused", "Calm", "Uncertain", "Challenged"];
const blankDraft: GoalDraft = { title: "", progress: 0, deadline: null, mood: null };

export function GoalsWidget({ userId }: { userId: string }) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<GoalDraft>(blankDraft);
  const [editing, setEditing] = useState<Goal | null>(null);

  const goals = useQuery({
    queryKey: ["life-goals", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("life_goals")
        .select("id,title,progress,deadline,mood")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Goal[];
    },
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["life-goals", userId] });

  const createGoal = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("life_goals").insert({
        user_id: userId,
        title: draft.title.trim(),
        progress: draft.progress,
        deadline: draft.deadline || null,
        mood: draft.mood,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setDraft(blankDraft);
      setAdding(false);
      toast.success("Goal added");
      void refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const saveGoal = useMutation({
    mutationFn: async (goal: Goal) => {
      const { error } = await supabase.from("life_goals").update({
        title: goal.title.trim(),
        progress: goal.progress,
        deadline: goal.deadline || null,
        mood: goal.mood,
      }).eq("id", goal.id).eq("user_id", userId);
      if (error) throw error;
    },
    onSuccess: () => {
      setEditing(null);
      toast.success("Goal updated");
      void refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const deleteGoal = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("life_goals").delete().eq("id", id).eq("user_id", userId);
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Goal removed"); void refresh(); },
    onError: (error: Error) => toast.error(error.message),
  });

  const moodOptions = [
    { value: "__none__", label: "Choose a mood" },
    ...moods.map((mood) => ({ value: mood, label: mood })),
  ];

  return (
    <section className="space-y-4" aria-labelledby="goals-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-hand text-2xl text-sepia">one step at a time</p>
          <h2 id="goals-heading" className="font-serif text-3xl text-primary">Life goals</h2>
        </div>
        {!adding && (
          <Button variant="outline" onClick={() => setAdding(true)}>
            <Plus /> Add a goal
          </Button>
        )}
      </div>

      {adding && (
        <form
          className="paper-card space-y-4 p-5"
          onSubmit={(event) => { event.preventDefault(); if (draft.title.trim()) createGoal.mutate(); }}
        >
          <Input autoFocus required maxLength={160} value={draft.title} placeholder="What would you like to work toward?"
            onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} />
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-2 text-sm text-muted-foreground">
              <span>Deadline</span>
              <Input type="date" value={draft.deadline ?? ""}
                onChange={(event) => setDraft((current) => ({ ...current, deadline: event.target.value || null }))} />
            </label>
            <label className="space-y-2 text-sm text-muted-foreground">
              <span>How does this goal feel?</span>
              <AppSelect value={draft.mood ?? "__none__"}
                onValueChange={(value) => setDraft((current) => ({ ...current, mood: value === "__none__" ? null : value }))}
                options={moodOptions} triggerClassName="w-full" />
            </label>
          </div>
          <ProgressEditor value={draft.progress} onChange={(progress) => setDraft((current) => ({ ...current, progress }))} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => { setAdding(false); setDraft(blankDraft); }}><X /> Cancel</Button>
            <Button type="submit" disabled={!draft.title.trim() || createGoal.isPending}><Plus /> Add goal</Button>
          </div>
        </form>
      )}

      {goals.isLoading ? (
        <p className="text-sm text-muted-foreground">Gathering your goals…</p>
      ) : goals.isError ? (
        <p className="text-sm text-destructive">Your goals could not be loaded. Please try again.</p>
      ) : goals.data?.length ? (
        <div className="grid gap-3 md:grid-cols-2">
          {goals.data.map((goal) => editing?.id === goal.id ? (
            <article key={goal.id} className="paper-card space-y-4 p-5">
              <Input autoFocus maxLength={160} value={editing.title}
                onChange={(event) => setEditing((current) => current ? { ...current, title: event.target.value } : current)} />
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="space-y-2 text-sm text-muted-foreground">
                  <span>Deadline</span>
                  <Input type="date" value={editing.deadline ?? ""}
                    onChange={(event) => setEditing((current) => current ? { ...current, deadline: event.target.value || null } : current)} />
                </label>
                <label className="space-y-2 text-sm text-muted-foreground">
                  <span>Mood</span>
                  <AppSelect value={editing.mood ?? "__none__"}
                    onValueChange={(value) => setEditing((current) => current ? { ...current, mood: value === "__none__" ? null : value } : current)}
                    options={moodOptions} triggerClassName="w-full" />
                </label>
              </div>
              <ProgressEditor value={editing.progress}
                onChange={(progress) => setEditing((current) => current ? { ...current, progress } : current)} />
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={() => setEditing(null)}><X /> Cancel</Button>
                <Button type="button" disabled={!editing.title.trim() || saveGoal.isPending} onClick={() => saveGoal.mutate(editing)}><Check /> Save</Button>
              </div>
            </article>
          ) : (
            <article key={goal.id} className="paper-card min-w-0 space-y-4 p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="break-words font-serif text-xl text-primary">{goal.title}</h3>
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                    {goal.deadline && <span className="inline-flex items-center gap-1.5"><CalendarDays className="size-4" />{formatDeadline(goal.deadline)}</span>}
                    {goal.mood && <span className="inline-flex items-center gap-1.5"><span aria-hidden="true">•</span>{goal.mood}</span>}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button variant="ghost" size="icon" aria-label={`Edit ${goal.title}`} title="Edit goal" onClick={() => setEditing(goal)}><Pencil /></Button>
                  <Button variant="ghost" size="icon" aria-label={`Delete ${goal.title}`} title="Delete goal" disabled={deleteGoal.isPending} onClick={() => deleteGoal.mutate(goal.id)}><Trash2 /></Button>
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex justify-between text-sm"><span className="text-muted-foreground">Progress</span><span className="font-medium text-primary">{goal.progress}%</span></div>
                <Progress value={goal.progress} aria-label={`${goal.progress}% complete`} />
              </div>
            </article>
          ))}
        </div>
      ) : !adding ? (
        <div className="flex flex-col items-center gap-2 border-y border-border py-8 text-center">
          <Target className="size-7 text-accent" />
          <p className="font-serif text-xl text-primary">Make room for what matters.</p>
          <p className="text-sm text-muted-foreground">Add a goal to keep track of your next steps.</p>
        </div>
      ) : null}
    </section>
  );
}

function ProgressEditor({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return (
    <label className="block space-y-2 text-sm text-muted-foreground">
      <span className="flex justify-between"><span>Progress</span><span className="font-medium text-primary">{value}%</span></span>
      <input aria-label="Goal progress" type="range" min={0} max={100} step={5} value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-2 w-full cursor-pointer accent-primary" />
    </label>
  );
}

function formatDeadline(date: string) {
  return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })
    .format(new Date(`${date}T00:00:00Z`));
}