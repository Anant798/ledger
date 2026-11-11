import { google } from "googleapis";

export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"] as const;
export const GMAIL_CALLBACK_PATH = "/api/integrations/gmail/callback";

export class GmailOAuthConfigurationError extends Error {
  readonly code = "GMAIL_OAUTH_CONFIGURATION_ERROR";
}

export type GmailOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export function getGmailOAuthConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  nodeEnv: string | undefined = env.NODE_ENV,
  appOrigin?: string,
): GmailOAuthConfig {
  const clientId = env.GMAIL_GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GMAIL_GOOGLE_CLIENT_SECRET?.trim();
  const redirectUri = env.GMAIL_GOOGLE_REDIRECT_URI?.trim() ||
    (nodeEnv === "production" ? undefined : `http://localhost:3000${GMAIL_CALLBACK_PATH}`);
  const missing = [
    !clientId && "GMAIL_GOOGLE_CLIENT_ID",
    !clientSecret && "GMAIL_GOOGLE_CLIENT_SECRET",
    !redirectUri && "GMAIL_GOOGLE_REDIRECT_URI",
  ].filter((name): name is string => Boolean(name));

  if (missing.length) {
    throw new GmailOAuthConfigurationError(
      `Gmail OAuth is not configured. Set ${missing.join(", ")} in the server environment.`,
    );
  }
  if (!clientId!.endsWith(".apps.googleusercontent.com")) {
    throw new GmailOAuthConfigurationError(
      "GMAIL_GOOGLE_CLIENT_ID must be a Google OAuth web application client ID.",
    );
  }
  if (clientSecret!.length < 8 || /^(your-|replace[-_])/i.test(clientSecret!)) {
    throw new GmailOAuthConfigurationError(
      "GMAIL_GOOGLE_CLIENT_SECRET is empty or still contains a placeholder.",
    );
  }

  let callback: URL;
  try {
    callback = new URL(redirectUri!);
  } catch {
    throw new GmailOAuthConfigurationError(
      "GMAIL_GOOGLE_REDIRECT_URI must be an absolute callback URL.",
    );
  }
  const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(callback.hostname);
  if (
    callback.pathname !== GMAIL_CALLBACK_PATH ||
    callback.username || callback.password || callback.search || callback.hash ||
    (callback.protocol !== "https:" && !(nodeEnv !== "production" && isLoopback && callback.protocol === "http:"))
  ) {
    throw new GmailOAuthConfigurationError(
      `GMAIL_GOOGLE_REDIRECT_URI must use HTTPS and end with ${GMAIL_CALLBACK_PATH}; local development may use http://localhost:3000${GMAIL_CALLBACK_PATH}.`,
    );
  }
  if (appOrigin && callback.origin !== new URL(appOrigin).origin) {
    throw new GmailOAuthConfigurationError(
      "GMAIL_GOOGLE_REDIRECT_URI must use the same origin that serves the Ledger app.",
    );
  }

  return { clientId: clientId!, clientSecret: clientSecret!, redirectUri: redirectUri! };
}

export function getGmailTokenEncryptionKey(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const key = env.TOKEN_ENCRYPTION_KEY;
  if (!key || key.length < 32 || Buffer.byteLength(key, "utf8") < 32) {
    throw new GmailOAuthConfigurationError(
      "TOKEN_ENCRYPTION_KEY must be configured with at least 32 bytes before connecting Gmail.",
    );
  }
  return key;
}

export function hasReadOnlyGmailScope(scope: string | null | undefined) {
  const scopes = scope?.split(/\s+/).filter(Boolean) || [];
  return scopes.length === 1 && scopes[0] === GMAIL_SCOPES[0];
}

export function getOAuth2Client(appOrigin?: string) {
  const { clientId, clientSecret, redirectUri } = getGmailOAuthConfig(process.env, process.env.NODE_ENV, appOrigin);
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function generateAuthUrl(state?: string, appOrigin?: string): string {
  const oauth2Client = getOAuth2Client(appOrigin);

  return oauth2Client.generateAuthUrl({
    access_type: "offline", // Essential to retrieve refresh_token
    prompt: "consent", // Force consent so refresh token is returned on re-auth
    scope: [...GMAIL_SCOPES],
    state,
  });
}
