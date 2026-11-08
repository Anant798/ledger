import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function getKey() {
  const secret = process.env.TOKEN_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be configured with at least 32 characters.");
  }
  return crypto.createHash("sha256").update(secret).digest();
}

export function encryptToken(plainText: string): string {
  if (!plainText) return "";
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);

  let encrypted = cipher.update(plainText, "utf8", "hex");
  encrypted += cipher.final("hex");

  const tag = cipher.getAuthTag().toString("hex");

  // Format: iv:tag:encrypted
  return `${iv.toString("hex")}:${tag}:${encrypted}`;
}

export function decryptToken(cipherText: string): string {
  if (!cipherText) return "";
  const parts = cipherText.split(":");
  if (parts.length !== 3 || !/^[a-f0-9]{24}$/i.test(parts[0]) ||
      !/^[a-f0-9]{32}$/i.test(parts[1]) || !/^(?:[a-f0-9]{2})+$/i.test(parts[2])) {
    throw new Error("Stored Gmail credential is not in the expected encrypted format.");
  }

  const [ivHex, tagHex, encrypted] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");

  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}
