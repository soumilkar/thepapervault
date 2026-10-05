import { createFileRoute, redirect } from "@tanstack/react-router";
import { pageMeta } from "@/lib/page-meta";
export const Route = createFileRoute("/lock")({ head: () => pageMeta("Lock", "Your lock workspace in The PaperVault."), beforeLoad: () => { throw redirect({ to: "/app/lock", replace: true }); } });
