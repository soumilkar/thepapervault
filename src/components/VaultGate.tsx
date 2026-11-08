import { useState } from "react";
import { Lock, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { useVault } from "@/lib/vault";
import { runVaultMigration } from "@/lib/vault-migrate";
import { markFirstTimeSignup } from "@/components/WelcomeTour";

export function VaultGate({ userId, children }: { userId: string; children: React.ReactNode }) {
  const { status, setup, unlock } = useVault();
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  if (status === "loading") {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <p className="font-hand text-sepia text-lg">one moment...</p>
      </div>
    );
  }

  if (status === "unlocked") return <>{children}</>;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      let dataKey: CryptoKey;
      if (status === "needs_setup") {
        if (passphrase !== confirm) throw new Error("Passphrases don't match");
        dataKey = await setup(passphrase);
        markFirstTimeSignup(userId);
        toast.success("Welcome in");
      } else {
        dataKey = await unlock(passphrase);
        toast.success("Welcome back");
      }
      void runVaultMigration(userId, dataKey).catch((err) => console.error("vault migration", err));
      setPassphrase("");
      setConfirm("");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Could not unlock");
    } finally {
      setBusy(false);
    }
  };

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

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-foreground/80">Passphrase</span>
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
        </label>

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
