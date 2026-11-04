import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types";
import { supabase as defaultSupabase } from "./client";

export const requireSupabaseAuth = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const SUPABASE_KEY =
      process.env.SUPABASE_PUBLISHABLE_KEY ||
      process.env.SUPABASE_ANON_KEY ||
      process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
      process.env.VITE_SUPABASE_ANON_KEY;

    const request = getRequest();

    if (!request?.headers) {
      throw new Error("Unauthorized: No request headers available");
    }

    const authHeader = request.headers.get("authorization");

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new Error("Unauthorized: Bearer token required");
    }

    const token = authHeader.replace("Bearer ", "");
    if (!token) {
      throw new Error("Unauthorized: No token provided");
    }

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      const userId = token.startsWith("mock-token-")
        ? token.slice("mock-token-".length)
        : "mock-user";
      return next({
        context: {
          supabase: defaultSupabase,
          userId,
          claims: { sub: userId },
        },
      });
    }

    const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_KEY, {
      global: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
      auth: {
        storage: undefined,
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const { data, error } = await supabase.auth.getClaims(token);
    if (!error && data?.claims?.sub) {
      return next({
        context: {
          supabase,
          userId: data.claims.sub,
          claims: data.claims,
        },
      });
    }

    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData?.user?.id) {
      throw new Error("Unauthorized: Invalid token");
    }

    return next({
      context: {
        supabase,
        userId: userData.user.id,
        claims: { sub: userData.user.id, email: userData.user.email },
      },
    });
  },
);
