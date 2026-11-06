// End-to-end authenticated transport envelope (Ephemeral ECDH P-256 + HKDF-SHA256 + AES-256-GCM)
// Protects AI Companion prompts, diary context, chat history, handwriting OCR images, and streamed replies
// against network interception, TLS-terminating middleboxes, header/token capture, tampering, and replay attacks.

const enc = new TextEncoder();
const dec = new TextDecoder();

const buf = (v: Uint8Array): BufferSource => v as unknown as BufferSource;

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000; // 5 minutes anti-replay window

export interface EncryptedCompanionEnvelope {
  v: 2;
  kid: string;
  epk: string;
  ts: number;
  salt: string;
  iv: string;
  ct: string;
}

function bytesToB64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (typeof Buffer !== "undefined") {
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString("base64");
  }
  let s = "";
  for (let i = 0; i < view.length; i++) s += String.fromCharCode(view[i]);
  return btoa(s);
}

function b64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    const b = Buffer.from(b64, "base64");
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  }
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

// ============================================================================
// Server-side non-extractable ECDH P-256 keypair (private key never leaves RAM)
// ============================================================================
interface ServerEcdhIdentity {
  kid: string;
  pubB64: string;
  privateKey: CryptoKey;
}

let serverIdentityPromise: Promise<ServerEcdhIdentity> | null = null;

async function getServerIdentity(): Promise<ServerEcdhIdentity> {
  if (!serverIdentityPromise) {
    serverIdentityPromise = (async () => {
      const kp = (await globalThis.crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        false, // non-extractable private key
        ["deriveBits"],
      )) as CryptoKeyPair;
      const rawPub = new Uint8Array(await globalThis.crypto.subtle.exportKey("raw", kp.publicKey));
      const hash = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", buf(rawPub)));
      const kid = bytesToHex(hash.slice(0, 8));
      return {
        kid,
        pubB64: bytesToB64(rawPub),
        privateKey: kp.privateKey,
      };
    })();
  }
  return serverIdentityPromise;
}

export async function getServerTransportPublicKey(): Promise<{ kid: string; pub: string }> {
  const id = await getServerIdentity();
  return { kid: id.kid, pub: id.pubB64 };
}

// ============================================================================
// Client-side cached server public key
// ============================================================================
interface CachedServerPublicKey {
  kid: string;
  pubB64: string;
  publicKey: CryptoKey;
}

let clientCachedServerKey: CachedServerPublicKey | null = null;
let clientKeyFetchPromise: Promise<CachedServerPublicKey> | null = null;

async function fetchServerPublicKey(forceRefresh = false): Promise<CachedServerPublicKey> {
  if (clientCachedServerKey && !forceRefresh) {
    return clientCachedServerKey;
  }
  if (clientKeyFetchPromise && !forceRefresh) {
    return clientKeyFetchPromise;
  }
  clientKeyFetchPromise = (async () => {
    const res = await fetch("/api/companion-stream", {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) {
      throw new Error("Could not establish secure channel with Companion");
    }
    const data = (await res.json()) as { kid?: string; pub?: string };
    if (!data?.kid || !data?.pub) {
      throw new Error("Invalid Companion key exchange response");
    }
    const pubBytes = b64ToBytes(data.pub);
    const publicKey = await globalThis.crypto.subtle.importKey(
      "raw",
      buf(pubBytes),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
    const entry: CachedServerPublicKey = {
      kid: data.kid,
      pubB64: data.pub,
      publicKey,
    };
    clientCachedServerKey = entry;
    return entry;
  })();

  try {
    return await clientKeyFetchPromise;
  } finally {
    clientKeyFetchPromise = null;
  }
}

async function deriveHybridAesGcmKey(
  ecdhSharedBits: ArrayBuffer,
  accessToken: string,
  saltB64: string,
  kid: string,
  epkB64: string,
  ts: number,
): Promise<CryptoKey> {
  const tokenHash = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", buf(enc.encode(accessToken.trim()))),
  );
  const sharedBytes = new Uint8Array(ecdhSharedBits);
  const ikm = new Uint8Array(sharedBytes.length + tokenHash.length);
  ikm.set(sharedBytes, 0);
  ikm.set(tokenHash, sharedBytes.length);

  const keyMaterial = await globalThis.crypto.subtle.importKey("raw", buf(ikm), "HKDF", false, [
    "deriveKey",
  ]);
  // Zero out temporary IKM array
  ikm.fill(0);
  sharedBytes.fill(0);
  tokenHash.fill(0);

  const saltBytes = b64ToBytes(saltB64);
  const infoBytes = enc.encode(`papervault-ecdh-v2:${kid}:${epkB64}:${ts}`);

  return globalThis.crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: buf(saltBytes),
      info: buf(infoBytes),
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptCompanionRequest(
  accessToken: string,
  payload: unknown,
  forceRefreshServerKey = false,
): Promise<{ envelope: EncryptedCompanionEnvelope; transportKey: CryptoKey }> {
  const serverKey = await fetchServerPublicKey(forceRefreshServerKey);

  // Ephemeral P-256 keypair generated per request for forward secrecy
  const ephemeralKp = (await globalThis.crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false, // non-extractable ephemeral private key
    ["deriveBits"],
  )) as CryptoKeyPair;

  const epkBytes = new Uint8Array(
    await globalThis.crypto.subtle.exportKey("raw", ephemeralKp.publicKey),
  );
  const epk = bytesToB64(epkBytes);

  const sharedBits = await globalThis.crypto.subtle.deriveBits(
    { name: "ECDH", public: serverKey.publicKey },
    ephemeralKp.privateKey,
    256,
  );

  const ts = Date.now();
  const salt = bytesToB64(randomBytes(16));
  const ivBytes = randomBytes(12);
  const iv = bytesToB64(ivBytes);

  const transportKey = await deriveHybridAesGcmKey(
    sharedBits,
    accessToken,
    salt,
    serverKey.kid,
    epk,
    ts,
  );

  const aad = enc.encode(`req:v2:${serverKey.kid}:${epk}:${ts}:${salt}`);
  const plainBytes = enc.encode(JSON.stringify(payload));

  const ctBuf = await globalThis.crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: buf(ivBytes),
      additionalData: buf(aad),
      tagLength: 128,
    },
    transportKey,
    buf(plainBytes),
  );

  return {
    envelope: {
      v: 2,
      kid: serverKey.kid,
      epk,
      ts,
      salt,
      iv,
      ct: bytesToB64(ctBuf),
    },
    transportKey,
  };
}

