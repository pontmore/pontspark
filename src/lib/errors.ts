/**
 * Readable text for any thrown value. Breez SDK errors carry their detail in
 * `inner` and only their variant name in `message` ("SdkError.SparkError"),
 * which tells a user (or a bug report) nothing.
 */
export function errorText(e: unknown): string {
  if (e && typeof e === "object") {
    const inner = (e as { inner?: unknown }).inner;
    const detail = Array.isArray(inner) ? inner.filter((x) => typeof x === "string" && x).join(": ") : "";
    const message = e instanceof Error ? e.message : "";
    if (detail) return message ? `${message}: ${detail}` : detail;
    if (message) return message;
  }
  return String(e);
}
