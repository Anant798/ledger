import { google } from "googleapis";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hasReadOnlyGmailScope, getOAuth2Client } from "./client.ts";
import { encryptToken, decryptToken } from "./encryption.ts";
import {
  buildGmailTransactionQuery,
  isLikelyTransactionEmail,
} from "./bank-filters.ts";
import { assertGeminiConfigured, extractTransactionFromEmail } from "../email-parser/gemini.ts";
import { normalizeEmailText, prepareEmailForExtraction } from "../email-parser/normalizer.ts";
import { isGmailQuotaError, withGmailQuotaRetry } from "./retry.ts";
import { extractPreferredMimeBody } from "./mime.ts";
import { normalizeTransactionDate } from "../email-parser/date.ts";
import { extractBankDateTime } from "../email-parser/bank-datetime.ts";
import { classifyBankTransaction } from "./classification.ts";

async function createAdminClient() {
  const { createAdminClient: createClient } = await import("../supabase/admin.ts");
  return createClient();
}

export interface SyncResult {
  syncType: "incremental_history" | "initial_paginated" | "fallback_full";
  messagesFound: number;
  processedCount: number;
  importedCount: number;
  reviewQueuedCount: number;
  ignoredCount: number;
  errorsCount: number;
  nextHistoryId?: string;
  nextPageToken?: string | null;
  historyPageToken?: string | null;
  initialSyncCompleted?: boolean;
  cursorUpdated: boolean;
  details: Array<{
    messageId: string;
    status: "imported" | "needs_review" | "ignored" | "skipped_duplicate" | "error";
    reason?: string;
    transactionId?: string;
    reviewId?: string;
  }>;
}

/**
 * Ensures access token is fresh; decrypts tokens and refreshes if expired.
 */
export async function getFreshGmailClient(userId: string) {
  const supabase = await createAdminClient();

  const { data: tokenRecord, error } = await supabase
    .from("server_oauth_tokens")
    .select("*")
    .eq("user_id", userId)
    .eq("provider", "gmail")
    .single();

  if (error || !tokenRecord) {
    throw new Error("Gmail integration not found for user.");
  }
  if (!hasReadOnlyGmailScope(tokenRecord.scope)) {
    throw new Error("Gmail integration is missing the required read-only scope. Reconnect Gmail.");
  }

  const oauth2Client = getOAuth2Client();
  const accessToken = decryptToken(tokenRecord.access_token);
  const refreshToken = tokenRecord.refresh_token
    ? decryptToken(tokenRecord.refresh_token)
    : undefined;

  oauth2Client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken,
    expiry_date: tokenRecord.token_expiry
      ? new Date(tokenRecord.token_expiry).getTime()
      : undefined,
  });

  oauth2Client.on("tokens", async (tokens) => {
    const updatePayload: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if (tokens.access_token) {
      updatePayload.access_token = encryptToken(tokens.access_token);
    }
    if (tokens.refresh_token) {
      updatePayload.refresh_token = encryptToken(tokens.refresh_token);
    }
    if (tokens.expiry_date) {
      updatePayload.token_expiry = new Date(tokens.expiry_date).toISOString();
    }

    const { error: tokenPersistError } = await supabase
      .from("server_oauth_tokens")
      .update(updatePayload)
      .eq("user_id", userId)
      .eq("provider", "gmail");
    if (tokenPersistError) console.error("Failed to persist refreshed Gmail credentials for user", userId);
  });

  const gmail = google.gmail({ version: "v1", auth: oauth2Client });
  return { gmail, tokenRecord, oauth2Client };
}

/**
 * Process a single Gmail message.
 * Message claiming and final writes are performed through atomic service-only RPCs.
 */
