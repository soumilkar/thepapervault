# The PaperVault — GitHub README Plan

Author a polished, showcase-grade GitHub `README.md` for **The PaperVault** that highlights its features, zero-knowledge end-to-end encryption architecture, tech stack, and local setup guide—delivered both in `README.md` and directly in chat for copy-pasting, with zero changes to the website application code.

## User Review & Critical Decisions

> [!IMPORTANT]
> Per your request, **no application code, styles, routes, or database configurations will be modified**. Only the documentation in `README.md` will be updated and provided in chat.

- **Confirmed Delivery**: Update `README.md` in the repository and output the full Markdown in chat so you can immediately copy-paste it to GitHub.
- **Confirmed Scope**:
  1. Project header, live link (`https://thepapervault.vercel.app`), and tech/security badges.
  2. Feature overview covering **Diary**, **Notes**, **Gallery**, **Blog**, **Companion (Inkwell)**, **Writing Streaks & Year Heatmap**, **Goals Tracker**, and **Mood Tracker**.
  3. Detailed **End-to-End Encryption (E2EE) & Zero-Knowledge Security Architecture** section with ASCII data-flow diagrams.
  4. **Tech Stack** breakdown and step-by-step **Local Development Setup** guide.
- **Confirmed Tone**: Polished product showcase paired with clear technical and cryptographic architecture documentation.

## 1. Overview & Core Concept

- **What It Does**: Provides visitors, users, and developers on GitHub with an authoritative, well-structured overview of **The PaperVault**—a warm, paper-crafted, privacy-first personal sanctuary for journaling, note-taking, photo archiving, blogging, habit/mood tracking, and conversing with an E2EE-aware AI companion.
- **Target Audience / Persona**: GitHub visitors, privacy-conscious writers, and developers evaluating or running the project locally.
- **Key Value**: Replaces the default Lovable boilerplate README with bespoke documentation that accurately reflects the app's cryptographic guarantees and feature set.

## 2. Document Structure & Visual Design

- **Key Sections**:
  1. **Hero Banner & Badges**: Title, tagline, live production URL (`https://thepapervault.vercel.app`), and shields.io badges for React 19, TypeScript, TanStack Start, Tailwind CSS v4, Web Crypto `AES-256-GCM`, and Supabase.
  2. **Core Features**:
     - **Private & Anonymous Public Diary**: Rich text with inline images, nested folders, iTunes 30-second song previews, full-text search, export to `.txt`, and optional anonymous sharing to the "Notes from Strangers" community feed.
     - **Encrypted Notes**: Masonry-style notes with tags, nested folders, encrypted image attachments, and instant search/sorting.
     - **Encrypted Photo Gallery**: Client-side encrypted photo binaries (`.bin`) and encrypted captions.
     - **Community Blog**: Markdown-powered publishing with cover images, music attachments, likes, and nested threaded comments with voting.
     - **AI Companion (Inkwell)**: Streaming conversational companion powered by Groq that reads only the date range and sources (Diary/Blog) decrypted client-side in your browser, with encrypted chat history and session titles.
     - **Home Sanctuary & Trackers**: Writing Streaks, Year-in-Writing Activity Heatmap, E2EE Goals Tracker, and E2EE Daily Mood Tracker.
  3. **End-to-End Encryption & Security Architecture**:
     - Details on `PBKDF2-HMAC-SHA256` (250,000 iterations, random 128-bit salts, constant-time verifier check) and `AES-256-GCM` (96-bit CSPRNG IVs, 128-bit authentication tags).
     - Memory hygiene: non-extractable `CryptoKey` held strictly in memory, automatic 15-minute idle lock, and immediate React Query cache wipe on lock/sign-out.
     - Encrypted local browser drafts (`useBrowserDraft`).
  4. **Tech Stack & Local Setup**:
     - Full stack table and step-by-step instructions (`git clone`, `.env` configuration, `npm install`, `npm run dev`).

## 3. Key Product Decisions & Trade-Offs

- **Decision 1: Zero Application Code Changes**
  - *Chosen Approach*: Touch only `README.md` and output the raw Markdown in the chat response.
  - *Why*: Strictly honors your constraint to leave the website untouched while giving you ready-to-paste GitHub documentation.
- **Decision 2: ASCII Cryptographic & System Diagrams**
  - *Chosen Approach*: Include clean Unicode box-drawing diagrams directly in the README to illustrate the client-side encryption boundary and vault key lifecycle.
  - *Why*: Renders natively on GitHub without external image dependencies and immediately proves how plaintext never leaves the browser unencrypted.

## 4. Technical Architecture & Data Strategy *(Included in README)*

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        BROWSER (TRUST BOUNDARY)                          │
│                                                                          │
│  Passphrase ──► PBKDF2-SHA256 (250k iter) ──► Non-extractable CryptoKey  │
│                                                       │                  │
│                        AES-256-GCM (12B IV, 128b Tag) ▼                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ Diary & Mood │  │ Notes & Tags │  │Gallery Photos│  │  Companion   │  │
│  │   + Folders  │  │  + Folders   │  │  + Captions  │  │Chats & Titles│  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  │
└─────────┼─────────────────┼─────────────────┼─────────────────┼──────────┘
          │ Ciphertext      │ Ciphertext      │ Encrypted .bin  │ Ciphertext
          ▼                 ▼                 ▼                 ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                 SUPABASE (POSTGRESQL + RLS + STORAGE)                    │
│     Stores only AES-GCM ciphertext, IVs, and PBKDF2 salts/verifiers      │
└──────────────────────────────────────────────────────────────────────────┘
```
