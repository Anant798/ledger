import crypto from "crypto";

// 32-byte key derived from server secret or fallback
const ENCRYPTION_SECRET =
  process.env.TOKEN_ENCRYPTION_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  "ledger-secure-server-token-key-32";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const KEY = crypto.createHash("sha256").update(ENCRYPTION_SECRET).digest();

export function encryptToken(plainText: string): string {
  if (!plainText) return "";
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);

  let encrypted = cipher.update(plainText, "utf8", "hex");
  encrypted += cipher.final("hex");

  const tag = cipher.getAuthTag().toString("hex");

  // Format: iv:tag:encrypted
  return `${iv.toString("hex")}:${tag}:${encrypted}`;
}

export function decryptToken(cipherText: string): string {
  if (!cipherText) return "";
  // If not in encrypted format (e.g. legacy plain text during dev), return as-is
  if (!cipherText.includes(":")) return cipherText;

  const parts = cipherText.split(":");
  if (parts.length !== 3) return cipherText;

  const [ivHex, tagHex, encrypted] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");

  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}
