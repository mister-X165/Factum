/**
 * Edge-safe auth primitives: session token signing/verification + base64url
 * helpers. Contains NO Node.js imports (no `crypto`, no `fs`, no `db`).
 *
 * This file is imported by `src/middleware.ts` which runs in the Edge Runtime.
 * The password-hashing and DB-access code lives in `src/lib/auth.ts` (Node.js
 * runtime only) to keep the Edge bundle clean.
 *
 * Token format:  base64url(JSON(payload)) + "." + base64url(HMAC-SHA256(payload, AUTH_SECRET))
 * Payload:       { uid, username, role, banned, exp }
 *
 * Uses ONLY the Web Crypto API (crypto.subtle) + btoa/atob — both available
 * in the Edge Runtime and Node.js ≥ 16.
 */

/** Cookie name carrying the signed session token. */
export const SESSION_COOKIE = "factum-session";

/** Token time-to-live in seconds (24 hours). */
export const TOKEN_TTL_SECONDS = 60 * 60 * 24;

/** Env var holding the HMAC signing secret. */
const AUTH_SECRET_ENV = "AUTH_SECRET";

export type UserRole = "admin" | "user";

/** Decoded session token payload. */
export interface SessionPayload {
  uid: string;
  username: string;
  role: UserRole;
  banned: boolean;
  exp: number; // unix seconds
}

// ---------------------------------------------------------------------------
// base64url helpers (work in both Edge and Node.js runtimes via btoa/atob)
// ---------------------------------------------------------------------------

export function b64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function b64urlDecode(str: string): Uint8Array {
  const padded =
    str.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (str.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Session token creation / verification (Web Crypto API — works everywhere)
// ---------------------------------------------------------------------------

async function getHmacKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

/** Get the AUTH_SECRET from env, or throw if missing. */
function getAuthSecret(): string {
  const secret = (process.env[AUTH_SECRET_ENV] || "").trim();
  if (!secret) {
    throw new Error(
      "AUTH_SECRET не задан в .env. Сгенерируйте случайную строку (≥ 32 символа) " +
        "и задайте AUTH_SECRET=<ваша-строка>, затем перезапустите сервер."
    );
  }
  return secret;
}

/** Create a signed session token for the given user. */
export async function createSessionToken(user: {
  id: string;
  username: string;
  role: UserRole;
  banned: boolean;
}): Promise<string> {
  const secret = getAuthSecret();
  const payload: SessionPayload = {
    uid: user.id,
    username: user.username,
    role: user.role,
    banned: user.banned,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
  };
  const data = new TextEncoder().encode(JSON.stringify(payload));
  const key = await getHmacKey(secret);
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, data as unknown as BufferSource)
  );
  return b64urlEncode(data) + "." + b64urlEncode(sig);
}

/**
 * Verify a signed session token. Returns the payload if the signature is
 * valid and the token hasn't expired, null otherwise.
 *
 * This function is safe to call in the Edge Runtime (middleware) — it uses
 * only Web Crypto API, no DB access, no Node.js modules.
 */
export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  if (!token) return null;
  const dotIdx = token.indexOf(".");
  if (dotIdx < 0) return null;
  const dataB64 = token.slice(0, dotIdx);
  const sigB64 = token.slice(dotIdx + 1);
  if (!dataB64 || !sigB64) return null;

  let secret: string;
  try {
    secret = getAuthSecret();
  } catch {
    return null;
  }

  const data = b64urlDecode(dataB64);
  const sig = b64urlDecode(sigB64);
  const key = await getHmacKey(secret);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    sig as unknown as BufferSource,
    data as unknown as BufferSource
  );
  if (!valid) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(data)) as SessionPayload;
  } catch {
    return null;
  }
  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }
  return payload;
}
