import { createFileRoute, redirect } from "@tanstack/react-router";
import { pageMeta } from "@/lib/page-meta";
export const Route = createFileRoute("/diary")({ head: () => pageMeta("Diary", "Your diary workspace in The PaperVault."), beforeLoad: () => { throw redirect({ to: "/app/diary", replace: true }); } });
