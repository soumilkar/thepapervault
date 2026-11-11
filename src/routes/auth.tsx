import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  consumeEmailCallbackIntent,
  EMAIL_AUTH_CALLBACK_EVENT,
  peekEmailCallbackIntent,
  setPendingEmailIntent,
  supabase,
} from "@/integrations/supabase/client";
import { ThemeToggleButton } from "@/lib/theme";
import { markFirstTimeSignup } from "@/components/WelcomeTour";
import { toast } from "sonner";
import { ArrowLeft, CheckCircle2, KeyRound, Lock, Mail, ShieldCheck } from "lucide-react";
import {
  buildSecurityQuestionsRecord,
  fetchEmailSecurityChallenge,
  saveSecurityQuestionsToServer,
  type SecurityQuestionsChallenge,
  stashPendingSignupSecurityQuestions,
  verifyEmailSecurityChallengeOnServer,
} from "@/lib/security-questions";
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

function AuthPage() {
  const router = useRouter();
  const [mode, setMode] = useState<AuthMode>(() => (isPasswordRecoveryUrl() ? "reset" : "signin"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [loading, setLoading] = useState(false);
  const [pastedResetLink, setPastedResetLink] = useState("");
  const [verifyingResetLink, setVerifyingResetLink] = useState(false);

  // First-time Sign-Up Security Questions state
  const [signupQuestionSlots, setSignupQuestionSlots] = useState<
    [QuestionDraftSlot, QuestionDraftSlot, QuestionDraftSlot]
  >(() => getDefaultQuestionSlots());

  // Forgot Password Security Questions challenge state
  const [forgotStep, setForgotStep] = useState<ForgotStep>("enter_email");
  const [challenge, setChallenge] = useState<SecurityQuestionsChallenge | null>(null);
  const [challengeAnswers, setChallengeAnswers] = useState<[string, string, string]>(["", "", ""]);

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

  const handleVerifyPastedResetLink = async (e: React.FormEvent) => {
    e.preventDefault();
    const raw = pastedResetLink.trim();
    if (!raw) return;
    setVerifyingResetLink(true);
    try {
      let verified = false;
      if (raw.startsWith("http://") || raw.startsWith("https://")) {
        const parsed = new URL(raw);
        const tokenParam =
          parsed.searchParams.get("token_hash") || parsed.searchParams.get("token") || "";
        const codeParam = parsed.searchParams.get("code") || "";
        if (tokenParam) {
          for (const t of ["recovery", "magiclink", "email"] as const) {
            const { error } = await supabase.auth.verifyOtp({ token_hash: tokenParam, type: t });
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
        if (!verified && parsed.hash.includes("access_token=")) {
          const hashParams = new URLSearchParams(parsed.hash.replace(/^#/, ""));
          const accessToken = hashParams.get("access_token") || "";
          const refreshToken = hashParams.get("refresh_token") || "";
          if (accessToken && refreshToken) {
            const { error } = await supabase.auth.setSession({
              access_token: accessToken,
              refresh_token: refreshToken,
            });
            if (!error) verified = true;
          }
        }
      } else if (email.trim()) {
        for (const t of ["recovery", "email", "magiclink"] as const) {
          const { error } = await supabase.auth.verifyOtp({
            email: email.trim().toLowerCase(),
            token: raw,
            type: t,
          });
          if (!error) {
            verified = true;
            break;
          }
        }
      }
      if (!verified) {
        throw new Error(
          "Could not verify that reset link. Right-click the button in your reset email, copy the link address, and paste it here.",
        );
      }
      setPastedResetLink("");
      setMode("reset");
      toast.success("Reset link verified! Enter your new password below.");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Could not verify reset link");
    } finally {
      setVerifyingResetLink(false);
    }
  };

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
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
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
            ? "Open your journal"
            : mode === "signup"
              ? "Create your journal"
              : mode === "forgot"
                ? "Reset your password"
                : "Set new password"}
        </h1>

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

            <form onSubmit={handleVerifyPastedResetLink} className="space-y-2.5">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-foreground/80">
                  Or right-click the reset link in your email, copy the link address, and paste it
                  here to reset right in this tab:
                </span>
                <input
                  type="text"
                  value={pastedResetLink}
                  onChange={(e) => setPastedResetLink(e.target.value)}
                  placeholder="Paste reset link from email (https://...)"
                  className="w-full rounded-md border border-input bg-card px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring"
                />
              </label>
              {pastedResetLink.trim() && (
                <button
                  type="submit"
                  disabled={verifyingResetLink}
                  className="w-full rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
                >
                  {verifyingResetLink
                    ? "Verifying reset link..."
                    : "Verify Reset Link & Set New Password"}
                </button>
              )}
            </form>

            <button
              type="button"
              onClick={() => {
                setForgotStep("enter_email");
                setChallenge(null);
                setMode("signin");
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

            {mode !== "reset" && !(mode === "forgot" && forgotStep === "answer_questions") && (
              <Field
                label="Email"
                type="email"
                required
                value={email}
                onChange={setEmail}
                placeholder="you@example.com"
              />
            )}

            {(mode === "signin" || mode === "signup") && (
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-sm font-medium text-foreground/80">Password</span>
                  {mode === "signin" && (
                    <button
                      type="button"
                      onClick={() => {
                        setForgotStep("enter_email");
                        setChallenge(null);
                        setMode("forgot");
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
                    ? "Sign in"
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
                setMode("signin");
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
              onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
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
