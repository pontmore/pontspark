/**
 * Private history of the accounts each customer has paid from.
 *
 * A triangulation scam has an unrelated victim pay the agent for something
 * sold outside Clink, while the scammer receives the bitcoin. The payment
 * looks right, so a reference or a declared sender cannot catch it. What a
 * scammer cannot cheaply fake is a history of completed swaps from the same
 * account. This is a risk signal for the agent, never an automatic block:
 * every honest first-time customer looks the same.
 *
 * Accounts are stored only as keyed hashes, so the cache never holds a
 * readable phone or account number.
 */
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";

export interface PayerHistoryEntry {
  /** Completed swaps paid from this account. */
  swaps: number;
  firstAt: number;
  lastAt: number;
}

export interface PayerSignal {
  payer: string;
  /** History for this exact account, absent the first time. */
  account?: PayerHistoryEntry;
  /** Other accounts this customer has completed swaps from on the same channel. */
  otherAccounts: number;
}

/** Spacing, case and phone punctuation don't make a different account. */
export function normalizePayer(payer: string): string {
  return payer.trim().toLowerCase().replace(/[\s\-().+]/g, "");
}

/** Registry id without its schema version: a schema revision doesn't change the account. */
const channelOf = (paymentChannel: string) => paymentChannel.replace(/@\d+$/, "");

/** Lookup prefix for one customer on one channel. */
export function payerPrefix(customer: string, paymentChannel: string): string {
  return `${customer}:${channelOf(paymentChannel)}:`;
}

export function payerKey(secret: Uint8Array, customer: string, paymentChannel: string, payer: string): string {
  const key = sha256(concatBytes(secret, utf8ToBytes("clink/payer-history/v1")));
  return payerPrefix(customer, paymentChannel) + bytesToHex(hmac(sha256, key, utf8ToBytes(normalizePayer(payer))));
}

export function payerSignal(
  history: Record<string, PayerHistoryEntry>,
  key: string,
  customer: string,
  paymentChannel: string,
  payer: string,
): PayerSignal {
  const prefix = payerPrefix(customer, paymentChannel);
  const otherAccounts = Object.keys(history).filter((k) => k.startsWith(prefix) && k !== key).length;
  return { payer, account: history[key], otherAccounts };
}
