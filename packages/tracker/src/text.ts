// What people write, as we keep it. No browser APIs: ingest applies the same cleaning.

/**
 * A user's message, ready to send: whitespace collapsed, at most 500 characters, and email
 * addresses and phone numbers replaced (feedback is sent with the visit, never contact details).
 */
export function feedbackText(raw: string): string | null {
  const text = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[email]")
    .replace(/\+?\d[\d\s().-]{6,}\d/g, "[phone]")
    .slice(0, 500);
  return text || null;
}