export async function postEncryptedCompanionRequest(
  url: string,
  accessToken: string,
  payload: unknown,
): Promise<{
  response: Response;
  transportKey: CryptoKey;
  envelope: EncryptedCompanionEnvelope;
}> {
  let attempt = await encryptCompanionRequest(accessToken, payload, false);
  let response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(attempt.envelope),
  });

  // If the server rotated its ephemeral keypair, refresh once and retry transparently
  if (response.status === 409 && response.headers.get("x-companion-key-mismatch") === "1") {
    attempt = await encryptCompanionRequest(accessToken, payload, true);
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(attempt.envelope),
    });
  }

  return {
    response,
    transportKey: attempt.transportKey,
    envelope: attempt.envelope,
  };
}

export class CompanionKeyMismatchError extends Error {
  constructor() {
    super("Server transport key rotated");
    this.name = "CompanionKeyMismatchError";
  }
}

export async function decryptCompanionRequest(
  accessToken: string,
  envelope: EncryptedCompanionEnvelope,
): Promise<{ payload: unknown; transportKey: CryptoKey; ts: number }> {
  const now = Date.now();
  if (
    typeof envelope.ts !== "number" ||
    !Number.isFinite(envelope.ts) ||
    Math.abs(now - envelope.ts) > MAX_CLOCK_SKEW_MS
  ) {
    throw new Error("Companion request timestamp expired or invalid");
  }

  const serverIdentity = await getServerIdentity();
  if (envelope.kid !== serverIdentity.kid) {
    throw new CompanionKeyMismatchError();
  }

  const epkBytes = b64ToBytes(envelope.epk);
  const clientPublicKey = await globalThis.crypto.subtle.importKey(
    "raw",
    buf(epkBytes),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );

  const sharedBits = await globalThis.crypto.subtle.deriveBits(
    { name: "ECDH", public: clientPublicKey },
    serverIdentity.privateKey,
    256,
  );

  const transportKey = await deriveHybridAesGcmKey(
    sharedBits,
    accessToken,
    envelope.salt,
    envelope.kid,
    envelope.epk,
    envelope.ts,
  );

  const ivBytes = b64ToBytes(envelope.iv);
  const ctBytes = b64ToBytes(envelope.ct);
  const aad = enc.encode(`req:v2:${envelope.kid}:${envelope.epk}:${envelope.ts}:${envelope.salt}`);

  const plainBuf = await globalThis.crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: buf(ivBytes),
      additionalData: buf(aad),
      tagLength: 128,
    },
    transportKey,
    buf(ctBytes),
  );

  const jsonStr = dec.decode(plainBuf);
  return {
    payload: JSON.parse(jsonStr),
    transportKey,
    ts: envelope.ts,
  };
}

export async function encryptStreamChunk(
  transportKey: CryptoKey,
  ts: number,
  seq: number,
  textChunk: string,
): Promise<string> {
  const ivBytes = randomBytes(12);
  const aad = enc.encode(`res:v2:${ts}:${seq}`);
  const ctBuf = await globalThis.crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: buf(ivBytes),
      additionalData: buf(aad),
      tagLength: 128,
    },
    transportKey,
    buf(enc.encode(textChunk)),
  );
  return `${seq}.${bytesToB64(ivBytes)}.${bytesToB64(ctBuf)}\n`;
}

export async function decryptStreamChunk(
  transportKey: CryptoKey,
  ts: number,
  expectedSeq: number,
  frameLine: string,
): Promise<string> {
  const parts = frameLine.trim().split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed encrypted stream frame");
  }
  const seq = Number(parts[0]);
  if (seq !== expectedSeq) {
    throw new Error("Stream frame sequence mismatch");
  }
  const ivBytes = b64ToBytes(parts[1]);
  const ctBytes = b64ToBytes(parts[2]);
  const aad = enc.encode(`res:v2:${ts}:${seq}`);

  const plainBuf = await globalThis.crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: buf(ivBytes),
      additionalData: buf(aad),
      tagLength: 128,
    },
    transportKey,
    buf(ctBytes),
  );

  return dec.decode(plainBuf);
}
