import {
  decryptText,
  deriveDataKey,
  deriveVerifier,
  encryptText,
  randomBytes,
  timingSafeEqualStr,
  toB64,
} from "@/lib/crypto";
import { supabase } from "@/integrations/supabase/client";
import { getFreshAccessToken } from "@/lib/offline-supabase";

export type SecurityQuestionOption = {
  id: string;
  slot: 1 | 2 | 3;
  question: string;
};

// Curated high-entropy personal memory questions designed to be resistant to OSINT / social media guessing.
export const SECURITY_QUESTION_POOL: SecurityQuestionOption[] = [
  // Slot 1 — Childhood places, specific numbers, and early memories
  {
    id: "sq_1_street",
    slot: 1,
    question:
      "What was the exact house/apartment number and street name of the earliest home you vividly remember?",
  },
  {
    id: "sq_1_teacher",
    slot: 1,
    question:
      "What was the full name of the teacher or mentor who gave you the hardest time (or biggest break) in school?",
  },
  {
    id: "sq_1_vehicle",
    slot: 1,
    question:
      "What was the make, model, and color of the first vehicle you ever rode in on a long road trip?",
  },
  {
    id: "sq_1_concert",
    slot: 1,
    question:
      "What was the very first concert, live show, or theater movie you paid for with your own money?",
  },
  {
    id: "sq_1_neighbor",
    slot: 1,
    question: "What was the last name of a childhood neighbor whom your family talked about often?",
  },

  // Slot 2 — Private moments, hiding spots, and specific misadventures
  {
    id: "sq_2_hiding",
    slot: 2,
    question:
      "What was a specific hiding spot, room corner, or outdoor place you went to when you wanted to be alone as a child?",
  },
  {
    id: "sq_2_cooking",
    slot: 2,
    question:
      "What was the first meal or dish you ever tried to cook by yourself that went memorably wrong?",
  },
  {
    id: "sq_2_gift",
    slot: 2,
    question:
      "What was the most unusual or specific gift you ever received that you still remember clearly?",
  },
  {
    id: "sq_2_grownup",
    slot: 2,
    question:
      "In what specific city or building were you standing during a moment you suddenly realized you had grown up?",
  },
  {
    id: "sq_2_injury",
    slot: 2,
    question:
      "What specific object or activity caused the most memorable minor scar or scrape from your childhood?",
  },

  // Slot 3 — Personal objects, private nicknames, and forgotten places
  {
    id: "sq_3_bedside",
    slot: 3,
    question:
      "What specific object sat on your bedside table or desk when you were fourteen years old?",
  },
  {
    id: "sq_3_nickname",
    slot: 3,
    question:
      "What is a private nickname or inside-joke phrase that only one person in your life has ever used for you?",
  },
  {
    id: "sq_3_trip",
    slot: 3,
    question:
      "What was the destination of a trip you planned or dreamed about taking that ended up getting canceled or changed?",
  },
  {
    id: "sq_3_shop",
    slot: 3,
    question:
      "What was the name of a small local shop, bakery, or café that no longer exists but you still miss?",
  },
  {
    id: "sq_3_book",
    slot: 3,
    question:
      "What was the title or cover subject of a book you read years ago that left a strange, lasting impression on you?",
  },
];

export const SIX_MONTHS_MS = 180 * 24 * 60 * 60 * 1000; // 6 months (180 days)

export type StoredQuestionEntry = {
  id: string;
  question: string;
  salt: string;
  verifier: string;
};

export type QuestionsRecoveryEnvelope = {
  salt: string;
  iv: string;
  ct: string;
  updated_at: string;
};

export type SecurityQuestionsRecord = {
  version: 1;
  user_id?: string;
  email_hash?: string;
  questions: StoredQuestionEntry[];
  combined_salt: string;
  verifier_salt: string;
  combined_verifier: string;
  questions_recovery_envelope?: QuestionsRecoveryEnvelope | null;
  created_at: string;
  expires_at: string;
};

