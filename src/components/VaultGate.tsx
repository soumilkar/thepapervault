import { useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Copy,
  Download,
  KeyRound,
  Lock,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import { formatDurationLabel, useVault } from "@/lib/vault";
import { runVaultMigration } from "@/lib/vault-migrate";
import { markFirstTimeSignup } from "@/components/WelcomeTour";
import {
  fetchUserSecurityQuestions,
  verifyAuthedSecurityQuestionsOnServer,
  type SecurityQuestionsRecord,
} from "@/lib/security-questions";

type GateView =
  "unlock" | "verify_security_questions" | "recover_key" | "reset_vault" | "show_recovery_key";

export function VaultGate({ userId, children }: { userId: string; children: React.ReactNode }) {
  const {
    status,
    setup,
    unlock,
    recoverWithRecoveryKey,
    resetVaultAndSetup,
    recoveryKey,
    failedAttempts,
    attemptsRemaining,
    nextLockoutDurationMs,
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

        {status === "locked" && failedAttempts > 0 && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div>
              <p className="font-semibold">
                {attemptsRemaining} passphrase {attemptsRemaining === 1 ? "attempt" : "attempts"}{" "}
                remaining
              </p>
              <p className="mt-0.5 text-muted-foreground">
                Entering a wrong passphrase {attemptsRemaining} more{" "}
                {attemptsRemaining === 1 ? "time" : "times"} will automatically log you out and lock
                your account for {formatDurationLabel(nextLockoutDurationMs)}.
              </p>
            </div>
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
