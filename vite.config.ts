// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare as a default target),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { loadEnv, type Plugin } from "vite";
import type { RollupLog } from "rollup";

function suppressUseClientDirectiveWarnings(): Plugin {
  let resolvedGroqKey = "";
  let resolvedSupabaseUrl = "";
  let resolvedSupabasePublishableKey = "";
  let resolvedSupabaseAnonKey = "";
  let resolvedSupabaseServiceRoleKey = "";
  let resolvedB2Bucket = "";
  let resolvedB2Endpoint = "";
  let resolvedB2KeyId = "";
  let resolvedB2AppKey = "";

  return {
    name: "suppress-use-client-directives",
    config(_, { mode }) {
      const env = { ...loadEnv(mode, process.cwd(), ""), ...process.env };
      resolvedSupabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL || "";
      resolvedSupabasePublishableKey =
        env.VITE_SUPABASE_PUBLISHABLE_KEY ||
        env.SUPABASE_PUBLISHABLE_KEY ||
        env.VITE_SUPABASE_ANON_KEY ||
        env.SUPABASE_ANON_KEY ||
        "";
      resolvedSupabaseAnonKey =
        env.VITE_SUPABASE_ANON_KEY ||
        env.SUPABASE_ANON_KEY ||
        env.VITE_SUPABASE_PUBLISHABLE_KEY ||
        env.SUPABASE_PUBLISHABLE_KEY ||
        "";
      resolvedSupabaseServiceRoleKey =
        env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
      resolvedGroqKey = env.GROQ_API_KEY || env.VITE_GROQ_API_KEY || "";
      resolvedB2Bucket =
        env.B2_BUCKET_NAME ||
        env.BACKBLAZE_BUCKET_NAME ||
        env.VITE_B2_BUCKET_NAME ||
        env.R2_BUCKET_NAME ||
        "";
      resolvedB2Endpoint = env.B2_ENDPOINT || env.BACKBLAZE_ENDPOINT || env.VITE_B2_ENDPOINT || "";
      resolvedB2KeyId =
        env.B2_KEY_ID ||
        env.B2_ACCESS_KEY_ID ||
        env.BACKBLAZE_KEY_ID ||
        env.VITE_B2_KEY_ID ||
        env.R2_ACCESS_KEY_ID ||
        "";
      resolvedB2AppKey =
        env.B2_APPLICATION_KEY ||
        env.B2_SECRET_ACCESS_KEY ||
        env.BACKBLAZE_APPLICATION_KEY ||
        env.VITE_B2_APPLICATION_KEY ||
        env.R2_SECRET_ACCESS_KEY ||
        "";

      if (resolvedGroqKey && !process.env.GROQ_API_KEY) {
        process.env.GROQ_API_KEY = resolvedGroqKey;
      }
      if (resolvedSupabaseUrl && !process.env.SUPABASE_URL) {
        process.env.SUPABASE_URL = resolvedSupabaseUrl;
      }
      if (resolvedSupabasePublishableKey && !process.env.SUPABASE_PUBLISHABLE_KEY) {
        process.env.SUPABASE_PUBLISHABLE_KEY = resolvedSupabasePublishableKey;
      }
      if (resolvedSupabaseAnonKey && !process.env.SUPABASE_ANON_KEY) {
        process.env.SUPABASE_ANON_KEY = resolvedSupabaseAnonKey;
      }
      if (resolvedSupabaseServiceRoleKey && !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        process.env.SUPABASE_SERVICE_ROLE_KEY = resolvedSupabaseServiceRoleKey;
      }
      if (resolvedB2Bucket && !process.env.B2_BUCKET_NAME) {
        process.env.B2_BUCKET_NAME = resolvedB2Bucket;
      }
      if (resolvedB2Endpoint && !process.env.B2_ENDPOINT) {
        process.env.B2_ENDPOINT = resolvedB2Endpoint;
      }
      if (resolvedB2KeyId && !process.env.B2_KEY_ID) {
        process.env.B2_KEY_ID = resolvedB2KeyId;
      }
      if (resolvedB2AppKey && !process.env.B2_APPLICATION_KEY) {
        process.env.B2_APPLICATION_KEY = resolvedB2AppKey;
      }

      return {
        define: {
          "import.meta.env.VITE_SUPABASE_URL": JSON.stringify(resolvedSupabaseUrl),
          "import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY": JSON.stringify(
            resolvedSupabasePublishableKey,
          ),
          "import.meta.env.VITE_SUPABASE_ANON_KEY": JSON.stringify(resolvedSupabaseAnonKey),
        },
      };
    },
    configEnvironment(name, config) {
      const prevOnwarn = config.build?.rollupOptions?.onwarn;
      const serverDefines: Record<string, string> = {};
      if (name !== "client") {
        if (resolvedGroqKey) {
          serverDefines["process.env.GROQ_API_KEY"] = JSON.stringify(resolvedGroqKey);
        }
        if (resolvedSupabaseUrl) {
          serverDefines["process.env.SUPABASE_URL"] = JSON.stringify(resolvedSupabaseUrl);
        }
        if (resolvedSupabasePublishableKey) {
          serverDefines["process.env.SUPABASE_PUBLISHABLE_KEY"] = JSON.stringify(
            resolvedSupabasePublishableKey,
          );
        }
        if (resolvedSupabaseAnonKey) {
          serverDefines["process.env.SUPABASE_ANON_KEY"] = JSON.stringify(resolvedSupabaseAnonKey);
        }
        if (resolvedSupabaseServiceRoleKey) {
          serverDefines["process.env.SUPABASE_SERVICE_ROLE_KEY"] = JSON.stringify(
            resolvedSupabaseServiceRoleKey,
          );
        }
        if (resolvedB2Bucket) {
          serverDefines["process.env.B2_BUCKET_NAME"] = JSON.stringify(resolvedB2Bucket);
        }
        if (resolvedB2Endpoint) {
          serverDefines["process.env.B2_ENDPOINT"] = JSON.stringify(resolvedB2Endpoint);
        }
        if (resolvedB2KeyId) {
          serverDefines["process.env.B2_KEY_ID"] = JSON.stringify(resolvedB2KeyId);
        }
        if (resolvedB2AppKey) {
          serverDefines["process.env.B2_APPLICATION_KEY"] = JSON.stringify(resolvedB2AppKey);
        }
      }

      return {
        ...(Object.keys(serverDefines).length > 0 ? { define: serverDefines } : {}),
        build: {
          rollupOptions: {
            onwarn(warning, warn) {
              if (
                warning.code === "MODULE_LEVEL_DIRECTIVE" &&
                typeof warning.message === "string" &&
                warning.message.includes('"use client"')
              ) {
                return;
              }
              if (prevOnwarn) {
                prevOnwarn(warning, warn);
              } else {
                warn(warning);
              }
            },
          },
        },
      };
    },
    transform(code, id) {
      if (
        id.includes("node_modules") &&
        (code.startsWith('"use client"') || code.startsWith("'use client'"))
      ) {
        return {
          code: code.replace(/^['"]use client['"];?\s*/, ""),
          map: null,
        };
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [suppressUseClientDirectiveWarnings()],
  vite: {
    optimizeDeps: {
      entries: ["src/router.tsx", "src/routes/**/*.tsx"],
    },
    server: {
      host: "0.0.0.0",
      port: 3000,
      allowedHosts: true,
      warmup: {
        clientFiles: [
          "./src/router.tsx",
          "./src/routes/__root.tsx",
          "./src/routes/index.tsx",
          "./src/routes/auth.tsx",
          "./src/routes/app/route.tsx",
        ],
        ssrFiles: ["./src/server.ts", "./src/router.tsx", "./src/routes/__root.tsx"],
      },
    },
    preview: {
      host: "0.0.0.0",
      port: 3000,
      allowedHosts: true,
    },
    build: {
      rollupOptions: {
        onwarn(warning: RollupLog, warn: (w: RollupLog) => void) {
          if (
            warning.code === "MODULE_LEVEL_DIRECTIVE" &&
            typeof warning.message === "string" &&
            warning.message.includes('"use client"')
          ) {
            return;
          }
          warn(warning);
        },
      },
    },
  },
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
});
