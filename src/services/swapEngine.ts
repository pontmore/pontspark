/**
 * Swap engine: ingests public chains and private payloads, and performs the
 * device's duties under pontmore/swap@1 with the Spark HTLC escrow.
 *
 * Escrow model (implementation assumption, see protocol/constants.ts):
 *
 *   fiat_to_btc   agent locks sats to the customer's Spark address under
 *                 H = sha256(P); customer pays fiat; agent confirms and sends
 *                 P privately; customer claims; agent's escrow key settles.
 *   btc_to_fiat   customer locks sats to the agent under their own H; agent
 *                 pays fiat; customer confirms and sends P; agent claims and
 *                 its escrow key settles.
 *
 * Unreleased locks return to the Bitcoin provider at expiry, which is the
 * refund path. Nobody but the two participants ever holds the funds.
 */
import type { Event } from "nostr-tools/pure";

import { KIND, RESOLUTION_POLICY, SWAP_TIMING, type DisputeClass } from "../protocol/constants";
import { actionTemplate, rootTemplate } from "../protocol/events";
import { checkRootAgainstOffer, parseOffer, priceStillHonoured, termsFromOffer, type Offer } from "../protocol/offer";
import { priceWithSpread } from "../lib/money";
import {
  openWrap,
  parsePrivateTerms,
  paymentReferenceBytes,
  wrapChat,
  wrapPayload,
  type PayloadBody,
  type PrivateTerms,
} from "../protocol/payloads";
import {
  bitcoinProvider,
  fiatReceiver,
  fiatSender,
  isTerminal,
  parseRoot,
  reconstruct,
  type Direction,
  type SwapState,
} from "../protocol/swap";
import { channelInfo, detailsComplete, type ChannelDetails } from "../lib/channels";
import { commit, htlcPreimage, paymentHashOf, verifyCommitment, type KeyRing } from "../lib/keys";
import { useAgent } from "../store/agent";
import { payloadFrom, swapState, useSwaps, type SwapRecord } from "../store/swaps";
import { useWallet } from "../store/wallet";
import type { AgentListing } from "./discovery";
import { publish, publishAll, query, resetPool, sign, subscribe } from "./nostr";
import * as wallet from "./wallet";

const now = () => Math.floor(Date.now() / 1000);
const WRAP_LOOKBACK = 4 * 24 * 60 * 60;
/** Don't start a lock the counterparty has no realistic time to act on. */
const MIN_PAY_TIME = 5 * 60;

let keys: KeyRing | null = null;
let stopFns: (() => void)[] = [];
let actionSub: (() => void) | null = null;
let actionSubKey = "";
let tick: ReturnType<typeof setInterval> | null = null;
const queues = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

function k(): KeyRing {
  if (!keys) throw new Error("Swap engine not started");
  return keys;
}

// -- lifecycle ---------------------------------------------------------------

export function startEngine(ring: KeyRing) {
  stopEngine();
  keys = ring;
  const me = ring.identity.pk;

  stopFns.push(
    subscribe([{ kinds: [KIND.root], "#p": [me] }], (e) => void ingestRoot(e)),
    subscribe([{ kinds: [KIND.giftWrap], "#p": [me], since: now() - WRAP_LOOKBACK }], (e) => void ingestWrap(e)),
    useSwaps.subscribe(() => refreshActionSubscription()),
  );
  refreshActionSubscription();
  void backfill();
  // Deadlines (refunds, expiries) need a clock, not just events.
  tick = setInterval(() => {
    for (const id of activeIds()) schedule(id);
  }, 30_000);
}

/**
 * Back in the foreground: sockets may have died silently while the app was
 * in the background, so reconnect from scratch and catch up on missed events.
 */
export function resumeEngine() {
  const ring = keys;
  if (!ring) return;
  stopEngine();
  resetPool();
  startEngine(ring);
}

