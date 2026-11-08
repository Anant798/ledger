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
  messagesFound: number;
  processedCount: number;
  importedCount: number;
  reviewQueuedCount: number;
  ignoredCount: number;
  errorsCount: number;
  details: Array<{
    messageId: string;
    status: "imported" | "needs_review" | "ignored" | "skipped_duplicate" | "error";
    reason?: string;
    transactionId?: string;
  }>;
}

/**
 * Ensures access token is fresh; decrypts tokens and refreshes if expired.
 * Interacts only with server_oauth_tokens using the admin service-role client.
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

  // Listen for automatic token refresh
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
 * Core synchronization function.
 * Manages deduplication via backend-controlled processed_emails table.
 * Places uncertain items into import_review_queue without modifying transactions status constraints.
 */
export async function syncUserGmail(
  userId: string,
  options: { maxResults?: number; forceFullSync?: boolean } = {}
): Promise<SyncResult> {
  const supabase = createAdminClient();
  const { gmail, tokenRecord } = await getFreshGmailClient(userId);

  // Set sync status to 'syncing'
  await supabase
    .from("server_oauth_tokens")
    .update({ sync_status: "syncing", last_error: null })
    .eq("user_id", userId)
    .eq("provider", "gmail");

  const result: SyncResult = {
    messagesFound: 0,
    processedCount: 0,
    importedCount: 0,
    reviewQueuedCount: 0,
    ignoredCount: 0,
    errorsCount: 0,
    details: [],
  };

  try {
    let afterTimestamp: number | undefined;

    if (!options.forceFullSync && tokenRecord.last_synced_at) {
      const lastSync = new Date(tokenRecord.last_synced_at).getTime();
      afterTimestamp = Math.floor((lastSync - 2 * 24 * 60 * 60 * 1000) / 1000);
    }

    const query = buildGmailTransactionQuery(afterTimestamp);

    const listResponse = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: options.maxResults || 25,
    });

    const messages = listResponse.data.messages || [];
    result.messagesFound = messages.length;

    for (const msgRef of messages) {
      if (!msgRef.id) continue;
      result.processedCount++;

      // Check if message was already processed in processed_emails (Deduplication)
      const { data: alreadyProcessed } = await supabase
        .from("processed_emails")
        .select("id, status, transaction_id")
        .eq("user_id", userId)
        .eq("message_id", msgRef.id)
        .maybeSingle();

      if (alreadyProcessed) {
        result.details.push({
          messageId: msgRef.id,
          status: "skipped_duplicate",
          reason: `Already processed with status: ${alreadyProcessed.status}`,
          transactionId: alreadyProcessed.transaction_id || undefined,
        });
        continue;
      }

      try {
        const messageRes = await gmail.users.messages.get({
          userId: "me",
          id: msgRef.id,
          format: "full",
        });

        const msg = messageRes.data;
        const headers = msg.payload?.headers || [];
        const fromHeader =
          headers.find((h) => h.name?.toLowerCase() === "from")?.value || "";
        const subjectHeader =
          headers.find((h) => h.name?.toLowerCase() === "subject")?.value || "";
        const dateHeader =
          headers.find((h) => h.name?.toLowerCase() === "date")?.value || "";

        const emailBody = extractBodyFromPayload(msg.payload);
        const internalDate = msg.internalDate
          ? new Date(Number(msg.internalDate)).toISOString()
          : new Date().toISOString();

        // 1. Heuristic Pre-filter
        if (!isLikelyTransactionEmail(fromHeader, subjectHeader, emailBody)) {
          await supabase.from("processed_emails").insert({
            user_id: userId,
            message_id: msgRef.id,
            history_id: msg.historyId || null,
            internal_date: internalDate,
            sender: fromHeader,
            subject: subjectHeader,
            status: "ignored_not_transaction",
            uncertain_reason: "Failed bank transaction heuristics",
          });

          result.ignoredCount++;
          result.details.push({
            messageId: msgRef.id,
            status: "ignored",
            reason: "Non-transaction email detected by filter",
          });
          continue;
        }

        // 2. AI Parsing with Gemini
        const parsed = await extractTransactionFromEmail(
          `Subject: ${subjectHeader}\nFrom: ${fromHeader}\nDate: ${dateHeader}\n\n${emailBody}`
        );

        if (!parsed.isTransaction || !parsed.amount || !parsed.direction) {
          await supabase.from("processed_emails").insert({
            user_id: userId,
            message_id: msgRef.id,
            history_id: msg.historyId || null,
            internal_date: internalDate,
            sender: fromHeader,
            subject: subjectHeader,
            status: "ignored_not_transaction",
            uncertain_reason: "Model evaluated as non-transaction or missing amount/direction",
          });

          result.ignoredCount++;
          result.details.push({
            messageId: msgRef.id,
            status: "ignored",
            reason: "Not a valid financial transaction according to model",
          });
          continue;
        }

        // 3. Separate bank_name and payment_provider
        const bankName = parsed.bankName || "Unknown Bank";
        const paymentProvider = parsed.recipientOrSenderUpi
          ? "UPI"
          : parsed.referenceNumber?.toLowerCase().startsWith("neft")
          ? "NEFT"
          : parsed.referenceNumber?.toLowerCase().startsWith("imps")
          ? "IMPS"
          : "Bank Transfer";

        // 4. Uncertainty Check
        const isUncertain =
          parsed.confidence < 0.75 ||
          parsed.status === "unknown" ||
          !parsed.currency ||
          !parsed.bankName;

        const normalizedDate = normalizeTransactionDate(parsed.transactionDate);
        const occurredAt = normalizedDate.value
          ? new Date(normalizedDate.value).toISOString()
          : internalDate;

        // Check for duplicate transaction by external_reference
        if (parsed.referenceNumber) {
          const { data: existingTxn } = await supabase
            .from("transactions")
            .select("id")
            .eq("user_id", userId)
            .eq("external_reference", parsed.referenceNumber)
            .maybeSingle();

          if (existingTxn) {
            await supabase.from("processed_emails").insert({
              user_id: userId,
              message_id: msgRef.id,
              history_id: msg.historyId || null,
              internal_date: internalDate,
              sender: fromHeader,
              subject: subjectHeader,
              status: "parsed",
              transaction_id: existingTxn.id,
              uncertain_reason: "Duplicate external_reference found",
            });

            result.details.push({
              messageId: msgRef.id,
              status: "skipped_duplicate",
              transactionId: existingTxn.id,
              reason: `Transaction with external_reference ${parsed.referenceNumber} already exists.`,
            });
            continue;
          }
        }

        // 5. If uncertain, put into import_review_queue (preserving transactions table constraints)
        if (isUncertain) {
          const { data: reviewItem, error: reviewErr } = await supabase
            .from("import_review_queue")
            .insert({
              user_id: userId,
              email_message_id: msgRef.id,
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
              uncertain_reason: `Low confidence score (${parsed.confidence}) or missing banking metadata.`,
              raw_snippet: emailBody.slice(0, 300),
              occurred_at: occurredAt,
              review_status: "pending",
            })
            .select("id")
            .single();

          if (reviewErr) throw reviewErr;

          // Record in processed_emails
          await supabase.from("processed_emails").insert({
            user_id: userId,
            message_id: msgRef.id,
            history_id: msg.historyId || null,
            internal_date: internalDate,
            sender: fromHeader,
            subject: subjectHeader,
            status: "uncertain_queued",
            uncertain_reason: `Queued in import_review_queue item ${reviewItem.id}`,
          });

          // Also create an alert for the user in alerts table
          await supabase.from("alerts").insert({
            user_id: userId,
            alert_type: "transaction_review",
            title: "Transaction Review Needed",
            message: `A transaction of ₹${parsed.amount} from ${parsed.merchantOrSender || "Unknown"} needs your confirmation.`,
            is_read: false,
            is_resolved: false,
          });

          result.reviewQueuedCount++;
          result.details.push({
            messageId: msgRef.id,
            status: "needs_review",
            reason: `Confidence: ${parsed.confidence}`,
          });
          continue;
        }

        // 6. Confirmed transaction -> insert into transactions table
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
          description: `Transaction auto-imported from Gmail message ${msgRef.id}`,
          metadata: {
            gmail_message_id: msgRef.id,
            confidence: parsed.confidence,
            bank_name: bankName,
            payment_provider: paymentProvider,
            upi_id: parsed.recipientOrSenderUpi,
          },
          external_event_id: msgRef.id,
          occurred_at: occurredAt,
        });

        // Log to processed_emails
        await supabase.from("processed_emails").insert({
          user_id: userId,
          message_id: msgRef.id,
          history_id: msg.historyId || null,
          internal_date: internalDate,
          sender: fromHeader,
          subject: subjectHeader,
          status: "parsed",
          transaction_id: newTxn.id,
        });

        result.importedCount++;
        result.details.push({
          messageId: msgRef.id,
          status: "imported",
          transactionId: newTxn.id,
        });
      } catch (err: any) {
        console.error(`Error processing email message ${msgRef.id}:`, err);
        result.errorsCount++;
        result.details.push({
          messageId: msgRef.id,
          status: "error",
          reason: err.message || "Failed to process message",
        });

        await supabase.from("processed_emails").insert({
          user_id: userId,
          message_id: msgRef.id,
          status: "failed",
          uncertain_reason: err.message || "Unknown processing error",
        });
      }
    }

    // Update token last_synced_at
    await supabase
      .from("server_oauth_tokens")
      .update({
        sync_status: "idle",
        last_synced_at: new Date().toISOString(),
      })
      .eq("user_id", userId)
      .eq("provider", "gmail");

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
    })
    .eq("user_id", userId)
    .eq("provider", "gmail");
}
