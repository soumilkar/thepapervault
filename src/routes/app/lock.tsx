import { createFileRoute, Link } from "@tanstack/react-router";
import { LockKeyhole } from "lucide-react";
import { Button } from "@/components/ui/button";
import { pageMeta } from "@/lib/page-meta";
export const Route = createFileRoute("/app/lock")({ head: () => pageMeta("Lock", "Protect your private PaperVault workspace with your passphrase."), component: LockPage });
function LockPage() {
  return <div className="flex min-h-[60vh] flex-col items-center justify-center gap-5 text-center"><LockKeyhole className="size-8 text-accent" /><h1 className="text-3xl">Your vault is open</h1><Button asChild><Link to="/app">Return to Home</Link></Button></div>;
}
