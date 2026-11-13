import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  consumeEmailCallbackIntent,
  EMAIL_AUTH_CALLBACK_EVENT,
  peekEmailCallbackIntent,
  setPendingEmailIntent,
  supabase,
} from "@/integrations/supabase/client";
import { cacheAuthSession } from "@/lib/offline-supabase";
import { ThemeToggleButton } from "@/lib/theme";
import { markFirstTimeSignup } from "@/components/WelcomeTour";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Clock,
  KeyRound,
  Lock,
  Mail,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import {
  buildSecurityQuestionsRecord,
  computeSecurityAnswerVerifiers,
  fetchEmailSecurityChallenge,
  saveSecurityQuestionsToServer,
  type SecurityQuestionsChallenge,
  stashPendingSignupSecurityQuestions,
  verifyEmailSecurityChallengeOnServer,
} from "@/lib/security-questions";
import {
  formatLockoutCountdown,
  formatLockoutDuration,
  signinSecurityPreflight,
  signinSecurityVerify,
  type ForceSignOutDetail,
  type SigninPreflightResult,
} from "@/lib/vault-lockout";
import {
  getDefaultQuestionSlots,
  type QuestionDraftSlot,
  SecurityQuestionsPicker,
} from "@/components/SecurityQuestionsOnboardingModal";

function isPasswordRecoveryUrl(): boolean {
  if (typeof window === "undefined") return false;
  const search = new URLSearchParams(window.location.search);
  const hash = window.location.hash || "";
  if (
    search.get("mode") === "reset" ||
    search.get("type") === "recovery" ||
    hash.includes("type=recovery")
  ) {
    return true;
  }
  return peekEmailCallbackIntent() === "password_reset";
}

export const Route = createFileRoute("/auth")({
  ssr: false,
  beforeLoad: async () => {
    if (isPasswordRecoveryUrl()) {
      return;
    }
    const { data } = await supabase.auth.getSession();
    if (peekEmailCallbackIntent(data.session) === "password_reset") {
      return;
    }
    if (data.session?.user) throw redirect({ to: "/app" });
  },
  head: () => ({ meta: [{ title: "Sign in · The PaperVault" }] }),
  component: AuthPage,
});

type AuthMode = "signin" | "signup" | "forgot" | "reset";
type ForgotStep = "enter_email" | "answer_questions" | "email_sent";
type SigninStep = "credentials" | "security_questions";

function readInitialAuthNotice(): ForceSignOutDetail | null {
  if (typeof window === "undefined") return null;
  let fromStorage: ForceSignOutDetail | null = null;
  try {
    const raw = window.sessionStorage.getItem("papervault:auth_notice");
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ForceSignOutDetail>;
      if (parsed.notice === "vault_attempts_signout" || parsed.notice === "vault_locked") {
        fromStorage = {
          notice: parsed.notice,
          lockedUntil: typeof parsed.lockedUntil === "number" ? parsed.lockedUntil : undefined,
          durationMs: typeof parsed.durationMs === "number" ? parsed.durationMs : undefined,
          lockoutCount: typeof parsed.lockoutCount === "number" ? parsed.lockoutCount : undefined,
          emailSent: typeof parsed.emailSent === "boolean" ? parsed.emailSent : undefined,
        };
      }
    }
  } catch {
    // ignore
  }

  try {
    const search = new URLSearchParams(window.location.search);
    const noticeParam = search.get("notice");
    if (noticeParam === "vault_attempts_signout" || noticeParam === "vault_locked") {
      const untilNum = Number(search.get("until") || "");
      const durationNum = Number(search.get("duration") || "");
      const countNum = Number(search.get("lockoutCount") || "");
      const emailSentParam = search.get("emailSent");
      return {
        notice: noticeParam,
        lockedUntil:
          Number.isFinite(untilNum) && untilNum > 0 ? untilNum : fromStorage?.lockedUntil,
        durationMs:
          Number.isFinite(durationNum) && durationNum > 0 ? durationNum : fromStorage?.durationMs,
        lockoutCount:
          Number.isFinite(countNum) && countNum > 0 ? countNum : fromStorage?.lockoutCount,
        emailSent:
          emailSentParam === "1" ? true : emailSentParam === "0" ? false : fromStorage?.emailSent,
      };
    }
  } catch {
    // ignore
  }

  return fromStorage;
}

