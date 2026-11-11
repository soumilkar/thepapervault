import { useEffect, useState } from "react";
import {
  Check,
  Clock,
  Copy,
  Download,
  KeyRound,
  Lock,
  Mail,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import {
  consumeEmailCallbackIntent,
  EMAIL_AUTH_CALLBACK_STORAGE_KEY,
  setPendingEmailIntent,
  supabase,
} from "@/integrations/supabase/client";
import { getFreshAccessToken } from "@/lib/offline-supabase";
import { useVault } from "@/lib/vault";
import {
  buildSecurityQuestionsRecord,
  fetchUserSecurityQuestions,
  getDaysUntilDepreciation,
  isSecurityQuestionsExpired,
  saveSecurityQuestionsToServer,
  type SecurityQuestionsRecord,
} from "@/lib/security-questions";
import {
  getDefaultQuestionSlots,
  SecurityQuestionsPicker,
  type QuestionDraftSlot,
} from "@/components/SecurityQuestionsOnboardingModal";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type SecurityTab = "account" | "vault" | "questions" | "recovery" | "about";

export const OPEN_SECURITY_DIALOG_EVENT = "papervault:open-security-dialog";

export function requestOpenSecurityDialog(tab: SecurityTab = "account"): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OPEN_SECURITY_DIALOG_EVENT, { detail: { tab } }));
}

const SECURITY_EMAIL_VERIFY_TTL_MS = 15 * 60 * 1000; // 15 minutes
const LEGACY_VERIFY_PREFIX = "papervault:security_panel_verified:v1:";
const PENDING_NONCE_PREFIX = "papervault:sec_email_nonce:v2:";
const SECURITY_EMAIL_VERIFIED_EVENT = "papervault:security-email-verified";
const SECURITY_BC_CHANNEL = "papervault_security_gate_v2";

// Volatile in-memory map of userId -> verifiedAt timestamp (never persisted in plain localStorage)
const verifiedSecuritySessions = new Map<string, number>();

export function isSecurityPanelEmailVerified(userId?: string): boolean {
  const key = userId || "anon";
  const verifiedAt = verifiedSecuritySessions.get(key);
  if (!verifiedAt) return false;
  if (Date.now() - verifiedAt >= SECURITY_EMAIL_VERIFY_TTL_MS) {
    verifiedSecuritySessions.delete(key);
    return false;
  }
  return true;
}

export function markSecurityPanelEmailVerified(userId?: string): void {
  const key = userId || "anon";
  verifiedSecuritySessions.set(key, Date.now());
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(`${LEGACY_VERIFY_PREFIX}${key}`);
    } catch {
      // ignore
    }
    window.dispatchEvent(new Event(SECURITY_EMAIL_VERIFIED_EVENT));
  }
}

export function clearSecurityPanelEmailVerified(userId?: string): void {
  if (userId) {
    verifiedSecuritySessions.delete(userId);
  } else {
    verifiedSecuritySessions.clear();
  }
  if (typeof window !== "undefined") {
    try {
      const key = userId || "anon";
      window.localStorage.removeItem(`${LEGACY_VERIFY_PREFIX}${key}`);
      window.sessionStorage.removeItem(`${PENDING_NONCE_PREFIX}${key}`);
      window.localStorage.removeItem(`${PENDING_NONCE_PREFIX}${key}`);
      window.sessionStorage.removeItem(EMAIL_AUTH_CALLBACK_STORAGE_KEY);
    } catch {
      // ignore
    }
    window.dispatchEvent(new Event(SECURITY_EMAIL_VERIFIED_EVENT));
  }
}

