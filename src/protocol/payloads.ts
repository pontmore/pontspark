/**
 * Private swap payloads and chat, carried in NIP-59 gift wraps.
 *
 * Payment instructions, Spark addresses, payment references and HTLC
 * preimages never appear in public events. Per swap@1, every private payload
 * names the profile, the coordination root, its participants and the
 * commitment scheme. Each wrap is also sent to the author so history survives
 * a reinstall.
 */
import { unwrapEvent, wrapEvent } from "nostr-tools/nip59";
import type { Event } from "nostr-tools/pure";

import { KIND, SWAP_PROFILE } from "./constants";
import type { ChannelDetails } from "../lib/channels";

export interface PaymentDetails {
  channel: string;
  details: ChannelDetails;
}

/** Exact bytes committed as `private_terms` in the root. */
export interface PrivateTerms {
  /** Customer's Spark address; required when the customer receives bitcoin. */
  spark_address?: string;
  /** Where the agent should send fiat; required when the customer sells bitcoin. */
  payout?: PaymentDetails;
}

export type PayloadBody =
  /** `payment_hash`: set when the customer provides the bitcoin (btc_to_fiat). */
  | { type: "request"; quote: string; private_terms: string; payment_hash?: string; name?: string }
  /** `payment_hash`: set when the agent provides the bitcoin (fiat_to_btc). */
  | { type: "accept"; payment?: PaymentDetails; spark_address?: string; payment_hash?: string }
  /** From the bitcoin recipient: a hold invoice for the provider's payment hash. */
  | { type: "invoice"; bolt11: string }
  | { type: "locked"; payment_hash: string; expires_at: number; amount: string }
  | { type: "fiat_sent"; reference: string }
  | { type: "release"; preimage: string }
  | { type: "claimed" }
  /** Why the agent declined; private so the reasons never appear in public events. */
  | { type: "declined"; reasons: string[] };

export type SwapPayload = PayloadBody & {
  v: 1;
  profile: string;
  coordination: string;
  participants: string[];
  commitment_scheme: "sha256-bytes@1";
};

export interface InboxItem {
  /** Rumor id. */
  id: string;
  from: string;
  to: string;
  createdAt: number;
  coordination: string;
  kind: "chat" | "payload";
  text?: string;
  payload?: SwapPayload;
}

export function wrapPayload(
  senderSk: Uint8Array,
  senderPk: string,
  recipientPk: string,
  coordination: string,
  participants: string[],
  body: PayloadBody,
): Event[] {
  const payload: SwapPayload = {
    v: 1,
    profile: SWAP_PROFILE,
    coordination,
    participants,
    commitment_scheme: "sha256-bytes@1",
    ...body,
  };
  const rumor = {
    kind: KIND.swapPayload,
    content: JSON.stringify(payload),
    tags: [
      ["p", recipientPk],
      ["e", coordination, "", "root"],
    ],
    created_at: Math.floor(Date.now() / 1000),
  };
  return [wrapEvent(rumor, senderSk, recipientPk), wrapEvent(rumor, senderSk, senderPk)];
}

export function wrapChat(senderSk: Uint8Array, senderPk: string, recipientPk: string, coordination: string, text: string): Event[] {
  const rumor = {
    kind: KIND.chat,
    content: text,
    tags: [
      ["p", recipientPk],
      ["e", coordination, "", "root"],
      ["subject", "Pontmore swap"],
    ],
    created_at: Math.floor(Date.now() / 1000),
  };
  return [wrapEvent(rumor, senderSk, recipientPk), wrapEvent(rumor, senderSk, senderPk)];
}

const hex32 = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const string = (v: unknown): v is string => typeof v === "string";
const optionalString = (v: unknown) => v === undefined || string(v);
const optionalHash = (v: unknown) => v === undefined || hex32(v);

function paymentDetails(v: unknown): boolean {
  return object(v) && string(v.channel) && object(v.details) && Object.values(v.details).every(string);
}

function validPayload(v: unknown, root: string, from: string, to: string): v is SwapPayload {
  if (!object(v) || v.v !== 1 || v.profile !== SWAP_PROFILE || v.coordination !== root ||
      v.commitment_scheme !== "sha256-bytes@1" || !Array.isArray(v.participants) ||
      v.participants.length !== 2 || !v.participants.every(hex32) ||
      new Set(v.participants).size !== 2 || !v.participants.includes(from) || !v.participants.includes(to)) return false;
  switch (v.type) {
    case "request": return string(v.quote) && string(v.private_terms) && optionalHash(v.payment_hash) && optionalString(v.name) && parsePrivateTerms(v.private_terms) !== null;
    case "accept": return (v.payment === undefined || paymentDetails(v.payment)) && optionalString(v.spark_address) && optionalHash(v.payment_hash);
    case "invoice": return string(v.bolt11) && v.bolt11.length > 0;
    case "locked": return hex32(v.payment_hash) && Number.isSafeInteger(v.expires_at) && (v.expires_at as number) > 0 && string(v.amount) && /^[1-9][0-9]*$/.test(v.amount);
    case "fiat_sent": return string(v.reference);
    case "release": return hex32(v.preimage);
    case "claimed": return true;
    case "declined": return Array.isArray(v.reasons) && v.reasons.every(string);
    default: return false;
  }
}

/** Untrusted decrypted data is validated inside the same boundary as decryption. */
export function openWrap(wrap: Event, sk: Uint8Array): InboxItem | null {
  try {
    const rumor = unwrapEvent(wrap, sk);
    if (!object(rumor) || !hex32(rumor.id) || !hex32(rumor.pubkey) ||
        !Number.isSafeInteger(rumor.created_at) || rumor.created_at < 0 ||
        !string(rumor.content) || !Array.isArray(rumor.tags) ||
        !rumor.tags.every((t) => Array.isArray(t) && t.length > 0 && t.every(string))) return null;
    const roots = rumor.tags.filter((t) => t[0] === "e");
    const recipients = rumor.tags.filter((t) => t[0] === "p");
    if (roots.length !== 1 || recipients.length !== 1) return null;
    const root = roots[0][1];
    const to = recipients[0][1];
    if (!hex32(root) || !hex32(to)) return null;
    const base = { id: rumor.id, from: rumor.pubkey, to, createdAt: rumor.created_at, coordination: root };
    if (rumor.kind === KIND.chat) return { ...base, kind: "chat", text: rumor.content.slice(0, 4000) };
    if (rumor.kind !== KIND.swapPayload) return null;
    const payload: unknown = JSON.parse(rumor.content);
    if (!validPayload(payload, root, rumor.pubkey, to)) return null;
    return { ...base, kind: "payload", payload };
  } catch {
    return null;
  }
}

/** The payment reference bytes committed by swap/fiat_sent. */
export function paymentReferenceBytes(coordination: string, reference: string): string {
  return JSON.stringify({ coordination, reference: reference.trim() });
}

export function parsePrivateTerms(bytes: string): PrivateTerms | null {
  try {
    const v: unknown = JSON.parse(bytes);
    if (!object(v) || !optionalString(v.spark_address) || (v.payout !== undefined && !paymentDetails(v.payout))) return null;
    return v as PrivateTerms;
  } catch {
    return null;
  }
}
