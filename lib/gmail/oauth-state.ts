import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const MAX_AGE_MS = 10 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type GmailOAuthState = { userId: string; issuedAt: number; nonce: string };

function sign(payload: string, secret: string) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createGmailOAuthState(userId: string, secret: string, now = Date.now()) {
  if (!UUID_PATTERN.test(userId)) throw new Error("A valid user ID is required for Gmail authorization.");
  if (secret.length < 32) throw new Error("TOKEN_ENCRYPTION_KEY must contain at least 32 characters.");
  const state: GmailOAuthState = { userId, issuedAt: now, nonce: randomBytes(16).toString("base64url") };
  const payload = Buffer.from(JSON.stringify(state)).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyGmailOAuthState(value: string, secret: string, now = Date.now()): GmailOAuthState {
  if (secret.length < 32) throw new Error("TOKEN_ENCRYPTION_KEY must contain at least 32 characters.");
  const [payload, providedSignature, extra] = value.split(".");
  if (!payload || !providedSignature || extra) throw new Error("Invalid Gmail OAuth state.");
  const expected = Buffer.from(sign(payload, secret));
  const provided = Buffer.from(providedSignature);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    throw new Error("Invalid Gmail OAuth state signature.");
  }
  let state: GmailOAuthState;
  try {
    state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as GmailOAuthState;
  } catch {
    throw new Error("Invalid Gmail OAuth state payload.");
  }
  if (!state || typeof state !== "object" || !UUID_PATTERN.test(state.userId) ||
      !Number.isFinite(state.issuedAt) || typeof state.nonce !== "string" || !state.nonce ||
      now - state.issuedAt > MAX_AGE_MS || state.issuedAt > now + 60_000) {
    throw new Error("Gmail OAuth state is expired or invalid.");
  }
  return state;
}
