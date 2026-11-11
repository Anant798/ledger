
export function normalizeEmailText(input: string): string {
  return input
    // Remove quoted replies and forwarded history before extracting the latest alert.
    .replace(/<blockquote\b[^>]*>[\s\S]*?<\/blockquote>/gi, " ")
    .replace(/<(div|section|table)\b[^>]*(gmail_quote|yahoo_quoted|moz-cite-prefix)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/^\s*(On .{3,200}wrote:|-----Original Message-----)[\s\S]*$/gim, " ")
    // Remove script and style blocks entirely.
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")

    // Preserve line breaks from common HTML elements.
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")

    // Remove remaining HTML tags.
    .replace(/<[^>]*>/g, " ")

    // Decode common HTML entities.
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")

    // Normalize whitespace.
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

/** Keep the latest message intact; if it remains huge, retain bounded windows around financial cues. */
export function prepareEmailForExtraction(input: string, maxChars = 20_000): { text: string; oversized: boolean } {
  const clean = normalizeEmailText(input);
  if (clean.length <= maxChars) return { text: clean, oversized: false };
  const cues = /(?:\b(?:INR|USD|EUR|GBP|Rs\.?|₹|\$|€|£)\s?[\d,]+(?:\.\d{1,2})?|\b(?:debited|credited|spent|received|transferred|paid|refund|UPI|reference|UTR|transaction)\b)/gi;
  const windows: Array<[number, number]> = [];
  for (const match of clean.matchAll(cues)) {
    const start = Math.max(0, (match.index ?? 0) - 450);
    const end = Math.min(clean.length, (match.index ?? 0) + match[0].length + 700);
    if (windows.length && start <= windows[windows.length - 1][1] + 100) windows[windows.length - 1][1] = end;
    else windows.push([start, end]);
  }
  let text = windows.map(([start, end]) => clean.slice(start, end)).join("\n[… omitted unrelated email content …]\n");
  if (!text || text.length > maxChars) return { text: "", oversized: true };
  return { text, oversized: false };
}
