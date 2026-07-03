// Simple heuristic mapping of free-text mood words to a 1–5 sentiment scale.
// Falls back to 3 (neutral) for unknown words.

const MOOD_MAP: Record<string, number> = {
  // 5 — very positive
  joyful: 5, ecstatic: 5, happy: 5, elated: 5, excited: 5, grateful: 5,
  blissful: 5, overjoyed: 5, thrilled: 5, wonderful: 5, amazing: 5,
  // 4 — positive
  peaceful: 4, content: 4, calm: 4, good: 4, fine: 4, hopeful: 4,
  inspired: 4, motivated: 4, relaxed: 4, satisfied: 4, cheerful: 4,
  pleasant: 4, warm: 4, loved: 4, confident: 4, optimistic: 4,
  // 3 — neutral
  okay: 3, neutral: 3, normal: 3, tired: 3, busy: 3, meh: 3, average: 3,
  indifferent: 3, unsure: 3, mixed: 3, flat: 3, restless: 3,
  // 2 — negative
  anxious: 2, stressed: 2, sad: 2, down: 2, lonely: 2, worried: 2,
  frustrated: 2, angry: 2, annoyed: 2, disappointed: 2, nervous: 2,
  overwhelmed: 2, insecure: 2, bored: 2, irritable: 2, gloomy: 2,
  // 1 — very negative
  depressed: 1, miserable: 1, devastated: 1, heartbroken: 1, hopeless: 1,
  despair: 1, worthless: 1, empty: 1, shattered: 1,
};

export function moodScore(mood: string | null | undefined): number {
  if (!mood) return 3;
  const key = mood.trim().toLowerCase().replace(/[^a-z]/g, "");
  return MOOD_MAP[key] ?? 3;
}

export function moodColor(score: number): string {
  // Returns a warm journal-friendly color mapped to sentiment
  switch (score) {
    case 5: return "#4ade80"; // green-400
    case 4: return "#86efac"; // green-300
    case 3: return "#d6d3d1"; // stone-300
    case 2: return "#fca5a5"; // red-300
    case 1: return "#f87171"; // red-400
    default: return "#d6d3d1";
  }
}

export function moodLabel(score: number): string {
  switch (score) {
    case 5: return "wonderful";
    case 4: return "good";
    case 3: return "neutral";
    case 2: return "difficult";
    case 1: return "hard";
    default: return "neutral";
  }
}
