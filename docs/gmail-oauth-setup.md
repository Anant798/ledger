# Gmail OAuth setup

Ledger Gmail connection has its own Google OAuth Web application client. It does not use the Google client configured for Supabase sign-in.

In Google Cloud Console, enable the Gmail API for the project that owns this dedicated client. Set the OAuth consent screen audience and add the local test account under Test users while the app is in testing. Create an OAuth client ID with application type **Web application** and add this exact Authorized redirect URI for local development:

```text
http://localhost:3000/api/integrations/gmail/callback
```

Put the Gmail OAuth client ID and secret in the server-only `.env.local` variables `GMAIL_GOOGLE_CLIENT_ID` and `GMAIL_GOOGLE_CLIENT_SECRET`. Set `GMAIL_GOOGLE_REDIRECT_URI` to the exact URI above. The redirect must use the same origin as the running Ledger app and the callback path shown above. For production use an HTTPS app origin and register that exact HTTPS callback URI in the Google client.

Set `TOKEN_ENCRYPTION_KEY` to at least 32 random bytes. Keep it stable: existing Gmail access and refresh tokens are encrypted with this key. Changing it makes previously stored tokens unreadable. The OAuth flow requests only `https://www.googleapis.com/auth/gmail.readonly`; it stores tokens encrypted and scoped to the signed-in Ledger user.

After changing `.env.local`, restart `npm run dev`. The initialization route reports missing variable names and safe configuration errors without returning secret values. Google may reject the authorization before redirecting if the callback URI is not registered exactly or the signing-in Google account is not listed as a consent-screen test user.
