import assert from "node:assert/strict";
import test from "node:test";
import { normalizeEmailText, prepareEmailForExtraction } from "./normalizer.ts";

test("HTML cleanup removes quoted content while preserving latest transaction text", () => {
  const text = normalizeEmailText('<p>INR 900 debited from account</p><blockquote>old quoted mail</blockquote><script>ignore()</script>');
  assert.match(text, /INR 900 debited/);
  assert.doesNotMatch(text, /old quoted|ignore/);
});

test("oversized messages retain financial cue windows, never first-character truncation", () => {
  const input = `${"newsletter filler ".repeat(2500)}\nYour account was debited INR 1,250.00 on 10 Nov 2026. Ref UTR998877`;
  const result = prepareEmailForExtraction(input, 2000);
  assert.equal(result.oversized, false);
  assert.match(result.text, /INR 1,250/);
  assert.ok(result.text.length < input.length);
});

test("oversized messages without transaction cues require review", () => {
  const result = prepareEmailForExtraction("marketing content ".repeat(3000), 1000);
  assert.deepEqual(result, { text: "", oversized: true });
});
