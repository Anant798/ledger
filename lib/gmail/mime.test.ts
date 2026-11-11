import assert from "node:assert/strict";
import test from "node:test";
import { extractPreferredMimeBody } from "./mime.ts";
import { normalizeEmailText } from "../email-parser/normalizer.ts";

test("multipart/alternative selects plain text instead of concatenating large HTML alternative", () => {
  const plain = "Debit INR 40 at HOSTEL H BOYS NEW HOSTEL. Ref 121291757896";
  const html = `<html><head><style>${".x{color:red}".repeat(1000)}</style></head><body><p>${"metadata ".repeat(2200)}</p>${plain}</body></html>`;
  const payload = { mimeType: "multipart/alternative", parts: [
    { mimeType: "text/plain", body: { data: Buffer.from(plain).toString("base64url") } },
    { mimeType: "text/html", body: { data: Buffer.from(html).toString("base64url") } },
  ] };
  assert.equal(extractPreferredMimeBody(payload), plain);
});

test("HTML fallback becomes readable and review snippets contain no markup", () => {
  const html = '<!doctype html><html><head><meta charset="utf-8"><style>.x{}</style><script>private()</script></head><body><p>Debit INR 40 at HOSTEL H BOYS NEW HOSTEL</p><blockquote>quoted alert</blockquote></body></html>';
  const raw = extractPreferredMimeBody({ mimeType: "text/html", body: { data: Buffer.from(html).toString("base64url") } });
  const readable = normalizeEmailText(raw);
  assert.match(readable, /Debit INR 40 at HOSTEL/);
  assert.doesNotMatch(readable, /doctype|<html|<meta|<style|<script|quoted alert/);
});

test("multipart/mixed keeps the selected alternative and ignores attachments", () => {
  const body = "Credit INR 500 from sender";
  const text = extractPreferredMimeBody({ mimeType: "multipart/mixed", parts: [
    { mimeType: "multipart/alternative", parts: [
      { mimeType: "text/plain", body: { data: Buffer.from(body).toString("base64url") } },
      { mimeType: "text/html", body: { data: Buffer.from(`<p>${body}</p>`).toString("base64url") } },
    ] },
    { mimeType: "text/plain", filename: "receipt.txt", body: { data: Buffer.from("attachment contents").toString("base64url") } },
  ] });
  assert.equal(text, body);
});
