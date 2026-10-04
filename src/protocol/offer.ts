/**
 * Swap offers as NIP-69 peer-to-peer order events (kind 38383).
 *
 * PIP-00 keeps prices and limits out of the Agent definition and says they
 * belong in signed, expiring offers or quotes. Pontmore agents publish them in
 * the NIP-69 shape that Mostro, lnp2pBot, RoboSats and Peach also use, so
 * order aggregators list Pontmore agents next to theirs. One event covers one
 * direction in one currency: `k=sell` when the agent sells bitcoin.
 *
 * NIP-69 prices relative to an unnamed index (`premium`). Pontmore needs the
 * exact price, because a customer's root commits to the exact offer bytes as
 * `commitments.quote` and the agent checks the sats against it. The exact
 * price, registry channel ids, escrow and resolver ride in extra tags that
 * other NIP-69 clients ignore.
 */
import { verifyEvent, type Event } from "nostr-tools/pure";

import { ESCROW_D_TAG, ESCROW_NETWORK, KIND, OFFER_PLATFORM, SWAP_PROFILE, escrowAddress } from "./constants";
import { compareDecimal, isDecimalAmount, satsForFiat } from "../lib/money";
import { verifyCommitment } from "../lib/keys";
import type { Direction, SwapRoot, SwapTerms } from "./swap";

export interface OfferSide {
  /** Exact fiat price per BTC. */
  price: string;
  min: string;
  max: string;
}

export type OfferStatus = "pending" | "canceled";

export interface OfferContent extends OfferSide {
  /** The customer's direction: `fiat_to_btc` is the agent selling (`k=sell`). */
  direction: Direction;
  currency: string;
  /** Versioned payment-channels registry ids. */
  channels: string[];
  /** Readable channel names for `pm`, for clients without the registry. */
  channelLabels: string[];
  /** NIP-69 `network`: mainnet, regtest, ... */
  network: string;
  /** NIP-69 `layer`; also the swap's `terms.bitcoin.network`. */
  layer: string;
  /** Margin over market in percent, from the agent's side. Indicative only. */
  premium: string;
  escrow: string;
  resolver: string;
  expires_at: number;
  status: OfferStatus;
  name?: string;
  source?: string;
}

export interface Offer extends OfferContent {
  event: Event;
  agent: string;
  /** Exact bytes the quote commitment covers. */
  raw: string;
}

export const orderType = (direction: Direction) => (direction === "fiat_to_btc" ? "sell" : "buy");

/** One addressable slot per agent, currency and direction. */
export const offerDTag = (currency: string, direction: Direction) => `${SWAP_PROFILE}:${currency}:${orderType(direction)}`;

const tag = (e: Event, name: string) => e.tags.find((t) => t[0] === name);
const one = (e: Event, name: string) => tag(e, name)?.[1];

export function serializeOffer(event: Event): string {
  return JSON.stringify(event);
}

export function parseOffer(event: Event, opts: { verify?: boolean } = {}): Offer {
  if (event.kind !== KIND.offer) throw new Error("Not an order");
  if (one(event, "y") !== OFFER_PLATFORM || one(event, "z") !== "order") throw new Error("Not a Pontmore offer");
  if (one(event, "protocol") !== SWAP_PROFILE) throw new Error("Unsupported offer profile");
  if (opts.verify !== false && !verifyEvent(event)) throw new Error("Bad offer signature");

  const k = one(event, "k");
  if (k !== "sell" && k !== "buy") throw new Error("Bad order type");
  const direction: Direction = k === "sell" ? "fiat_to_btc" : "btc_to_fiat";
  if (one(event, "d") !== offerDTag(one(event, "f") ?? "", direction)) throw new Error("Bad offer slot");

  const status = one(event, "s");
  if (status !== "pending" && status !== "canceled") throw new Error("Bad status");
  const currency = one(event, "f") ?? "";
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Bad currency");
  const fa = tag(event, "fa");
  const [min, max] = fa?.length === 3 ? [fa[1], fa[2]] : [fa?.[1], fa?.[1]];
  const price = one(event, "price");
  if (!price || !isDecimalAmount(price) || Number(price) <= 0) throw new Error("Bad price");
  if (!min || !isDecimalAmount(min) || !max || !isDecimalAmount(max)) throw new Error("Bad fiat amount");
  if (compareDecimal(min, max) > 0) throw new Error("min above max");
  if (one(event, "amt") !== "0") throw new Error("Pontmore offers are fiat-denominated");

  const channels = (tag(event, "channels") ?? []).slice(1);
  if (!channels.every((c) => /^[a-z0-9_]+@\d+$/.test(c))) throw new Error("Bad channels");
  if (status === "pending" && !channels.length) throw new Error("Offer has no channels");
  const escrow = tag(event, "a")?.[3] === "escrow" ? tag(event, "a")![1] : "";
  if (!/^30361:[0-9a-f]{64}:.+$/.test(escrow)) throw new Error("Bad escrow");
  const resolver = event.tags.find((t) => t[0] === "p" && t[3] === "core/resolver")?.[1] ?? "";
  if (!/^[0-9a-f]{64}$/.test(resolver)) throw new Error("Bad resolver");
  const expires = Number(one(event, "expires_at"));
  if (!Number.isInteger(expires)) throw new Error("Bad expiry");

  return {
    direction,
    currency,
    channels,
    channelLabels: (tag(event, "pm") ?? []).slice(1),
    network: one(event, "network") ?? "",
    layer: one(event, "layer") ?? "",
    price,
    min,
    max,
    premium: one(event, "premium") ?? "0",
    escrow,
    resolver,
    expires_at: expires,
    status,
    name: one(event, "name"),
    source: one(event, "source"),
    event,
    agent: event.pubkey,
    raw: serializeOffer(event),
  };
}