export type SecurityQuestionsChallenge = {
  configured: boolean;
  questions: { id: string; question: string; salt: string }[];
  combined_salt: string;
  verifier_salt: string;
  created_at: string;
  expires_at: string;
  questions_recovery_envelope?: QuestionsRecoveryEnvelope | null;
};

const LOCAL_SQ_KEY_PREFIX = "papervault:security_questions:v1:";
const ONBOARDED_SQ_KEY_PREFIX = "papervault:sq_onboarded:";
const PENDING_SIGNUP_SQ_KEY = "papervault:pending_signup_sq:v1";

export function markSecurityQuestionsOnboarded(userId: string): void {
  if (typeof window === "undefined" || !userId) return;
  try {
    window.localStorage.setItem(`${ONBOARDED_SQ_KEY_PREFIX}${userId}`, "1");
  } catch {
    // ignore
  }
}

export function hasCompletedSecurityQuestionsOnboarding(userId: string): boolean {
  if (typeof window === "undefined" || !userId) return false;
  try {
    if (window.localStorage.getItem(`${ONBOARDED_SQ_KEY_PREFIX}${userId}`) === "1") {
      return true;
    }
    if (getCachedSecurityQuestions(userId)) {
      window.localStorage.setItem(`${ONBOARDED_SQ_KEY_PREFIX}${userId}`, "1");
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

export function normalizeSecurityAnswer(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ");
}

function buildCombinedAnswerSecret(questionIds: string[], normalizedAnswers: string[]): string {
  return questionIds.map((qid, idx) => `${qid}:${normalizedAnswers[idx] ?? ""}`).join("|");
}

export function isSecurityQuestionsExpired(
  record: { created_at?: string; expires_at?: string } | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (!record) return false;
  if (record.expires_at) {
    const exp = Date.parse(record.expires_at);
    if (!Number.isNaN(exp)) return nowMs >= exp;
  }
  if (record.created_at) {
    const created = Date.parse(record.created_at);
    if (!Number.isNaN(created)) return nowMs - created >= SIX_MONTHS_MS;
  }
  return false;
}

export function getDaysUntilDepreciation(
  record: { created_at?: string; expires_at?: string } | null | undefined,
  nowMs = Date.now(),
): number {
  if (!record) return 0;
  const exp = record.expires_at
    ? Date.parse(record.expires_at)
    : record.created_at
      ? Date.parse(record.created_at) + SIX_MONTHS_MS
      : 0;
  if (!exp || Number.isNaN(exp)) return 0;
  return Math.max(0, Math.ceil((exp - nowMs) / (24 * 60 * 60 * 1000)));
}

/**
 * Builds a zero-knowledge SecurityQuestionsRecord in the browser using PBKDF2-HMAC-SHA256 (250,000 iterations).
 * Plaintext answers never leave the browser.
 */
export async function buildSecurityQuestionsRecord(params: {
  userId?: string;
  selectedQuestions: { id: string; question: string; answer: string }[];
  vaultPassphrase?: string | null;
}): Promise<SecurityQuestionsRecord> {
  if (params.selectedQuestions.length !== 3) {
    throw new Error("Please select and answer all 3 security questions.");
  }

  const normalizedAnswers = params.selectedQuestions.map((q) => normalizeSecurityAnswer(q.answer));
  for (let i = 0; i < normalizedAnswers.length; i++) {
    if (normalizedAnswers[i].length < 2) {
      throw new Error(`Answer ${i + 1} is too short. Please provide a memorable answer.`);
    }
  }

  const uniqueIds = new Set(params.selectedQuestions.map((q) => q.id));
  if (uniqueIds.size !== 3) {
    throw new Error("Please choose 3 different security questions.");
  }

  const storedQuestions: StoredQuestionEntry[] = await Promise.all(
    params.selectedQuestions.map(async (q, idx) => {
      const salt = toB64(randomBytes(16));
      const verifier = await deriveVerifier(`${q.id}:${normalizedAnswers[idx]}`, salt);
      return {
        id: q.id,
        question: q.question,
        salt,
        verifier,
      };
    }),
  );

  const combinedSalt = toB64(randomBytes(16));
  let verifierSalt = toB64(randomBytes(16));
  while (verifierSalt === combinedSalt) {
    verifierSalt = toB64(randomBytes(16));
  }

  const combinedSecret = buildCombinedAnswerSecret(
    params.selectedQuestions.map((q) => q.id),
    normalizedAnswers,
  );
  const combinedVerifier = await deriveVerifier(combinedSecret, verifierSalt);

  let questionsRecoveryEnvelope: QuestionsRecoveryEnvelope | null = null;
  if (params.vaultPassphrase && params.vaultPassphrase.length >= 8) {
    const wrappingKey = await deriveDataKey(combinedSecret, combinedSalt);
    const { ct, iv } = await encryptText(wrappingKey, params.vaultPassphrase);
    questionsRecoveryEnvelope = {
      salt: combinedSalt,
      iv,
      ct,
      updated_at: new Date().toISOString(),
    };
  }

  const now = Date.now();
  return {
    version: 1,
    user_id: params.userId,
    questions: storedQuestions,
    combined_salt: combinedSalt,
    verifier_salt: verifierSalt,
    combined_verifier: combinedVerifier,
    questions_recovery_envelope: questionsRecoveryEnvelope,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + SIX_MONTHS_MS).toISOString(),
  };
}

/**
 * Wraps the user's vault passphrase with the key derived from their 3 security answers,
 * or if we only have the record + answers, updates `questions_recovery_envelope`.
 */
export async function computeSecurityAnswerVerifiers(
  challenge: {
    questions: { id: string; salt: string }[];
    combined_salt: string;
    verifier_salt: string;
  },
  rawAnswers: string[],
): Promise<{
  verifiers: string[];
  combinedVerifier: string;
  combinedSecret: string;
}> {
  if (challenge.questions.length !== 3 || rawAnswers.length !== 3) {
    throw new Error("Please answer all 3 security questions.");
  }
  const normalizedAnswers = rawAnswers.map((a) => normalizeSecurityAnswer(a));
  for (let i = 0; i < 3; i++) {
    if (!normalizedAnswers[i]) {
      throw new Error(`Please provide an answer for question ${i + 1}.`);
    }
  }

  const verifiers = await Promise.all(
    challenge.questions.map((q, idx) =>
      deriveVerifier(`${q.id}:${normalizedAnswers[idx]}`, q.salt),
    ),
  );

  const combinedSecret = buildCombinedAnswerSecret(
    challenge.questions.map((q) => q.id),
    normalizedAnswers,
  );
  const combinedVerifier = await deriveVerifier(combinedSecret, challenge.verifier_salt);

  return {
    verifiers,
    combinedVerifier,
    combinedSecret,
  };
}

export async function verifyAnswersAgainstLocalRecord(
  record: SecurityQuestionsRecord,
  rawAnswers: string[],
): Promise<{ verified: boolean; combinedSecret: string }> {
  const { verifiers, combinedVerifier, combinedSecret } = await computeSecurityAnswerVerifiers(
    record,
    rawAnswers,
  );
  let allMatch = timingSafeEqualStr(combinedVerifier, record.combined_verifier);
  for (let i = 0; i < record.questions.length; i++) {
    if (!timingSafeEqualStr(verifiers[i] ?? "", record.questions[i].verifier)) {
      allMatch = false;
    }
  }
  return { verified: allMatch, combinedSecret };
}

export async function unwrapPassphraseWithSecurityAnswers(
  envelope: QuestionsRecoveryEnvelope,
  combinedSecret: string,
): Promise<string> {
  const wrappingKey = await deriveDataKey(combinedSecret, envelope.salt);
  return decryptText(wrappingKey, envelope.ct, envelope.iv);
}

export function getCachedSecurityQuestions(userId: string): SecurityQuestionsRecord | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(`${LOCAL_SQ_KEY_PREFIX}${userId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SecurityQuestionsRecord;
    if (
      parsed &&
      Array.isArray(parsed.questions) &&
      parsed.questions.length === 3 &&
      typeof parsed.combined_verifier === "string"
    ) {
      return parsed;
    }
  } catch {
    // ignore
  }
  return null;
}

export function cacheSecurityQuestions(userId: string, record: SecurityQuestionsRecord): void {
  if (typeof window === "undefined") return;
  try {
    // Strip verifier hashes before caching in localStorage so hashes cannot be extracted offline
    const sanitized: SecurityQuestionsRecord = {
      ...record,
      user_id: userId,
      combined_verifier: "",
      questions: record.questions.map((q) => ({
        id: q.id,
        question: q.question,
        salt: q.salt,
        verifier: "",
      })),
    };
    window.localStorage.setItem(`${LOCAL_SQ_KEY_PREFIX}${userId}`, JSON.stringify(sanitized));
    markSecurityQuestionsOnboarded(userId);
  } catch {
    // ignore
  }
}

export function stashPendingSignupSecurityQuestions(record: SecurityQuestionsRecord): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(PENDING_SIGNUP_SQ_KEY, JSON.stringify(record));
    window.localStorage.removeItem(PENDING_SIGNUP_SQ_KEY);
  } catch {
    // ignore
  }
}

export function consumePendingSignupSecurityQuestions(): SecurityQuestionsRecord | null {
  if (typeof window === "undefined") return null;
  try {
    const raw =
      window.sessionStorage.getItem(PENDING_SIGNUP_SQ_KEY) ||
      window.localStorage.getItem(PENDING_SIGNUP_SQ_KEY);
    if (!raw) return null;
    window.sessionStorage.removeItem(PENDING_SIGNUP_SQ_KEY);
    window.localStorage.removeItem(PENDING_SIGNUP_SQ_KEY);
    const parsed = JSON.parse(raw) as SecurityQuestionsRecord;
    if (parsed && Array.isArray(parsed.questions) && parsed.questions.length === 3) {
      return parsed;
    }
  } catch {
    // ignore
  }
  return null;
}

function parseMetadataSecurityRecord(
  userId: string,
  metaRaw: unknown,
): SecurityQuestionsRecord | null {
  if (!metaRaw || typeof metaRaw !== "object") return null;
  const rec = metaRaw as Record<string, unknown>;
  if (!Array.isArray(rec.questions) || rec.questions.length !== 3) return null;
  if (typeof rec.combined_salt !== "string" || typeof rec.verifier_salt !== "string") return null;
  return {
    version: 1,
    user_id: userId,
    questions: (rec.questions as Record<string, unknown>[]).map((q) => ({
      id: String(q.id || ""),
      question: String(q.question || ""),
      salt: String(q.salt || ""),
      verifier: "",
    })),
    combined_salt: rec.combined_salt,
    verifier_salt: rec.verifier_salt,
    combined_verifier: "",
    created_at: typeof rec.created_at === "string" ? rec.created_at : new Date().toISOString(),
    expires_at:
      typeof rec.expires_at === "string"
        ? rec.expires_at
        : new Date(Date.now() + SIX_MONTHS_MS).toISOString(),
  };
}

export async function saveSecurityQuestionsToServer(
  userId: string,
  record: SecurityQuestionsRecord,
): Promise<void> {
  const payload: SecurityQuestionsRecord = {
    ...record,
    user_id: userId,
  };
  cacheSecurityQuestions(userId, payload);
  markSecurityQuestionsOnboarded(userId);

  if (typeof navigator !== "undefined" && !navigator.onLine) return;

  // Also persist directly in Supabase Auth user_metadata so it survives logout/login on every device
  void supabase.auth
    .updateUser({
      data: {
        papervault_sq_onboarded: true,
        papervault_sq_v1: {
          version: 1,
          user_id: userId,
          questions: payload.questions,
          combined_salt: payload.combined_salt,
          verifier_salt: payload.verifier_salt,
          combined_verifier: payload.combined_verifier,
          created_at: payload.created_at,
          expires_at: payload.expires_at,
        },
      },
    })
    .catch(() => {});

  const token = await getFreshAccessToken();
  if (!token) return;

  const res = await fetch(`/api/storage-proxy?action=security-questions-save`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || "Failed to save security questions to server");
  }
  const saved = (await res.json().catch(() => ({}))) as {
    created_at?: string;
    expires_at?: string;
  };
  if (saved.created_at && saved.expires_at) {
    cacheSecurityQuestions(userId, {
      ...payload,
      created_at: saved.created_at,
      expires_at: saved.expires_at,
    });
  }
}

export async function fetchUserSecurityQuestions(
  userId: string,
): Promise<SecurityQuestionsRecord | null> {
  let local = getCachedSecurityQuestions(userId);

  // Check active Supabase session user_metadata (available in 0ms right after login)
  try {
    const { data: sessionData } = await supabase.auth.getSession();
    const meta = sessionData.session?.user?.user_metadata as Record<string, unknown> | undefined;
    if (meta?.papervault_sq_onboarded) {
      markSecurityQuestionsOnboarded(userId);
    }
    const metaRecord = parseMetadataSecurityRecord(userId, meta?.papervault_sq_v1);
    if (metaRecord) {
      cacheSecurityQuestions(userId, metaRecord);
      local = metaRecord;
    }
  } catch {
    // ignore
  }

  if (typeof navigator !== "undefined" && !navigator.onLine) {
    return local;
  }
  try {
    const token = await getFreshAccessToken();
    if (token) {
      const res = await fetch(`/api/storage-proxy?action=security-questions-get&_t=${Date.now()}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          configured?: boolean;
          record?: SecurityQuestionsRecord;
        };
        if (data?.configured && data.record && Array.isArray(data.record.questions)) {
          cacheSecurityQuestions(userId, data.record);
          return data.record;
        }
      }
    }
  } catch {
    // fallback to local / session metadata
  }
  return local;
}

