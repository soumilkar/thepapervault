import { createFileRoute, redirect } from "@tanstack/react-router";
import { pageMeta } from "@/lib/page-meta";
export const Route = createFileRoute("/blog")({ head: () => pageMeta("Blog", "Your blog workspace in The PaperVault."), beforeLoad: () => { throw redirect({ to: "/app/blog", replace: true }); } });
