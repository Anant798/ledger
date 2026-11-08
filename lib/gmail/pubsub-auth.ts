export type PubSubTokenClaims = { aud?: string | string[]; email?: string; email_verified?: boolean };
export type PubSubTokenVerifier = (token: string, audience: string) => Promise<PubSubTokenClaims>;

export async function verifyGooglePubSubPush(
  authorization: string | null,
  audience: string | undefined,
  serviceAccountEmail: string | undefined,
  verifyToken: PubSubTokenVerifier
) {
  if (!audience || !serviceAccountEmail || !authorization) return false;
  const match = authorization.match(/^Bearer\s+([^\s]+)$/i);
  if (!match) return false;
  try {
    const claims = await verifyToken(match[1], audience);
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    return audiences.includes(audience) && claims.email === serviceAccountEmail && claims.email_verified === true;
  } catch {
    return false;
  }
}
