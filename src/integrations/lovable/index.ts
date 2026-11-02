import { supabase } from "../supabase/client";

type SignInOptions = {
  redirect_uri?: string;
  extraParams?: Record<string, string>;
};

function isInIframe(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

export const lovable = {
  auth: {
    signInWithOAuth: async (provider: "google" | "apple" | "microsoft", opts?: SignInOptions) => {
      const hasSupabaseEnv = Boolean(
        import.meta.env.VITE_SUPABASE_URL &&
          (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY)
      );

      if (!hasSupabaseEnv) {
        try {
          await supabase.auth.setSession({
            access_token: `mock-token-oauth-${provider}`,
            refresh_token: `mock-refresh-${provider}`,
          });
          return { redirected: false, error: null };
        } catch (e) {
          return { error: e instanceof Error ? e : new Error(String(e)) };
        }
      }

      const redirectTo = opts?.redirect_uri ?? `${window.location.origin}/app`;
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo,
          queryParams: opts?.extraParams,
          skipBrowserRedirect: true,
        },
      });
      if (error) return { error };
      if (!data?.url) return { error: new Error("Failed to construct OAuth URL") };

      if (!isInIframe()) {
        window.location.href = data.url;
        return { redirected: true, error: null };
      }

      const popup = window.open(data.url, "oauth_popup", "width=550,height=650");
      if (!popup) {
        return { error: new Error("Popup was blocked. Please allow popups for this site.") };
      }

      return new Promise<{ redirected: boolean; error: Error | null }>((resolve) => {
        const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
          if (event === "SIGNED_IN" && session) {
            clearInterval(timer);
            sub.subscription.unsubscribe();
            try { popup.close(); } catch { /* ignore */ }
            resolve({ redirected: false, error: null });
          }
        });

        const timer = setInterval(async () => {
          const { data: sessionData } = await supabase.auth.getSession();
          if (sessionData.session) {
            clearInterval(timer);
            sub.subscription.unsubscribe();
            try { popup.close(); } catch { /* ignore */ }
            resolve({ redirected: false, error: null });
            return;
          }
          if (popup.closed) {
            clearInterval(timer);
            sub.subscription.unsubscribe();
            resolve({ redirected: false, error: new Error("Sign in was cancelled") });
          }
        }, 500);
      });
    },
  },
};
