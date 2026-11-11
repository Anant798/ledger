import assert from "node:assert/strict";
import test from "node:test";
import { isGmailQuotaError, withGmailQuotaRetry } from "./retry.ts";

test("Gmail quota retries honor Retry-After and eventually succeed", async () => {
  let calls = 0;
  const delays: number[] = [];
  const result = await withGmailQuotaRetry(async () => {
    calls++;
    if (calls === 1) throw { response: { status: 429, headers: { "retry-after": "3" } } };
    return "ok";
  }, { sleep: async (ms) => { delays.push(ms); }, now: () => 0 });
  assert.equal(result, "ok");
  assert.equal(calls, 2);
  assert.deepEqual(delays, [3000]);
});

test("quota classification includes 403 rate limits and excludes other errors", () => {
  assert.equal(isGmailQuotaError({ response: { status: 403, data: { error: { errors: [{ reason: "userRateLimitExceeded" }] } } } }), true);
  assert.equal(isGmailQuotaError({ response: { status: 403, data: { error: { message: "forbidden" } } } }), false);
});
