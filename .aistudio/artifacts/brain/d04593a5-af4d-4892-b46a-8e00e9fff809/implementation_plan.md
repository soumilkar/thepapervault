# Auto-Sync Implementation Plan

## Completed Work
1. **Enhanced Background Sync Engine (`src/lib/offline-supabase.ts`)**:
   - Added automatic token getter integration (`registerAuthTokenGetter`) connecting Supabase client auth to the offline queue flusher.
   - Handled JWT 401 token refresh on reconnect so expired session tokens are transparently refreshed and replayed without breaking sync.
   - Sanitized replayed HTTP request headers to omit browser-restricted headers (`host`, `content-length`, etc.) and ensure proper `content-type` and `x-upsert` headers for storage uploads.
   - Staged automatic sync triggers on browser `online`, tab `visibilitychange`, window `focus`, initial startup, and newly enqueued mutations.
   - Added a lightweight 4-second watchdog interval while offline items are queued and connectivity is restored.
   - Propagated server response data back into local IndexedDB so server-generated timestamps and IDs stay in sync.

2. **Reactive Query Invalidation & Toast (`src/routes/app/route.tsx`)**:
   - Subscribed to `papervault:sync-success` in the authenticated layout to invalidate active TanStack Query caches (`notes`, `diary`, `diary-metrics`, `blog`, `gallery`, `heatmap-activity`, `dashboard-counts`, `user-profile`) and trigger companion session updates.
   - Reassured users with a clean, discreet sonner toast (`"Offline change synced"` / `"Synced X offline changes"`) without adding persistent telemetry badges or violating the clean UI constraint.
   - Integrated `triggerAutoSync` into the vault unlock warmer so pending items flush as soon as the vault is unlocked.

3. **Supabase Client Integration (`src/integrations/supabase/client.ts`)**:
   - Connected `client.auth.getSession()` and `client.auth.refreshSession()` to provide fresh access tokens to the offline engine.
   - Added `onAuthStateChange` trigger to kick off auto-sync when the user session becomes active.
