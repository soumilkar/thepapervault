import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Sparkles, X } from "lucide-react";

type Props = { userId: string };

const STEPS = [
  {
    title: "Welcome to The PaperVault",
    body: "A quiet, warm home for your diary, blogs, photos and an AI companion that has read your story.",
  },
  {
    title: "Diary",
    body: "Write daily entries with mood and a photo. Keep them private or share anonymously with the community.",
  },
  {
    title: "Blog",
    body: "Publish longer pieces, add tags, attach a song, and see likes & comments from other writers.",
  },
  {
    title: "Gallery",
    body: "Upload photos that matter (under 5 MB) and caption them like a real album.",
  },
  {
    title: "Companion",
    body: "Ask anything about your own writing. It only reads YOUR diary and blogs — never anyone else's.",
  },
];

export function WelcomeTour({ userId }: Props) {
  const [show, setShow] = useState(false);
  const [step, setStep] = useState(0);

  useEffect(() => {
    let active = true;
    supabase
      .from("profiles")
      .select("tour_completed")
      .eq("id", userId)
      .maybeSingle()
      .then(({ data }) => {
        if (active && data && !data.tour_completed) setShow(true);
      });
    return () => {
      active = false;
    };
  }, [userId]);

  const finish = async () => {
    setShow(false);
    await supabase.from("profiles").update({ tour_completed: true }).eq("id", userId);
  };

  if (!show) return null;
  const s = STEPS[step];
  const last = step === STEPS.length - 1;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="paper-card relative w-full max-w-md p-6">
        <button
          onClick={finish}
          aria-label="Skip"
          className="absolute right-3 top-3 text-muted-foreground hover:text-foreground"
        >
          <X className="size-4" />
        </button>
        <div className="flex items-center gap-2 text-accent">
          <Sparkles className="size-5" />
          <span className="text-xs uppercase tracking-wide">a quick tour</span>
        </div>
        <h2 className="mt-2 font-serif text-2xl text-primary">{s.title}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{s.body}</p>
        <div className="mt-4 flex items-center justify-center gap-1.5">
          {STEPS.map((_, i) => (
            <span
              key={i}
              className={`size-1.5 rounded-full ${i === step ? "bg-primary" : "bg-border"}`}
            />
          ))}
        </div>
        <div className="mt-5 flex items-center justify-between">
          <button onClick={finish} className="text-sm text-muted-foreground hover:text-primary">
            Skip
          </button>
          <div className="flex gap-2">
            {step > 0 && (
              <button
                onClick={() => setStep(step - 1)}
                className="rounded-md border border-border px-4 py-1.5 text-sm"
              >
                Back
              </button>
            )}
            <button
              onClick={() => (last ? finish() : setStep(step + 1))}
              className="rounded-md bg-primary px-4 py-1.5 text-sm text-primary-foreground"
            >
              {last ? "Start writing" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
