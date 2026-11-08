import { google } from "googleapis";

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
];

export function hasReadOnlyGmailScope(scope: string | null | undefined) {
  const scopes = scope?.split(/\s+/).filter(Boolean) || [];
  return scopes.length === 1 && scopes[0] === GMAIL_SCOPES[0];
}

export function getOAuth2Client() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI ||
    "http://localhost:3000/api/integrations/gmail/callback";

  if (!clientId || !clientSecret) {
    throw new Error(
      "GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is missing from environment variables."
    );
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function generateAuthUrl(state?: string): string {
  const oauth2Client = getOAuth2Client();

  return oauth2Client.generateAuthUrl({
    access_type: "offline", // Essential to retrieve refresh_token
    prompt: "consent", // Force consent so refresh token is returned on re-auth
    scope: GMAIL_SCOPES,
    state,
  });
}
