import { createFileRoute, redirect } from "@tanstack/react-router";
import { pageMeta } from "@/lib/page-meta";
export const Route = createFileRoute("/notes")({ head: () => pageMeta("Notes", "Your notes workspace in The PaperVault."), beforeLoad: () => { throw redirect({ to: "/app/notes", replace: true }); } });
