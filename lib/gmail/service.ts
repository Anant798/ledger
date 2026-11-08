import { google } from "googleapis";
import { getOAuth2Client } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptToken, decryptToken } from "./encryption";
import {
  buildGmailTransactionQuery,
  isLikelyTransactionEmail,
} from "./bank-filters";
import { extractTransactionFromEmail } from "@/lib/email-parser/gemini";
import { normalizeTransactionDate } from "@/lib/email-parser/date";

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
  const supabase = createAdminClient();

  const { data: tokenRecord, error } = await supabase
    .from("server_oauth_tokens")
    .select("*")
    .eq("user_id", userId)
    .eq("provider", "gmail")
    .single();

  if (error || !tokenRecord) {
    throw new Error("Gmail integration not found for user.");
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

    await supabase
      .from("server_oauth_tokens")
      .update(updatePayload)
      .eq("user_id", userId)
      .eq("provider", "gmail");
  });

  const gmail = google.gmail({ version: "v1", auth: oauth2Client });
  return { gmail, tokenRecord, oauth2Client };
}

function extractBodyFromPayload(payload: any): string {
  let body = "";

  if (payload.body && payload.body.data) {
    body += Buffer.from(payload.body.data, "base64").toString("utf-8");
  }

  if (payload.parts && Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body && part.body.data) {
        body += Buffer.from(part.body.data, "base64").toString("utf-8");
      } else if (part.mimeType === "text/html" && part.body && part.body.data) {
        body += Buffer.from(part.body.data, "base64").toString("utf-8");
      } else if (part.parts) {
        body += extractBodyFromPayload(part);
      }
    }
  }

  return body;
}

/**
 * Process a single Gmail message.
 * Strict insert order to satisfy foreign key constraints:
 * processed_emails is ALWAYS created before import_review_queue references it!
 */
