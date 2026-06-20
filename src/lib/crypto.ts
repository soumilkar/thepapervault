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
  return crypto.subtle.importKey(
    "raw",
    buf(enc.encode(passphrase)),
    "PBKDF2",
    false,
    ["deriveBits", "deriveKey"],
  );
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

export async function encryptText(key: CryptoKey, plaintext: string): Promise<{ ct: string; iv: string }> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(iv) }, key, buf(enc.encode(plaintext)));
  return { ct: toB64(ct), iv: toB64(iv) };
}

export async function decryptText(key: CryptoKey, ctB64: string, ivB64: string): Promise<string> {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: buf(fromB64(ivB64)) },
    key,
    buf(fromB64(ctB64)),
  );
  return dec.decode(pt);
}

export async function encryptBlob(key: CryptoKey, blob: Blob): Promise<{ blob: Blob; iv: string }> {
  const iv = randomBytes(12);
  const buffer = await blob.arrayBuffer();
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(iv) }, key, buffer);
  return { blob: new Blob([ct], { type: "application/octet-stream" }), iv: toB64(iv) };
}

export async function decryptBytes(key: CryptoKey, bytes: ArrayBuffer, ivB64: string): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(fromB64(ivB64)) }, key, bytes);
}
