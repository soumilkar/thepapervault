import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useVault } from "@/lib/vault";
import { encryptText } from "@/lib/crypto";
import { CHAT_SESSIONS_UPDATED } from "./chat";

export const Route = createFileRoute("/app/chat/")({
  component: ChatIndex,
});

function ChatIndex() {
  const { user } = Route.useRouteContext();
  const { key } = useVault();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    (async () => {
      // Find the most recent conversation; open it, else create a new one.
      const { data, error: qErr } = await supabase
        .from("chat_sessions")
        .select("id")
        .eq("user_id", user.id)
        .order("last_message_at", { ascending: false })
        .limit(1);
      if (cancelled) return;
      if (qErr) {
        setError("Could not load your last conversation");
        return;
      }
      if (data && data.length > 0) {
        navigate({
          to: "/app/chat/$sessionId",
          params: { sessionId: data[0].id },
          replace: true,
        });
        return;
      }
      const enc = await encryptText(key, "New conversation");
      const { data: created, error: insErr } = await supabase
        .from("chat_sessions")
        .insert({ user_id: user.id, title: enc.ct, title_iv: enc.iv })
        .select("id")
        .single();
      if (cancelled) return;
      if (insErr || !created) {
        toast.error("Could not start a conversation");
        setError("Could not start a conversation");
        return;
      }
      window.dispatchEvent(new Event(CHAT_SESSIONS_UPDATED));
      navigate({
        to: "/app/chat/$sessionId",
        params: { sessionId: created.id },
        replace: true,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [user.id, key, navigate]);

  return (
    <div className="paper-card flex flex-col items-center justify-center gap-3 p-10 text-center">
      <Sparkles className="size-8 text-accent" />
      <p className="font-serif text-2xl text-primary">
        {error ?? "Opening your last conversation…"}
      </p>
    </div>
  );
}
