import { createFileRoute, redirect } from "@tanstack/react-router";
import { pageMeta } from "@/lib/page-meta";
export const Route = createFileRoute("/gallery")({ head: () => pageMeta("Gallery", "Your gallery workspace in The PaperVault."), beforeLoad: () => { throw redirect({ to: "/app/gallery", replace: true }); } });
