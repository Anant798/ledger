import assert from "node:assert/strict";
import test from "node:test";
import {
  GMAIL_CALLBACK_PATH,
  GMAIL_SCOPES,
  generateAuthUrl,
  getGmailOAuthConfig,
  getGmailTokenEncryptionKey,
  GmailOAuthConfigurationError,
} from "./client.ts";

const validEnv = {
  GMAIL_GOOGLE_CLIENT_ID: "123456789.apps.googleusercontent.com",
  GMAIL_GOOGLE_CLIENT_SECRET: "gmail-client-secret-value",
  GMAIL_GOOGLE_REDIRECT_URI: `http://localhost:3000${GMAIL_CALLBACK_PATH}`,
  TOKEN_ENCRYPTION_KEY: "a-local-test-encryption-key-with-at-least-32-bytes",
};

test("Gmail uses dedicated OAuth credentials, not Google sign-in variables", () => {
  assert.throws(
    () => getGmailOAuthConfig({ GOOGLE_CLIENT_ID: "sign-in.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "sign-in-secret" }, "development"),
    (error: unknown) => error instanceof GmailOAuthConfigurationError &&
      error.message.includes("GMAIL_GOOGLE_CLIENT_ID") && error.message.includes("GMAIL_GOOGLE_CLIENT_SECRET"),
  );
});

test("local callback URL is validated and Gmail OAuth requests only gmail.readonly", () => {
  const config = getGmailOAuthConfig(validEnv, "development");
  const names = ["GMAIL_GOOGLE_CLIENT_ID", "GMAIL_GOOGLE_CLIENT_SECRET", "GMAIL_GOOGLE_REDIRECT_URI"] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) process.env[name] = validEnv[name];
    const query = new URL(generateAuthUrl("signed-state")).searchParams;
    assert.equal(config.redirectUri, `http://localhost:3000${GMAIL_CALLBACK_PATH}`);
    assert.equal(query.get("redirect_uri"), config.redirectUri);
    assert.deepEqual(query.get("scope")?.split(" "), [...GMAIL_SCOPES]);
    assert.equal(query.get("access_type"), "offline");
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("production callback must use HTTPS and the exact Gmail callback path", () => {
  assert.throws(
    () => getGmailOAuthConfig({ ...validEnv, GMAIL_GOOGLE_REDIRECT_URI: "http://example.com/callback" }, "production"),
    /GMAIL_GOOGLE_REDIRECT_URI must use HTTPS/,
  );
  assert.throws(
    () => getGmailOAuthConfig({ ...validEnv, GMAIL_GOOGLE_REDIRECT_URI: "https://example.com/other" }, "production"),
    /GMAIL_GOOGLE_REDIRECT_URI must use HTTPS/,
  );
  assert.throws(
    () => getGmailOAuthConfig(validEnv, "development", "http://127.0.0.1:3000"),
    /GMAIL_GOOGLE_REDIRECT_URI must use the same origin/,
  );
});

test("token encryption key must be present and at least 32 bytes", () => {
  assert.equal(getGmailTokenEncryptionKey(validEnv), validEnv.TOKEN_ENCRYPTION_KEY);
  assert.throws(() => getGmailTokenEncryptionKey({}), /TOKEN_ENCRYPTION_KEY must be configured/);
  assert.throws(() => getGmailTokenEncryptionKey({ TOKEN_ENCRYPTION_KEY: "short" }), /at least 32 bytes/);
});
