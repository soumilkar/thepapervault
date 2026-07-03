## Data & Insights Features for The PaperVault

Here are concrete features that fit your journal's data & insights direction. Pick the ones you want and I'll build them.

---

### 1. Mood Timeline Chart
A visual graph on the dashboard (or a dedicated Insights tab) showing how the user's mood has changed over time based on diary entries. Since you already collect a `mood` field on every diary entry, we just need to aggregate and visualize it.

- X-axis: dates  
- Y-axis: mood sentiment (e.g., peaceful → anxious → joyful, mapped to a color gradient)
- Click any point to jump to that diary entry

**Tech:** No new DB tables needed. Use existing `diary_entries` data. Can build a lightweight SVG/CSS chart or add a small charting library.

---

### 2. Writing Streaks & Stats
A "streak" card on the dashboard showing:
- Current consecutive days with a diary entry
- Longest streak ever
- Total words written this month / all time
- Average entries per week

**Tech:** Computed from existing `diary_entries.created_at` and `content` length. No new schema.

---

### 3. Weekly AI Reflection
A new section (or tab) where the AI Companion auto-generates a gentle weekly summary of the user's diary and blog entries. Something like:

> "This week you wrote about feeling anxious on Monday, but by Thursday you noted a sense of calm returning. You seemed most grateful for..."

The user clicks a button to generate it for any chosen week. Uses the existing Gemini integration — just a new prompt template and date range.

**Tech:** Reuses existing `askCompanion` server function. No new DB tables.

---

### 4. Tag Cloud / Topic Explorer
A visual cloud of the most-used tags across blogs, notes, and diary entries. Click a tag to see all entries that use it. Helps users spot recurring themes in their writing.

**Tech:** Aggregate existing `tags` columns from `blog_posts` and `notes`. No new schema.

---

### 5. Entry Heatmap
A GitHub-style contribution grid showing which days the user wrote a diary entry, blog post, or note. Hover shows count. Adds a satisfying "I showed up" visual to the dashboard.

**Tech:** Computed from `created_at` on `diary_entries`, `blog_posts`, and `notes`. No new DB tables.

---

## Recommended Next Step

If you want to start, I suggest **Mood Timeline + Writing Streaks + Entry Heatmap** together — they all reuse existing data, require no new DB schema, and make the dashboard feel alive. Then we can add the **Weekly AI Reflection** as a follow-up since it reuses the Companion infrastructure.

Which ones do you want me to build?