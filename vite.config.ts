// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare as a default target),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import type { Plugin } from "vite";

function suppressUseClientDirectiveWarnings(): Plugin {
  return {
    name: "suppress-use-client-directives",
    configEnvironment(_name, config) {
      const prevOnwarn = config.build?.rollupOptions?.onwarn;
      return {
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
    server: {
      host: "0.0.0.0",
      port: 3000,
      allowedHosts: true,
    },
    preview: {
      host: "0.0.0.0",
      port: 3000,
      allowedHosts: true,
    },
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
