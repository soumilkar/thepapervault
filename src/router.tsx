import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 0,
        gcTime: 1000 * 60 * 30,
        refetchOnWindowFocus: true,
        refetchOnMount: true,
        retry: 1,
        networkMode: "always",
      },
      mutations: {
        networkMode: "always",
      },
    },
  });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreload: "intent",
    defaultPreloadDelay: 0,
    defaultPreloadStaleTime: 1000 * 60 * 5,
    defaultPendingMs: 0,
    defaultPendingMinMs: 0,
  });

  return router;
};
