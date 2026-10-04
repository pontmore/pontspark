/**
 * Event kinds and identifiers.
 *
 * Kinds 30360, 30361, 7300 and 7301 are Pontmore protocol state (PIP-00..02).
 * Everything tagged "implementation assumption" below is this app's own
 * convention where the specs are silent, kept separate so it can be swapped
 * for a standard once one exists.
 */

export const KIND = {
  profile: 0,
  relayList: 10002,
  /** PIP-00 Agent definition. */
  agentDefinition: 30360,
  /** PIP-01 escrow descriptor. */
  escrowDescriptor: 30361,
  /** PIP-02 coordination root. */
  root: 7300,
  /** PIP-02 coordination action. */
  action: 7301,
  /** NIP-69 peer-to-peer order; carries signed expiring swap offers. */
  offer: 38383,
  /** NIP-59 gift wrap. */
  giftWrap: 1059,
  /** NIP-17 chat message rumor. */
  chat: 14,
  /** Implementation assumption: structured private swap payload rumor (gift-wrapped only). */
  swapPayload: 7310,
} as const;

export const SWAP_PROFILE = "pontmore/swap@1";
export const SWAP_CAPABILITY = "pontmore/swap@1";
export const PIP02_VERSION = 2;

/**
 * Implementation assumption: a non-custodial escrow made of a Lightning hold
 * invoice between two Breez Spark wallets. The Bitcoin provider picks the
 * payment hash; the recipient creates a hold invoice for it and the provider
 * pays it. The payment stays held until the provider releases the preimage
 * after fiat is confirmed, and fails back to the provider if it never is.
 * (Direct Spark-to-Spark HTLCs, the earlier `spark_htlc` escrow, are refused
 * by Spark operators.) The descriptor publisher is the bound `core/escrow`
 * authority.
 */
export const ESCROW_TYPE = "spark_hold_invoice";
export const ESCROW_D_TAG = "spark-hold-invoice";
export const ESCROW_NETWORK = "spark";

export const AGENT_D_TAG = "agent";
/** NIP-69 `y` platform tag for Pontmore offers. */
export const OFFER_PLATFORM = "pontmore";
export const RESOLUTION_POLICY = "pontmore-mobile/agent-resolver@1";

export const capabilityTag = (id: string) => `pontmore-capability:${id}`;
export const escrowAddress = (escrowPk: string) => `${KIND.escrowDescriptor}:${escrowPk}:${ESCROW_D_TAG}`;

export const DISPUTE_CLASSES = [
  "fiat_not_received",
  "incorrect_fiat_amount",
  "payment_reference_invalid",
  "escrow_not_secured",
  "bitcoin_not_released",
  "conflicting_confirmation",
  "timeout",
] as const;
export type DisputeClass = (typeof DISPUTE_CLASSES)[number];

/** Default timings for new swaps, in seconds. */
export const SWAP_TIMING = {
  /** Agent must accept within this window (root `expires_at`). */
  acceptWindow: 15 * 60,
  /** Fiat must be sent within this window after the request. */
  payWindow: 75 * 60,
  /**
   * Fiat receipt must be confirmed within this window after the request.
   * Spark holds an incoming hold-invoice payment for about 4 hours, so this
   * leaves room to release after the last possible confirmation.
   */
  confirmWindow: 3 * 60 * 60,
  /** The lock is expected to outlive `fiat_confirm_by` by this much. */
  htlcGrace: 60 * 60,
  /** Offers are republished while online and expire on their own when not. */
  offerLifetime: 30 * 60,
  /** How far a quoted price may be from the agent's current price and still be honoured. */
  quoteTolerancePct: 1,
  /** Descriptor lifetime; republishing it would invalidate in-flight roots. */
  descriptorLifetime: 365 * 24 * 60 * 60,
} as const;