export async function verifyAuthedSecurityQuestionsOnServer(
  record: SecurityQuestionsRecord,
  rawAnswers: string[],
): Promise<{ verified: boolean; combinedSecret: string }> {
  const { verifiers, combinedVerifier, combinedSecret } = await computeSecurityAnswerVerifiers(
    record,
    rawAnswers,
  );
  const token = await getFreshAccessToken();
  if (!token) {
    throw new Error("Your session expired. Please sign in again.");
  }
  const res = await fetch(`/api/storage-proxy?action=security-questions-verify-authed`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      verifiers,
      combined_verifier: combinedVerifier,
    }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || "One or more security question answers did not match.");
  }
  const data = (await res.json()) as { verified?: boolean };
  return { verified: Boolean(data.verified), combinedSecret };
}

export async function fetchEmailSecurityChallenge(
  email: string,
): Promise<SecurityQuestionsChallenge | null> {
  const res = await fetch(`/api/storage-proxy?action=security-questions-challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: email.trim().toLowerCase() }),
  });
  if (!res.ok) {
    return null;
  }
  const data = (await res.json()) as SecurityQuestionsChallenge;
  if (!data?.configured || !Array.isArray(data.questions) || data.questions.length !== 3) {
    return null;
  }
  return data;
}

export async function verifyEmailSecurityChallengeOnServer(
  email: string,
  challenge: SecurityQuestionsChallenge,
  rawAnswers: string[],
): Promise<boolean> {
  const { verifiers, combinedVerifier } = await computeSecurityAnswerVerifiers(
    challenge,
    rawAnswers,
  );
  const res = await fetch(`/api/storage-proxy?action=security-questions-verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: email.trim().toLowerCase(),
      verifiers,
      combined_verifier: combinedVerifier,
    }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || "Incorrect security question answers.");
  }
  const data = (await res.json()) as { verified?: boolean };
  return Boolean(data.verified);
}
