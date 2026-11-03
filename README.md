<div align="center">

# The PaperVault

**A warm, zero-knowledge personal sanctuary for your diary, notes, photo gallery, blog, and an AI companion that knows your story.**

[![Live App](https://img.shields.io/badge/Live_App-thepapervault.vercel.app-8B5A2B?style=for-the-badge)](https://thepapervault.vercel.app)
[![Encryption](https://img.shields.io/badge/E2EE-AES--256--GCM_%2B_PBKDF2-2E6F40?style=for-the-badge)](#end-to-end-encryption--security-architecture)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react&logoColor=black)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-v4-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![Supabase](https://img.shields.io/badge/Supabase-Postgres_%2B_RLS-3ECF8E?style=for-the-badge&logo=supabase&logoColor=white)](https://supabase.com/)

</div>

---

## Overview

**The PaperVault** is a tactile, paper-inspired personal workspace built around a strict privacy guarantee: **your private thoughts belong only to you**.

Every private diary entry, note, folder name, gallery photo, caption, tracker log, companion conversation, and even unsaved browser draft is encrypted **client-side in your browser** using the Web Crypto API (`AES-256-GCM`) before it ever touches the network or local storage. Neither the server nor the database ever sees your vault passphrase or derived encryption key.

🔗 **Live Application:** [https://thepapervault.vercel.app](https://thepapervault.vercel.app)

---

## Key Features

### 1. Private & Anonymous Community Diary
- **Zero-Knowledge Private Entries**: Title, body, mood, word count, and attached song metadata are bundled and encrypted into a single `AES-256-GCM` ciphertext payload before being stored.
- **Rich Text & Inline Media**: Paste image links on their own line to render inline previews alongside Markdown formatting.
- **Music Soundtracks**: Search and attach 30-second song previews via iTunes Search to capture the soundtrack of a memory.
- **Nested Folders**: Organize entries into multi-level nested folders (`parent_id`), with folder names encrypted client-side.
- **Anonymous Community Sharing ("Notes from Strangers")**: Optionally publish selected diary entries anonymously to the community feed on the Home tab while keeping your private entries strictly locked.
- **One-Click Export**: Export your decrypted diary archive to a clean `.txt` file at any time.

### 2. End-to-End Encrypted Notes
- **Masonry Scrapbook Layout**: Capture quick thoughts, reminders, and long-form notes.
- **Encrypted Tags & Subfolders**: Filter by nested folders, search across titles/content/tags, and sort by newest, oldest, recently edited, or title.
- **Encrypted Image Attachments**: Attached images are encrypted in-browser (`encryptBlob`) and uploaded as binary `.bin` ciphertext with strict owner-only Storage Row-Level Security (RLS).

### 3. Encrypted Photo Gallery
- **Binary Photo Encryption**: Every uploaded JPEG, PNG, WebP, or GIF is encrypted into an `application/octet-stream` binary blob with a unique 96-bit IV before upload.
- **Encrypted Captions**: Photo captions are encrypted with their own IVs and decrypted on the fly in memory using revocable `Blob` URLs.

### 4. Community Blog
- **Public Publishing**: Write and publish Markdown blog posts with cover photos, tags, and song previews.
- **Threaded Discussions & Voting**: Readers can like posts, leave nested multi-level replies, and upvote/downvote comments.

### 5. AI Companion (*Inkwell*)
- **Privacy-Preserving Context**: When you chat with *Inkwell* (powered by Groq), your browser decrypts only the date range and sources (`Diary + Blog`, `Diary only`, or `Blog only`) you explicitly choose to share for that turn.
- **Real-Time Streaming**: Responses stream token-by-token with automatic scroll-to-bottom tracking.
- **Encrypted History**: Every user prompt, assistant reply, and conversation title is encrypted with your vault key before being saved to the database.

### 6. Home Sanctuary & Personal Trackers
- **Writing Streaks**: Tracks your current streak, best streak, total entries, and words written this month—computed client-side from decrypted entries.
- **Year in Writing Heatmap**: A full-year GitHub-style activity grid visualizing your daily writing consistency across diary entries, notes, and blog posts.
- **Goals Tracker (E2EE)**: Create and track goals across `Daily`, `This week`, `This month`, and `Long-term` horizons with 25% progress increments and completion filters.
- **Mood Tracker (E2EE)**: Log daily mood check-ins (`Heavy`, `Uneasy`, `Steady`, `Warm`, `Radiant`) with notes and visualize your emotional rhythm over time on an interactive area chart.

---

## End-to-End Encryption & Security Architecture

The PaperVault enforces a strict **browser trust boundary**. All cryptographic operations happen exclusively in the client via the native **Web Crypto API** (`window.crypto.subtle`).

```
┌────────────────────────────────────────────────────────────────────────────┐
│                         BROWSER (TRUST BOUNDARY)                           │
│                                                                            │
│  Vault Passphrase                                                          │
│        │                                                                   │
│        ├──► PBKDF2-HMAC-SHA256 (250k iter, verifier_salt) ──► Verifier     │
│        │    (Checked via constant-time comparison)                         │
│        │                                                                   │
│        └──► PBKDF2-HMAC-SHA256 (250k iter, kdf_salt)                       │
│                   │                                                        │
│                   ▼                                                        │
│        Non-Extractable CryptoKey (AES-256-GCM, RAM only)                   │
│                   │                                                        │
│     ┌─────────────┼──────────────┬──────────────┬──────────────┐           │
│     ▼             ▼              ▼              ▼              ▼           │
│  ┌──────┐     ┌───────┐     ┌─────────┐    ┌─────────┐   ┌──────────┐      │
│  │Diary │     │ Notes │     │ Gallery │    │Companion│   │Trackers &│      │
│  │& Fld │     │ & Fld │     │  Blobs  │    │  Chats  │   │  Drafts  │      │
│  └──┬───┘     └───┬───┘     └────┬────┘    └────┬────┘   └────┬─────┘      │
└─────┼─────────────┼──────────────┼──────────────┼─────────────┼────────────┘
      │ Ciphertext  │ Ciphertext   │ .bin Blob    │ Ciphertext  │ Ciphertext
      ▼             ▼              ▼              ▼             ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                   SUPABASE (POSTGRESQL + RLS + STORAGE)                    │
│       Stores only AES-256-GCM ciphertext, 96-bit IVs, and KDF salts        │
└────────────────────────────────────────────────────────────────────────────┘
```

### Cryptographic Specifications
| Layer | Primitive / Mechanism | Details |
| :--- | :--- | :--- |
| **Key Derivation** | `PBKDF2-HMAC-SHA256` | `250,000` iterations with separate 128-bit CSPRNG salts (`kdf_salt` and `verifier_salt`). |
| **Symmetric Cipher** | `AES-256-GCM` | 256-bit key, fresh 96-bit (12-byte) CSPRNG IV per encryption, and 128-bit authentication tag (`tagLength: 128`). |
| **Passphrase Verification** | Constant-Time Verifier | Derived verifier bits are compared using a constant-time byte comparison (`timingSafeEqualStr`) to prevent timing side-channels. |
| **Key Residency** | Non-Extractable `CryptoKey` | Derived with `extractable: false` and held strictly in React state—never written to `window`, `localStorage`, `sessionStorage`, or cookies. |
| **Memory & Cache Hygiene** | Instant Wipe + Idle Lock | Locking the vault, signing out, or 15 minutes of tab inactivity immediately clears the `CryptoKey`, wipes the React Query cache (`queryClient.clear()`), and resets in-memory drafts. |
| **Encrypted Local Drafts** | `useBrowserDraft` | Unsaved form drafts in `localStorage` are encrypted with `AES-256-GCM` using the active vault key; nothing is read or written while the vault is locked. |

### What Is Encrypted?
- **Diary (Private)**: Title, content, mood, word count, attached music metadata, and folder names (`diary_folders`).
- **Notes**: Title, content, tags, attached image binaries (`.bin`), and folder names (`note_folders`).
- **Gallery**: Photo binaries (`.bin`), captions, and unsaved caption drafts.
- **Companion**: Session titles (`title_iv`), user messages, assistant responses, and input drafts.
- **Home Trackers**: All Goals Tracker items and Mood Tracker check-ins (`vault-trackers.bin`).

---

## Tech Stack

| Category | Technology |
| :--- | :--- |
| **Framework & Routing** | [React 19](https://react.dev), [TanStack Start](https://tanstack.com/start) & [TanStack Router](https://tanstack.com/router) (file-based SSR/SPA routing) |
| **State & Data Fetching** | [TanStack Query v5](https://tanstack.com/query) |
| **Styling & UI** | [Tailwind CSS v4](https://tailwindcss.com), [Radix UI](https://www.radix-ui.com) / [shadcn/ui](https://ui.shadcn.com), [Lucide Icons](https://lucide.dev) |
| **Cryptography** | Native Browser **Web Crypto API** (`PBKDF2`, `AES-256-GCM`) |
| **Database, Auth & Storage** | [Supabase](https://supabase.com) (PostgreSQL, Row-Level Security, Email Auth, Private Storage Buckets) |
| **AI Companion** | [Groq API](https://groq.com) (`qwen/qwen3.8-27b`) via server-side streaming endpoint (`/api/companion-stream`) |
| **Charts & Markdown** | [Recharts](https://recharts.org), `react-markdown`, `remark-gfm` |

---

## License

Private personal project. All rights reserved.
