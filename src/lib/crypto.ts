// Browser-side end-to-end encryption helpers using Web Crypto (AES-GCM + PBKDF2).
// The server never sees the passphrase or the derived key.

const KDF_ITERATIONS = 250_000;
const KEY_BITS = 256;

const enc = new TextEncoder();
const dec = new TextDecoder();

// Cast helper: TS's lib.dom narrows BufferSource to ArrayBuffer-backed views, but Uint8Array
// from TextEncoder etc. is `Uint8Array<ArrayBufferLike>`. Crypto APIs accept both at runtime.
const buf = (v: Uint8Array): BufferSource => v as unknown as BufferSource;

export function toB64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < view.length; i++) s += String.fromCharCode(view[i]);
  return btoa(s);
}

export function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

async function importPassphrase(passphrase: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", buf(enc.encode(passphrase)), "PBKDF2", false, [
    "deriveBits",
    "deriveKey",
  ]);
}

export async function deriveDataKey(passphrase: string, saltB64: string): Promise<CryptoKey> {
  const baseKey = await importPassphrase(passphrase);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: buf(fromB64(saltB64)), iterations: KDF_ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: KEY_BITS },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function deriveVerifier(passphrase: string, saltB64: string): Promise<string> {
  const baseKey = await importPassphrase(passphrase);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: buf(fromB64(saltB64)), iterations: KDF_ITERATIONS, hash: "SHA-256" },
    baseKey,
    256,
  );
  return toB64(bits);
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const bytesA = enc.encode(a);
  const bytesB = enc.encode(b);
  const len = Math.max(bytesA.length, bytesB.length);
  let diff = bytesA.length ^ bytesB.length;
  for (let i = 0; i < len; i++) {
    diff |= (bytesA[i] ?? 0) ^ (bytesB[i] ?? 0);
  }
  return diff === 0;
}

export async function encryptText(
  key: CryptoKey,
  plaintext: string,
): Promise<{ ct: string; iv: string }> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: buf(iv), tagLength: 128 },
    key,
    buf(enc.encode(plaintext)),
  );
  return { ct: toB64(ct), iv: toB64(iv) };
}

let decryptTextCache = new WeakMap<CryptoKey, Map<string, string>>();

export function clearCryptoCache(): void {
  decryptTextCache = new WeakMap<CryptoKey, Map<string, string>>();
}

export async function decryptText(key: CryptoKey, ctB64: string, ivB64: string): Promise<string> {
  let keyMap = decryptTextCache.get(key);
  const cacheKey = `${ivB64}:${ctB64}`;
  if (keyMap) {
    const cached = keyMap.get(cacheKey);
    if (cached !== undefined) return cached;
  }

  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: buf(fromB64(ivB64)), tagLength: 128 },
    key,
    buf(fromB64(ctB64)),
  );
  const plain = dec.decode(pt);

  if (!keyMap) {
    keyMap = new Map<string, string>();
    decryptTextCache.set(key, keyMap);
  }
  keyMap.set(cacheKey, plain);
  return plain;
}

const FIELD_PREFIX = "e2ee:v1:";

export function isEncryptedField(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(FIELD_PREFIX);
}

export async function encryptField(key: CryptoKey, plaintext: string): Promise<string> {
  const { ct, iv } = await encryptText(key, plaintext);
  return `${FIELD_PREFIX}${iv}:${ct}`;
}

export async function decryptField(
  key: CryptoKey,
  raw: string,
): Promise<{ plaintext: string; wasEncrypted: boolean }> {
  if (!isEncryptedField(raw)) {
    return { plaintext: raw, wasEncrypted: false };
  }
  const rest = raw.slice(FIELD_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep <= 0) {
    return { plaintext: "[encrypted]", wasEncrypted: true };
  }
  const iv = rest.slice(0, sep);
  const ct = rest.slice(sep + 1);
  const plaintext = await decryptText(key, ct, iv);
  return { plaintext, wasEncrypted: true };
}

export async function encryptBlob(key: CryptoKey, blob: Blob): Promise<{ blob: Blob; iv: string }> {
  const iv = randomBytes(12);
  const buffer = await blob.arrayBuffer();
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: buf(iv), tagLength: 128 },
    key,
    buffer,
  );
  return { blob: new Blob([ct], { type: "application/octet-stream" }), iv: toB64(iv) };
}

export async function decryptBytes(
  key: CryptoKey,
  bytes: ArrayBuffer,
  ivB64: string,
): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv: buf(fromB64(ivB64)), tagLength: 128 },
    key,
    bytes,
  );
}
