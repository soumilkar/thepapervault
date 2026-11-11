import { useEffect, useMemo, useState } from "react";
import { ShieldAlert, ShieldCheck, Lock } from "lucide-react";
import { toast } from "sonner";
import {
  buildSecurityQuestionsRecord,
  consumePendingSignupSecurityQuestions,
  fetchUserSecurityQuestions,
  isSecurityQuestionsExpired,
  saveSecurityQuestionsToServer,
  SECURITY_QUESTION_POOL,
  type SecurityQuestionsRecord,
} from "@/lib/security-questions";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type QuestionDraftSlot = {
  id: string;
  question: string;
  answer: string;
};

export function getDefaultQuestionSlots(
  excludeIds?: Set<string>,
): [QuestionDraftSlot, QuestionDraftSlot, QuestionDraftSlot] {
  const pickForSlot = (slot: 1 | 2 | 3) => {
    const candidates = SECURITY_QUESTION_POOL.filter((q) => q.slot === slot);
    const fresh = excludeIds ? candidates.find((q) => !excludeIds.has(q.id)) : candidates[0];
    const chosen = fresh ?? candidates[0];
    return {
      id: chosen.id,
      question: chosen.question,
      answer: "",
    };
  };
  return [pickForSlot(1), pickForSlot(2), pickForSlot(3)];
}