function AuthPage() {
  const router = useRouter();
  const [mode, setMode] = useState<AuthMode>(() => (isPasswordRecoveryUrl() ? "reset" : "signin"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [loading, setLoading] = useState(false);

  // Forced sign-out / lockout notice state
  const [authNotice] = useState<ForceSignOutDetail | null>(() => readInitialAuthNotice());
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Escalated sign-in Security Questions challenge state
  const [signinStep, setSigninStep] = useState<SigninStep>("credentials");
  const [signinChallenge, setSigninChallenge] = useState<SecurityQuestionsChallenge | null>(null);
  const [signinSqAnswers, setSigninSqAnswers] = useState<[string, string, string]>(["", "", ""]);
  const [signinLockoutInfo, setSigninLockoutInfo] = useState<
    SigninPreflightResult["lockout"] | null
  >(null);

  // First-time Sign-Up Security Questions state
  const [signupQuestionSlots, setSignupQuestionSlots] = useState<
    [QuestionDraftSlot, QuestionDraftSlot, QuestionDraftSlot]
  >(() => getDefaultQuestionSlots());

  // Forgot Password Security Questions challenge state
  const [forgotStep, setForgotStep] = useState<ForgotStep>("enter_email");
  const [challenge, setChallenge] = useState<SecurityQuestionsChallenge | null>(null);
  const [challengeAnswers, setChallengeAnswers] = useState<[string, string, string]>(["", "", ""]);

  const switchMode = (nextMode: AuthMode) => {
    setMode(nextMode);
    setSigninStep("credentials");
    setSigninChallenge(null);
    setSigninSqAnswers(["", "", ""]);
    setSigninLockoutInfo(null);
  };

  useEffect(() => {
    if (typeof window !== "undefined") {
      try {
        window.sessionStorage.removeItem("papervault:auth_notice");
      } catch {
        // ignore
      }
    }
  }, []);

  const activeLockedUntil = Math.max(
    authNotice?.lockedUntil ?? 0,
    signinLockoutInfo?.lockedUntil ?? 0,
  );

  useEffect(() => {
    if (!activeLockedUntil || activeLockedUntil <= Date.now()) return;
    setNowMs(Date.now());
    const id = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(id);
  }, [activeLockedUntil]);

  useEffect(() => {
    if (isPasswordRecoveryUrl()) {
      consumeEmailCallbackIntent();
      setMode("reset");
    }
    const onEmailCallback = (e: Event) => {
      const detail = (e as CustomEvent<{ intent?: string }>).detail;
      if (detail?.intent === "password_reset" || isPasswordRecoveryUrl()) {
        consumeEmailCallbackIntent();
        setMode("reset");
      }
    };
    window.addEventListener(EMAIL_AUTH_CALLBACK_EVENT, onEmailCallback);
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY" || peekEmailCallbackIntent(session) === "password_reset") {
        consumeEmailCallbackIntent(session);
        setMode("reset");
      }
    });
    return () => {
      window.removeEventListener(EMAIL_AUTH_CALLBACK_EVENT, onEmailCallback);
      subscription.unsubscribe();
    };
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (mode === "forgot") {
        const cleanEmail = email.trim().toLowerCase();
        if (!cleanEmail) {
          throw new Error("Please enter your email address.");
        }

        if (forgotStep === "enter_email") {
          const foundChallenge = await fetchEmailSecurityChallenge(cleanEmail);
          if (foundChallenge) {
            setChallenge(foundChallenge);
            setChallengeAnswers(["", "", ""]);
            setForgotStep("answer_questions");
            toast.info("Please answer your 3 security questions first to continue.");
            return;
          }
          // If the user hasn't set security questions yet on this email, send reset link directly
          setPendingEmailIntent("password_reset");
          const { error } = await supabase.auth.resetPasswordForEmail(cleanEmail, {
            redirectTo: `${window.location.origin}/auth`,
          });
          if (error) throw error;
          setForgotStep("email_sent");
          toast.success("Password reset link sent! Check your email inbox.");
          return;
        }

        if (forgotStep === "answer_questions" && challenge) {
          const verified = await verifyEmailSecurityChallengeOnServer(
            cleanEmail,
            challenge,
            challengeAnswers,
          );
          if (!verified) {
            throw new Error("Security question answers did not match. Please try again.");
          }
          setPendingEmailIntent("password_reset");
          const { error } = await supabase.auth.resetPasswordForEmail(cleanEmail, {
            redirectTo: `${window.location.origin}/auth`,
          });
          if (error) throw error;
          setForgotStep("email_sent");
          toast.success("Security questions verified! Password reset link sent to your email.");
          return;
        }
        return;
      }

      if (mode === "reset") {
        if (password.length < 6) {
          throw new Error("New password must be at least 6 characters.");
        }
        if (password !== confirmPassword) {
          throw new Error("Passwords do not match.");
        }
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw error;
        consumeEmailCallbackIntent();
        toast.success("Your password has been updated!");
        router.navigate({ to: "/app", replace: true });
        return;
      }

      if (mode === "signup") {
        const trimmedName = displayName.trim();
        if (!trimmedName) {
          throw new Error("Please enter a display name.");
        }
        // Build zero-knowledge encrypted/hashed security questions before creating the account
        const sqRecord = await buildSecurityQuestionsRecord({
          selectedQuestions: signupQuestionSlots,
        });
        stashPendingSignupSecurityQuestions(sqRecord);

        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: `${window.location.origin}/app`,
            data: { display_name: trimmedName },
          },
        });
        if (error) throw error;
        if (data.user) {
          markFirstTimeSignup(data.user.id);
        }
        if (data.user && data.session) {
          await Promise.allSettled([
            supabase.from("profiles").upsert({ id: data.user.id, display_name: trimmedName }),
            saveSecurityQuestionsToServer(data.user.id, {
              ...sqRecord,
              user_id: data.user.id,
            }),
          ]);
        }
        toast.success("Welcome! Check your email if confirmation is required.");
      } else {
        if (signinStep === "credentials") {
          const preflight = await signinSecurityPreflight(email, password);
          if (preflight.requireSecurityQuestions && preflight.challenge) {
            setSigninChallenge(preflight.challenge);
            setSigninSqAnswers(["", "", ""]);
            setSigninLockoutInfo(preflight.lockout);
            setSigninStep("security_questions");
            toast.info(
              "Security verification required: please answer your 3 security questions to sign in.",
            );
            return;
          }
          if (preflight.session) {
            cacheAuthSession(preflight.session);
            const { error: setErr } = await supabase.auth.setSession(preflight.session);
            if (setErr) throw setErr;
          } else {
            const { error } = await supabase.auth.signInWithPassword({ email, password });
            if (error) throw error;
          }
        } else {
          if (!signinChallenge) {
            setSigninStep("credentials");
            throw new Error("Security challenge expired. Please sign in again.");
          }
          const { verifiers, combinedVerifier } = await computeSecurityAnswerVerifiers(
            signinChallenge,
            signinSqAnswers,
          );
          const verifiedRes = await signinSecurityVerify({
            email,
            password,
            verifiers,
            combined_verifier: combinedVerifier,
          });
          if (!verifiedRes.verified || !verifiedRes.session) {
            throw new Error("One or more security question answers did not match.");
          }
          cacheAuthSession(verifiedRes.session);
          const { error: setErr } = await supabase.auth.setSession(verifiedRes.session);
          if (setErr) throw setErr;
        }
      }
      router.navigate({ to: "/app", replace: true });
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center px-4 py-10">
      <div className="fixed top-4 right-4 z-40">
        <ThemeToggleButton
          className="flex items-center gap-1.5 rounded-xl border border-border/70 bg-card/85 px-3 py-2 text-xs text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-secondary hover:text-primary"
          showLabel
        />
      </div>
      <div className={`paper-card w-full p-8 ${mode === "signup" ? "max-w-lg" : "max-w-md"}`}>
        <p className="font-hand text-2xl text-sepia text-center">
          {mode === "signin"
            ? "welcome back"
            : mode === "signup"
              ? "begin your story"
              : mode === "forgot"
                ? "account recovery"
                : "choose a new key"}
        </p>
        <h1 className="mt-1 text-center font-serif text-3xl text-primary">
          {mode === "signin"
            ? signinStep === "security_questions"
              ? "Verify your identity"
              : "Open your journal"
            : mode === "signup"
              ? "Create your journal"
              : mode === "forgot"
                ? "Reset your password"
                : "Set new password"}
        </h1>

        {mode === "signin" && authNotice && (
          <div
            className={`mt-5 rounded-lg border p-3.5 text-xs leading-relaxed ${
              authNotice.notice === "vault_locked"
                ? "border-destructive/40 bg-destructive/10 text-foreground"
                : "border-amber-500/40 bg-amber-500/10 text-foreground"
            }`}
          >
            <div className="flex items-start gap-2.5">
              {authNotice.notice === "vault_locked" ? (
                <ShieldAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
              ) : (
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
              )}
              <div className="space-y-1">
                {authNotice.notice === "vault_locked" ? (
                  <>
                    <p className="font-semibold text-destructive">
                      Signed out & vault locked
                      {authNotice.durationMs
                        ? ` for ${formatLockoutDuration(authNotice.durationMs)}`
                        : ""}
                    </p>
                    {authNotice.lockedUntil && authNotice.lockedUntil > nowMs ? (
                      <p className="flex items-center gap-1.5 text-muted-foreground">
                        <Clock className="size-3.5 shrink-0 text-destructive" />
                        <span>
                          Cooldown remaining:{" "}
                          <strong className="font-mono text-foreground">
                            {formatLockoutCountdown(authNotice.lockedUntil - nowMs)}
                          </strong>
                        </span>
                      </p>
                    ) : authNotice.lockedUntil ? (
                      <p className="text-muted-foreground">Your vault cooldown period has ended.</p>
                    ) : null}
                    <p className="text-muted-foreground">
                      {authNotice.emailSent
                        ? "A security alert has been emailed to your account address. "
                        : ""}
                      Signing back in requires answering your 3 security questions.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="font-semibold text-foreground">
                      Signed out after repeated wrong passphrase attempts
                    </p>
                    <p className="text-muted-foreground">
                      For your protection, signing back in will require answering your 3 security
                      questions. Another wrong passphrase afterward will lock your vault for 1 hour.
                    </p>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {mode === "forgot" && forgotStep === "email_sent" ? (
          <div className="mt-6 space-y-4">
            <div className="rounded-lg border border-border bg-secondary/40 p-4 text-sm text-foreground space-y-2">
              <div className="flex items-center gap-2 font-medium text-primary">
                <CheckCircle2 className="size-4 text-accent shrink-0" />
                <span>Reset link sent to {email}</span>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Open the email we just sent you and click the recovery link to set a new account
                password.
              </p>
            </div>

            <button
              type="button"
              onClick={() => {
                setForgotStep("enter_email");
                setChallenge(null);
                switchMode("signin");
              }}
              className="flex w-full items-center justify-center gap-1.5 rounded-md border border-border bg-card px-4 py-2.5 text-sm text-primary hover:bg-secondary"
            >
              <ArrowLeft className="size-4" /> Back to sign in
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="mt-6 space-y-4">
            {mode === "forgot" && forgotStep === "enter_email" && (
              <p className="text-center text-xs text-muted-foreground">
                Enter your account email. We will verify your security questions first before
                sending your password reset link.
              </p>
            )}

            {mode === "forgot" && forgotStep === "answer_questions" && challenge && (
              <div className="space-y-3">
                <div className="flex items-center justify-between rounded-lg border border-border bg-secondary/35 px-3 py-2 text-xs">
                  <span className="font-medium text-primary">
                    Step 1: Verify Security Questions
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setForgotStep("enter_email");
                      setChallenge(null);
                    }}
                    className="text-accent hover:underline"
                  >
                    Change email
                  </button>
                </div>

                {challenge.questions.map((q, idx) => (
                  <label
                    key={q.id}
                    className="block rounded-lg border border-border/80 bg-secondary/20 p-3 space-y-1.5"
                  >
                    <span className="block text-xs font-medium text-primary">{q.question}</span>
                    <input
                      type="password"
                      required
                      value={challengeAnswers[idx] ?? ""}
                      onChange={(e) => {
                        const next = [...challengeAnswers] as [string, string, string];
                        next[idx] = e.target.value;
                        setChallengeAnswers(next);
                      }}
                      placeholder="Your answer"
                      className="w-full rounded-md border border-input bg-card px-3 py-1.5 text-sm text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring"
                    />
                  </label>
                ))}
              </div>
            )}

            {mode === "reset" && (
              <p className="text-center text-xs text-muted-foreground">
                Enter a new login password for your PaperVault account below.
              </p>
            )}

            {mode === "signup" && (
              <Field
                label="Display name"
                required
                value={displayName}
                onChange={setDisplayName}
                placeholder="What should we call you?"
              />
            )}

            {mode === "signin" && signinStep === "security_questions" && signinChallenge && (
              <div className="space-y-3">
                <div className="flex items-center justify-between rounded-lg border border-border bg-secondary/35 px-3 py-2 text-xs">
                  <span className="flex items-center gap-1.5 font-medium text-primary">
                    <ShieldCheck className="size-4 text-accent shrink-0" />
                    <span>Security Questions Required</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setSigninStep("credentials");
                      setSigninChallenge(null);
                      setSigninSqAnswers(["", "", ""]);
                      setSigninLockoutInfo(null);
                    }}
                    className="text-accent hover:underline"
                  >
                    Back
                  </button>
                </div>

                {signinLockoutInfo?.isLocked && signinLockoutInfo.lockedUntil > nowMs && (
                  <div className="flex items-start gap-2 rounded-lg border border-destructive/35 bg-destructive/10 p-2.5 text-xs text-muted-foreground">
                    <Clock className="mt-0.5 size-3.5 shrink-0 text-destructive" />
                    <span>
                      Note: Your vault remains locked for{" "}
                      <strong className="font-mono text-foreground">
                        {formatLockoutCountdown(signinLockoutInfo.lockedUntil - nowMs)}
                      </strong>{" "}
                      even after signing in.
                    </span>
                  </div>
                )}

                {signinChallenge.questions.map((q, idx) => (
                  <label
                    key={q.id}
                    className="block rounded-lg border border-border/80 bg-secondary/20 p-3 space-y-1.5"
                  >
                    <span className="block text-[11px] font-semibold uppercase tracking-wide text-accent">
                      Question {idx + 1}
                    </span>
                    <span className="block text-xs font-medium text-primary">{q.question}</span>
                    <input
                      type="password"
                      required
                      value={signinSqAnswers[idx] ?? ""}
                      onChange={(e) => {
                        const next = [...signinSqAnswers] as [string, string, string];
                        next[idx] = e.target.value;
                        setSigninSqAnswers(next);
                      }}
                      placeholder="Your answer"
                      className="w-full rounded-md border border-input bg-card px-3 py-1.5 text-sm text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring"
                    />
                  </label>
                ))}
              </div>
            )}

            {mode !== "reset" &&
              !(mode === "forgot" && forgotStep === "answer_questions") &&
              !(mode === "signin" && signinStep === "security_questions") && (
                <Field
                  label="Email"
                  type="email"
                  required
                  value={email}
                  onChange={setEmail}
                  placeholder="you@example.com"
                />
              )}

            {((mode === "signin" && signinStep === "credentials") || mode === "signup") && (
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-sm font-medium text-foreground/80">Password</span>
                  {mode === "signin" && (
                    <button
                      type="button"
                      onClick={() => {
                        setForgotStep("enter_email");
                        setChallenge(null);
                        switchMode("forgot");
                      }}
                      className="text-xs text-accent hover:text-primary hover:underline"
                    >
                      Forgot password?
                    </button>
                  )}
                </div>
                <input
                  type="password"
                  required
                  value={password}
                  placeholder="••••••••"
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-md border border-input bg-card px-3 py-2 text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring"
                />
              </div>
            )}

            {mode === "signup" && (
              <div className="space-y-3 border-t border-border/70 pt-4">
                <div className="flex items-center gap-2 text-primary">
                  <ShieldCheck className="size-4 text-accent shrink-0" />
                  <span className="font-serif text-lg">Security Questions (6-Month Shield)</span>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Choose 3 tough personal memory questions. Your answers are stretched with 250,000
                  rounds of PBKDF2-SHA256 in your browser so no one can intercept them, and they are
                  required whenever you reset a forgotten password.
                </p>
                <SecurityQuestionsPicker
                  slots={signupQuestionSlots}
                  onChange={setSignupQuestionSlots}
                  compact
                />
                <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Lock className="size-3 text-accent shrink-0" />
                  <span>Zero-knowledge encrypted on-device · Rotates every 6 months</span>
                </p>
              </div>
            )}

            {mode === "reset" && (
              <>
                <Field
                  label="New password"
                  type="password"
                  required
                  value={password}
                  onChange={setPassword}
                  placeholder="At least 6 characters"
                />
                <Field
                  label="Confirm new password"
                  type="password"
                  required
                  value={confirmPassword}
                  onChange={setConfirmPassword}
                  placeholder="Re-enter new password"
                />
              </>
            )}

            <button
              type="submit"
              disabled={loading}
              className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-primary-foreground hover:opacity-90 disabled:opacity-60"
            >
              {mode === "forgot" && <Mail className="size-4" />}
              {mode === "reset" && <KeyRound className="size-4" />}
              <span>
                {loading
                  ? "Please wait..."
                  : mode === "signin"
                    ? signinStep === "security_questions"
                      ? "Verify answers & sign in"
                      : "Sign in"
                    : mode === "signup"
                      ? "Create account"
                      : mode === "forgot"
                        ? forgotStep === "enter_email"
                          ? "Continue to security questions"
                          : "Verify answers & send reset link"
                        : "Save new password"}
              </span>
            </button>
          </form>
        )}

        {mode === "forgot" && forgotStep !== "email_sent" && (
          <p className="mt-6 text-center text-sm text-muted-foreground">
            Remembered your password?{" "}
            <button
              type="button"
              onClick={() => {
                setForgotStep("enter_email");
                setChallenge(null);
                switchMode("signin");
              }}
              className="text-primary underline"
            >
              Sign in
            </button>
          </p>
        )}

        {(mode === "signin" || mode === "signup") && (
          <p className="mt-6 text-center text-sm text-muted-foreground">
            {mode === "signin" ? "No account yet?" : "Already have one?"}{" "}
            <button
              type="button"
              onClick={() => switchMode(mode === "signin" ? "signup" : "signin")}
              className="text-primary underline"
            >
              {mode === "signin" ? "Create one" : "Sign in"}
            </button>
          </p>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  required,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-foreground/80">{label}</span>
      <input
        type={type}
        required={required}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-input bg-card px-3 py-2 text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring"
      />
    </label>
  );
}
