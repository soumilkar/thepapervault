# Storage Upload & Gallery Organization Implementation Plan

## Problem Identified

1. **Image Upload Failures**: Direct Supabase storage uploads from the client were being rejected with a `403 / 400 new row violates row-level security policy` on `storage.objects` because the storage buckets lacked insert permissions for authenticated tokens.
2. **Missing Source Folder Organization in Gallery**: The Gallery tab only had a flat display without distinguishing between photos uploaded from the Diary versus Notes, and did not support browsing images organized into Notes directories and nested subfolders.

## Implemented Solutions

1. **Authenticated Server-Side Storage Proxy (`/api/storage-proxy`)**:
   - Built a secure server proxy endpoint that verifies the user's active session token and ensures all uploaded/accessed paths belong strictly to the authenticated `user.id`.
   - Uses the server-side `SUPABASE_SERVICE_ROLE_KEY` to perform uploads, signed URL batch generation, and removals on both `gallery` and `media` buckets.
   - Updated `offlineAwareSupabaseFetch` and `flushOfflineSyncQueue` in `src/lib/offline-supabase.ts` to route storage operations through this proxy when online, with graceful offline fallback to IndexedDB `storage_blobs` and `sync_queue`.

2. **Note Image Synchronization (`src/routes/app/notes.tsx`)**:
   - When a note is created or updated with an image, it is automatically cataloged in `gallery_images` with encrypted caption metadata linking it to the note's folder.
   - When a note is updated or deleted, attached media is cleaned up and gallery queries are invalidated.

3. **Gallery Tab Redesign with Diary & Notes Folders (`src/routes/app/gallery.tsx`)**:
   - **Main Folder Tabs**:
     - **📁 Diary**: Shows all photos attached to diary entries or uploaded to Diary in a clean, flat photo stream with **no subfolders**.
     - **📁 Notes**: Features full directory and subfolder browsing matching the user's Notes folder structure (using `parent_id` nesting and `src/lib/folders.ts`), with photo count badges on each folder tile and interactive breadcrumbs.
     - **📁 All Photos**: Allows viewing the complete collection across all sources.
   - **Folder-Aware Uploads**: Uploading directly in the Gallery detects whether you are in Diary or a Notes folder/subfolder and attaches the photo to that specific section.
   - **Photo Lightbox**: Fullscreen photo view modal on click with zoom, caption details, source badges, and deletion capabilities.