export async function processGmailMessage(
  supabase: SupabaseClient,
  gmail: ReturnType<typeof google.gmail>,
  userId: string,
  messageId: string,
  extractor: typeof extractTransactionFromEmail = extractTransactionFromEmail
) {
  const { data: claimed, error: claimError } = await supabase.rpc("claim_processed_email", {
    p_user_id: userId, p_message_id: messageId, p_history_id: null,
    p_internal_date: null, p_sender: null, p_subject: null,
  });
  if (claimError) throw claimError;
  if (!claimed) {
    const { data: existing, error } = await supabase.from("processed_emails")
      .select("status,transaction_id").eq("user_id", userId).eq("message_id", messageId).maybeSingle();
    if (error) throw error;
    return {
      messageId,
      status: "skipped_duplicate" as const,
      reason: `Already claimed or processed${existing?.status ? ` (${existing.status})` : ""}`,
      transactionId: existing?.transaction_id || undefined,
    };
  }

  const messageRes = await withGmailQuotaRetry(() => gmail.users.messages.get({
    userId: "me", id: messageId, format: "full",
  }));

  const msg = messageRes.data;
  const headers = msg.payload?.headers || [];
  const fromHeader = headers.find((h) => h.name?.toLowerCase() === "from")?.value || "";
  const subjectHeader = headers.find((h) => h.name?.toLowerCase() === "subject")?.value || "";
  const dateHeader = headers.find((h) => h.name?.toLowerCase() === "date")?.value || "";

  const emailBody = normalizeEmailText(extractPreferredMimeBody(msg.payload));
  const gmailReceivedAt = msg.internalDate && Number.isFinite(Number(msg.internalDate)) ? new Date(Number(msg.internalDate)) : null;
  const headerReceivedAt = !gmailReceivedAt && dateHeader ? new Date(dateHeader) : null;
  const receivedAt = gmailReceivedAt && !Number.isNaN(gmailReceivedAt.getTime())
    ? gmailReceivedAt
    : headerReceivedAt && !Number.isNaN(headerReceivedAt.getTime()) ? headerReceivedAt : null;
  const internalDate = receivedAt?.toISOString() ?? null;

  const { error: messageUpdateError } = await supabase.from("processed_emails").update({
    history_id: msg.historyId || null, internal_date: internalDate, sender: fromHeader, subject: subjectHeader,
  }).eq("user_id", userId).eq("message_id", messageId).eq("status", "processing");
  if (messageUpdateError) throw messageUpdateError;

  // 1. Heuristic Pre-filter
  if (!isLikelyTransactionEmail(fromHeader, subjectHeader, emailBody)) {
    const { error } = await supabase.rpc("finish_processed_email", {
      p_user_id: userId, p_message_id: messageId, p_status: "ignored_not_transaction",
      p_reason: "Failed bank transaction heuristics",
    });
    if (error) throw error;

    return {
      messageId,
      status: "ignored" as const,
      reason: "Non-transaction email detected by bank filter",
    };
  }

  // 2. AI Parsing with Gemini
  const preparedEmail = prepareEmailForExtraction(
    `Subject: ${subjectHeader}\nFrom: ${fromHeader}\nDate: ${dateHeader}\n\n${emailBody}`,
  );
  const bodyDateTime = extractBankDateTime(emailBody, {
    internalDate: gmailReceivedAt && !Number.isNaN(gmailReceivedAt.getTime()) ? String(gmailReceivedAt.getTime()) : null,
    dateHeader,
    timeZone: process.env.LEDGER_TIME_ZONE || "Asia/Kolkata",
  });
  if (preparedEmail.oversized) {
    const { data: reviewId, error } = await supabase.rpc("complete_gmail_review", {
      p_user_id: userId,
      p_message_id: messageId,
      p_review: {
        direction: null, amount: null, currency_code: null, transaction_type: "other", category: null,
        description: "Gmail alert requires manual review", merchant_name: null, bank_name: null,
        payment_provider: null, account_last4: null, external_reference: null, upi_id: null,
        confidence: 0, uncertain_reason: "Email content remains too large to extract safely after removing quoted content.",
        raw_snippet: normalizeEmailText(emailBody).slice(0, 300), occurred_at: bodyDateTime?.occurredAt ?? null,
        occurred_at_source: bodyDateTime?.occurredAtSource ?? null,
      },
    });
    if (error) throw error;
    return { messageId, status: "needs_review" as const, reason: "Email too large for safe extraction", reviewId: String(reviewId) };
  }
  const parsed = await extractor(preparedEmail.text);

  const bankName = parsed.bankName?.trim() || null;
  // payment_provider is the identity namespace used with external_reference
  // for deduplication. Keep it tied to the institution, not the transfer rail
  // (UPI/NEFT/etc. can be shared by unrelated banks).
  const paymentProvider = bankName?.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || null;
  const externalReference = parsed.referenceNumber?.trim() || null;
  const modelDate = parsed.transactionDateSource === "email" ? normalizeTransactionDate(parsed.transactionDate) : null;
  const occurredAt = bodyDateTime?.occurredAt ?? (modelDate?.precision === "datetime" ? modelDate.value : null);
  const occurredAtSource = bodyDateTime?.occurredAtSource ?? (occurredAt ? "bank_provided" as const : null);

  const isUncertain =
    parsed.confidence < 0.75 ||
    !parsed.isTransaction ||
    !parsed.amount ||
    !parsed.direction ||
    parsed.status !== "completed" ||
    !parsed.currency ||
    !parsed.bankName ||
    !externalReference ||
    !parsed.merchantOrSender?.trim() ||
    !occurredAt ||
    !occurredAtSource;
  const transactionType = parsed.transactionType;
  const category = classifyBankTransaction({ merchant: parsed.merchantOrSender, description: subjectHeader, direction: parsed.direction });

  // 3. Handle Uncertain:
  // Step 1: Insert processed_emails record first (so foreign key in import_review_queue is valid)
  if (isUncertain) {
    // Persist the review item and its processed-email state atomically below.

    const { data: reviewId, error: reviewErr } = await supabase.rpc("complete_gmail_review", {
      p_user_id: userId,
      p_message_id: messageId,
      p_review: {
        direction: parsed.direction,
        amount: parsed.amount,
        currency_code: parsed.currency,
        transaction_type: parsed.transactionType,
        category,
        description: `Imported via Gmail: ${parsed.merchantOrSender || "Pending Review"}`,
        merchant_name: parsed.merchantOrSender,
        bank_name: bankName,
        payment_provider: paymentProvider,
        account_last4: parsed.accountLast4,
        external_reference: externalReference,
        upi_id: parsed.recipientOrSenderUpi,
        confidence: parsed.confidence,
        uncertain_reason: [
          !parsed.isTransaction && "transaction classification is uncertain",
          !parsed.amount && "amount is missing",
          !parsed.direction && "transaction type/direction is missing",
          !parsed.currency && "currency is missing",
          !bankName && "bank is missing",
          !externalReference && "reference number is missing",
          !parsed.merchantOrSender?.trim() && "merchant or sender is missing",
          !occurredAt && "transaction date could not be read from the bank email",
          occurredAtSource === "email_received_fallback" && "time uses email receipt and is not bank-confirmed",
          parsed.status !== "completed" && `status is ${parsed.status}`,
          parsed.confidence < 0.75 && `low extraction confidence (${parsed.confidence})`,
        ].filter(Boolean).join("; "),
        raw_snippet: emailBody.slice(0, 300),
        occurred_at: occurredAt,
        occurred_at_source: occurredAtSource,
      },
    });

    if (reviewErr) throw reviewErr;

    return {
      messageId,
      status: "needs_review" as const,
      reviewId,
      reason: `Needs confirmation: ${[!parsed.amount && "amount", !parsed.direction && "direction", !parsed.currency && "currency", !bankName && "bank", !externalReference && "reference", !parsed.merchantOrSender?.trim() && "merchant", !occurredAt && "transaction date/time", parsed.status !== "completed" && "status", parsed.confidence < 0.75 && "confidence"].filter(Boolean).join(", ") || "transaction classification"}`,
    };
  }

  // Transaction, ledger event and processed-email status are committed atomically.
  const { data: importResult, error: insertTxnError } = await supabase.rpc("complete_gmail_import", {
    p_user_id: userId,
    p_message_id: messageId,
    p_transaction: {
      transaction_type: transactionType,
      category,
      direction: parsed.direction,
      amount: parsed.amount,
      currency_code: parsed.currency || "INR",
      status: "completed",
      description: `Auto-imported: ${parsed.merchantOrSender || "Bank Transaction"}`,
      merchant_name: parsed.merchantOrSender,
      bank_name: bankName,
      payment_provider: paymentProvider,
      account_last4: parsed.accountLast4,
      external_reference: externalReference,
      occurred_at: occurredAt,
      occurred_at_source: occurredAtSource,
    },
    p_metadata: {
      confidence: parsed.confidence,
      bank_name: bankName,
      payment_provider: paymentProvider,
      upi_id: parsed.recipientOrSenderUpi,
    },
  });
  if (insertTxnError) throw insertTxnError;

  return {
    messageId,
    status: importResult?.duplicate ? "skipped_duplicate" as const : "imported" as const,
    transactionId: importResult?.transaction?.id,
  };
}

