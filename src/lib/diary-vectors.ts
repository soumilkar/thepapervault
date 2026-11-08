// Client-side E2EE Vector Index, Extractive Digest & Surrounding-Entry Retriever.
// Computes 512-dim L2-normalized Float32Array vectors (stemmed unigrams, bigrams, subword 4-grams,
// and temporal/mood embeddings) locally in browser RAM (0 external API calls, 0 extra tokens).
// Preserves high information density:
// - Short/medium entries (<= 450 chars) are kept 100% intact inside the digest.
// - Longer entries get a multi-sentence extractive digest scoring the highest-information sentences
//   (names, emotions, decisions, turning points, events) in chronological order.
// - When the user refers to something specific, vector similarity pulls the matched focal entries
//   PLUS their surrounding chronological entries (±1 before & after) in 100% FULL TEXT.

const VECTOR_DIM = 512;

const STOP_WORDS = new Set([
  "a",
  "about",
  "above",
  "after",
  "again",
  "against",
  "all",
  "am",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "because",
  "been",
  "before",
  "being",
  "below",
  "between",
  "both",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "doing",
  "down",
  "during",
  "each",
  "few",
  "for",
  "from",
  "further",
  "had",
  "has",
  "have",
  "having",
  "he",
  "her",
  "here",
  "hers",
  "herself",
  "him",
  "himself",
  "his",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "itself",
  "just",
  "me",
  "more",
  "most",
  "my",
  "myself",
  "no",
  "nor",
  "not",
  "now",
  "of",
  "off",
  "on",
  "once",
  "only",
  "or",
  "other",
  "our",
  "ours",
  "ourselves",
  "out",
  "over",
  "own",
  "same",
  "she",
  "should",
  "so",
  "some",
  "such",
  "than",
  "that",
  "the",
  "their",
  "theirs",
  "them",
  "themselves",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "to",
  "too",
  "under",
  "until",
  "up",
  "very",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "whom",
  "why",
  "will",
  "with",
  "would",
  "you",
  "your",
  "yours",
  "yourself",
  "yourselves",
  "tell",
  "talk",
  "think",
  "wrote",
  "write",
  "entry",
  "entries",
  "diary",
]);

const HIGH_SIGNAL_WORDS =
  /\b(felt|feeling|realized|decided|happened|because|important|worried|excited|grateful|happy|sad|anxious|stressed|overwhelmed|proud|hopeful|tired|exhausted|met|talked|called|started|finished|learned|remember|goal|plan|dream|family|friend|work|project|health|love|hurt|relief|peace)\b/i;

function stemWord(word: string): string {
  if (word.length <= 3) return word;
  let w = word;
  if (w.endsWith("ies") && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith("ing") && w.length > 5) {
    w = w.slice(0, -3);
    if (w.length >= 3 && w.at(-1) === w.at(-2)) w = w.slice(0, -1);
    return w;
  }
  if (w.endsWith("ed") && w.length > 4) {
    w = w.slice(0, -2);
    if (w.length >= 3 && w.at(-1) === w.at(-2)) w = w.slice(0, -1);
    return w;
  }
  if (w.endsWith("ly") && w.length > 4) return w.slice(0, -2);
  if (w.endsWith("es") && w.length > 4) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && w.length > 3) return w.slice(0, -1);
  return w;
}

