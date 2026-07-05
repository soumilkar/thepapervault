import { createFileRoute } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";

export const Route = createFileRoute("/app/chat/")({
  component: ChatIndex,
});

function ChatIndex() {
  return (
    <div className="paper-card flex flex-col items-center justify-center gap-3 p-10 text-center">
      <Sparkles className="size-8 text-accent" />
      <p className="font-serif text-2xl text-primary">Pick up where you left off</p>
      <p className="max-w-md text-sm text-muted-foreground">
        Choose a recent conversation on the left, or tap <span className="font-medium">New chat</span> to start a fresh one. Your last 7 conversations are kept for 14 days.
      </p>
    </div>
  );
}