/**
 * Main Gmail synchronization entry point with complete pagination & cursor safety.
 */
export async function syncUserGmail(
  userId: string,
  options: {
    maxResults?: number;
    forceFullSync?: boolean;
    fetchAllPages?: boolean;
    maxPages?: number;
  } = {}
): Promise<SyncResult> {
  assertGeminiConfigured();
  const supabase = await createAdminClient();
  const { gmail, tokenRecord } = await getFreshGmailClient(userId);

  const { data: syncClaimed, error: statusError } = await supabase.rpc("claim_gmail_sync", {
    p_user_id: userId,
    p_lease_seconds: 900,
  });
  if (statusError) throw statusError;
  if (!syncClaimed) throw new Error("A Gmail synchronization is already in progress for this account.");

  const result: SyncResult = {
    syncType: "initial_paginated",
    messagesFound: 0,
    processedCount: 0,
    importedCount: 0,
    reviewQueuedCount: 0,
    ignoredCount: 0,
    errorsCount: 0,
    cursorUpdated: false,
    details: [],
  };

  try {
    let messageIdsToProcess: string[] = [];
    let nextHistoryId: string | undefined;
    let nextHistoryPageToken: string | null = null;
    let nextPageToken: string | null = null;
    let isInitialSyncDone = tokenRecord.initial_sync_completed ?? false;

    const useHistory =
      !options.forceFullSync &&
      tokenRecord.history_id &&
      tokenRecord.initial_sync_completed;

    if (useHistory) {
      // INCREMENTAL HISTORY SYNC (with complete pagination & safe token resumption)
      try {
        result.syncType = "incremental_history";
        const collectedIds = new Set<string>();
        let currentHistoryToken: string | undefined =
          tokenRecord.history_page_token || undefined;
        let pagesCount = 0;
        const maxPages = options.fetchAllPages ? (options.maxPages || 10) : 1;

        do {
          const historyRes = await withGmailQuotaRetry(() => gmail.users.history.list({
            userId: "me",
            startHistoryId: tokenRecord.history_id,
            historyTypes: ["messageAdded"],
            pageToken: currentHistoryToken,
            maxResults: options.maxResults || 50,
          }));

          pagesCount++;
          if (historyRes.data.historyId) {
            nextHistoryId = historyRes.data.historyId;
          }

          const histories = historyRes.data.history || [];
          for (const h of histories) {
            if (h.messagesAdded) {
              for (const item of h.messagesAdded) {
                if (item.message?.id) {
                  collectedIds.add(item.message.id);
                }
              }
            }
          }

          currentHistoryToken = historyRes.data.nextPageToken || undefined;
        } while (currentHistoryToken && (options.fetchAllPages ? pagesCount < maxPages : false));

        messageIdsToProcess = Array.from(collectedIds);
        nextHistoryPageToken = currentHistoryToken || null;
      } catch (historyErr: unknown) {
        if (isGmailQuotaError(historyErr)) throw historyErr;
        console.warn(
          `History API sync failed (${historyErr instanceof Error ? historyErr.message : "unknown error"}). Falling back to query sync.`
        );
        result.syncType = "fallback_full";
        messageIdsToProcess = [];
        nextHistoryPageToken = null;
      }
    }

    // INITIAL OR FULL QUERY SYNC (with safe resumable pagination)
    if (messageIdsToProcess.length === 0 && result.syncType !== "incremental_history") {
      let afterTimestamp: number | undefined;

      if (result.syncType !== "fallback_full" && !options.forceFullSync && tokenRecord.initial_sync_completed && tokenRecord.last_synced_at) {
        const lastSync = new Date(tokenRecord.last_synced_at).getTime();
        afterTimestamp = Math.floor((lastSync - 2 * 24 * 60 * 60 * 1000) / 1000);
      }

      const query = buildGmailTransactionQuery(afterTimestamp);

      // Resume from previous tokenRecord.next_page_token if initial sync was partially completed
      let currentPageToken: string | undefined =
        tokenRecord.next_page_token || undefined;
      const maxPages = options.fetchAllPages ? (options.maxPages || 10) : 1;
      let pagesFetched = 0;
      const collectedIds = new Set<string>();

      do {
        const listResponse = await gmail.users.messages.list({
          userId: "me",
          q: query,
          maxResults: options.maxResults || 25,
          pageToken: currentPageToken,
        });

        pagesFetched++;
        const messages = listResponse.data.messages || [];
        for (const m of messages) {
          if (m.id) collectedIds.add(m.id);
        }

        currentPageToken = listResponse.data.nextPageToken || undefined;
      } while (currentPageToken && pagesFetched < maxPages);

      messageIdsToProcess = Array.from(collectedIds);
      nextPageToken = currentPageToken || null;

      // If no more pages left, initial sync is complete
      if (!currentPageToken) {
        isInitialSyncDone = true;
      }
    }

    // Add previously failed messages for retry
    const { data: failedMessages, error: failedMessagesError } = await supabase
      .from("processed_emails")
      .select("message_id")
      .eq("user_id", userId)
      .eq("status", "failed")
      .limit(5);
    if (failedMessagesError) throw failedMessagesError;

    if (failedMessages && failedMessages.length > 0) {
      for (const fm of failedMessages) {
        if (!messageIdsToProcess.includes(fm.message_id)) {
          messageIdsToProcess.push(fm.message_id);
        }
      }
    }

    result.messagesFound = messageIdsToProcess.length;

    // Process each message
    for (const msgId of messageIdsToProcess) {
      result.processedCount++;
      try {
        const itemResult = await processGmailMessage(supabase, gmail, userId, msgId);
        result.details.push(itemResult);

        if (itemResult.status === "imported") result.importedCount++;
        else if (itemResult.status === "needs_review") result.reviewQueuedCount++;
        else if (itemResult.status === "ignored") result.ignoredCount++;
      } catch (err: unknown) {
        console.error(`Error processing Gmail message ${msgId}:`, err instanceof Error ? err.message : "Unknown processing failure");
        result.errorsCount++;
        result.details.push({
          messageId: msgId,
          status: "error",
          reason: err instanceof Error ? err.message : "Failed to process message",
        });

        const { error: markFailedError } = await supabase.rpc("finish_processed_email", {
          p_user_id: userId, p_message_id: msgId, p_status: "failed",
          p_reason: err instanceof Error ? err.message : "Processing exception",
        });
        if (markFailedError) console.error("Failed to record Gmail message failure:", markFailedError.message);
        if (isGmailQuotaError(err)) break;
      }
    }

    // CURSOR SAFETY:
    // Only advance cursor if NO critical message errors occurred in this batch.
    // In History API sync, never advance history_id if more history pages remain (nextHistoryPageToken != null).
    if (result.errorsCount === 0) {
      const updateData: Record<string, unknown> = {
        sync_status: "idle",
        sync_lease_until: null,
        last_synced_at: new Date().toISOString(),
        next_page_token: nextPageToken,
        history_page_token: nextHistoryPageToken,
        initial_sync_completed: isInitialSyncDone,
      };

      // Only advance history_id when all history pages have been processed!
      const canAdvanceHistory =
        result.syncType === "incremental_history"
          ? nextHistoryPageToken === null // all history pages finished
          : isInitialSyncDone && nextPageToken === null; // all initial query pages finished

      if (canAdvanceHistory) {
        if (!nextHistoryId) {
          try {
            const profileRes = await gmail.users.getProfile({ userId: "me" });
            nextHistoryId = profileRes.data.historyId || undefined;
          } catch {
            // Profile call unavailable
          }
        }
        if (nextHistoryId) {
          updateData.history_id = nextHistoryId;
          updateData.history_page_token = null;
        }
      }

      const { error: cursorError } = await supabase
        .from("server_oauth_tokens")
        .update(updateData)
        .eq("user_id", userId)
        .eq("provider", "gmail");
      if (cursorError) throw cursorError;

      result.cursorUpdated = true;
    } else {
      // PRESERVE previous cursor so failed messages and un-advanced window are retried
      const { error: preserveCursorError } = await supabase
        .from("server_oauth_tokens")
        .update({
          sync_status: "idle",
          sync_lease_until: null,
          last_error: `${result.errorsCount} messages failed to process. Cursor was preserved.`,
        })
        .eq("user_id", userId)
        .eq("provider", "gmail");
      if (preserveCursorError) throw preserveCursorError;

      result.cursorUpdated = false;
    }

    result.nextHistoryId = nextHistoryId;
    result.nextPageToken = nextPageToken;
    result.historyPageToken = nextHistoryPageToken;
    result.initialSyncCompleted = isInitialSyncDone;
    return result;
  } catch (syncError: unknown) {
    console.error(`Gmail sync error for user ${userId}:`, syncError);
    const { error: syncErrorUpdate } = await supabase
      .from("server_oauth_tokens")
      .update({
        sync_status: "error",
        sync_lease_until: null,
        last_error: syncError instanceof Error ? syncError.message : "Sync failed",
      })
      .eq("user_id", userId)
      .eq("provider", "gmail");
    if (syncErrorUpdate) console.error("Failed to persist Gmail sync error:", syncErrorUpdate.message);

    throw syncError;
  }
}

export async function setupGmailWatch(userId: string, topicName: string) {
  const { gmail } = await getFreshGmailClient(userId);
  const supabase = await createAdminClient();

  const res = await gmail.users.watch({
    userId: "me",
    requestBody: {
      topicName,
      labelIds: ["INBOX"],
    },
  });

  const expiration = res.data.expiration
    ? new Date(Number(res.data.expiration)).toISOString()
    : null;

  const { error: watchUpdateError } = await supabase
    .from("server_oauth_tokens")
    .update({
      history_id: res.data.historyId || null,
      watch_expiration: expiration,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .eq("provider", "gmail");
  if (watchUpdateError) throw watchUpdateError;

  return res.data;
}

export async function stopGmailWatch(userId: string) {
  const { gmail } = await getFreshGmailClient(userId);
  const supabase = await createAdminClient();

  await gmail.users.stop({ userId: "me" });

  const { error: watchUpdateError } = await supabase
    .from("server_oauth_tokens")
    .update({
      watch_expiration: null,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .eq("provider", "gmail");
  if (watchUpdateError) throw watchUpdateError;
}