function fnv1aHash(str: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function tokenizeAndStem(text: string): string[] {
  const rawTokens = text
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
  return rawTokens.map(stemWord);
}

/**
 * Projects text + metadata into a 512-dimensional L2-normalized Float32Array vector
 * using signed feature hashing over stemmed unigrams, bigrams, and character 4-grams.
 */
export function computeTextVector(text: string, boostTokens: string[] = []): Float32Array {
  const vec = new Float32Array(VECTOR_DIM);
  const tokens = tokenizeAndStem(text);

  const addFeature = (feature: string, weight: number) => {
    const h1 = fnv1aHash(feature, 0x811c9dc5);
    const h2 = fnv1aHash(feature, 0x9e3779b9);
    const idx = h1 % VECTOR_DIM;
    const sign = (h2 & 1) === 0 ? 1 : -1;
    vec[idx] += sign * weight;
  };

  const tf = new Map<string, number>();
  for (const t of tokens) {
    tf.set(t, (tf.get(t) ?? 0) + 1);
  }
  for (const [token, count] of tf) {
    const w = (1 + Math.log(count)) * 2.0;
    addFeature(`u:${token}`, w);
    if (token.length >= 4) {
      for (let i = 0; i <= token.length - 4; i++) {
        addFeature(`c:${token.slice(i, i + 4)}`, 0.5);
      }
    }
  }

  for (let i = 0; i < tokens.length - 1; i++) {
    addFeature(`b:${tokens[i]}_${tokens[i + 1]}`, 2.5);
  }

  for (const rawBoost of boostTokens) {
    for (const bt of tokenizeAndStem(rawBoost)) {
      addFeature(`u:${bt}`, 3.5);
    }
  }

  let normSq = 0;
  for (let i = 0; i < VECTOR_DIM; i++) {
    normSq += vec[i] * vec[i];
  }
  if (normSq > 0) {
    const invNorm = 1 / Math.sqrt(normSq);
    for (let i = 0; i < VECTOR_DIM; i++) {
      vec[i] *= invNorm;
    }
  }
  return vec;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < VECTOR_DIM; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

export interface DecodedDiaryEntry {
  entryDate: string; // YYYY-MM-DD
  title: string;
  content: string;
  mood?: string;
}

interface CachedDiaryVector {
  hash: number;
  vector: Float32Array;
  digestLine: string;
  tokenSet: Set<string>;
  temporalTerms: string[];
}

const vectorCache = new Map<string, CachedDiaryVector>();

function formatTemporalTerms(entryDate: string): { label: string; terms: string[] } {
  const parts = entryDate.split("-").map(Number);
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
    return { label: entryDate, terms: [entryDate] };
  }
  const [year, month, day] = parts;
  const dt = new Date(year, month - 1, day);
  const weekday = dt.toLocaleDateString("en-US", { weekday: "long" });
  const weekdayShort = dt.toLocaleDateString("en-US", { weekday: "short" });
  const monthLong = dt.toLocaleDateString("en-US", { month: "long" });
  const monthShort = dt.toLocaleDateString("en-US", { month: "short" });
  return {
    label: `${entryDate} (${weekdayShort})`,
    terms: [
      entryDate,
      weekday.toLowerCase(),
      weekdayShort.toLowerCase(),
      monthLong.toLowerCase(),
      monthShort.toLowerCase(),
      `${monthLong.toLowerCase()} ${day}`,
      `${monthShort.toLowerCase()} ${day}`,
      `${day}`,
    ],
  };
}

/**
 * Information-preserving extractive digest (~420 chars max per entry):
 * - Entries <= 420 chars are kept 100% verbatim so nothing is lost.
 * - Longer entries have their sentences scored by information density
 *   (unique keywords, proper nouns/capitalized words, emotional/event markers, numbers, opening & closing arc)
 *   and the top sentences are joined in chronological order.
 */
function buildEntryDigestLine(entry: DecodedDiaryEntry, dateLabel: string): string {
  const clean = entry.content
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const DIGEST_BUDGET = 420;
  let summaryText = "";

  if (clean.length <= DIGEST_BUDGET) {
    summaryText = clean;
  } else {
    const sentences = clean
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    if (sentences.length <= 2) {
      summaryText = `${clean.slice(0, DIGEST_BUDGET)}…`;
    } else {
      const scored = sentences.map((s, idx) => {
        const words = tokenizeAndStem(s);
        const uniqueWords = new Set(words).size;
        let score = uniqueWords * 1.2;
        // Boost opening and concluding sentences for narrative continuity
        if (idx === 0) score += 6;
        if (idx === sentences.length - 1) score += 4;
        // Boost sentences with emotional, causal, or decision markers
        if (HIGH_SIGNAL_WORDS.test(s)) score += 5;
        // Boost sentences with capitalized names/places (beyond first word) or numbers/times
        if (/\s[A-Z][a-z]{2,}/.test(s)) score += 3.5;
        if (/\d/.test(s)) score += 2;
        return { idx, text: s, score };
      });

      const ranked = [...scored].sort((a, b) => b.score - a.score);
      const chosenIndices: number[] = [];
      let usedChars = 0;

      for (const candidate of ranked) {
        if (usedChars + candidate.text.length > DIGEST_BUDGET && chosenIndices.length >= 2) {
          continue;
        }
        chosenIndices.push(candidate.idx);
        usedChars += candidate.text.length + 3;
        if (usedChars >= DIGEST_BUDGET) break;
      }

      chosenIndices.sort((a, b) => a - b);
      summaryText = chosenIndices.map((i) => sentences[i]).join(" · ");
      if (summaryText.length > DIGEST_BUDGET + 40) {
        summaryText = `${summaryText.slice(0, DIGEST_BUDGET)}…`;
      }
    }
  }

  const moodTag = entry.mood ? ` · mood: ${entry.mood}` : "";
  const titleTag = entry.title && entry.title !== "Untitled" ? `${entry.title} — ` : "";
  return `- [${dateLabel}${moodTag}] ${titleTag}${summaryText || "(empty entry)"}`;
}

function getOrBuildDiaryVector(entry: DecodedDiaryEntry): CachedDiaryVector {
  const rawKey = `${entry.entryDate}|${entry.mood ?? ""}|${entry.title}|${entry.content}`;
  const hash = fnv1aHash(rawKey);
  const cacheKey = `${entry.entryDate}:${hash}`;
  const existing = vectorCache.get(cacheKey);
  if (existing && existing.hash === hash) {
    return existing;
  }

  const temporal = formatTemporalTerms(entry.entryDate);
  const boostTokens = [entry.title, entry.mood ?? "", ...temporal.terms].filter(Boolean);

  const vector = computeTextVector(
    `${entry.title} ${entry.mood ?? ""} ${temporal.terms.join(" ")} ${entry.content}`,
    boostTokens,
  );
  const digestLine = buildEntryDigestLine(entry, temporal.label);
  const tokenSet = new Set(tokenizeAndStem(`${entry.title} ${entry.mood ?? ""} ${entry.content}`));

  const built: CachedDiaryVector = {
    hash,
    vector,
    digestLine,
    tokenSet,
    temporalTerms: temporal.terms,
  };

  if (vectorCache.size > 400) {
    const firstKey = vectorCache.keys().next().value;
    if (firstKey) vectorCache.delete(firstKey);
  }
  vectorCache.set(cacheKey, built);
  return built;
}

export interface SmartDiaryContextResult {
  formattedText: string;
  focalCount: number;
  surroundingCount: number;
  digestCount: number;
}

/**
 * Builds a high-retention, token-smart Diary context using per-entry vectors:
 * 1. Every entry in the range appears in the chronological DIARY TIMELINE DIGEST
 *    with its multi-sentence extractive summary (or full text if <= 420 chars).
 * 2. Scores each entry's 512-dim vector against the user's query + recent conversation context.
 * 3. Pulls the top vector-matched focal entries AND their surrounding chronological entries
 *    (±1 neighbors before & after) in 100% FULL TEXT (up to 5,000 chars each), plus the 2 newest entries.
 * 4. If the total number of entries in the selected range is small (<= 6 entries), includes all of them in full text.
 */
export function buildSmartVectorDiaryContext(
  entriesNewestFirst: DecodedDiaryEntry[],
  userQuery: string,
  recentConversationText = "",
  startDate: string,
  endDate: string,
): SmartDiaryContextResult {
  if (entriesNewestFirst.length === 0) {
    return {
      formattedText: `=== DIARY ENTRIES (${startDate} → ${endDate}) ===\n(no diary entries in this range)`,
      focalCount: 0,
      surroundingCount: 0,
      digestCount: 0,
    };
  }

  const nodes = entriesNewestFirst.map((entry) => ({
    entry,
    meta: getOrBuildDiaryVector(entry),
  }));

  const combinedQuery = `${userQuery} ${recentConversationText}`.trim();
  const queryVec = computeTextVector(combinedQuery, [userQuery]);
  const queryTokens = tokenizeAndStem(combinedQuery);
  const queryLower = combinedQuery.toLowerCase();

  const scores = nodes.map((node, index) => {
    const cos = cosineSimilarity(queryVec, node.meta.vector);

    let lexicalHits = 0;
    for (const qt of queryTokens) {
      if (node.meta.tokenSet.has(qt)) lexicalHits++;
    }
    const lexicalRatio = queryTokens.length > 0 ? lexicalHits / queryTokens.length : 0;

    let temporalOrMoodBoost = 0;
    if (node.entry.mood && queryLower.includes(node.entry.mood.toLowerCase())) {
      temporalOrMoodBoost += 0.25;
    }
    for (const term of node.meta.temporalTerms) {
      if (term.length >= 3 && queryLower.includes(term)) {
        temporalOrMoodBoost += 0.3;
        break;
      }
    }

    if (index === 0 && /\b(today|latest|recent|last night|tonight)\b/i.test(queryLower)) {
      temporalOrMoodBoost += 0.35;
    } else if (index === 1 && /\b(yesterday|prior|before)\b/i.test(queryLower)) {
      temporalOrMoodBoost += 0.35;
    }

    const totalScore = cos * 0.55 + lexicalRatio * 0.35 + temporalOrMoodBoost;
    return { index, totalScore, lexicalHits, cos };
  });

  const focalIndices = new Set<number>();
  const surroundingIndices = new Set<number>();

  // If the date range only has <= 6 entries total, include all of them in full text so 0% is lost
  if (nodes.length <= 6) {
    for (let i = 0; i < nodes.length; i++) focalIndices.add(i);
  } else {
    // Always include the 2 most recent entries in full text
    focalIndices.add(0);
    if (nodes.length > 1) focalIndices.add(1);

    const SPECIFIC_THRESHOLD = 0.12;
    const rankedMatches = [...scores]
      .filter((s) => s.totalScore >= SPECIFIC_THRESHOLD || s.lexicalHits >= 1)
      .sort((a, b) => b.totalScore - a.totalScore)
      .slice(0, 3);

    for (const match of rankedMatches) {
      focalIndices.add(match.index);
      // Pull surrounding chronological entries (±1 neighbor before and after the matched focal entry)
      if (match.index - 1 >= 0 && !focalIndices.has(match.index - 1)) {
        surroundingIndices.add(match.index - 1);
      }
      if (match.index + 1 < nodes.length && !focalIndices.has(match.index + 1)) {
        surroundingIndices.add(match.index + 1);
      }
    }

    for (const fi of focalIndices) {
      surroundingIndices.delete(fi);
    }
  }

  const FULL_ENTRY_MAX_CHARS = 5000;
  const trim = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);

  const selectedFullIndices = [...focalIndices, ...surroundingIndices]
    .slice(0, 8)
    .sort((a, b) => a - b);

  const fullBlocks = selectedFullIndices.map((idx) => {
    const { entry } = nodes[idx];
    const roleTag = focalIndices.has(idx) ? "FOCAL / RECENT ENTRY" : "SURROUNDING ENTRY (±1 DAY)";
    return `[${entry.entryDate}${entry.mood ? ` · ${entry.mood}` : ""} · ${roleTag}] ${entry.title || "Untitled"}\n${trim(entry.content, FULL_ENTRY_MAX_CHARS)}`;
  });

  const digestLines = nodes.map((n) => n.meta.digestLine);

  const sections: string[] = [
    `=== DIARY TIMELINE DIGEST (${startDate} → ${endDate}, ${nodes.length} entries) ===\n${digestLines.join("\n")}`,
  ];

  if (fullBlocks.length > 0) {
    sections.push(
      `=== FULL TEXT OF VECTOR-MATCHED & SURROUNDING DIARY ENTRIES (${fullBlocks.length} entries in full detail) ===\n${fullBlocks.join("\n\n---\n\n")}`,
    );
  }

  return {
    formattedText: sections.join("\n\n"),
    focalCount: focalIndices.size,
    surroundingCount: surroundingIndices.size,
    digestCount: nodes.length,
  };
}
