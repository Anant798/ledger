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
 * Process a single Gmail message with parsing, multi-key deduplication, and atomic logging.
 */
async function processSingleMessage(
  supabase: any,
  gmail: any,
  userId: string,
  messageId: string
) {
  // Check if already processed (deduplication check)
  const { data: alreadyProcessed } = await supabase
    .from("processed_emails")
    .select("id, status, transaction_id")
    .eq("user_id", userId)
    .eq("message_id", messageId)
    .maybeSingle();

  if (alreadyProcessed) {
    // If it was already successfully parsed, queued, or ignored, skip it
    if (alreadyProcessed.status !== "failed") {
      return {
        messageId,
        status: "skipped_duplicate" as const,
        reason: `Already processed with status: ${alreadyProcessed.status}`,
        transactionId: alreadyProcessed.transaction_id || undefined,
      };
    }
    // If previously failed, we retry it below
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

  // 3. Separate bank_name and payment_provider distinctly
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

  // 4. Uncertainty Check
  const isUncertain =
    parsed.confidence < 0.75 ||
    parsed.status === "unknown" ||
    !parsed.currency ||
    !parsed.bankName;

  const normalizedDate = normalizeTransactionDate(parsed.transactionDate);
  // Ensure date-only string is preserved or full ISO datetime without shifting
  const occurredAt = normalizedDate.value
    ? (normalizedDate.precision === "date"
        ? `${normalizedDate.value}T12:00:00+05:30` // noon IST to prevent midnight UTC rollback
        : normalizedDate.value)
    : internalDate;

  // 5. Multi-key deduplication: Check for existing transaction by external_reference AND payment_provider/bank
  if (parsed.referenceNumber) {
    let duplicateQuery = supabase
      .from("transactions")
      .select("id, payment_provider, bank_name, amount")
      .eq("user_id", userId)
      .eq("external_reference", parsed.referenceNumber);

    // Only treat as duplicate if same payment_provider or bank_name matches
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
        reason: `Transaction with external_reference ${parsed.referenceNumber} already exists for provider ${paymentProvider}.`,
      };
    }
  }

  // 6. Handle Uncertain -> import_review_queue
  if (isUncertain) {
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

    await supabase.from("processed_emails").upsert({
      user_id: userId,
      message_id: messageId,
      history_id: msg.historyId || null,
      internal_date: internalDate,
      sender: fromHeader,
      subject: subjectHeader,
      status: "uncertain_queued",
      uncertain_reason: `Queued in import_review_queue ${reviewItem.id}`,
    }, { onConflict: "user_id,message_id" });

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

  // 7. Confirmed Transaction Import
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

  // Log to ledger_events
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

  // Log to processed_emails
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
 * Main Gmail synchronization entry point.
 * Supports:
 * 1. Incremental sync using Gmail History API (when history_id exists).
 * 2. Fallback to full sync if history_id is expired (HTTP 404/INVALID_ARGUMENT).
 * 3. Paginated initial sync with maxResults and page tokens.
 * 4. Sync cursor (history_id & last_synced_at) updated ONLY after successful processing.
 */
export async function syncUserGmail(
  userId: string,
  options: { maxResults?: number; forceFullSync?: boolean; pageToken?: string } = {}
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
    details: [],
  };

  try {
    let messageIdsToProcess: string[] = [];
    let newHistoryId: string | undefined;

    // 1. Try Incremental History Sync if history_id is available and forceFullSync is false
    if (!options.forceFullSync && tokenRecord.history_id) {
      try {
        result.syncType = "incremental_history";
        const historyRes = await gmail.users.history.list({
          userId: "me",
          startHistoryId: tokenRecord.history_id,
          historyTypes: ["messageAdded"],
        });

        newHistoryId = historyRes.data.historyId || undefined;
        const histories = historyRes.data.history || [];

        const collectedIds = new Set<string>();
        for (const h of histories) {
          if (h.messagesAdded) {
            for (const item of h.messagesAdded) {
              if (item.message?.id) {
                collectedIds.add(item.message.id);
              }
            }
          }
        }
        messageIdsToProcess = Array.from(collectedIds);
      } catch (historyErr: any) {
        // If history ID is expired/out of date (404 or invalid startHistoryId), fall back to standard full query sync
        console.warn(
          `History API sync failed (${historyErr.message}). Falling back to query sync.`
        );
        result.syncType = "fallback_full";
        messageIdsToProcess = [];
      }
    }

    // 2. If incremental sync was not used or yielded fallback, do paginated search query
    if (messageIdsToProcess.length === 0 && result.syncType !== "incremental_history") {
      let afterTimestamp: number | undefined;

      if (!options.forceFullSync && tokenRecord.last_synced_at) {
        // 2 days lookback buffer
        const lastSync = new Date(tokenRecord.last_synced_at).getTime();
        afterTimestamp = Math.floor((lastSync - 2 * 24 * 60 * 60 * 1000) / 1000);
      }

      const query = buildGmailTransactionQuery(afterTimestamp);
      const listResponse = await gmail.users.messages.list({
        userId: "me",
        q: query,
        maxResults: options.maxResults || 25,
        pageToken: options.pageToken,
      });

      const messages = listResponse.data.messages || [];
      messageIdsToProcess = messages.map((m: any) => m.id).filter(Boolean);
    }

    // Also include previously failed messages for retry
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

    // 3. Process each message individually
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

    // 4. Update sync cursor only after processing completes
    // Fetch latest profile historyId from Gmail if we don't have one
    if (!newHistoryId) {
      try {
        const profileRes = await gmail.users.getProfile({ userId: "me" });
        newHistoryId = profileRes.data.historyId || undefined;
      } catch {
        // Ignored if profile call is unavailable
      }
    }

    const updateData: Record<string, any> = {
      sync_status: "idle",
      last_synced_at: new Date().toISOString(),
    };
    if (newHistoryId) {
      updateData.history_id = newHistoryId;
    }

    await supabase
      .from("server_oauth_tokens")
      .update(updateData)
      .eq("user_id", userId)
      .eq("provider", "gmail");

    result.nextHistoryId = newHistoryId;
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

/**
 * Sets up or renews Gmail Push Notifications (Pub/Sub watch).
 */
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