async function processSingleMessage(
  supabase: any,
  gmail: any,
  userId: string,
  messageId: string
) {
  // Check if already processed
  const { data: alreadyProcessed } = await supabase
    .from("processed_emails")
    .select("id, status, transaction_id")
    .eq("user_id", userId)
    .eq("message_id", messageId)
    .maybeSingle();

  if (alreadyProcessed && alreadyProcessed.status !== "failed") {
    return {
      messageId,
      status: "skipped_duplicate" as const,
      reason: `Already processed with status: ${alreadyProcessed.status}`,
      transactionId: alreadyProcessed.transaction_id || undefined,
    };
  }

  const messageRes = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });

  const msg = messageRes.data;
  const headers = msg.payload?.headers || [];
  const fromHeader = headers.find((h: any) => h.name?.toLowerCase() === "from")?.value || "";
  const subjectHeader = headers.find((h: any) => h.name?.toLowerCase() === "subject")?.value || "";
  const dateHeader = headers.find((h: any) => h.name?.toLowerCase() === "date")?.value || "";

  const emailBody = extractBodyFromPayload(msg.payload);
  const internalDate = msg.internalDate
    ? new Date(Number(msg.internalDate)).toISOString()
    : new Date().toISOString();

  // 1. Heuristic Pre-filter
  if (!isLikelyTransactionEmail(fromHeader, subjectHeader, emailBody)) {
    await supabase.from("processed_emails").upsert({
      user_id: userId,
      message_id: messageId,
      history_id: msg.historyId || null,
      internal_date: internalDate,
      sender: fromHeader,
      subject: subjectHeader,
      status: "ignored_not_transaction",
      uncertain_reason: "Failed bank transaction heuristics",
    }, { onConflict: "user_id,message_id" });

    return {
      messageId,
      status: "ignored" as const,
      reason: "Non-transaction email detected by bank filter",
    };
  }

  // 2. AI Parsing with Gemini
  const parsed = await extractTransactionFromEmail(
    `Subject: ${subjectHeader}\nFrom: ${fromHeader}\nDate: ${dateHeader}\n\n${emailBody}`
  );

  if (!parsed.isTransaction || !parsed.amount || !parsed.direction) {
    await supabase.from("processed_emails").upsert({
      user_id: userId,
      message_id: messageId,
      history_id: msg.historyId || null,
      internal_date: internalDate,
      sender: fromHeader,
      subject: subjectHeader,
      status: "ignored_not_transaction",
      uncertain_reason: "Model evaluated as non-transaction or missing amount/direction",
    }, { onConflict: "user_id,message_id" });

    return {
      messageId,
      status: "ignored" as const,
      reason: "Not a valid financial transaction according to model",
    };
  }

  const bankName = parsed.bankName || "Unknown Bank";
  const paymentProvider = parsed.recipientOrSenderUpi
    ? "UPI"
    : parsed.referenceNumber?.toLowerCase().startsWith("neft")
    ? "NEFT"
    : parsed.referenceNumber?.toLowerCase().startsWith("imps")
    ? "IMPS"
    : parsed.referenceNumber?.toLowerCase().startsWith("rtgs")
    ? "RTGS"
    : "Bank Transfer";

  const isUncertain =
    parsed.confidence < 0.75 ||
    parsed.status === "unknown" ||
    !parsed.currency ||
    !parsed.bankName;

  const normalizedDate = normalizeTransactionDate(parsed.transactionDate);
  const occurredAt = normalizedDate.value
    ? (normalizedDate.precision === "date"
        ? `${normalizedDate.value}T12:00:00+05:30`
        : normalizedDate.value)
    : internalDate;

  // Duplicate check
  if (parsed.referenceNumber) {
    let duplicateQuery = supabase
      .from("transactions")
      .select("id, payment_provider, bank_name, amount")
      .eq("user_id", userId)
      .eq("external_reference", parsed.referenceNumber);

    if (paymentProvider) {
      duplicateQuery = duplicateQuery.eq("payment_provider", paymentProvider);
    }

    const { data: existingTxn } = await duplicateQuery.maybeSingle();

    if (existingTxn) {
      await supabase.from("processed_emails").upsert({
        user_id: userId,
        message_id: messageId,
        history_id: msg.historyId || null,
        internal_date: internalDate,
        sender: fromHeader,
        subject: subjectHeader,
        status: "parsed",
        transaction_id: existingTxn.id,
        uncertain_reason: `Duplicate match on external_reference: ${parsed.referenceNumber} and provider: ${paymentProvider}`,
      }, { onConflict: "user_id,message_id" });

      return {
        messageId,
        status: "skipped_duplicate" as const,
        transactionId: existingTxn.id,
        reason: `Transaction with external_reference ${parsed.referenceNumber} already exists.`,
      };
    }
  }

  // 3. Handle Uncertain:
  // Step 1: Insert processed_emails record first (so foreign key in import_review_queue is valid)
  if (isUncertain) {
    await supabase.from("processed_emails").upsert({
      user_id: userId,
      message_id: messageId,
      history_id: msg.historyId || null,
      internal_date: internalDate,
      sender: fromHeader,
      subject: subjectHeader,
      status: "uncertain_queued",
      uncertain_reason: `Confidence (${parsed.confidence}) or missing banking metadata.`,
    }, { onConflict: "user_id,message_id" });

    // Step 2: Insert into import_review_queue with valid foreign key (user_id, email_message_id)
    const { data: reviewItem, error: reviewErr } = await supabase
      .from("import_review_queue")
      .insert({
        user_id: userId,
        email_message_id: messageId,
        direction: parsed.direction,
        amount: parsed.amount,
        currency_code: parsed.currency || "INR",
        transaction_type:
          parsed.transactionType === "reversal"
            ? "reversal"
            : parsed.transactionType === "refund"
            ? "refund"
            : "payment",
        description: `Imported via Gmail: ${parsed.merchantOrSender || "Pending Review"}`,
        merchant_name: parsed.merchantOrSender,
        bank_name: bankName,
        payment_provider: paymentProvider,
        account_last4: parsed.accountLast4,
        external_reference: parsed.referenceNumber,
        upi_id: parsed.recipientOrSenderUpi,
        confidence: parsed.confidence,
        uncertain_reason: `Confidence (${parsed.confidence}) or missing banking metadata.`,
        raw_snippet: emailBody.slice(0, 300),
        occurred_at: occurredAt,
        review_status: "pending",
      })
      .select("id")
      .single();

    if (reviewErr) throw reviewErr;

    await supabase.from("alerts").insert({
      user_id: userId,
      alert_type: "transaction_review",
      title: "Transaction Review Needed",
      message: `A transaction of ₹${parsed.amount} from ${parsed.merchantOrSender || "Unknown"} needs confirmation.`,
      is_read: false,
      is_resolved: false,
    });

    return {
      messageId,
      status: "needs_review" as const,
      reviewId: reviewItem.id,
      reason: `Confidence: ${parsed.confidence}`,
    };
  }

  // 4. Confirmed Transaction:
  const { data: newTxn, error: insertTxnError } = await supabase
    .from("transactions")
    .insert({
      user_id: userId,
      transaction_type:
        parsed.transactionType === "reversal"
          ? "reversal"
          : parsed.transactionType === "refund"
          ? "refund"
          : "payment",
      direction: parsed.direction,
      amount: parsed.amount,
      currency_code: parsed.currency || "INR",
      status: "completed",
      description: `Auto-imported: ${parsed.merchantOrSender || "Bank Transaction"}`,
      merchant_name: parsed.merchantOrSender,
      bank_name: bankName,
      payment_provider: paymentProvider,
      account_last4: parsed.accountLast4,
      external_reference: parsed.referenceNumber,
      occurred_at: occurredAt,
    })
    .select("id")
    .single();

  if (insertTxnError) throw insertTxnError;

  // Insert ledger event
  await supabase.from("ledger_events").insert({
    transaction_id: newTxn.id,
    user_id: userId,
    event_type: "email_imported",
    event_source: "gmail_sync",
    description: `Transaction auto-imported from Gmail message ${messageId}`,
    metadata: {
      gmail_message_id: messageId,
      confidence: parsed.confidence,
      bank_name: bankName,
      payment_provider: paymentProvider,
      upi_id: parsed.recipientOrSenderUpi,
    },
    external_event_id: messageId,
    occurred_at: occurredAt,
  });

  // Insert/update processed_emails with new transaction_id
  await supabase.from("processed_emails").upsert({
    user_id: userId,
    message_id: messageId,
    history_id: msg.historyId || null,
    internal_date: internalDate,
    sender: fromHeader,
    subject: subjectHeader,
    status: "parsed",
    transaction_id: newTxn.id,
  }, { onConflict: "user_id,message_id" });

  return {
    messageId,
    status: "imported" as const,
    transactionId: newTxn.id,
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
  const supabase = createAdminClient();
  const { gmail, tokenRecord } = await getFreshGmailClient(userId);

  await supabase
    .from("server_oauth_tokens")
    .update({ sync_status: "syncing", last_error: null })
    .eq("user_id", userId)
    .eq("provider", "gmail");

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
    let nextPageToken: string | null = null;
    let isInitialSyncDone = tokenRecord.initial_sync_completed ?? false;

    const useHistory =
      !options.forceFullSync &&
      tokenRecord.history_id &&
      tokenRecord.initial_sync_completed;

    if (useHistory) {
      // INCREMENTAL HISTORY SYNC (with full history pagination)
      try {
        result.syncType = "incremental_history";
        const collectedIds = new Set<string>();
        let historyPageToken: string | undefined = undefined;

        do {
          const historyRes: any = await gmail.users.history.list({
            userId: "me",
            startHistoryId: tokenRecord.history_id,
            historyTypes: ["messageAdded"],
            pageToken: historyPageToken,
            maxResults: options.maxResults || 50,
          });

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

          historyPageToken = historyRes.data.nextPageToken || undefined;
        } while (historyPageToken && options.fetchAllPages);

        messageIdsToProcess = Array.from(collectedIds);
      } catch (historyErr: any) {
        console.warn(
          `History API sync failed (${historyErr.message}). Falling back to query sync.`
        );
        result.syncType = "fallback_full";
        messageIdsToProcess = [];
      }
    }

    // INITIAL OR FULL QUERY SYNC (with safe resumable pagination)
    if (messageIdsToProcess.length === 0 && result.syncType !== "incremental_history") {
      let afterTimestamp: number | undefined;

      if (!options.forceFullSync && tokenRecord.initial_sync_completed && tokenRecord.last_synced_at) {
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
    const { data: failedMessages } = await supabase
      .from("processed_emails")
      .select("message_id")
      .eq("user_id", userId)
      .eq("status", "failed")
      .limit(5);

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
        const itemResult = await processSingleMessage(supabase, gmail, userId, msgId);
        result.details.push(itemResult);

        if (itemResult.status === "imported") result.importedCount++;
        else if (itemResult.status === "needs_review") result.reviewQueuedCount++;
        else if (itemResult.status === "ignored") result.ignoredCount++;
      } catch (err: any) {
        console.error(`Error processing message ${msgId}:`, err);
        result.errorsCount++;
        result.details.push({
          messageId: msgId,
          status: "error",
          reason: err.message || "Failed to process message",
        });

        await supabase.from("processed_emails").upsert({
          user_id: userId,
          message_id: msgId,
          status: "failed",
          uncertain_reason: err.message || "Processing exception",
        }, { onConflict: "user_id,message_id" });
      }
    }

    // CURSOR SAFETY:
    // Only advance cursor if NO critical message errors occurred in this batch.
    // Also, during initial sync, only save final history cursor when all pages are completed.
    if (result.errorsCount === 0) {
      const updateData: Record<string, any> = {
        sync_status: "idle",
        last_synced_at: new Date().toISOString(),
        next_page_token: nextPageToken,
        initial_sync_completed: isInitialSyncDone,
      };

      // Only advance history_id when initial sync is fully complete or during incremental sync
      if (isInitialSyncDone) {
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
        }
      }

      await supabase
        .from("server_oauth_tokens")
        .update(updateData)
        .eq("user_id", userId)
        .eq("provider", "gmail");

      result.cursorUpdated = true;
    } else {
      // PRESERVE previous cursor so failed messages and un-advanced window are retried
      await supabase
        .from("server_oauth_tokens")
        .update({
          sync_status: "idle",
          last_error: `${result.errorsCount} messages failed to process. Cursor was preserved.`,
        })
        .eq("user_id", userId)
        .eq("provider", "gmail");

      result.cursorUpdated = false;
    }

    result.nextHistoryId = nextHistoryId;
    result.nextPageToken = nextPageToken;
    result.initialSyncCompleted = isInitialSyncDone;
    return result;
  } catch (syncError: any) {
    console.error(`Gmail sync error for user ${userId}:`, syncError);
    await supabase
      .from("server_oauth_tokens")
      .update({
        sync_status: "error",
        last_error: syncError.message || "Sync failed",
      })
      .eq("user_id", userId)
      .eq("provider", "gmail");

    throw syncError;
  }
}

export async function setupGmailWatch(userId: string, topicName: string) {
  const { gmail } = await getFreshGmailClient(userId);
  const supabase = createAdminClient();

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

  await supabase
    .from("server_oauth_tokens")
    .update({
      history_id: res.data.historyId || null,
      watch_expiration: expiration,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .eq("provider", "gmail");

  return res.data;
}

export async function stopGmailWatch(userId: string) {
  const { gmail } = await getFreshGmailClient(userId);
  const supabase = createAdminClient();

  await gmail.users.stop({ userId: "me" });

  await supabase
    .from("server_oauth_tokens")
    .update({
      watch_expiration: null,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .eq("provider", "gmail");
}