export function stopEngine() {
  stopFns.forEach((f) => f());
  stopFns = [];
  actionSub?.();
  actionSub = null;
  actionSubKey = "";
  if (tick) clearInterval(tick);
  tick = null;
  keys = null;
}

/** Notified whenever a duty finishes, so screens can re-read wallet state. */
export function onEngineChange(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

function activeIds(): string[] {
  return Object.values(useSwaps.getState().records)
    .filter((r) => {
      try {
        const st = swapState(r);
        return !isTerminal(st) || needsPostTerminalWork(r, st);
      } catch {
        return false;
      }
    })
    .map((r) => r.id);
}

/** The customer may still need to claim after the agent recorded settlement. */
function needsPostTerminalWork(rec: SwapRecord, st: SwapState): boolean {
  return st.status === "settled" && rec.role === "customer" && st.root.terms.direction === "fiat_to_btc" && !rec.local.claimedAt;
}

function refreshActionSubscription() {
  const ids = activeIds().sort();
  const key = ids.join(",");
  if (key === actionSubKey) return;
  actionSubKey = key;
  actionSub?.();
  actionSub = ids.length ? subscribe([{ kinds: [KIND.action], "#e": ids }], (e) => ingestAction(e)) : null;
}

async function backfill() {
  const ids = activeIds();
  if (!ids.length) return;
  const events = await query({ kinds: [KIND.action], "#e": ids }, 6000);
  events.forEach(ingestAction);
  ids.forEach(schedule);
}

// -- ingestion ---------------------------------------------------------------

async function ingestRoot(e: Event) {
  const ring = keys;
  if (!ring) return;
  const rec = useSwaps.getState().upsertRoot(e, ring.identity.pk);
  if (!rec) return;
  const actions = await query({ kinds: [KIND.action], "#e": [e.id] });
  useSwaps.getState().addActions(e.id, actions);
  schedule(e.id);
}

function ingestAction(e: Event) {
  const rootId = e.tags.find((t) => t[0] === "e" && t[3] === "root")?.[1];
  if (!rootId) return;
  if (useSwaps.getState().addActions(rootId, [e])) schedule(rootId);
}

async function ingestWrap(wrap: Event) {
  const ring = keys;
  if (!ring) return;
  const item = openWrap(wrap, ring.identity.sk);
  if (!item) return;
  let rec: SwapRecord | null = useSwaps.getState().records[item.coordination] ?? null;
  if (!rec) {
    // A request can arrive before its root reaches our relays' subscription.
    const [root] = await query({ ids: [item.coordination], kinds: [KIND.root] });
    if (!root) return;
    rec = useSwaps.getState().upsertRoot(root, ring.identity.pk);
    if (!rec) return;
    const actions = await query({ kinds: [KIND.action], "#e": [root.id] });
    useSwaps.getState().addActions(root.id, actions);
  }
  // Only the two participants may speak in a swap's private channel.
  const st = swapState(rec);
  const parties = [st.root.agent, st.root.customer];
  if (!parties.includes(item.from) || !parties.includes(item.to)) return;
  if (useSwaps.getState().addInbox(item)) schedule(item.coordination);
}

// -- helpers -----------------------------------------------------------------

function record(id: string): SwapRecord {
  const rec = useSwaps.getState().records[id];
  if (!rec) throw new Error("Unknown swap");
  return rec;
}

/** Pull the latest chain from relays, then append one action at the tip. */
async function act(id: string, signerSk: Uint8Array, action: string, data?: Record<string, unknown>): Promise<void> {
  const fresh = await query({ kinds: [KIND.action], "#e": [id] }, 4000);
  useSwaps.getState().addActions(id, fresh);
  const rec = record(id);
  const st = swapState(rec);
  if (st.forked) throw new Error("This swap is frozen: two conflicting actions were published.");
  const ev = sign(
    actionTemplate(id, st.tip, action, data, [
      { pk: st.root.agent, role: "swap/agent" },
      { pk: st.root.customer, role: "swap/customer" },
    ]),
    signerSk,
  );
  // Refuse to publish anything our own reducer would reject.
  const next = reconstruct(st.root, [...rec.actions, ev], { verify: false });
  if (next.tip !== ev.id) {
    const reason = next.rejected.find((r) => r.id === ev.id)?.reason ?? "not valid now";
    throw new Error(`Can't ${action.split("/")[1].replace(/_/g, " ")}: ${reason}`);
  }
  await publish(ev);
  useSwaps.getState().addActions(id, [ev]);
}

async function send(id: string, body: PayloadBody) {
  const ring = k();
  const st = swapState(record(id));
  const to = st.root.agent === ring.identity.pk ? st.root.customer : st.root.agent;
  const wraps = wrapPayload(ring.identity.sk, ring.identity.pk, to, id, [st.root.agent, st.root.customer], body);
  await publishAll(wraps);
  // Our self-copy lands via the subscription; record it now for idempotency.
  const self = openWrap(wraps[1], ring.identity.sk);
  if (self) useSwaps.getState().addInbox(self);
}

function sentByMe(rec: SwapRecord, type: PayloadBody["type"]) {
  return payloadFrom(rec, k().identity.pk, type);
}

function privateTermsOf(rec: SwapRecord): PrivateTerms | null {
  const bytes = rec.local.privateTermsBytes ?? payloadFrom(rec, swapState(rec).root.customer, "request")?.private_terms;
  return bytes ? parsePrivateTerms(bytes) : null;
}

function htlcExpiry(st: SwapState): number {
  return st.root.terms.deadlines.fiat_confirm_by + SWAP_TIMING.htlcGrace;
}

/** The payment hash locking this swap's sats, whoever generated it. */
function lockHash(rec: SwapRecord, st: SwapState): string | undefined {
  const me = k().identity.pk;
  if (bitcoinProvider(st.root) === me) return paymentHashOf(htlcPreimage(k().identity.sk, rec.id));
  return payloadFrom(rec, bitcoinProvider(st.root), "locked")?.payment_hash;
}

export interface LockCheck {
  ok: boolean;
  reason?: string;
  tx?: wallet.WalletTx;
}

/** Recipient-side check that the provider's HTLC really is in our wallet. */
export async function verifyIncomingLock(id: string): Promise<LockCheck> {
  const rec = record(id);
  const st = swapState(rec);
  const locked = payloadFrom(rec, bitcoinProvider(st.root), "locked");
  if (!locked) return { ok: false, reason: "Waiting for the bitcoin to be locked" };
  const tx = await wallet.findHtlc(locked.payment_hash, "in");
  if (!tx) return { ok: false, reason: "The lock hasn't reached your wallet yet" };
  if (tx.amountSats < BigInt(st.root.terms.bitcoin.amount)) return { ok: false, reason: "Locked amount is too small", tx };
  if (tx.htlc?.status !== "waiting" && !(tx.htlc?.status === "released" && rec.local.claimedAt))
    return { ok: false, reason: "Lock is no longer claimable", tx };
  if ((tx.htlc?.expiresAt ?? 0) < st.root.terms.deadlines.fiat_confirm_by)
    return { ok: false, reason: "Lock expires before the swap deadline", tx };
  return { ok: true, tx };
}

// -- duties ------------------------------------------------------------------

export function schedule(id: string) {
  const prev = queues.get(id) ?? Promise.resolve();
  const next = prev
    .then(() => runDuties(id))
    .catch((e: Error) => {
      useSwaps.getState().patchLocal(id, { lastError: e.message });
    })
    .finally(() => {
      if (queues.get(id) === next) queues.delete(id);
      listeners.forEach((l) => l());
    });
  queues.set(id, next);
}

async function runDuties(id: string) {
  if (!keys) return;
  // One duty often enables the next (accept -> lock -> secure).
  for (let i = 0; i < 6; i++) {
    const did = await duty(id);
    if (!did) break;
  }
  if (record(id).local.lastError) useSwaps.getState().patchLocal(id, { lastError: undefined });
}

/** Perform at most one duty. Returns true if something was done. */
async function duty(id: string): Promise<boolean> {
  const ring = k();
  const me = ring.identity.pk;
  const rec = record(id);
  const st = swapState(rec);
  const { root } = st;
  const t = now();
  if (st.forked || st.disputed) return false;

  const iProvide = bitcoinProvider(root) === me;
  const direction = root.terms.direction;

  if (rec.role === "agent") {
    if (st.status === "proposed") {
      if (t >= root.expiresAt) return false;
      if (!rec.local.problems) {
        const request = payloadFrom(rec, root.customer, "request");
        if (!request) return false;
        const check = await validateRequest(rec, request.quote, request.private_terms);
        // A wallet or price feed that isn't up yet (e.g. right after launch)
        // says nothing about the request; check again on the next tick.
        if (check.unsure) throw new Error(check.unsure);
        useSwaps.getState().patchLocal(id, {
          problems: check.problems,
          quoteBytes: request.quote,
          privateTermsBytes: request.private_terms,
        });
        return true;
      }
      if (rec.local.problems.length) {
        if (__DEV__) console.warn(`[swap ${id.slice(0, 8)}] declining:`, rec.local.problems);
        // Tell the customer why, privately; the decline itself must not wait on it.
        if (!sentByMe(rec, "declined")) await send(id, { type: "declined", reasons: rec.local.problems }).catch(() => undefined);
        await act(id, ring.identity.sk, "core/decline");
        return true;
      }
      const { autoAccept, online } = useAgent.getState();
      if (autoAccept && online) {
        await acceptSwap(id);
        return true;
      }
      return false;
    }

    if (st.status === "accepted") {
      if (!sentByMe(rec, "accept")) {
        await sendAcceptDetails(id);
        return true;
      }
      if (direction === "fiat_to_btc") return lockAndSecure(id);
      // btc_to_fiat: the customer locks; our escrow key attests once verified.
      const check = await verifyIncomingLock(id);
      if (check.ok) {
        await act(id, ring.escrow.sk, "core/secure");
        return true;
      }
      return false;
    }

    if (st.status === "settlement_authorized") {
      const hash = lockHash(rec, st);
      if (!hash) return false;
      if (direction === "fiat_to_btc") {
        if (!sentByMe(rec, "release")) {
          await send(id, { type: "release", preimage: htlcPreimage(ring.identity.sk, id) });
          return true;
        }
        const out = await wallet.findHtlc(hash, "out");
        if (out?.htlc?.status === "released" || payloadFrom(rec, root.customer, "claimed")) {
          await act(id, ring.escrow.sk, "core/settle");
          return true;
        }
        return false;
      }
      const release = payloadFrom(rec, root.customer, "release");
      if (!release || paymentHashOf(release.preimage) !== hash) return false;
      await claim(id, release.preimage, hash);
      await act(id, ring.escrow.sk, "core/settle");
      return true;
    }

    if (st.status === "refund_authorized") {
      const hash = lockHash(rec, st);
      const tx = hash ? await wallet.findHtlc(hash, direction === "fiat_to_btc" ? "out" : "in") : null;
      const expiry = tx?.htlc?.expiresAt ?? htlcExpiry(st);
      if (tx?.htlc?.status === "returned" || t > expiry + 600) {
        await act(id, ring.escrow.sk, "core/refund");
        return true;
      }
      return false;
    }
  }

  if (rec.role === "customer") {
    if (st.status === "proposed" && t < root.expiresAt && !sentByMe(rec, "request") && rec.local.quoteBytes) {
      await send(id, { type: "request", quote: rec.local.quoteBytes, private_terms: rec.local.privateTermsBytes ?? "{}" });
      return true;
    }
    if (st.status === "accepted" && direction === "btc_to_fiat") return lockAndSecure(id);

    if ((st.status === "settlement_authorized" || st.status === "settled") && direction === "fiat_to_btc" && !rec.local.claimedAt) {
      const release = payloadFrom(rec, root.agent, "release");
      const hash = lockHash(rec, st);
      if (!release || !hash || paymentHashOf(release.preimage) !== hash) return false;
      await claim(id, release.preimage, hash);
      return true;
    }
  }

  // Either role: the Bitcoin provider recovers when fiat never moved.
  if (st.status === "secured" && iProvide && t >= root.terms.deadlines.fiat_pay_by) {
    await act(id, ring.identity.sk, "core/authorize_refund");
    return true;
  }
  return false;
}

async function claim(id: string, preimage: string, hash: string) {
  const rec = record(id);
  if (!rec.local.claimedAt) {
    const existing = await wallet.findHtlc(hash, "in");
    if (existing?.htlc?.status === "waiting") await wallet.claimHtlc(preimage);
    useSwaps.getState().patchLocal(id, { claimedAt: now() });
    void useWallet.getState().refresh();
  }
  if (!sentByMe(record(id), "claimed")) await send(id, { type: "claimed" });
}

/** Bitcoin provider: lock the HTLC (idempotently), announce it, and — for the agent — secure. */
async function lockAndSecure(id: string): Promise<boolean> {
  const ring = k();
  const rec = record(id);
  const st = swapState(rec);
  const { root } = st;
  const preimage = htlcPreimage(ring.identity.sk, id);
  const hash = paymentHashOf(preimage);
  const amount = BigInt(root.terms.bitcoin.amount);

  if (!sentByMe(rec, "locked")) {
    let tx = await wallet.findHtlc(hash, "out");
    if (!tx) {
      if (now() > root.terms.deadlines.fiat_pay_by - MIN_PAY_TIME) {
        throw new Error("Too close to the payment deadline to lock bitcoin safely");
      }
      const recipient =
        rec.role === "agent"
          ? privateTermsOf(rec)?.spark_address
          : payloadFrom(rec, root.agent, "accept")?.spark_address;
      if (!recipient) return false;
      useSwaps.getState().patchLocal(id, { lockStartedAt: now() });
      tx = await wallet.lockHtlc({
        sparkAddress: recipient,
        amountSats: amount,
        paymentHash: hash,
        expirySecs: htlcExpiry(st) - now(),
        idempotencySeed: `pontmore/lock/${id}`,
      });
      void useWallet.getState().refresh();
    }
    useSwaps.getState().patchLocal(id, { lockTxId: tx.id });
    await send(id, { type: "locked", payment_hash: hash, expires_at: htlcExpiry(st), amount: amount.toString() });
    return true;
  }
  if (rec.role === "agent") {
    await act(id, ring.escrow.sk, "core/secure");
    return true;
  }
  return false;
}

interface RequestCheck {
  problems: string[];
  /** Set when the agent couldn't check the request yet; never decline on it. */
  unsure?: string;
}

async function validateRequest(rec: SwapRecord, quoteBytes: string, privateTermsBytes: string): Promise<RequestCheck> {
  const ring = k();
  const st = swapState(rec);
  const { root } = st;
  const problems = checkRootAgainstOffer(root, quoteBytes, ring.identity.pk, ring.escrow.pk);
  if (root.escrow !== ring.escrow.pk || root.resolver !== ring.resolver.pk) problems.push("Authorities are not mine");
  const descriptor = useAgent.getState().descriptor;
  if (!descriptor || descriptor.id !== root.descriptorId) problems.push("Escrow descriptor revision is not current");
  if (!root.commitments.private_terms || !verifyCommitment(privateTermsBytes, root.commitments.private_terms)) {
    problems.push("Private terms do not match their commitment");
  }
  const terms = parsePrivateTerms(privateTermsBytes);
  const market = useAgent.getState().markets.find((m) => m.currency === root.terms.fiat.currency);
  if (!market) problems.push("I don't serve this currency anymore");
  else if (!problems.length) {
    // Honour only (roughly) the current price, not the best of past offers.
    await useWallet.getState().refreshRates().catch(() => undefined);
    const rate = useWallet.getState().rates[market.currency];
    const side = root.terms.direction === "fiat_to_btc" ? market.buy : market.sell;
    const current = rate ? priceWithSpread(rate, (root.terms.direction === "fiat_to_btc" ? 1 : -1) * side.spreadPct) : null;
    const offer = parseOffer(JSON.parse(quoteBytes) as Event, { verify: false });
    if (!side.enabled) problems.push("I no longer offer this direction");
    else if (!current) return { problems, unsure: "Market price is unavailable" };
    else if (!priceStillHonoured(offer, current, SWAP_TIMING.quoteTolerancePct)) problems.push("Price has moved since this offer");
  }
  if (root.terms.direction === "fiat_to_btc") {
    if (!terms?.spark_address) problems.push("No Spark address to send bitcoin to");
    if (!market || !detailsComplete(root.terms.payment_channel, market.channels[root.terms.payment_channel]))
      problems.push("No payment details for this channel");
    let balance: bigint;
    try {
      balance = await wallet.balanceSats(true);
    } catch (e) {
      return { problems, unsure: `Couldn't read the wallet balance: ${(e as Error).message}` };
    }
    if (balance < BigInt(root.terms.bitcoin.amount)) problems.push("Not enough bitcoin to cover this swap");
  } else if (!terms?.payout || terms.payout.channel !== root.terms.payment_channel || !detailsComplete(terms.payout.channel, terms.payout.details)) {
    problems.push("Customer payout details are missing");
  }
  if (now() > root.terms.deadlines.fiat_pay_by - MIN_PAY_TIME * 2) problems.push("Request is too old to complete safely");
  return { problems };
}

async function sendAcceptDetails(id: string) {
  const rec = record(id);
  const { root } = swapState(rec);
  if (root.terms.direction === "fiat_to_btc") {
    const market = useAgent.getState().markets.find((m) => m.currency === root.terms.fiat.currency);
    const details = market?.channels[root.terms.payment_channel];
    if (!details) throw new Error("Add your payment details for this channel first");
    await send(id, { type: "accept", payment: { channel: root.terms.payment_channel, details } });
  } else {
    await send(id, { type: "accept", spark_address: await wallet.sparkAddress() });
  }
}

// -- user actions ------------------------------------------------------------

export interface NewSwap {
  listing: AgentListing;
  offer: Offer;
  direction: Direction;
  fiatAmount: string;
  channel: string;
  /** Required when selling bitcoin: where the agent should pay. */
  payout?: ChannelDetails;
}

export async function createSwap(input: NewSwap): Promise<string> {
  const ring = k();
  const t = now();
  const terms = termsFromOffer(input.offer, input.direction, input.fiatAmount, input.channel, {
    fiat_pay_by: t + SWAP_TIMING.payWindow,
    fiat_confirm_by: t + SWAP_TIMING.confirmWindow,
  });
  if (!terms) throw new Error("This agent can't quote that amount");
  if (input.direction === "btc_to_fiat") {
    const balance = await wallet.balanceSats();
    if (balance < BigInt(terms.bitcoin.amount)) throw new Error("Not enough bitcoin in your wallet for this swap");
    if (!input.payout || !detailsComplete(input.channel, input.payout))
      throw new Error(`Add your ${channelInfo(input.channel).short} details so the agent can pay you`);
  }
  const privateTerms: PrivateTerms =
    input.direction === "fiat_to_btc"
      ? { spark_address: await wallet.sparkAddress() }
      : { payout: { channel: input.channel, details: input.payout! } };
  const privateTermsBytes = JSON.stringify(privateTerms);
  const escrowPk = input.offer.escrow.split(":")[1];
  const root = sign(
    rootTemplate({
      agent: input.listing.pk,
      customer: ring.identity.pk,
      escrow: escrowPk,
      resolver: input.offer.resolver,
      descriptorId: input.listing.descriptor.id,
      terms,
      expiresAt: t + SWAP_TIMING.acceptWindow,
      commitments: { quote: commit(input.offer.raw), private_terms: commit(privateTermsBytes) },
      createdAt: t,
    }),
    ring.identity.sk,
  );
  // Never publish a root we would reject, or one the agent's own checks would decline.
  const problems = checkRootAgainstOffer(parseRoot(root), input.offer.raw, input.listing.pk, escrowPk);
  if (problems.length) throw new Error(`This request wouldn't match the agent's offer: ${problems.join("; ")}`);
  await publish(root);
  const rec = useSwaps.getState().upsertRoot(root, ring.identity.pk);
  if (!rec) throw new Error("Could not create the swap");
  useSwaps.getState().patchLocal(root.id, {
    quoteBytes: input.offer.raw,
    privateTermsBytes,
    counterpartyName: input.listing.profile.name,
  });
  try {
    await send(root.id, { type: "request", quote: input.offer.raw, private_terms: privateTermsBytes });
  } catch {
    // The root is public; the engine retries the private request.
    schedule(root.id);
  }
  return root.id;
}

export async function acceptSwap(id: string) {
  await act(id, k().identity.sk, "core/accept");
  await sendAcceptDetails(id);
  schedule(id);
}

export async function declineSwap(id: string) {
  await act(id, k().identity.sk, "core/decline");
}

export async function cancelSwap(id: string) {
  await act(id, k().identity.sk, "core/cancel");
}

export async function expireSwap(id: string) {
  await act(id, k().identity.sk, "core/expire");
}

export async function markFiatSent(id: string, reference: string) {
  const rec = record(id);
  const st = swapState(rec);
  if (fiatSender(st.root) !== k().identity.pk) throw new Error("Only the payer marks fiat as sent");
  const bytes = paymentReferenceBytes(id, reference);
  await send(id, { type: "fiat_sent", reference: bytes });
  await act(id, k().identity.sk, "swap/fiat_sent", { payment_reference: commit(bytes) });
  useSwaps.getState().patchLocal(id, { referenceText: reference.trim() });
}

/** Fiat receiver: confirm receipt, authorize settlement and release the preimage. */
export async function confirmAndRelease(id: string) {
  const ring = k();
  let st = swapState(record(id));
  if (fiatReceiver(st.root) !== ring.identity.pk) throw new Error("Only the fiat receiver can confirm");
  if (st.status === "fiat_sent") {
    await act(id, ring.identity.sk, "swap/fiat_confirmed", { payment_reference: st.paymentReference });
    st = swapState(record(id));
  }
  if (st.status === "fiat_confirmed") await act(id, ring.identity.sk, "core/authorize_settlement");
  if (!sentByMe(record(id), "release")) {
    await send(id, { type: "release", preimage: htlcPreimage(ring.identity.sk, id) });
  }
  useSwaps.getState().patchLocal(id, { releasedAt: now() });
  schedule(id);
}

export async function openDispute(id: string, cls: DisputeClass) {
  await act(id, k().identity.sk, "core/open_dispute", { class: cls });
}

export async function resolveDispute(id: string, effect: "resume" | "authorize_settlement" | "authorize_refund" | "cancel") {
  await act(id, k().resolver.sk, "core/resolve_dispute", { policy: RESOLUTION_POLICY, effect });
  schedule(id);
}

export async function sendChat(id: string, text: string) {
  const ring = k();
  const st = swapState(record(id));
  const to = st.root.agent === ring.identity.pk ? st.root.customer : st.root.agent;
  const wraps = wrapChat(ring.identity.sk, ring.identity.pk, to, id, text.trim());
  await publishAll(wraps);
  const self = openWrap(wraps[1], ring.identity.sk);
  if (self) useSwaps.getState().addInbox(self);
}

/** Force a refresh of one swap from relays. */
export async function refreshSwap(id: string) {
  const events = await query({ kinds: [KIND.action], "#e": [id] });
  useSwaps.getState().addActions(id, events);
  schedule(id);
}
