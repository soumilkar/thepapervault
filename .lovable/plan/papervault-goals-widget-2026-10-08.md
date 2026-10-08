# PaperVault goals widget

Replace the Dashboard Mood Timeline with a private goals widget where each user can create and manage life goals with progress, an optional deadline, and a manually selected mood. Persist goals in Lovable Cloud with owner-only access. Remove automatic AI mood estimation from diary loading so entries are not analyzed outside explicit Companion use.

## Technical details
- Add an owner-scoped `public.life_goals` table with explicit grants, RLS policies, and update timestamps.
- Build the dashboard widget with create, edit/progress, and delete interactions using existing project styling.
- Keep mood user-entered only; do not invoke AI analysis for goal or journal mood.
- Add dashboard-specific page metadata and verify the preview/build.
