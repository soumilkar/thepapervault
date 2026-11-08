import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { ThemeToggleButton } from "@/lib/theme";
import { markFirstTimeSignup } from "@/components/WelcomeTour";
import { toast } from "sonner";

export const Route = createFileRoute("/auth")({
  ssr: false,
  beforeLoad: async () => {
    const { data } = await supabase.auth.getSession();
    if (data.session?.user) throw redirect({ to: "/app" });
  },
  head: () => ({ meta: [{ title: "Sign in · The PaperVault" }] }),
  component: AuthPage,
});

function AuthPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (mode === "signup") {
        const trimmedName = displayName.trim();
        if (!trimmedName) {
          throw new Error("Please enter a display name.");
        }
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
          await supabase.from("profiles").upsert({ id: data.user.id, display_name: trimmedName });
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
    <div className="relative flex min-h-screen items-center justify-center px-4">
      <div className="fixed top-4 right-4 z-40">
        <ThemeToggleButton
          className="flex items-center gap-1.5 rounded-xl border border-border/70 bg-card/85 px-3 py-2 text-xs text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-secondary hover:text-primary"
          showLabel
        />
      </div>
      <div className="paper-card w-full max-w-md p-8">
        <p className="font-hand text-2xl text-sepia text-center">
          {mode === "signin" ? "welcome back" : "begin your story"}
        </p>
        <h1 className="mt-1 text-center font-serif text-3xl text-primary">
          {mode === "signin" ? "Open your journal" : "Create your journal"}
        </h1>

        <form onSubmit={submit} className="mt-6 space-y-4">
          {mode === "signup" && (
            <Field
              label="Display name"
              required
              value={displayName}
              onChange={setDisplayName}
              placeholder="What should we call you?"
            />
          )}
          <Field
            label="Email"
            type="email"
            required
            value={email}
            onChange={setEmail}
            placeholder="you@example.com"
          />
          <Field
            label="Password"
            type="password"
            required
            value={password}
            onChange={setPassword}
            placeholder="••••••••"
          />

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-md bg-primary px-4 py-2.5 text-primary-foreground hover:opacity-90 disabled:opacity-60"
          >
            {loading ? "Please wait..." : mode === "signin" ? "Sign in" : "Create account"}
          </button>
        </form>

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
