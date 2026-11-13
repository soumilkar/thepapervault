import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Clock,
  Copy,
  Download,
  KeyRound,
  Lock,
  LogOut,
  Mail,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import { useVault } from "@/lib/vault";
import { runVaultMigration } from "@/lib/vault-migrate";
import { markFirstTimeSignup } from "@/components/WelcomeTour";
import {
  fetchUserSecurityQuestions,
  SECURITY_QUESTIONS_UPDATED_EVENT,
  verifyAuthedSecurityQuestionsOnServer,
  type SecurityQuestionsRecord,
} from "@/lib/security-questions";
import {
  formatLockoutCountdown,
  formatLockoutDuration,
  requestForceSignOut,
} from "@/lib/vault-lockout";

type GateView =
  "unlock" | "verify_security_questions" | "recover_key" | "reset_vault" | "show_recovery_key";

export function VaultGate({
  userId,
  userEmail,
  children,
}: {
  userId: string;
  userEmail?: string;
  children: React.ReactNode;
}) {
  const {
    status,
    setup,
    unlock,
    recoverWithRecoveryKey,
    resetVaultAndSetup,
    recoveryKey,
    lockoutStatus,
    refreshLockoutStatus,
  } = useVault();
  const [view, setView] = useState<GateView>("unlock");
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [recoveryCodeInput, setRecoveryCodeInput] = useState("");
  const [resetConfirmationText, setResetConfirmationText] = useState("");
  const [busy, setBusy] = useState(false);
  const [progressText, setProgressText] = useState("");
  const [newlyIssuedRecoveryKey, setNewlyIssuedRecoveryKey] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);

  // Security Questions verification state for "Forgot passphrase?"
  const [sqRecord, setSqRecord] = useState<SecurityQuestionsRecord | null>(null);
  const [sqAnswers, setSqAnswers] = useState<[string, string, string]>(["", "", ""]);
  const [sqVerified, setSqVerified] = useState(false);
  const [loadingSq, setLoadingSq] = useState(false);

  // Defense-in-depth Security Questions gate state when signed in after escalation
  const [gateSqRecord, setGateSqRecord] = useState<SecurityQuestionsRecord | null>(null);
  const [gateSqLoading, setGateSqLoading] = useState(false);
  const [gateSqFailedLoad, setGateSqFailedLoad] = useState(false);
  const [gateSqAnswers, setGateSqAnswers] = useState<[string, string, string]>(["", "", ""]);
  const [gateSqBusy, setGateSqBusy] = useState(false);

  // Live countdown ticker when temporarily locked
  const [nowMs, setNowMs] = useState(() => Date.now());
  const expiredRefreshedForRef = useRef<number>(0);

  const lockedUntil = lockoutStatus?.lockedUntil ?? 0;
  const isTemporarilyLocked = Boolean(status === "locked" && lockoutStatus && lockedUntil > nowMs);

  useEffect(() => {
    if (status !== "locked" || !lockedUntil || lockedUntil <= Date.now()) return;
    setNowMs(Date.now());
    const id = window.setInterval(() => {
      const next = Date.now();
      setNowMs(next);
      if (next >= lockedUntil && expiredRefreshedForRef.current !== lockedUntil) {
        expiredRefreshedForRef.current = lockedUntil;
        void refreshLockoutStatus();
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [status, lockedUntil, refreshLockoutStatus]);

  useEffect(() => {
    if (status !== "locked" || !lockoutStatus?.needsSecurityQuestionsInGate) {
      setGateSqRecord(null);
      setGateSqFailedLoad(false);
      setGateSqAnswers(["", "", ""]);
    }
  }, [status, lockoutStatus?.needsSecurityQuestionsInGate]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onSqUpdated = (e: Event) => {
      const detail = (e as CustomEvent<{ userId?: string }>).detail;
      if (detail?.userId && detail.userId !== userId) return;
      setGateSqRecord(null);
      setGateSqFailedLoad(false);
      setGateSqAnswers(["", "", ""]);
      setSqRecord(null);
      setSqVerified(false);
      setSqAnswers(["", "", ""]);
    };
    window.addEventListener(SECURITY_QUESTIONS_UPDATED_EVENT, onSqUpdated);
    return () => {
      window.removeEventListener(SECURITY_QUESTIONS_UPDATED_EVENT, onSqUpdated);
    };
  }, [userId]);

  useEffect(() => {
    if (
      status !== "locked" ||
      isTemporarilyLocked ||
      !lockoutStatus?.needsSecurityQuestionsInGate ||
      gateSqRecord ||
      gateSqFailedLoad
    ) {
      return;
    }
    let cancelled = false;
    setGateSqLoading(true);
    void fetchUserSecurityQuestions(userId)
      .then((rec) => {
        if (cancelled) return;
        if (rec && Array.isArray(rec.questions) && rec.questions.length === 3) {
          setGateSqRecord(rec);
        } else {
          setGateSqFailedLoad(true);
        }
      })
      .catch(() => {
        if (!cancelled) setGateSqFailedLoad(true);
      })
      .finally(() => {
        if (!cancelled) setGateSqLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    status,
    isTemporarilyLocked,
    lockoutStatus?.needsSecurityQuestionsInGate,
    gateSqRecord,
    gateSqFailedLoad,
    userId,
  ]);

  if (status === "loading") {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <p className="font-hand text-sepia text-lg">one moment...</p>
      </div>
    );
  }

  if (status === "unlocked" && view !== "show_recovery_key") {
    return <>{children}</>;
  }

  const displayedRecoveryKey = newlyIssuedRecoveryKey || recoveryKey;

  const copyRecoveryKey = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedKey(true);
      toast.success("Recovery Key copied to clipboard");
      window.setTimeout(() => setCopiedKey(false), 2500);
    } catch {
      toast.error("Could not copy automatically. Please select and copy the key.");
    }
  };

  const downloadRecoveryKey = (code: string) => {
    const content = [
      "THE PAPERVAULT — VAULT RECOVERY KEY",
      "===================================",
      "",
      `Recovery Key: ${code}`,
      `Generated: ${new Date().toISOString()}`,
      "",
      "Keep this key in a safe place (like a password manager or printed copy).",
      "If you ever forget your Vault Passphrase, you can enter this Recovery Key",
      "on the unlock screen to reset your passphrase without losing your encrypted",
      "diary entries, notes, gallery photos, or companion chats.",
      "",
    ].join("\n");
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "papervault-recovery-key.txt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  if (status === "unlocked" && view === "show_recovery_key" && displayedRecoveryKey) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center px-4">
        <div className="paper-card w-full max-w-md space-y-5 p-8">
          <div className="flex items-center gap-2 text-accent">
            <KeyRound className="size-5" />
            <p className="font-hand text-2xl text-sepia">save your recovery key</p>
          </div>
          <h2 className="font-serif text-2xl text-primary">Your Emergency Recovery Key</h2>
          <p className="text-sm text-muted-foreground">
            If you ever forget your vault passphrase, this Recovery Key lets you reset your
            passphrase and keep all of your encrypted diary entries, notes, and photos. You can also
            view it anytime under <strong>Security</strong> on your <strong>Home</strong> tab.
          </p>

          <div className="rounded-lg border border-border bg-secondary/50 p-4 text-center">
            <code className="select-all font-mono text-sm font-semibold tracking-wider text-primary sm:text-base">
              {displayedRecoveryKey}
            </code>
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void copyRecoveryKey(displayedRecoveryKey)}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-xs font-medium text-primary hover:bg-secondary"
            >
              {copiedKey ? <Check className="size-4 text-accent" /> : <Copy className="size-4" />}
              <span>{copiedKey ? "Copied" : "Copy key"}</span>
            </button>
            <button
              type="button"
              onClick={() => downloadRecoveryKey(displayedRecoveryKey)}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-xs font-medium text-primary hover:bg-secondary"
            >
              <Download className="size-4" />
              <span>Download .txt</span>
            </button>
          </div>

          <button
            type="button"
            onClick={() => {
              setNewlyIssuedRecoveryKey(null);
              setView("unlock");
            }}
            className="w-full rounded-md bg-primary px-4 py-2.5 text-sm text-primary-foreground hover:opacity-90"
          >
            I&apos;ve saved my Recovery Key — Continue
          </button>
        </div>
      </div>
    );
  }

  const handleStartForgotPassphrase = async () => {
    if (isTemporarilyLocked) {
      toast.error("Your vault is temporarily locked. Please wait until the cooldown ends.");
      return;
    }
    setPassphrase("");
    setConfirm("");
    setResetConfirmationText("");
    setSqAnswers(["", "", ""]);
    setLoadingSq(true);
    try {
      const record = await fetchUserSecurityQuestions(userId);
      if (record && Array.isArray(record.questions) && record.questions.length === 3) {
        setSqRecord(record);
        setSqVerified(false);
        setView("verify_security_questions");
      } else {
        setSqRecord(null);
        setSqVerified(true);
        setView("recover_key");
      }
    } catch {
      setSqRecord(null);
      setSqVerified(true);
      setView("recover_key");
    } finally {
      setLoadingSq(false);
    }
  };

  const onVerifySecurityQuestions = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sqRecord) {
      setSqVerified(true);
      setView("recover_key");
      return;
    }
    setBusy(true);
    setProgressText("Verifying security answers...");
    try {
      const { verified } = await verifyAuthedSecurityQuestionsOnServer(sqRecord, sqAnswers);
      if (!verified) {
        throw new Error("One or more security question answers did not match.");
      }
      setSqVerified(true);
      setSqAnswers(["", "", ""]);
      setView("recover_key");
      toast.success("Security questions verified! You can now reset your passphrase.");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Incorrect security question answers.");
    } finally {
      setBusy(false);
      setProgressText("");
    }
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setProgressText("");
    try {
      let dataKey: CryptoKey;
      if (status === "needs_setup") {
        if (passphrase !== confirm) throw new Error("Passphrases don't match");
        dataKey = await setup(passphrase);
        markFirstTimeSignup(userId);
        setPassphrase("");
        setConfirm("");
        setView("show_recovery_key");
        toast.success("Vault created! Save your emergency recovery key.");
      } else {
        dataKey = await unlock(passphrase);
        setPassphrase("");
        setConfirm("");
        toast.success("Welcome back");
      }
      void runVaultMigration(userId, dataKey).catch((err) => console.error("vault migration", err));
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Could not unlock");
    } finally {
      setBusy(false);
    }
  };

  const onRecoverWithKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (sqRecord && !sqVerified) {
      setView("verify_security_questions");
      toast.error("Please answer your security questions first.");
      return;
    }
    if (!recoveryCodeInput.trim()) {
      toast.error("Please enter your Recovery Key.");
      return;
    }
    if (passphrase.length < 8) {
      toast.error("New passphrase must be at least 8 characters.");
      return;
    }
    if (passphrase !== confirm) {
      toast.error("New passphrases do not match.");
      return;
    }
    setBusy(true);
    setProgressText("Verifying recovery key...");
    try {
      const dataKey = await recoverWithRecoveryKey(recoveryCodeInput, passphrase, (step) =>
        setProgressText(step),
      );
      void runVaultMigration(userId, dataKey).catch(() => {});
      setPassphrase("");
      setConfirm("");
      setRecoveryCodeInput("");
      setView("unlock");
      toast.success("Passphrase reset! All your encrypted entries have been preserved.");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Could not recover vault");
    } finally {
      setBusy(false);
      setProgressText("");
    }
  };

  const onResetVaultFresh = async (e: React.FormEvent) => {
    e.preventDefault();
    if (sqRecord && !sqVerified) {
      setView("verify_security_questions");
      toast.error("Please answer your security questions first.");
      return;
    }
    if (resetConfirmationText.trim().toUpperCase() !== "RESET") {
      toast.error('Please type "RESET" to confirm.');
      return;
    }
    if (passphrase.length < 8) {
      toast.error("New passphrase must be at least 8 characters.");
      return;
    }
    if (passphrase !== confirm) {
      toast.error("Passphrases do not match.");
      return;
    }
    setBusy(true);
    setProgressText("Resetting vault and setting up new passphrase...");
    try {
      const { recoveryKey: freshRecKey } = await resetVaultAndSetup(passphrase);
      setPassphrase("");
      setConfirm("");
      setResetConfirmationText("");
      setNewlyIssuedRecoveryKey(freshRecKey);
      setView("show_recovery_key");
      toast.success("Vault reset complete! Save your new Recovery Key.");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Could not reset vault");
    } finally {
      setBusy(false);
      setProgressText("");
    }
  };

  const onVerifyGateSecurityQuestions = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!gateSqRecord) return;
    setGateSqBusy(true);
    try {
      const { verified } = await verifyAuthedSecurityQuestionsOnServer(gateSqRecord, gateSqAnswers);
      if (!verified) {
        throw new Error("One or more security question answers did not match.");
      }
      setGateSqAnswers(["", "", ""]);
      await refreshLockoutStatus();
      toast.success("Security questions verified. You may now enter your passphrase.");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Incorrect security question answers.");
    } finally {
      setGateSqBusy(false);
    }
  };

  if (status === "locked" && isTemporarilyLocked && lockoutStatus) {
    const remainingMs = Math.max(0, lockoutStatus.lockedUntil - nowMs);
    const unlockAtLabel = new Date(lockoutStatus.lockedUntil).toLocaleString([], {
      dateStyle: "medium",
      timeStyle: "short",
    });
    const currentLockDurationLabel = formatLockoutDuration(
      lockoutStatus.lastLockDurationMs || lockoutStatus.nextLockDurationMs,
    );
    const nextTierLabel = formatLockoutDuration(lockoutStatus.nextLockDurationMs);

    return (
      <div className="flex min-h-[60vh] items-center justify-center px-4">
        <div className="paper-card w-full max-w-md space-y-5 p-8">
          <div className="flex items-center gap-2 text-destructive">
            <ShieldAlert className="size-5 shrink-0" />
            <p className="font-hand text-2xl text-sepia">vault temporarily locked</p>
          </div>

          <h2 className="font-serif text-2xl text-primary">Too many incorrect attempts</h2>

          <p className="text-sm leading-relaxed text-muted-foreground">
            Your vault has been temporarily locked for{" "}
            <strong className="text-foreground">{currentLockDurationLabel}</strong> to protect your
            encrypted entries.
          </p>

          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-center space-y-1.5">
            <div className="flex items-center justify-center gap-1.5 text-xs font-medium uppercase tracking-wider text-destructive">
              <Clock className="size-3.5" />
              <span>Lockout Tier #{Math.max(1, lockoutStatus.lockoutCount)}</span>
            </div>
            <p className="font-mono text-2xl font-semibold tracking-tight text-primary">
              {formatLockoutCountdown(remainingMs)}
            </p>
            <p className="text-xs text-muted-foreground">Unlocks at {unlockAtLabel}</p>
          </div>

          <div className="flex items-start gap-2.5 rounded-lg border border-border/80 bg-secondary/35 p-3 text-xs text-muted-foreground">
            <Mail className="mt-0.5 size-4 shrink-0 text-accent" />
            <p className="leading-relaxed">
              {lockoutStatus.lastEmailSentAt > 0
                ? `A security lockout alert has been sent to ${userEmail || "your account email"}. `
                : `A security notice was triggered for ${userEmail || "your account email"}. `}
              Entering an incorrect passphrase again after the timer ends will increase the next
              lockout to <strong className="text-foreground">{nextTierLabel}</strong>.
            </p>
          </div>

          <button
            type="button"
            onClick={() =>
              requestForceSignOut({
                notice: "vault_locked",
                lockedUntil: lockoutStatus.lockedUntil,
                durationMs: lockoutStatus.lastLockDurationMs,
                lockoutCount: lockoutStatus.lockoutCount,
                emailSent: lockoutStatus.lastEmailSentAt > 0,
              })
            }
            className="flex w-full items-center justify-center gap-2 rounded-md border border-border bg-card px-4 py-2.5 text-sm font-medium text-primary hover:bg-secondary"
          >
            <LogOut className="size-4" />
            <span>Sign out</span>
          </button>
        </div>
      </div>
    );
  }

  if (
    status === "locked" &&
    !isTemporarilyLocked &&
    lockoutStatus?.needsSecurityQuestionsInGate &&
    !gateSqFailedLoad
  ) {
    if (gateSqLoading || !gateSqRecord) {
      return (
        <div className="flex min-h-[40vh] items-center justify-center">
          <p className="font-hand text-sepia text-lg">loading security verification...</p>
        </div>
      );
    }

    return (
      <div className="flex min-h-[60vh] items-center justify-center px-4">
        <div className="paper-card w-full max-w-md space-y-5 p-8">
          <div className="flex items-center gap-2 text-accent">
            <ShieldCheck className="size-5" />
            <p className="font-hand text-2xl text-sepia">security verification required</p>
          </div>
          <h2 className="font-serif text-2xl text-primary">Answer your security questions</h2>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Because of previous failed vault passphrase attempts, please verify your 3 security
            questions before attempting to unlock your vault.
          </p>

          <form onSubmit={onVerifyGateSecurityQuestions} className="space-y-3.5">
            {gateSqRecord.questions.map((q, idx) => (
              <label
                key={q.id}
                className="block rounded-lg border border-border/80 bg-secondary/25 p-3 space-y-1.5"
              >
                <span className="block text-[11px] font-semibold uppercase tracking-wide text-accent">
                  Question {idx + 1}
                </span>
                <span className="block text-xs font-medium text-foreground">{q.question}</span>
                <input
                  type="password"
                  required
                  value={gateSqAnswers[idx] ?? ""}
                  onChange={(e) => {
                    const next = [...gateSqAnswers] as [string, string, string];
                    next[idx] = e.target.value;
                    setGateSqAnswers(next);
                  }}
                  placeholder="Your answer"
                  className="w-full rounded-md border border-input bg-card px-3 py-1.5 text-sm outline-none focus:border-ring focus:ring-1 focus:ring-ring"
                />
              </label>
            ))}

            <button
              type="submit"
              disabled={gateSqBusy}
              className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
            >
              {gateSqBusy ? "Verifying answers..." : "Verify & continue to passphrase"}
            </button>
          </form>

          <button
            type="button"
            onClick={() => requestForceSignOut({ notice: "vault_attempts_signout" })}
            className="flex w-full items-center justify-center gap-1.5 text-xs text-muted-foreground hover:text-primary"
          >
            <LogOut className="size-3.5" />
            <span>Sign out instead</span>
          </button>
        </div>
      </div>
    );
  }

  if (status === "locked" && view === "verify_security_questions" && sqRecord) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center px-4">
        <div className="paper-card w-full max-w-md space-y-5 p-8">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-accent">
              <ShieldCheck className="size-5" />
              <p className="font-hand text-2xl text-sepia">step 1 of 2 · security check</p>
            </div>
            <button
              type="button"
              onClick={() => {
                setView("unlock");
                setSqAnswers(["", "", ""]);
              }}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
            >
              <ArrowLeft className="size-3.5" /> Back
            </button>
          </div>

          <h2 className="font-serif text-2xl text-primary">Answer Security Questions First</h2>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Before resetting your vault passphrase, verify the 3 security questions linked to your
            account. Your answers are verified locally in your browser using 250,000 rounds of
            PBKDF2-HMAC-SHA256.
          </p>

          <form onSubmit={onVerifySecurityQuestions} className="space-y-3.5">
            {sqRecord.questions.map((q, idx) => (
              <label
                key={q.id}
                className="block rounded-lg border border-border/80 bg-secondary/25 p-3 space-y-1.5"
              >
                <span className="block text-[11px] font-semibold uppercase tracking-wide text-accent">
                  Question {idx + 1}
                </span>
                <span className="block text-xs font-medium text-foreground">{q.question}</span>
                <input
                  type="password"
                  required
                  value={sqAnswers[idx] ?? ""}
                  onChange={(e) => {
                    const next = [...sqAnswers] as [string, string, string];
                    next[idx] = e.target.value;
                    setSqAnswers(next);
                  }}
                  placeholder="Your answer"
                  className="w-full rounded-md border border-input bg-card px-3 py-1.5 text-sm outline-none focus:border-ring focus:ring-1 focus:ring-ring"
                />
              </label>
            ))}

            {progressText && (
              <p className="text-center font-hand text-base text-sepia">{progressText}</p>
            )}

            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
            >
              {busy ? "Verifying answers..." : "Verify answers & continue"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (status === "locked" && (view === "recover_key" || view === "reset_vault")) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center px-4">
        <div className="paper-card w-full max-w-md space-y-5 p-8">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-accent">
              <KeyRound className="size-5" />
              <p className="font-hand text-2xl text-sepia">reset passphrase</p>
            </div>
            <button
              type="button"
              onClick={() => {
                setView("unlock");
                setPassphrase("");
                setConfirm("");
                setResetConfirmationText("");
              }}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
            >
              <ArrowLeft className="size-3.5" /> Back
            </button>
          </div>

          <h2 className="font-serif text-2xl text-primary">Forgot your passphrase?</h2>

          {sqRecord && sqVerified && (
            <div className="flex items-center gap-2 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-xs text-primary">
              <ShieldCheck className="size-4 shrink-0 text-accent" />
              <span>Security questions verified. Choose how to reset your passphrase below.</span>
            </div>
          )}

          <div className="grid grid-cols-2 gap-1.5 rounded-lg border border-border bg-secondary/40 p-1 text-xs">
            <button
              type="button"
              onClick={() => setView("recover_key")}
              className={`rounded-md px-2.5 py-2 font-medium transition ${
                view === "recover_key"
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:text-primary"
              }`}
            >
              Use Recovery Key
            </button>
            <button
              type="button"
              onClick={() => setView("reset_vault")}
              className={`rounded-md px-2.5 py-2 font-medium transition ${
                view === "reset_vault"
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:text-primary"
              }`}
            >
              Start Fresh Reset
            </button>
          </div>

          {view === "recover_key" ? (
            <form onSubmit={onRecoverWithKey} className="space-y-4">
              <p className="text-xs leading-relaxed text-muted-foreground">
                Enter your <strong>Vault Recovery Key</strong> (starting with{" "}
                <code className="font-mono text-primary">PV-...</code>) to decrypt your vault and
                set a new passphrase without losing any entries.
              </p>

              <label className="block">
                <span className="mb-1 block text-sm font-medium text-foreground/80">
                  Recovery Key
                </span>
                <input
                  type="text"
                  required
                  value={recoveryCodeInput}
                  onChange={(e) => setRecoveryCodeInput(e.target.value)}
                  className="w-full rounded-md border border-input bg-card px-3 py-2 font-mono text-sm uppercase outline-none focus:border-ring focus:ring-1 focus:ring-ring"
                  placeholder="PV-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-sm font-medium text-foreground/80">
                  New passphrase
                </span>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  className="w-full rounded-md border border-input bg-card px-3 py-2 outline-none focus:border-ring focus:ring-1 focus:ring-ring"
                  placeholder="At least 8 characters"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-sm font-medium text-foreground/80">
                  Confirm new passphrase
                </span>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className="w-full rounded-md border border-input bg-card px-3 py-2 outline-none focus:border-ring focus:ring-1 focus:ring-ring"
                  placeholder="Re-enter new passphrase"
                />
              </label>

              {progressText && (
                <p className="text-center font-hand text-base text-sepia">{progressText}</p>
              )}

              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-md bg-primary px-4 py-2.5 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-60"
              >
                {busy ? "Recovering vault..." : "Recover & set new passphrase"}
              </button>
            </form>
          ) : (
            <form onSubmit={onResetVaultFresh} className="space-y-4">
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs leading-relaxed text-foreground">
                <div className="flex items-center gap-1.5 font-semibold text-destructive">
                  <AlertTriangle className="size-4 shrink-0" />
                  <span>No Recovery Key? Resetting clears old encrypted items</span>
                </div>
                <p className="mt-1 text-muted-foreground">
                  Because your private diary, notes, and photos are end-to-end encrypted, they
                  cannot be decrypted without your passphrase or Recovery Key. Resetting lets you
                  wipe unreadable encrypted items and set a brand-new passphrase.
                </p>
              </div>

              <label className="block">
                <span className="mb-1 block text-sm font-medium text-foreground/80">
                  New passphrase
                </span>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  className="w-full rounded-md border border-input bg-card px-3 py-2 outline-none focus:border-ring focus:ring-1 focus:ring-ring"
                  placeholder="At least 8 characters"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-sm font-medium text-foreground/80">
                  Confirm new passphrase
                </span>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className="w-full rounded-md border border-input bg-card px-3 py-2 outline-none focus:border-ring focus:ring-1 focus:ring-ring"
                  placeholder="Re-enter new passphrase"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-xs font-medium text-foreground/80">
                  Type <code className="font-mono font-bold text-destructive">RESET</code> to
                  confirm
                </span>
                <input
                  type="text"
                  required
                  value={resetConfirmationText}
                  onChange={(e) => setResetConfirmationText(e.target.value)}
                  className="w-full rounded-md border border-input bg-card px-3 py-2 font-mono text-sm uppercase outline-none focus:border-ring focus:ring-1 focus:ring-ring"
                  placeholder="RESET"
                />
              </label>

              {progressText && (
                <p className="text-center font-hand text-base text-sepia">{progressText}</p>
              )}

              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-md bg-destructive px-4 py-2.5 text-sm text-destructive-foreground hover:opacity-90 disabled:opacity-60"
              >
                {busy ? "Resetting vault..." : "Reset vault & set new passphrase"}
              </button>
            </form>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4">
      <form onSubmit={onSubmit} className="paper-card w-full max-w-md space-y-4 p-8">
        <div className="flex items-center gap-2 text-accent">
          {status === "needs_setup" ? (
            <ShieldCheck className="size-5" />
          ) : (
            <Lock className="size-5" />
          )}
          <p className="font-hand text-2xl text-sepia">
            {status === "needs_setup" ? "create your passphrase" : "enter your passphrase"}
          </p>
        </div>
        <h2 className="font-serif text-2xl text-primary">
          {status === "needs_setup" ? "Pick a passphrase" : "Welcome back"}
        </h2>
        <p className="text-sm text-muted-foreground">
          {status === "needs_setup"
            ? "Choose a passphrase you'll remember. It end-to-end encrypts your diary, notes, folders, gallery, and companion chats."
            : "Enter your passphrase to decrypt your private diary, notes, folders, gallery, and companion chats."}
        </p>

        {status === "locked" && lockoutStatus && lockoutStatus.escalationStage >= 1 && (
          <div className="flex items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs leading-relaxed text-foreground">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div>
              <p className="font-semibold text-destructive">Strict lockout warning</p>
              <p className="mt-0.5 text-muted-foreground">
                Entering an incorrect passphrase again will immediately sign you out, lock your
                vault for{" "}
                <strong className="text-foreground">
                  {formatLockoutDuration(lockoutStatus.nextLockDurationMs)}
                </strong>
                , and email you a security alert.
              </p>
            </div>
          </div>
        )}

        {status === "locked" &&
          lockoutStatus &&
          lockoutStatus.escalationStage === 0 &&
          lockoutStatus.failedAttempts > 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs leading-relaxed text-foreground">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <p className="text-muted-foreground">
                <strong className="text-foreground">
                  {lockoutStatus.remainingAttempts} attempt
                  {lockoutStatus.remainingAttempts === 1 ? "" : "s"} remaining
                </strong>{" "}
                before you are automatically signed out and required to answer your security
                questions.
              </p>
            </div>
          )}

        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-sm font-medium text-foreground/80">Passphrase</span>
            {status === "locked" && (
              <button
                type="button"
                disabled={loadingSq}
                onClick={() => void handleStartForgotPassphrase()}
                className="text-xs text-accent hover:text-primary hover:underline disabled:opacity-60"
              >
                {loadingSq ? "Loading..." : "Forgot passphrase?"}
              </button>
            )}
          </div>
          <input
            type="password"
            required
            minLength={8}
            autoFocus
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            className="w-full rounded-md border border-input bg-card px-3 py-2 outline-none focus:border-ring focus:ring-1 focus:ring-ring"
            placeholder="At least 8 characters"
          />
        </div>

        {status === "needs_setup" && (
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-foreground/80">
              Confirm passphrase
            </span>
            <input
              type="password"
              required
              minLength={8}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="w-full rounded-md border border-input bg-card px-3 py-2 outline-none focus:border-ring focus:ring-1 focus:ring-ring"
            />
          </label>
        )}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-primary px-4 py-2.5 text-primary-foreground hover:opacity-90 disabled:opacity-60"
        >
          {busy ? "Working..." : status === "needs_setup" ? "Continue" : "Unlock"}
        </button>
      </form>
    </div>
  );
}
