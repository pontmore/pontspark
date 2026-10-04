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
  | { type: "request"; quote: string; private_terms: string; payment_hash?: string }
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

const PAYLOAD_TYPES = new Set(["request", "accept", "invoice", "locked", "fiat_sent", "release", "claimed", "declined"]);

/** Unwrap a gift wrap addressed to `sk`, or null if it is not ours or not a swap message. */
export function openWrap(wrap: Event, sk: Uint8Array): InboxItem | null {
  let rumor;
  try {
    rumor = unwrapEvent(wrap, sk);
  } catch {
    return null;
  }
  const root = rumor.tags.find((t) => t[0] === "e")?.[1];
  const to = rumor.tags.find((t) => t[0] === "p")?.[1];
  if (!root || !to || !/^[0-9a-f]{64}$/.test(root)) return null;
  const base = { id: rumor.id, from: rumor.pubkey, to, createdAt: rumor.created_at, coordination: root };

  if (rumor.kind === KIND.chat) {
    return { ...base, kind: "chat", text: String(rumor.content).slice(0, 4000) };
  }
  if (rumor.kind === KIND.swapPayload) {
    try {
      const p = JSON.parse(rumor.content) as SwapPayload;
      if (p.v !== 1 || p.profile !== SWAP_PROFILE || p.coordination !== root || !PAYLOAD_TYPES.has(p.type)) return null;
      return { ...base, kind: "payload", payload: p };
    } catch {
      return null;
    }
  }
  return null;
}

/** The payment reference bytes committed by swap/fiat_sent. */
export function paymentReferenceBytes(coordination: string, reference: string): string {
  return JSON.stringify({ coordination, reference: reference.trim() });
}

export function parsePrivateTerms(bytes: string): PrivateTerms | null {
  try {
    const v = JSON.parse(bytes) as PrivateTerms;
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}
