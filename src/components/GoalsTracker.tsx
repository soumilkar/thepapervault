import { memo, useMemo, useState } from "react";
import { CheckCircle2, Circle, Plus, Target, Trash2 } from "lucide-react";
import { AppSelect } from "@/components/AppSelect";
import { useVaultTrackers, type GoalHorizon, type GoalItem } from "@/lib/vault-trackers";

const HORIZON_LABELS: Record<GoalHorizon, string> = {
  daily: "Daily",
  weekly: "This week",
  monthly: "This month",
  "long-term": "Long-term",
};

export const GoalsTracker = memo(function GoalsTracker({ userId }: { userId: string }) {
  const { data, isLoading, updateTrackers } = useVaultTrackers(userId);
  const [title, setTitle] = useState("");
  const [horizon, setHorizon] = useState<GoalHorizon>("weekly");
  const [filter, setFilter] = useState<"active" | "completed" | "all">("active");

  const goals = data.goals ?? [];

  const stats = useMemo(() => {
    const total = goals.length;
    const completed = goals.filter((g) => g.completed).length;
    const active = total - completed;
    return { total, completed, active };
  }, [goals]);

  const filteredGoals = useMemo(() => {
    return goals
      .filter((g) => {
        if (filter === "active") return !g.completed;
        if (filter === "completed") return g.completed;
        return true;
      })
      .sort((a, b) => {
        if (a.completed !== b.completed) return a.completed ? 1 : -1;
        return b.created_at.localeCompare(a.created_at);
      });
  }, [goals, filter]);

  const addGoal = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = title.trim();
    if (!clean) return;
    const newGoal: GoalItem = {
      id: crypto.randomUUID(),
      title: clean,
      horizon,
      progress: 0,
      completed: false,
      created_at: new Date().toISOString(),
    };
    updateTrackers((prev) => ({
      ...prev,
      goals: [newGoal, ...(prev.goals ?? [])],
    }));
    setTitle("");
  };

  const toggleGoal = (id: string) => {
    updateTrackers((prev) => ({
      ...prev,
      goals: prev.goals.map((g) =>
        g.id === id
          ? {
              ...g,
              completed: !g.completed,
              progress: !g.completed ? 100 : g.progress === 100 ? 75 : g.progress,
            }
          : g,
      ),
    }));
  };

  const stepProgress = (id: string, delta: number) => {
    updateTrackers((prev) => ({
      ...prev,
      goals: prev.goals.map((g) => {
        if (g.id !== id) return g;
        const nextProgress = Math.max(0, Math.min(100, g.progress + delta));
        return {
          ...g,
          progress: nextProgress,
          completed: nextProgress === 100,
        };
      }),
    }));
  };

  const removeGoal = (id: string) => {
    updateTrackers((prev) => ({
      ...prev,
      goals: prev.goals.filter((g) => g.id !== id),
    }));
  };

  return (
    <div className="paper-card flex h-full flex-col justify-between p-5 overflow-hidden">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-accent">
            <Target className="size-5" />
            <div>
              <h3 className="font-serif text-xl text-primary">Goals tracker</h3>
              <p className="text-xs text-muted-foreground">
                {stats.active} active · {stats.completed} completed
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1 rounded-md border border-border bg-secondary/40 p-0.5 text-xs">
            {(["active", "completed", "all"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setFilter(tab)}
                className={`rounded px-2.5 py-1 capitalize transition ${
                  filter === tab
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-primary"
                }`}
              >
                {tab}
              </button>
            ))}
          </div>
        </div>

        <form onSubmit={addGoal} className="flex flex-wrap items-center gap-2 rounded-lg bg-secondary/35 p-3">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Add a goal..."
            className="min-w-0 flex-1 rounded-md border border-input bg-card px-2.5 py-1.5 text-xs outline-none focus:border-ring"
          />
          <AppSelect
            value={horizon}
            onValueChange={(v) => setHorizon(v as GoalHorizon)}
            triggerClassName="h-8 text-xs"
            options={[
              { value: "daily", label: "Daily" },
              { value: "weekly", label: "This week" },
              { value: "monthly", label: "This month" },
              { value: "long-term", label: "Long-term" },
            ]}
          />
          <button
            type="submit"
            disabled={!title.trim()}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            <Plus className="size-3.5" /> Add
          </button>
        </form>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">loading goals...</p>
        ) : filteredGoals.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {goals.length === 0
              ? "No goals yet. Add an intention above to start tracking."
              : `No ${filter} goals right now.`}
          </p>
        ) : (
          <ul className="max-h-72 space-y-2 overflow-y-auto pr-1">
            {filteredGoals.map((g) => (
              <li
                key={g.id}
                className="rounded-lg border border-border/70 bg-secondary/25 p-3 transition hover:bg-secondary/40"
              >
                <div className="flex items-start justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => toggleGoal(g.id)}
                    className="flex min-w-0 flex-1 items-start gap-2 text-left"
                  >
                    {g.completed ? (
                      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />
                    ) : (
                      <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p
                        className={`break-words text-sm font-medium ${
                          g.completed ? "line-through text-muted-foreground" : "text-primary"
                        }`}
                      >
                        {g.title}
                      </p>
                      <span className="inline-block rounded-full bg-secondary px-2 py-0.5 text-[10px] uppercase tracking-wide text-secondary-foreground">
                        {HORIZON_LABELS[g.horizon]}
                      </span>
                    </div>
                  </button>

                  <div className="flex shrink-0 items-center gap-1">
                    {!g.completed && (
                      <>
                        <button
                          type="button"
                          onClick={() => stepProgress(g.id, -25)}
                          disabled={g.progress <= 0}
                          className="rounded border border-border bg-card px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-primary disabled:opacity-40"
                          title="Decrease progress"
                        >
                          -25%
                        </button>
                        <button
                          type="button"
                          onClick={() => stepProgress(g.id, 25)}
                          className="rounded border border-border bg-card px-1.5 py-0.5 text-[10px] text-primary hover:bg-secondary"
                          title="Advance progress"
                        >
                          +25%
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => removeGoal(g.id)}
                      aria-label="Delete goal"
                      className="ml-1 p-1 text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                </div>

                <div className="mt-2 flex items-center gap-2">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
                    <div
                      className="h-full rounded-full bg-primary transition-all duration-300"
                      style={{ width: `${g.completed ? 100 : g.progress}%` }}
                    />
                  </div>
                  <span className="w-8 text-right text-[10px] text-muted-foreground">
                    {g.completed ? 100 : g.progress}%
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
});