export function SecurityQuestionsPicker({
  slots,
  onChange,
  compact = false,
}: {
  slots: [QuestionDraftSlot, QuestionDraftSlot, QuestionDraftSlot];
  onChange: (next: [QuestionDraftSlot, QuestionDraftSlot, QuestionDraftSlot]) => void;
  compact?: boolean;
}) {
  const updateSlot = (idx: 0 | 1 | 2, patch: Partial<QuestionDraftSlot>) => {
    const next = [...slots] as [QuestionDraftSlot, QuestionDraftSlot, QuestionDraftSlot];
    next[idx] = { ...next[idx], ...patch };
    onChange(next);
  };

  return (
    <div className={compact ? "space-y-3" : "space-y-4"}>
      {([0, 1, 2] as const).map((idx) => {
        const slotNumber = (idx + 1) as 1 | 2 | 3;
        const options = SECURITY_QUESTION_POOL.filter((q) => q.slot === slotNumber);
        const current = slots[idx];

        return (
          <div
            key={slotNumber}
            className="rounded-xl border border-border/80 bg-secondary/25 p-3.5 space-y-2.5"
          >
            <div>
              <span className="mb-1.5 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-accent">
                <span>Security Question {slotNumber}</span>
                <span className="font-hand text-sm normal-case text-sepia">choose a prompt</span>
              </span>
              <Select
                value={current.id}
                onValueChange={(val) => {
                  const found = options.find((o) => o.id === val);
                  if (found) {
                    updateSlot(idx, { id: found.id, question: found.question });
                  }
                }}
              >
                <SelectTrigger className="h-auto min-h-10 w-full whitespace-normal rounded-lg border-border bg-card/90 px-3 py-2 text-left text-xs leading-relaxed text-primary shadow-xs transition hover:border-accent/60 hover:bg-secondary/40 [&>span]:line-clamp-2">
                  <SelectValue placeholder="Choose a security question" />
                </SelectTrigger>
                <SelectContent className="paper-card max-h-72 w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-2.5rem)] border-border/80 bg-card/98 p-1.5 shadow-xl backdrop-blur-md">
                  {options.map((opt) => (
                    <SelectItem
                      key={opt.id}
                      value={opt.id}
                      className="cursor-pointer rounded-lg py-2.5 pl-3 pr-8 text-xs leading-relaxed whitespace-normal text-foreground/90 focus:bg-secondary/80 focus:text-primary data-[state=checked]:bg-secondary/60 data-[state=checked]:font-medium data-[state=checked]:text-primary"
                    >
                      {opt.question}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <label className="block">
              <input
                type="password"
                required
                value={current.answer}
                onChange={(e) => updateSlot(idx, { answer: e.target.value })}
                placeholder="Your memorable answer (encrypted on your device)"
                className="w-full rounded-lg border border-input bg-card px-3 py-2 text-sm text-foreground outline-none transition focus:border-ring focus:ring-1 focus:ring-ring"
              />
            </label>
          </div>
        );
      })}
    </div>
  );
}

export function SecurityQuestionsOnboardingModal({
  userId,
  onSaved,
}: {
  userId: string;
  onSaved?: (record: SecurityQuestionsRecord) => void;
}) {
  const [open, setOpen] = useState(false);
  const [isRenewal, setIsRenewal] = useState(false);
  const [previousIds, setPreviousIds] = useState<Set<string>>(new Set());
  const [slots, setSlots] = useState<[QuestionDraftSlot, QuestionDraftSlot, QuestionDraftSlot]>(
    () => getDefaultQuestionSlots(),
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // 1. If user just completed sign-up on /auth with security questions, persist them immediately
      const pending = consumePendingSignupSecurityQuestions();
      if (pending) {
        try {
          await saveSecurityQuestionsToServer(userId, { ...pending, user_id: userId });
          onSaved?.({ ...pending, user_id: userId });
          return;
        } catch {
          // continue to check
        }
      }

      // 2. Check existing user's security questions record
      const existing = await fetchUserSecurityQuestions(userId);
      if (cancelled) return;

      if (!existing) {
        setIsRenewal(false);
        setSlots(getDefaultQuestionSlots());
        setOpen(true);
        return;
      }

      if (isSecurityQuestionsExpired(existing)) {
        const oldSet = new Set(existing.questions.map((q) => q.id));
        setPreviousIds(oldSet);
        setIsRenewal(true);
        setSlots(getDefaultQuestionSlots(oldSet));
        setOpen(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userId, onSaved]);

  const titleText = useMemo(
    () =>
      isRenewal
        ? "Refresh Your Security Questions (6-Month Rotation)"
        : "Protect Your Account with Security Questions",
    [isRenewal],
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const record = await buildSecurityQuestionsRecord({
        userId,
        selectedQuestions: slots,
      });
      await saveSecurityQuestionsToServer(userId, record);
      setOpen(false);
      onSaved?.(record);
      toast.success(
        isRenewal
          ? "Security questions rotated for the next 6 months!"
          : "Security questions encrypted and saved!",
      );
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Could not save security questions");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        // Keep open until completed so every account is protected once
        if (!nextOpen && !busy) return;
        setOpen(nextOpen);
      }}
    >
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-lg"
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-serif text-2xl text-primary">
            {isRenewal ? (
              <ShieldAlert className="size-5 text-accent shrink-0" />
            ) : (
              <ShieldCheck className="size-5 text-accent shrink-0" />
            )}
            <span>{titleText}</span>
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed text-muted-foreground">
            {isRenewal ? (
              <>
                Your security questions depreciate every <strong>6 months</strong> for your safety.
                Your previous questions remained active until this login—now pick 3 fresh questions
                and answers for the next 6 months.
              </>
            ) : (
              <>
                Choose 3 personal memory questions below. You will only be asked to set these once
                (and rotate them every 6 months). Whenever you click{" "}
                <strong>Forgot password?</strong> or <strong>Forgot passphrase?</strong>, you will
                be asked these questions first.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 pt-1">
          <SecurityQuestionsPicker slots={slots} onChange={setSlots} compact />

          {previousIds.size > 0 && (
            <p className="text-[11px] text-muted-foreground">
              We automatically pre-selected fresh questions different from your last 6-month set.
            </p>
          )}

          <div className="flex items-start gap-2 rounded-lg border border-border/70 bg-card/80 p-3 text-[11px] leading-relaxed text-muted-foreground">
            <Lock className="mt-0.5 size-3.5 shrink-0 text-accent" />
            <span>
              <strong>Zero-Knowledge Protection:</strong> Your answers are normalized and stretched
              in your browser using <strong>250,000 rounds of PBKDF2-HMAC-SHA256</strong> with
              unique cryptographic salts before leaving your device. Plaintext answers are never
              transmitted or stored anywhere.
            </span>
          </div>

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
          >
            {busy
              ? "Encrypting & saving answers..."
              : isRenewal
                ? "Save new 6-month security questions"
                : "Encrypt & save security questions"}
          </button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
