type HeaderBag = { get?: (name: string) => string | null; [key: string]: unknown };
type GmailFailure = { code?: number | string; status?: number; message?: string; response?: { status?: number; headers?: HeaderBag; data?: unknown }; errors?: Array<{ reason?: string }> };

export function isGmailQuotaError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const failure = error as GmailFailure;
  const status = Number(failure.response?.status ?? failure.status ?? failure.code);
  const reasons = `${failure.message ?? ""} ${JSON.stringify(failure.response?.data ?? "")} ${(failure.errors ?? []).map((item) => item.reason ?? "").join(" ")}`.toLowerCase();
  return status === 429 || (status === 403 && /rate.?limit|quota.?exceed|user.?rate/i.test(reasons));
}

function retryAfterMs(error: unknown, now: number): number | null {
  if (!error || typeof error !== "object") return null;
  const headers = (error as GmailFailure).response?.headers;
  const raw = headers?.get?.("retry-after") ?? headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(String(raw));
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

export async function withGmailQuotaRetry<T>(
  request: () => Promise<T>,
  options: { attempts?: number; sleep?: (ms: number) => Promise<void>; random?: () => number; now?: () => number } = {},
): Promise<T> {
  const attempts = options.attempts ?? 4;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  for (let attempt = 0; ; attempt++) {
    try { return await request(); } catch (error) {
      if (!isGmailQuotaError(error) || attempt + 1 >= attempts) throw error;
      const retryAfter = retryAfterMs(error, now());
      const backoffCap = Math.min(30_000, 1_000 * 2 ** attempt);
      const delay = retryAfter === null ? Math.floor(random() * backoffCap) : Math.min(120_000, retryAfter);
      await sleep(delay);
    }
  }
}