export function offerSide(offer: OfferContent, direction: Direction): OfferSide | undefined {
  return offer.direction === direction ? offer : undefined;
}

export function escrowPkOf(offer: OfferContent): string {
  return offer.escrow.split(":")[1];
}

export function isOfferLive(offer: OfferContent, at = Math.floor(Date.now() / 1000)): boolean {
  return offer.status === "pending" && offer.expires_at > at;
}

export interface Quote {
  direction: Direction;
  fiatAmount: string;
  sats: bigint;
  price: string;
}

export function quote(offer: OfferContent, direction: Direction, fiatAmount: string): Quote | null {
  const s = offerSide(offer, direction);
  if (!s) return null;
  return { direction, fiatAmount, sats: satsForFiat(fiatAmount, s.price), price: s.price };
}

/**
 * The terms a customer commits to when requesting a swap from `offer`. The
 * swap's `bitcoin.network` is the offer's settlement layer (spark), not its
 * NIP-69 chain network; agents decline anything else.
 */
export function termsFromOffer(
  offer: OfferContent,
  direction: Direction,
  fiatAmount: string,
  channel: string,
  deadlines: SwapTerms["deadlines"],
): SwapTerms | null {
  const q = quote(offer, direction, fiatAmount);
  if (!q || q.sats <= 0n) return null;
  return {
    direction,
    fiat: { currency: offer.currency, amount: fiatAmount },
    bitcoin: { amount: q.sats.toString(), unit: "sat", network: offer.layer },
    payment_channel: channel,
    deadlines,
  };
}

export type LimitCheck = "ok" | "below_min" | "above_max" | "unsupported";

export function checkLimits(offer: OfferContent, direction: Direction, fiatAmount: string): LimitCheck {
  const s = offerSide(offer, direction);
  if (!s) return "unsupported";
  if (compareDecimal(fiatAmount, s.min) < 0) return "below_min";
  if (compareDecimal(fiatAmount, s.max) > 0) return "above_max";
  return "ok";
}

/**
 * Agent-side check that a customer's root matches one of the agent's own
 * offers exactly. Returns a list of human-readable problems; empty is valid.
 */
export function checkRootAgainstOffer(root: SwapRoot, quoteBytes: string, agentPk: string, escrowPk: string): string[] {
  const problems: string[] = [];
  if (!root.commitments.quote || !verifyCommitment(quoteBytes, root.commitments.quote)) {
    return ["Quote commitment does not match"];
  }
  let offer: Offer;
  try {
    offer = parseOffer(JSON.parse(quoteBytes) as Event);
  } catch (e) {
    return [`Quote is not a valid offer: ${(e as Error).message}`];
  }
  if (offer.agent !== agentPk) problems.push("Quote was not signed by this agent");
  if (offer.status !== "pending") problems.push("Quote was withdrawn");
  if (offer.expires_at <= root.createdAt) problems.push("Quote had expired when the request was made");
  if (offer.direction !== root.terms.direction) problems.push("Direction does not match");
  if (offer.escrow !== escrowAddress(escrowPk) || root.descriptorAddress !== escrowAddress(escrowPk))
    problems.push("Escrow does not match");
  if (!root.descriptorAddress.endsWith(`:${ESCROW_D_TAG}`)) problems.push("Unsupported escrow descriptor");
  if (offer.resolver !== root.resolver) problems.push("Resolver does not match");
  if (offer.currency !== root.terms.fiat.currency) problems.push("Currency does not match");
  if (!offer.channels.includes(root.terms.payment_channel)) problems.push("Payment channel not offered");
  if (offer.layer !== root.terms.bitcoin.network || offer.layer !== ESCROW_NETWORK) problems.push("Network does not match");
  const limits = checkLimits(offer, root.terms.direction, root.terms.fiat.amount);
  if (limits !== "ok") problems.push(`Amount ${limits.replace("_", " ")}`);
  const q = quote(offer, root.terms.direction, root.terms.fiat.amount);
  if (!q || q.sats.toString() !== root.terms.bitcoin.amount) problems.push("Bitcoin amount does not match the quoted price");
  return problems;
}

/**
 * Agent-side freshness check. Offers are republished every few minutes and a
 * customer could hold several unexpired ones, so the agent honours a quote
 * only if its price is no worse for the agent than what it would publish
 * now, within `tolerancePct`. That covers a request racing a republish
 * without letting anyone pick the best of the agent's past prices.
 */
export function priceStillHonoured(offer: OfferContent, currentPrice: string, tolerancePct: number): boolean {
  const quoted = Number(offer.price);
  const now = Number(currentPrice);
  if (!(quoted > 0) || !(now > 0)) return false;
  // Agent sells bitcoin: a lower quoted price is worse for it. Agent buys: higher is worse.
  return offer.direction === "fiat_to_btc" ? quoted >= now * (1 - tolerancePct / 100) : quoted <= now * (1 + tolerancePct / 100);
}