async function startSecurityPanelChallengeOnServer(): Promise<void> {
  try {
    const token = await getFreshAccessToken();
    if (!token) return;
    await fetch(`/api/storage-proxy?action=security-panel-challenge-start`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
  } catch {
    // ignore network errors
  }
}

async function completeSecurityPanelChallengeOnServer(): Promise<void> {
  try {
    const token = await getFreshAccessToken();
    if (!token) return;
    await fetch(`/api/storage-proxy?action=security-panel-challenge-complete`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
  } catch {
    // ignore
  }
}

async function checkSecurityPanelChallengeStatusOnServer(): Promise<boolean> {
  try {
    const token = await getFreshAccessToken();
    if (!token) return false;
    const res = await fetch(
      `/api/storage-proxy?action=security-panel-challenge-status&_t=${Date.now()}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      },
    );
    if (!res.ok) return false;
    const data = (await res.json()) as { verified?: boolean };
    return Boolean(data.verified);
  } catch {
    return false;
  }
}

async function verifySecurityPanelLinkOnServer(rawInput: string): Promise<boolean> {
  try {
    const token = await getFreshAccessToken();
    if (!token) return false;
    const res = await fetch(`/api/storage-proxy?action=security-panel-verify-link`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ input: rawInput }),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { verified?: boolean };
    return Boolean(data.verified);
  } catch {
    return false;
  }
}

export async function consumeSecurityEmailCallback(userId: string): Promise<boolean> {
  if (typeof window === "undefined" || !userId) return false;
  try {
    const callbackIntent = consumeEmailCallbackIntent();
    const search = new URLSearchParams(window.location.search);
    const hash = window.location.hash || "";

    const hasUrlCallbackIndicator =
      Boolean(callbackIntent) ||
      search.has("code") ||
      search.has("token_hash") ||
      search.has("security_nonce") ||
      search.get("security_verified") === "1" ||
      hash.includes("access_token=") ||
      hash.includes("type=magiclink") ||
      hash.includes("type=recovery") ||
      search.get("type") === "recovery" ||
      search.get("type") === "magiclink";

    if (!hasUrlCallbackIndicator) return false;

    window.sessionStorage.removeItem(EMAIL_AUTH_CALLBACK_STORAGE_KEY);
    markSecurityPanelEmailVerified(userId);
    void completeSecurityPanelChallengeOnServer();

    if ("BroadcastChannel" in window) {
      try {
        const bc = new BroadcastChannel(SECURITY_BC_CHANNEL);
        bc.postMessage({ userId, verified: true });
        bc.close();
      } catch {
        // ignore
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function SecuritySettingsDialog({
  open,
  onOpenChange,
  userId,
  userEmail,
  initialTab = "account",
  onSecurityQuestionsUpdated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId?: string;
  userEmail?: string;
  initialTab?: SecurityTab;
  onSecurityQuestionsUpdated?: (record: SecurityQuestionsRecord) => void;
}) {
  const { status, recoveryKey, changePassphrase, regenerateRecoveryKey } = useVault();
  const [tab, setTab] = useState<SecurityTab>(initialTab);

  // Email Confirmation Gate state
  const [emailVerified, setEmailVerified] = useState<boolean>(() =>
    isSecurityPanelEmailVerified(userId),
  );
  const [sendingConfirmEmail, setSendingConfirmEmail] = useState(false);
  const [confirmEmailSent, setConfirmEmailSent] = useState(false);
  const [otpCode, setOtpCode] = useState("");
  const [verifyingOtp, setVerifyingOtp] = useState(false);
  const [checkingLinkStatus, setCheckingLinkStatus] = useState(false);

  // Account Password state
  const [newAccountPassword, setNewAccountPassword] = useState("");
  const [confirmAccountPassword, setConfirmAccountPassword] = useState("");
  const [accountBusy, setAccountBusy] = useState(false);
  const [sendingResetEmail, setSendingResetEmail] = useState(false);

  // Vault Passphrase state
  const [currentPassphrase, setCurrentPassphrase] = useState("");
  const [newPassphrase, setNewPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [vaultBusy, setVaultBusy] = useState(false);
  const [vaultProgress, setVaultProgress] = useState("");

  // Security Questions state
  const [sqRecord, setSqRecord] = useState<SecurityQuestionsRecord | null>(null);
  const [sqLoading, setSqLoading] = useState(false);
  const [editingQuestions, setEditingQuestions] = useState(false);
  const [questionSlots, setQuestionSlots] = useState<
    [QuestionDraftSlot, QuestionDraftSlot, QuestionDraftSlot]
  >(() => getDefaultQuestionSlots());
  const [sqBusy, setSqBusy] = useState(false);

  // Recovery Key state
  const [copiedRecovery, setCopiedRecovery] = useState(false);
  const [regenPassphrase, setRegenPassphrase] = useState("");
  const [showRegenForm, setShowRegenForm] = useState(false);
  const [regenBusy, setRegenBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setTab(initialTab);
      const localVerified = isSecurityPanelEmailVerified(userId);
      setEmailVerified(localVerified);
      if (!localVerified && userId) {
        void checkSecurityPanelChallengeStatusOnServer().then((serverVerified) => {
          if (serverVerified) {
            markSecurityPanelEmailVerified(userId);
            setEmailVerified(true);
          }
        });
      }
    }
  }, [open, initialTab, userId]);

  useEffect(() => {
    const syncVerifiedState = () => {
      const verified = isSecurityPanelEmailVerified(userId);
      setEmailVerified(verified);
    };
    let bc: BroadcastChannel | null = null;
    if (typeof window !== "undefined") {
      window.addEventListener(SECURITY_EMAIL_VERIFIED_EVENT, syncVerifiedState);
      if ("BroadcastChannel" in window && userId) {
        try {
          bc = new BroadcastChannel(SECURITY_BC_CHANNEL);
          bc.onmessage = (ev: MessageEvent<{ userId?: string; verified?: boolean }>) => {
            if (ev.data?.userId === userId && ev.data?.verified) {
              markSecurityPanelEmailVerified(userId);
              setEmailVerified(true);
            }
          };
        } catch {
          bc = null;
        }
      }
    }
    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener(SECURITY_EMAIL_VERIFIED_EVENT, syncVerifiedState);
      }
      if (bc) {
        try {
          bc.close();
        } catch {
          // ignore
        }
      }
    };
  }, [userId]);

  // Poll server every 2s while waiting for the user to click the confirmation link in their email
  useEffect(() => {
    if (!open || emailVerified || !confirmEmailSent || !userId) return;
    let cancelled = false;

    const pollNow = async () => {
      const verified = await checkSecurityPanelChallengeStatusOnServer();
      if (!cancelled && verified) {
        markSecurityPanelEmailVerified(userId);
        setEmailVerified(true);
        toast.success("Email link confirmed! Security panel unlocked.");
      }
    };

    const interval = window.setInterval(() => {
      void pollNow();
    }, 2000);

    const onFocus = () => {
      void pollNow();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [open, emailVerified, confirmEmailSent, userId]);

  const handleSendSecurityConfirmationEmail = async () => {
    if (!userEmail || !userId) {
      toast.error("No email address associated with this account.");
      return;
    }
    setSendingConfirmEmail(true);
    try {
      setPendingEmailIntent("security_panel");
      // Use clean /app redirect URL so Supabase Redirect URL allowlist never blocks query params
      const redirectUrl = `${window.location.origin}/app`;
      const { error: otpError } = await supabase.auth.signInWithOtp({
        email: userEmail,
        options: {
          shouldCreateUser: false,
          emailRedirectTo: redirectUrl,
        },
      });
      if (otpError) {
        const { error: resetError } = await supabase.auth.resetPasswordForEmail(userEmail, {
          redirectTo: redirectUrl,
        });
        if (resetError) {
          const msg = (resetError.message || otpError.message || "").toLowerCase();
          if (
            msg.includes("rate limit") ||
            msg.includes("seconds") ||
            msg.includes("too many") ||
            resetError.status === 429
          ) {
            await startSecurityPanelChallengeOnServer();
            setConfirmEmailSent(true);
            toast.info(
              `A confirmation email was recently sent to ${userEmail}. Click the link in that email (or paste it below) to unlock.`,
            );
            return;
          }
          throw resetError;
        }
      }
      // Record post-send baseline on server so clicking the email link is detected immediately
      await startSecurityPanelChallengeOnServer();
      setConfirmEmailSent(true);
      toast.success(`Confirmation email sent to ${userEmail}`);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Could not send confirmation email");
    } finally {
      setSendingConfirmEmail(false);
    }
  };

  const handleCheckEmailLinkClicked = async () => {
    if (!userId) return;
    setCheckingLinkStatus(true);
    try {
      const verified = await checkSecurityPanelChallengeStatusOnServer();
      if (verified) {
        markSecurityPanelEmailVerified(userId);
        setEmailVerified(true);
        toast.success("Email confirmed! Security panel unlocked.");
      } else {
        toast.info(
          "Not detected yet. Make sure you clicked the link inside the email, or copy & paste the link into the box below.",
        );
      }
    } finally {
      setCheckingLinkStatus(false);
    }
  };

  const handleVerifyEmailCode = async (e: React.FormEvent) => {
    e.preventDefault();
    const rawInput = otpCode.trim();
    if (!userEmail || !rawInput) {
      toast.error("Please paste the confirmation link or code from your email.");
      return;
    }
    setVerifyingOtp(true);
    try {
      let verified = false;

      // 1. Check if the user pasted a full confirmation URL from their email or browser address bar
      if (rawInput.startsWith("http://") || rawInput.startsWith("https://")) {
        try {
          const parsedUrl = new URL(rawInput);
          const tokenParam =
            parsedUrl.searchParams.get("token_hash") || parsedUrl.searchParams.get("token") || "";
          const typeParam = parsedUrl.searchParams.get("type") || "magiclink";
          const codeParam = parsedUrl.searchParams.get("code") || "";

          if (tokenParam) {
            for (const otpType of [typeParam, "magiclink", "recovery", "email"] as const) {
              const { error } = await supabase.auth.verifyOtp({
                token_hash: tokenParam,
                type: otpType as "magiclink" | "recovery" | "email",
              });
              if (!error) {
                verified = true;
                break;
              }
            }
          }

          if (!verified && codeParam) {
            const { error } = await supabase.auth.exchangeCodeForSession(codeParam);
            if (!error) verified = true;
          }
        } catch {
          // fall through to server verification
        }

        if (!verified) {
          verified = await verifySecurityPanelLinkOnServer(rawInput);
        }
      } else {
        // 2. User entered a 6-digit OTP code or token hash string directly
        for (const otpType of ["email", "magiclink", "recovery"] as const) {
          const { error } = await supabase.auth.verifyOtp({
            email: userEmail,
            token: rawInput,
            type: otpType,
          });
          if (!error) {
            verified = true;
            break;
          }
        }
        if (!verified && rawInput.length >= 20) {
          for (const otpType of ["magiclink", "recovery", "email"] as const) {
            const { error } = await supabase.auth.verifyOtp({
              token_hash: rawInput,
              type: otpType,
            });
            if (!error) {
              verified = true;
              break;
            }
          }
        }
      }

      if (!verified) {
        verified = await checkSecurityPanelChallengeStatusOnServer();
      }

      if (!verified) {
        throw new Error(
          "Could not verify that link or code. Please click the confirmation link in your email or right-click and copy the link address from the email.",
        );
      }

      await completeSecurityPanelChallengeOnServer();
      markSecurityPanelEmailVerified(userId);
      setEmailVerified(true);
      setOtpCode("");
      toast.success("Email confirmed! Security panel unlocked.");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Could not verify link or code");
    } finally {
      setVerifyingOtp(false);
    }
  };

  useEffect(() => {
    if (!open || !userId || !emailVerified) return;
    let cancelled = false;
    setSqLoading(true);
    fetchUserSecurityQuestions(userId)
      .then((rec) => {
        if (cancelled) return;
        setSqRecord(rec);
        if (!rec) {
          setEditingQuestions(true);
          setQuestionSlots(getDefaultQuestionSlots());
        } else {
          setEditingQuestions(false);
          const usedIds = new Set(rec.questions.map((q) => q.id));
          setQuestionSlots(getDefaultQuestionSlots(usedIds));
        }
      })
      .finally(() => {
        if (!cancelled) setSqLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, userId, emailVerified]);

  const handleAccountPasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newAccountPassword.length < 6) {
      toast.error("Account password must be at least 6 characters.");
      return;
    }
    if (newAccountPassword !== confirmAccountPassword) {
      toast.error("Account passwords do not match.");
      return;
    }
    setAccountBusy(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: newAccountPassword });
      if (error) throw error;
      setNewAccountPassword("");
      setConfirmAccountPassword("");
      toast.success("Account login password updated!");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Could not update password");
    } finally {
      setAccountBusy(false);
    }
  };

  const handleSendResetEmail = async () => {
    if (!userEmail) {
      toast.error("No email address associated with this account.");
      return;
    }
    setSendingResetEmail(true);
    try {
      setPendingEmailIntent("password_reset");
      const { error } = await supabase.auth.resetPasswordForEmail(userEmail, {
        redirectTo: `${window.location.origin}/auth`,
      });
      if (error) throw error;
      toast.success(`Password reset link sent to ${userEmail}`);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to send reset email");
    } finally {
      setSendingResetEmail(false);
    }
  };

  const handleVaultPassphraseSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassphrase.length < 8) {
      toast.error("New vault passphrase must be at least 8 characters.");
      return;
    }
    if (newPassphrase !== confirmPassphrase) {
      toast.error("New vault passphrases do not match.");
      return;
    }
    setVaultBusy(true);
    setVaultProgress("Starting re-encryption...");
    try {
      await changePassphrase(currentPassphrase, newPassphrase, (step) => setVaultProgress(step));
      setCurrentPassphrase("");
      setNewPassphrase("");
      setConfirmPassphrase("");
      toast.success("Vault passphrase updated and all entries re-encrypted!");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Could not change passphrase");
    } finally {
      setVaultBusy(false);
      setVaultProgress("");
    }
  };

  const handleSaveSecurityQuestions = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userId) {
      toast.error("You must be signed in to save security questions.");
      return;
    }
    setSqBusy(true);
    try {
      const record = await buildSecurityQuestionsRecord({
        userId,
        selectedQuestions: questionSlots,
      });
      await saveSecurityQuestionsToServer(userId, record);
      setSqRecord(record);
      setEditingQuestions(false);
      onSecurityQuestionsUpdated?.(record);
      toast.success("Security questions encrypted & updated for the next 6 months!");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Could not save security questions");
    } finally {
      setSqBusy(false);
    }
  };

  const copyRecoveryKey = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedRecovery(true);
      toast.success("Recovery Key copied to clipboard");
      window.setTimeout(() => setCopiedRecovery(false), 2500);
    } catch {
      toast.error("Could not copy automatically. Please select and copy the key.");
    }
  };

  const downloadRecoveryKey = (code: string) => {
    const content = [
      "THE PAPERVAULT — VAULT RECOVERY KEY",
      "===================================",
      "",
      `Account: ${userEmail || "PaperVault User"}`,
      `Recovery Key: ${code}`,
      `Exported: ${new Date().toISOString()}`,
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

  const handleRegenerateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!regenPassphrase) return;
    setRegenBusy(true);
    try {
      await regenerateRecoveryKey(regenPassphrase);
      setRegenPassphrase("");
      setShowRegenForm(false);
      toast.success("New Recovery Key generated! Be sure to save the updated key.");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Could not regenerate key");
    } finally {
      setRegenBusy(false);
    }
  };

  const sqExpired = isSecurityQuestionsExpired(sqRecord);
  const sqDaysLeft = getDaysUntilDepreciation(sqRecord);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between gap-2 font-serif text-2xl text-primary pr-6">
            <span className="flex items-center gap-2">
              <ShieldCheck className="size-5 text-accent" />
              <span>Security &amp; Vault Protection</span>
            </span>
            {emailVerified && (
              <button
                type="button"
                onClick={() => {
                  clearSecurityPanelEmailVerified(userId);
                  setEmailVerified(false);
                  setConfirmEmailSent(false);
                }}
                className="inline-flex items-center gap-1 rounded-full border border-border bg-secondary/50 px-2.5 py-1 font-sans text-[11px] font-medium text-muted-foreground transition hover:text-primary"
                title="Re-lock Security panel"
              >
                <Lock className="size-3 text-accent" />
                <span>Lock panel</span>
              </button>
            )}
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {emailVerified
              ? "Manage your login password, end-to-end encryption vault passphrase, 6-month zero-knowledge security questions, emergency recovery key, and read how your privacy is protected."
              : "For your protection, confirm via an email sent to your account before opening the Security panel."}
          </DialogDescription>
        </DialogHeader>

        {!emailVerified ? (
          <div className="space-y-4 pt-1">
            <div className="rounded-xl border border-border/80 bg-secondary/30 p-4 space-y-2">
              <div className="flex items-center gap-2 text-accent">
                <Mail className="size-4" />
                <p className="font-hand text-xl text-sepia">verify it&apos;s really you</p>
              </div>
              <h3 className="font-serif text-lg text-primary">Email Confirmation Required</h3>
              <p className="text-xs leading-relaxed text-muted-foreground">
                To protect your passwords, recovery key, and security questions against unauthorized
                access on an unlocked device, please confirm with an email sent to{" "}
                <strong className="text-foreground">{userEmail || "your account email"}</strong>.
              </p>
            </div>

            {!confirmEmailSent ? (
              <div className="space-y-2.5">
                <button
                  type="button"
                  disabled={sendingConfirmEmail || !userEmail}
                  onClick={() => void handleSendSecurityConfirmationEmail()}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
                >
                  <Mail className="size-4" />
                  <span>
                    {sendingConfirmEmail
                      ? "Sending confirmation email..."
                      : `Send Confirmation Email to ${userEmail || "your email"}`}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void startSecurityPanelChallengeOnServer();
                    setConfirmEmailSent(true);
                  }}
                  className="w-full text-center text-xs text-accent hover:text-primary hover:underline"
                >
                  Already received a confirmation email? Click here to verify or paste the link
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="rounded-xl border border-accent/40 bg-accent/10 p-3.5 text-xs leading-relaxed text-foreground space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 font-semibold text-primary">
                      <Check className="size-4 text-accent shrink-0" />
                      <span>Confirmation email sent to {userEmail}</span>
                    </div>
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-accent">
                      <RefreshCw className="size-3 animate-spin" />
                      <span>Listening for click...</span>
                    </span>
                  </div>
                  <p className="text-muted-foreground">
                    <strong>1. Click the link in your email:</strong> Keep this window open and
                    click the confirmation link in the email we sent you—this panel will unlock
                    automatically within 2 seconds (even if the email link opens in another tab).
                  </p>
                  <button
                    type="button"
                    disabled={checkingLinkStatus}
                    onClick={() => void handleCheckEmailLinkClicked()}
                    className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-accent/50 bg-card px-3 py-2 text-xs font-medium text-primary transition hover:bg-secondary disabled:opacity-60"
                  >
                    <ShieldCheck className="size-4 text-accent" />
                    <span>
                      {checkingLinkStatus
                        ? "Checking confirmation status..."
                        : "I've clicked the email link — Unlock Security Panel"}
                    </span>
                  </button>
                </div>

                <form onSubmit={handleVerifyEmailCode} className="space-y-3">
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-foreground/80">
                      <strong>2. Or paste the link from your email:</strong> Right-click the button
                      or link in your email, choose <em>Copy link address</em>, and paste it below
                      (or enter a 6-digit code if your email template includes one):
                    </span>
                    <input
                      type="text"
                      value={otpCode}
                      onChange={(e) => setOtpCode(e.target.value)}
                      placeholder="Paste confirmation link (https://...) or code"
                      className="w-full rounded-lg border border-input bg-card px-3 py-2 font-mono text-xs outline-none focus:border-ring focus:ring-1 focus:ring-ring"
                    />
                  </label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={sendingConfirmEmail}
                      onClick={() => void handleSendSecurityConfirmationEmail()}
                      className="rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground transition hover:bg-secondary hover:text-primary disabled:opacity-60"
                    >
                      {sendingConfirmEmail ? "Sending..." : "Resend email"}
                    </button>
                    <button
                      type="submit"
                      disabled={verifyingOtp || !otpCode.trim()}
                      className="flex-1 rounded-lg bg-primary px-4 py-2 text-xs font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
                    >
                      {verifyingOtp ? "Verifying..." : "Verify Link / Code & Open Security"}
                    </button>
                  </div>
                </form>
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-secondary/40 p-1 text-xs sm:grid-cols-5">
              <button
                type="button"
                onClick={() => setTab("account")}
                className={`rounded-md px-2 py-2 font-medium transition ${
                  tab === "account"
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:text-primary"
                }`}
              >
                Login Password
              </button>
              <button
                type="button"
                onClick={() => setTab("vault")}
                className={`rounded-md px-2 py-2 font-medium transition ${
                  tab === "vault"
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:text-primary"
                }`}
              >
                Vault Passphrase
              </button>
              <button
                type="button"
                onClick={() => setTab("questions")}
                className={`rounded-md px-2 py-2 font-medium transition ${
                  tab === "questions"
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:text-primary"
                }`}
              >
                Security Qs
              </button>
              <button
                type="button"
                onClick={() => setTab("recovery")}
                className={`rounded-md px-2 py-2 font-medium transition ${
                  tab === "recovery"
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:text-primary"
                }`}
              >
                Recovery Key
              </button>
              <button
                type="button"
                onClick={() => setTab("about")}
                className={`col-span-2 rounded-md px-2 py-2 font-medium transition sm:col-span-1 ${
                  tab === "about"
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:text-primary"
                }`}
              >
                About Security
              </button>
            </div>

            {tab === "account" && (
              <div className="space-y-4 pt-1">
                <form onSubmit={handleAccountPasswordSubmit} className="space-y-3">
                  <p className="text-xs text-muted-foreground">
                    Update the password you use to sign in with{" "}
                    <strong className="text-foreground">{userEmail || "your email"}</strong>.
                  </p>

                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-foreground/80">
                      New login password
                    </span>
                    <input
                      type="password"
                      required
                      minLength={6}
                      value={newAccountPassword}
                      onChange={(e) => setNewAccountPassword(e.target.value)}
                      placeholder="At least 6 characters"
                      className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm outline-none focus:border-ring focus:ring-1 focus:ring-ring"
                    />
                  </label>

                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-foreground/80">
                      Confirm new login password
                    </span>
                    <input
                      type="password"
                      required
                      minLength={6}
                      value={confirmAccountPassword}
                      onChange={(e) => setConfirmAccountPassword(e.target.value)}
                      placeholder="Re-enter new password"
                      className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm outline-none focus:border-ring focus:ring-1 focus:ring-ring"
                    />
                  </label>

                  <button
                    type="submit"
                    disabled={accountBusy}
                    className="w-full rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-60"
                  >
                    {accountBusy ? "Updating..." : "Update login password"}
                  </button>
                </form>

                {userEmail && (
                  <div className="border-t border-border/60 pt-3">
                    <button
                      type="button"
                      disabled={sendingResetEmail}
                      onClick={() => void handleSendResetEmail()}
                      className="flex w-full items-center justify-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground hover:bg-secondary hover:text-primary disabled:opacity-60"
                    >
                      <Mail className="size-3.5" />
                      <span>
                        {sendingResetEmail
                          ? "Sending email..."
                          : `Email a password reset link to ${userEmail}`}
                      </span>
                    </button>
                  </div>
                )}
              </div>
            )}

            {tab === "vault" && (
              <div className="space-y-4 pt-1">
                {status !== "unlocked" ? (
                  <div className="rounded-lg border border-border bg-secondary/40 p-4 text-center text-xs text-muted-foreground">
                    <Lock className="mx-auto mb-2 size-5 text-accent" />
                    <p>
                      Unlock your vault first to change your passphrase, or click{" "}
                      <strong>Forgot passphrase?</strong> on the unlock card to reset it after
                      answering your Security Questions.
                    </p>
                  </div>
                ) : (
                  <form onSubmit={handleVaultPassphraseSubmit} className="space-y-3">
                    <p className="text-xs text-muted-foreground">
                      Changing your vault passphrase automatically re-encrypts your private diary,
                      notes, folders, gallery photos, and companion chats with your new key.
                    </p>

                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-foreground/80">
                        Current passphrase
                      </span>
                      <input
                        type="password"
                        required
                        value={currentPassphrase}
                        onChange={(e) => setCurrentPassphrase(e.target.value)}
                        placeholder="Enter current passphrase"
                        className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm outline-none focus:border-ring focus:ring-1 focus:ring-ring"
                      />
                    </label>

                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-foreground/80">
                        New passphrase
                      </span>
                      <input
                        type="password"
                        required
                        minLength={8}
                        value={newPassphrase}
                        onChange={(e) => setNewPassphrase(e.target.value)}
                        placeholder="At least 8 characters"
                        className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm outline-none focus:border-ring focus:ring-1 focus:ring-ring"
                      />
                    </label>

                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-foreground/80">
                        Confirm new passphrase
                      </span>
                      <input
                        type="password"
                        required
                        minLength={8}
                        value={confirmPassphrase}
                        onChange={(e) => setConfirmPassphrase(e.target.value)}
                        placeholder="Re-enter new passphrase"
                        className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm outline-none focus:border-ring focus:ring-1 focus:ring-ring"
                      />
                    </label>

                    {vaultProgress && (
                      <p className="text-center font-hand text-base text-sepia">{vaultProgress}</p>
                    )}

                    <button
                      type="submit"
                      disabled={vaultBusy}
                      className="w-full rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-60"
                    >
                      {vaultBusy ? "Re-encrypting vault..." : "Change vault passphrase"}
                    </button>
                  </form>
                )}
              </div>
            )}

            {tab === "questions" && (
              <div className="space-y-4 pt-1">
                {sqLoading ? (
                  <p className="py-6 text-center font-hand text-lg text-sepia">
                    checking your security questions...
                  </p>
                ) : sqRecord && !editingQuestions ? (
                  <div className="space-y-4">
                    <div
                      className={`flex items-start justify-between gap-3 rounded-lg border p-3.5 text-xs ${
                        sqExpired
                          ? "border-destructive/40 bg-destructive/10 text-foreground"
                          : "border-border bg-secondary/35 text-foreground"
                      }`}
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-1.5 font-semibold text-primary">
                          {sqExpired ? (
                            <ShieldAlert className="size-4 text-destructive" />
                          ) : (
                            <ShieldCheck className="size-4 text-accent" />
                          )}
                          <span>
                            {sqExpired
                              ? "6-Month Rotation Due — Old Questions Remain Active Until Rotated"
                              : "3 Zero-Knowledge Security Questions Active"}
                          </span>
                        </div>
                        <p className="text-muted-foreground leading-relaxed">
                          {sqExpired ? (
                            <>
                              Your security questions reached their 6-month depreciation mark. Your
                              existing answers still work for password &amp; vault recovery right
                              now, and you can rotate to 3 new questions below.
                            </>
                          ) : (
                            <>
                              Required first whenever you click <strong>Forgot password?</strong> on
                              sign-in or <strong>Forgot passphrase?</strong> on vault unlock.
                            </>
                          )}
                        </p>
                      </div>
                      <div className="shrink-0 rounded-md border border-border bg-card px-2.5 py-1.5 text-right">
                        <div className="flex items-center gap-1 text-[11px] font-medium text-accent">
                          <Clock className="size-3" />
                          <span>{sqExpired ? "Due now" : `${sqDaysLeft}d left`}</span>
                        </div>
                        <div className="text-[10px] text-muted-foreground">6-month cycle</div>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <div className="text-xs font-medium text-foreground/80">
                        Your Active Questions:
                      </div>
                      {sqRecord.questions.map((q, idx) => (
                        <div
                          key={q.id}
                          className="rounded-lg border border-border/80 bg-card/80 px-3 py-2.5 text-xs"
                        >
                          <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-accent">
                            <span>Question {idx + 1}</span>
                            <span>PBKDF2-SHA256 (250k rounds)</span>
                          </div>
                          <p className="mt-0.5 font-medium text-primary">{q.question}</p>
                        </div>
                      ))}
                    </div>

                    <button
                      type="button"
                      onClick={() => {
                        const currentSet = new Set(sqRecord.questions.map((q) => q.id));
                        setQuestionSlots(getDefaultQuestionSlots(currentSet));
                        setEditingQuestions(true);
                      }}
                      className="flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:opacity-90"
                    >
                      <RefreshCw className="size-3.5" />
                      <span>Rotate / Choose New Security Questions</span>
                    </button>
                  </div>
                ) : (
                  <form onSubmit={handleSaveSecurityQuestions} className="space-y-3.5">
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      Choose 3 hard personal memory questions. Answers are salted and stretched with{" "}
                      <strong>250,000 rounds of PBKDF2-HMAC-SHA256</strong> on your device—plaintext
                      answers never leave your browser. Questions automatically depreciate after{" "}
                      <strong>6 months</strong>.
                    </p>

                    <SecurityQuestionsPicker
                      slots={questionSlots}
                      onChange={setQuestionSlots}
                      compact
                    />

                    <div className="flex gap-2 pt-1">
                      {sqRecord && (
                        <button
                          type="button"
                          onClick={() => setEditingQuestions(false)}
                          className="flex-1 rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground hover:text-primary"
                        >
                          Cancel
                        </button>
                      )}
                      <button
                        type="submit"
                        disabled={sqBusy}
                        className="flex-1 rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
                      >
                        {sqBusy ? "Encrypting & saving..." : "Save 6-Month Security Questions"}
                      </button>
                    </div>
                  </form>
                )}
              </div>
            )}

            {tab === "recovery" && (
              <div className="space-y-4 pt-1">
                {status !== "unlocked" || !recoveryKey ? (
                  <div className="rounded-lg border border-border bg-secondary/40 p-4 text-center text-xs text-muted-foreground">
                    <KeyRound className="mx-auto mb-2 size-5 text-accent" />
                    <p>Unlock your vault to view or download your emergency Recovery Key.</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      Save this <strong>Emergency Recovery Key</strong> in a password manager or
                      safe place. If you ever forget your Vault Passphrase, answer your 3 Security
                      Questions after clicking <strong>Forgot passphrase?</strong> and enter this
                      key to reset your passphrase without losing any data.
                    </p>

                    <div className="rounded-lg border border-border bg-secondary/50 p-3.5 text-center">
                      <code className="select-all font-mono text-sm font-semibold tracking-wider text-primary">
                        {recoveryKey}
                      </code>
                    </div>

                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => void copyRecoveryKey(recoveryKey)}
                        className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-xs font-medium text-primary hover:bg-secondary"
                      >
                        {copiedRecovery ? (
                          <Check className="size-3.5 text-accent" />
                        ) : (
                          <Copy className="size-3.5" />
                        )}
                        <span>{copiedRecovery ? "Copied" : "Copy key"}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => downloadRecoveryKey(recoveryKey)}
                        className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-xs font-medium text-primary hover:bg-secondary"
                      >
                        <Download className="size-3.5" />
                        <span>Download .txt</span>
                      </button>
                    </div>

                    <div className="border-t border-border/60 pt-3">
                      {!showRegenForm ? (
                        <button
                          type="button"
                          onClick={() => setShowRegenForm(true)}
                          className="flex w-full items-center justify-center gap-1.5 text-xs text-muted-foreground hover:text-primary"
                        >
                          <RefreshCw className="size-3.5" />
                          <span>Generate a new Recovery Key (invalidates old key)</span>
                        </button>
                      ) : (
                        <form onSubmit={handleRegenerateKey} className="space-y-2">
                          <label className="block">
                            <span className="mb-1 block text-xs font-medium text-foreground/80">
                              Confirm current vault passphrase to generate a new key
                            </span>
                            <input
                              type="password"
                              required
                              value={regenPassphrase}
                              onChange={(e) => setRegenPassphrase(e.target.value)}
                              placeholder="Current passphrase"
                              className="w-full rounded-md border border-input bg-card px-3 py-1.5 text-xs outline-none focus:border-ring"
                            />
                          </label>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setShowRegenForm(false);
                                setRegenPassphrase("");
                              }}
                              className="flex-1 rounded-md border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground hover:text-primary"
                            >
                              Cancel
                            </button>
                            <button
                              type="submit"
                              disabled={regenBusy}
                              className="flex-1 rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:opacity-90 disabled:opacity-60"
                            >
                              {regenBusy ? "Generating..." : "Confirm new key"}
                            </button>
                          </div>
                        </form>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {tab === "about" && (
              <div className="space-y-3.5 pt-1 text-xs leading-relaxed text-muted-foreground">
                <div className="rounded-lg border border-border bg-secondary/35 p-3.5">
                  <p className="font-hand text-xl text-sepia">built like a physical lockbox</p>
                  <h3 className="font-serif text-lg text-primary">
                    How Security Works on The PaperVault
                  </h3>
                  <p className="mt-1">
                    The PaperVault is engineered around a strict{" "}
                    <strong className="text-foreground">
                      zero-knowledge, client-side encryption
                    </strong>{" "}
                    architecture. Neither our servers, database providers, nor network
                    intermediaries can ever read your private thoughts.
                  </p>
                </div>

                <div className="grid gap-2.5 sm:grid-cols-2">
                  <div className="rounded-lg border border-border/80 bg-card/80 p-3 space-y-1">
                    <div className="flex items-center gap-1.5 font-semibold text-primary">
                      <Lock className="size-3.5 text-accent" />
                      <span>1. AES-256-GCM Client-Side Encryption</span>
                    </div>
                    <p>
                      Every private diary entry, note, folder name, gallery photo, companion chat
                      message, and local browser draft is encrypted inside your browser using{" "}
                      <strong>256-bit AES-GCM</strong> with a fresh 96-bit random IV before it ever
                      leaves your device.
                    </p>
                  </div>

                  <div className="rounded-lg border border-border/80 bg-card/80 p-3 space-y-1">
                    <div className="flex items-center gap-1.5 font-semibold text-primary">
                      <KeyRound className="size-3.5 text-accent" />
                      <span>2. 250,000-Round Key Stretching</span>
                    </div>
                    <p>
                      Your Vault Passphrase is never transmitted. Instead, WebCrypto stretches it
                      through <strong>250,000 rounds of PBKDF2-HMAC-SHA256</strong> with a 128-bit
                      cryptographic salt to derive a non-extractable in-memory key.
                    </p>
                  </div>

                  <div className="rounded-lg border border-border/80 bg-card/80 p-3 space-y-1">
                    <div className="flex items-center gap-1.5 font-semibold text-primary">
                      <ShieldCheck className="size-3.5 text-accent" />
                      <span>3. Salted Security Questions &amp; 6-Month Rotation</span>
                    </div>
                    <p>
                      Your 3 security question answers are normalized, salted individually and
                      jointly, and hashed with 250,000 rounds of PBKDF2-HMAC-SHA256 on your device.
                      Questions depreciate every <strong>6 months</strong> (while keeping your
                      previous set active for recovery if you haven&apos;t logged in yet) and gate
                      both sign-in password resets and vault passphrase recovery.
                    </p>
                  </div>

                  <div className="rounded-lg border border-border/80 bg-card/80 p-3 space-y-1">
                    <div className="flex items-center gap-1.5 font-semibold text-primary">
                      <Sparkles className="size-3.5 text-accent" />
                      <span>4. Auto-Lock &amp; Zero AI Scanning</span>
                    </div>
                    <p>
                      Your decrypted key resides only in volatile RAM and is wiped after{" "}
                      <strong>15 minutes of inactivity</strong> or when you click Lock. No AI ever
                      scans your diary or notes—only messages you explicitly send in the Companion
                      tab are processed.
                    </p>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
