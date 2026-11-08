import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { google } from "googleapis";
import type { ParsedTransaction } from "../email-parser/schema.ts";
import { processGmailMessage } from "./service.ts";
import { createGmailOAuthState, verifyGmailOAuthState } from "./oauth-state.ts";

const USER_ID = "c4f7c50a-cd20-47b7-bc68-46ced200d249";
const SECRET = "a-long-test-secret-with-more-than-32-characters";

function fakeSupabase(options: { claimed?: boolean; existing?: unknown } = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      if (name === "claim_processed_email") return { data: options.claimed ?? true, error: null };
      if (name === "complete_gmail_import") return { data: { transaction: { id: "txn-1" }, duplicate: false }, error: null };
      if (name === "complete_gmail_review") return { data: "review-1", error: null };
      return { data: null, error: null };
    },
    from() {
      return {
        update() {
          const query = { eq() { return query; }, then(resolve: (value: { error: null }) => unknown) { return Promise.resolve({ error: null }).then(resolve); } };
          return query;
        },
        select() {
          return { eq() { return this; }, maybeSingle: async () => ({ data: options.existing ?? null, error: null }) };
        },
      };
    },
  };
}

function fakeGmail() {
  const body = Buffer.from("INR 120 debited by UPI ref UPI/123456").toString("base64");
  return {
    users: { messages: { get: async () => ({ data: {
      id: "message-1", historyId: "history-1", internalDate: "1794120000000",
      payload: { headers: [
        { name: "From", value: "HDFC Alerts <alerts@hdfcbank.net>" },
        { name: "Subject", value: "INR 120 debited" },
        { name: "Date", value: "08 Nov 2026" },
      ], body: { data: body } },
    } }) } },
  };
}

const transaction: ParsedTransaction = {
  isTransaction: true, transactionType: "payment", direction: "debit", amount: 120,
  currency: "INR", transactionDate: null, transactionDateSource: "unknown",
  merchantOrSender: "Cafe", recipientOrSenderUpi: null, bankName: "HDFC Bank",
  accountLast4: "1234", referenceNumber: "UPI/123456", status: "completed", confidence: 0.99,
};

test("Gmail OAuth state is signed, age limited and user scoped", () => {
  const state = createGmailOAuthState(USER_ID, SECRET, 1_000_000);
  assert.equal(verifyGmailOAuthState(state, SECRET, 1_001_000).userId, USER_ID);
  assert.throws(() => verifyGmailOAuthState(`${state}x`, SECRET, 1_001_000), /signature|state/i);
  assert.throws(() => verifyGmailOAuthState(state, SECRET, 1_700_000), /expired/i);
});

test("Gmail import uses an atomic transaction/event RPC after claiming a message", async () => {
  const supabase = fakeSupabase();
  const result = await processGmailMessage(supabase as unknown as SupabaseClient, fakeGmail() as unknown as ReturnType<typeof google.gmail>, USER_ID, "message-1", async () => transaction);
  assert.equal(result.status, "imported");
  assert.equal(result.transactionId, "txn-1");
  assert.deepEqual(supabase.calls.map((call) => call.name), ["claim_processed_email", "complete_gmail_import"]);
  assert.equal((supabase.calls[1].args.p_transaction as Record<string, unknown>).transaction_type, "payment");
});

test("uncertain and non-completed alerts atomically create review items", async () => {
  const supabase = fakeSupabase();
  const result = await processGmailMessage(supabase as unknown as SupabaseClient, fakeGmail() as unknown as ReturnType<typeof google.gmail>, USER_ID, "message-1", async () => ({ ...transaction, confidence: 0.4 }));
  assert.equal(result.status, "needs_review");
  assert.equal(result.reviewId, "review-1");
  assert.equal(supabase.calls[1].name, "complete_gmail_review");
});

test("duplicate delivery claims do not retrieve or process the Gmail message again", async () => {
  const supabase = fakeSupabase({ claimed: false, existing: { status: "parsed", transaction_id: "txn-existing" } });
  let fetched = false;
  const gmail = { users: { messages: { get: async () => { fetched = true; throw new Error("should not fetch"); } } } };
  const result = await processGmailMessage(supabase as unknown as SupabaseClient, gmail as unknown as ReturnType<typeof google.gmail>, USER_ID, "message-1", async () => transaction);
  assert.equal(result.status, "skipped_duplicate");
  assert.equal(result.transactionId, "txn-existing");
  assert.equal(fetched, false);
});
