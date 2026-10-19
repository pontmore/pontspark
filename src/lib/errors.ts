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

/**
 * Copy for a failed background step. The engine's own messages are already
 * sentences; wallet and network failures read like logs, so name the problem
 * instead of echoing them.
 */
export function friendlyError(raw: string): string {
  if (/dns|network|timed? ?out|connect|relay|offline|unreachable/i.test(raw)) return "Can't reach the network. Retrying automatically.";
  if (/insufficient|not enough funds|balance/i.test(raw)) return "Not enough bitcoin in the wallet for this step.";
  if (/^SdkError\b|\bError\.\w+/.test(raw)) return "The wallet couldn't finish this step. Retrying automatically.";
  return raw;
}
