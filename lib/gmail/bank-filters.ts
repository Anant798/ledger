/**
 * Known Indian bank email senders, keywords, and alert patterns.
 * Supports multiple Indian banks (HDFC, ICICI, SBI, Axis, Kotak, IndusInd, PNB, Canara, Standard Chartered, YES Bank, Bank of Baroda, Federal Bank, IDFC First, etc.)
 */
export const INDIAN_BANK_SENDERS = [
  "hdfcbank.net",
  "alerts@hdfcbank.net",
  "hdfcbank.com",
  "icicibank.com",
  "alerts@icicibank.com",
  "sbi.co.in",
  "axisbank.com",
  "alerts@axisbank.com",
  "kotak.com",
  "indusind.com",
  "pnb.co.in",
  "canarabank.com",
  "idfcfirstbank.com",
  "yesbank.in",
  "bankofbaroda.co.in",
  "federalbank.co.in",
  "sc.com", // Standard Chartered
  "citibank.com",
  "rblbank.com",
  "paytm.com",
  "cred.club",
  "sliceit.com",
  "jupiter.money",
  "fi.money",
];

export const TRANSACTION_KEYWORDS = [
  "debited",
  "credited",
  "spent",
  "sent",
  "received",
  "paid",
  "refund",
  "reversal",
  "transferred",
  "txn",
  "vpa",
  "upi",
  "neft",
  "rtgs",
  "imps",
  "atm withdrawal",
  "pos txn",
  "inr",
  "rs.",
];

/**
 * Filter out OTPs, promotional newsletters, marketing, statements, credit card bill offers,
 * and service requests that are NOT actual transaction execution notifications.
 */
export const NON_TRANSACTION_INDICATORS = [
  "otp",
  "one time password",
  "verification code",
  "statement for the month",
  "e-statement",
  "pre-approved",
  "exclusive offer",
  "apply now",
  "discount",
  "special invitation",
  "reward points balance",
  "password reset",
  "login alert",
];

/**
 * Generates an optimized Gmail search query to only fetch transaction-relevant emails
 * and avoid scanning arbitrary personal or promotional emails.
 */
export function buildGmailTransactionQuery(afterTimestampSeconds?: number): string {
  const senderQuery = INDIAN_BANK_SENDERS.map((s) => `from:${s}`).join(" OR ");
  const keywords = `(debited OR credited OR "spent" OR "transferred" OR "paid" OR "refund" OR "UPI" OR "NEFT" OR "IMPS" OR "INR")`;
  const excludeKeywords = `-{"otp" "verification code" "login alert" "special offer"}`;

  let query = `(${senderQuery}) ${keywords} ${excludeKeywords}`;

  if (afterTimestampSeconds && afterTimestampSeconds > 0) {
    query += ` after:${afterTimestampSeconds}`;
  }

  return query;
}

/**
 * Quick heuristic check before spending Gemini API tokens.
 * Returns true if the email is genuinely plausible as a financial transaction alert.
 */
export function isLikelyTransactionEmail(from: string, subject: string, bodyText: string): boolean {
  const combined = `${from} ${subject} ${bodyText}`.toLowerCase();

  // Check if it's an obvious OTP or promotional email
  for (const nonTxn of NON_TRANSACTION_INDICATORS) {
    // If it mentions OTP or verification code specifically in subject or short text
    if (subject.toLowerCase().includes(nonTxn) || (nonTxn === "otp" && combined.includes("otp for"))) {
      return false;
    }
  }

  // Must have at least one transaction keyword
  const hasTxnKeyword = TRANSACTION_KEYWORDS.some((kw) => combined.includes(kw));
  if (!hasTxnKeyword) return false;

  // Must have an amount or currency indicator
  const hasCurrencyIndicator = /inr|rs\.?|₹|\b\d+(\.\d{1,2})?\s*(debited|credited)/i.test(combined);
  return hasCurrencyIndicator;
}
