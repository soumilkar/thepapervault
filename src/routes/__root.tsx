import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";
import { Toaster } from "sonner";
import { ScrollToTop } from "@/components/ScrollToTop";

import appCss from "../styles.css?url";
import cormorant400Url from "@fontsource/cormorant-garamond/files/cormorant-garamond-latin-400-normal.woff2?url";
import cormorant600Url from "@fontsource/cormorant-garamond/files/cormorant-garamond-latin-600-normal.woff2?url";
import nunito400Url from "@fontsource/nunito/files/nunito-latin-400-normal.woff2?url";
import nunito600Url from "@fontsource/nunito/files/nunito-latin-600-normal.woff2?url";
import caveat400Url from "@fontsource/caveat/files/caveat-latin-400-normal.woff2?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { supabase } from "@/integrations/supabase/client";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="paper-card max-w-md p-10 text-center">
        <h1 className="text-6xl font-serif text-primary">404</h1>
        <p className="mt-4 text-muted-foreground">This page seems to have wandered off.</p>
        <Link to="/" className="mt-6 inline-block text-primary underline">
          Return home
        </Link>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: ErrorComponentProps) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="paper-card max-w-md p-10 text-center">
        <h2 className="text-2xl font-serif">Something went sideways</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          An unexpected error occurred. Please try again.
        </p>
        <button
          onClick={() => {
            router.invalidate();
            reset();
          }}
          className="mt-6 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground"
        >
          Try again
        </button>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "The PaperVault — Your personal journal" },
      {
        name: "description",
        content:
          "A warm, private space for your diary, blog, gallery, and an AI companion that knows your story.",
      },
      { property: "og:title", content: "The PaperVault — Your personal journal" },
      { name: "twitter:title", content: "The PaperVault — Your personal journal" },
      {
        property: "og:description",
        content:
          "A warm, private space for your diary, blog, gallery, and an AI companion that knows your story.",
      },
      {
        name: "twitter:description",
        content:
          "A warm, private space for your diary, blog, gallery, and an AI companion that knows your story.",
      },
      {
        property: "og:image",
        content:
          "https://storage.googleapis.com/gpt-engineer-file-uploads/attachments/og-images/1430fae1-cc9e-4a3a-87be-a6694be59784",
      },
      {
        name: "twitter:image",
        content:
          "https://storage.googleapis.com/gpt-engineer-file-uploads/attachments/og-images/1430fae1-cc9e-4a3a-87be-a6694be59784",
      },
      { name: "twitter:card", content: "summary_large_image" },
      { property: "og:type", content: "website" },
    ],
    links: [
      {
        rel: "preload",
        as: "font",
        type: "font/woff2",
        href: cormorant400Url,
        crossOrigin: "anonymous",
      },
      {
        rel: "preload",
        as: "font",
        type: "font/woff2",
        href: cormorant600Url,
        crossOrigin: "anonymous",
      },
      {
        rel: "preload",
        as: "font",
        type: "font/woff2",
        href: nunito400Url,
        crossOrigin: "anonymous",
      },
      {
        rel: "preload",
        as: "font",
        type: "font/woff2",
        href: nunito600Url,
        crossOrigin: "anonymous",
      },
      {
        rel: "preload",
        as: "font",
        type: "font/woff2",
        href: caveat400Url,
        crossOrigin: "anonymous",
      },
      { rel: "stylesheet", href: appCss },
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
      { rel: "icon", type: "image/svg+xml", href: "/icon.svg" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

import { ThemeProvider, useTheme } from "@/lib/theme";

const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem("papervault:theme");if(t==="dark"||(!t&&window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches&&t==="__auto__")){document.documentElement.classList.add("dark");document.documentElement.style.colorScheme="dark";}else{document.documentElement.classList.remove("dark");document.documentElement.style.colorScheme="light";}}catch(e){}})();`;

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <HeadContent />
      </head>
      <body suppressHydrationWarning>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function ThemedToaster() {
  const { theme } = useTheme();
  return (
    <Toaster
      theme={theme}
      richColors
      position="top-center"
      offset={{ top: 92 }}
      mobileOffset={{ top: 82 }}
      duration={2200}
      toastOptions={{ duration: 2200 }}
    />
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const router = useRouter();

  useEffect(() => {
    if (typeof window !== "undefined" && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    let docTimer: number | null = null;
    const elemTimers = new WeakMap<Element, number>();

    const isMobileOrTablet = () =>
      window.innerWidth < 1024 ||
      (typeof window.matchMedia === "function" &&
        window.matchMedia("(hover: none), (pointer: coarse)").matches);

    const handleScroll = (e: Event) => {
      if (isMobileOrTablet()) return;
      const target = e.target;
      if (
        !target ||
        target === document ||
        target === document.documentElement ||
        target === document.body
      ) {
        document.documentElement.setAttribute("data-scrolling", "true");
        document.body?.setAttribute("data-scrolling", "true");
        if (docTimer !== null) window.clearTimeout(docTimer);
        docTimer = window.setTimeout(() => {
          document.documentElement.removeAttribute("data-scrolling");
          document.body?.removeAttribute("data-scrolling");
          docTimer = null;
        }, 750);
      } else if (target instanceof Element) {
        target.setAttribute("data-scrolling", "true");
        const prev = elemTimers.get(target);
        if (prev !== undefined) window.clearTimeout(prev);
        const next = window.setTimeout(() => {
          target.removeAttribute("data-scrolling");
          elemTimers.delete(target);
        }, 750);
        elemTimers.set(target, next);
      }
    };

    window.addEventListener("scroll", handleScroll, { capture: true, passive: true });
    return () => {
      window.removeEventListener("scroll", handleScroll, { capture: true });
      if (docTimer !== null) window.clearTimeout(docTimer);
    };
  }, []);

  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event !== "SIGNED_IN" && event !== "SIGNED_OUT" && event !== "USER_UPDATED") return;
      router.invalidate();
      if (event !== "SIGNED_OUT") queryClient.invalidateQueries();
    });
    return () => sub.subscription.unsubscribe();
  }, [router, queryClient]);

  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <Outlet />
        <ThemedToaster />
        <ScrollToTop />
      </QueryClientProvider>
    </ThemeProvider>
  );
}
