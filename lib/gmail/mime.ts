export type GmailMimePart = {
  mimeType?: string | null;
  filename?: string | null;
  body?: { data?: string | null; attachmentId?: string | null } | null;
  parts?: GmailMimePart[] | null;
};

function decodePart(part: GmailMimePart): string {
  const data = part.body?.data;
  return data ? Buffer.from(data, "base64url").toString("utf8") : "";
}

/** Select one body per MIME branch; multipart/alternative prefers plain text. */
export function extractPreferredMimeBody(payload: GmailMimePart | null | undefined): string {
  if (!payload || payload.filename || payload.body?.attachmentId) return "";
  const mime = payload.mimeType?.toLowerCase() ?? "";
  if (payload.parts?.length) {
    const children = payload.parts
      .filter((part) => !part.filename && !part.body?.attachmentId)
      .map((part) => ({ mime: part.mimeType?.toLowerCase() ?? "", text: extractPreferredMimeBody(part) }))
      .filter((part) => part.text.trim());
    if (mime === "multipart/alternative") {
      return children.find((part) => part.mime === "text/plain")?.text
        ?? children.find((part) => part.mime === "text/html")?.text
        ?? children[0]?.text
        ?? "";
    }
    return children.map((part) => part.text).join("\n");
  }
  if (mime === "text/plain" || mime === "text/html") return decodePart(payload);
  return "";
}
