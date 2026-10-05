import { createFileRoute, redirect } from "@tanstack/react-router";
import { pageMeta } from "@/lib/page-meta";
export const Route = createFileRoute("/companion")({ head: () => pageMeta("Companion", "Your companion workspace in The PaperVault."), beforeLoad: () => { throw redirect({ to: "/app/chat", replace: true }); } });
