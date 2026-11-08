import assert from "node:assert/strict";
import test from "node:test";
import { decryptToken, encryptToken } from "./encryption.ts";

test("Gmail credentials encrypt at rest and decrypt only valid ciphertext", () => {
  const previousKey = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.TOKEN_ENCRYPTION_KEY = "test-encryption-key-that-is-more-than-32-chars";
  try {
    const encrypted = encryptToken("oauth-access-secret");
    assert.notEqual(encrypted, "oauth-access-secret");
    assert.equal(decryptToken(encrypted), "oauth-access-secret");
    assert.throws(() => decryptToken("plaintext-access-token"), /encrypted format/);
    assert.throws(() => decryptToken(`${encrypted.slice(0, -2)}00`), /Unsupported state|authenticate|Unsupported state or unable to authenticate data/);
  } finally {
    if (previousKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = previousKey;
  }
});
