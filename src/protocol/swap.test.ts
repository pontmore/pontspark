import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from "nostr-tools/pure";

import { actionTemplate, escrowDescriptorTemplate, offerTemplate, rootTemplate } from "./events";
import { checkRootAgainstOffer, isOfferLive, parseOffer, priceStillHonoured, quote, serializeOffer, termsFromOffer } from "./offer";
import { parseRoot, reconstruct, type Direction, type SwapRoot } from "./swap";
import { escrowAddress } from "./constants";
import { commit, deriveKeyRing, htlcPreimage, paymentHashOf } from "../lib/keys";
import { openWrap, wrapChat, wrapPayload } from "./payloads";

const key = () => {
  const sk = generateSecretKey();
  return { sk, pk: getPublicKey(sk) };
};

const T0 = 1_800_000_000;

function setup(direction: Direction = "fiat_to_btc") {
  const agent = key();
  const customer = key();
  const escrow = key();
  const resolver = key();
  const descriptor = finalizeEvent({ ...escrowDescriptorTemplate(T0 + 1e6), created_at: T0 - 10 }, escrow.sk);
  const rootEvent = finalizeEvent(
    rootTemplate({
      agent: agent.pk,
      customer: customer.pk,
      escrow: escrow.pk,
      resolver: resolver.pk,
      descriptorId: descriptor.id,
      terms: {
        direction,
        fiat: { currency: "KES", amount: "1000" },
        bitcoin: { amount: "6000", unit: "sat", network: "spark" },
        payment_channel: "mpesa_phone_ke_kes@2",
        deadlines: { fiat_pay_by: T0 + 3600, fiat_confirm_by: T0 + 7200 },
      },
      expiresAt: T0 + 600,
      createdAt: T0,
    }),
    customer.sk,
  );
  const root = parseRoot(rootEvent);
  const events: Event[] = [];
  let tip = root.id;
  const act = (sk: Uint8Array, action: string, at: number, data?: Record<string, unknown>, prev = tip) => {
    const ev = finalizeEvent(actionTemplate(root.id, prev, action, data, [], at), sk);
    events.push(ev);
    tip = ev.id;
    return ev;
  };
  return { agent, customer, escrow, resolver, root, events, act };
}

const ref = commit("QWE123");

describe("pontmore/swap@1 reconstruction", () => {
  it("settles a fiat_to_btc swap", () => {
    const s = setup();
    s.act(s.agent.sk, "core/accept", T0 + 60);
    s.act(s.escrow.sk, "core/secure", T0 + 120);
    s.act(s.customer.sk, "swap/fiat_sent", T0 + 300, { payment_reference: ref });
    s.act(s.agent.sk, "swap/fiat_confirmed", T0 + 400, { payment_reference: ref });
    s.act(s.agent.sk, "core/authorize_settlement", T0 + 401);
    s.act(s.escrow.sk, "core/settle", T0 + 500);
    // Relay order must not matter.
    const state = reconstruct(s.root, [...s.events].reverse());
    expect(state.status).toBe("settled");
    expect(state.chain.map((a) => a.action)).toHaveLength(6);
    expect(state.forked).toBe(false);
  });

  it("settles a btc_to_fiat swap with roles swapped", () => {
    const s = setup("btc_to_fiat");
    s.act(s.agent.sk, "core/accept", T0 + 60);
    s.act(s.escrow.sk, "core/secure", T0 + 120);
    s.act(s.agent.sk, "swap/fiat_sent", T0 + 300, { payment_reference: ref });
    s.act(s.customer.sk, "swap/fiat_confirmed", T0 + 400, { payment_reference: ref });
    s.act(s.customer.sk, "core/authorize_settlement", T0 + 401);
    s.act(s.escrow.sk, "core/settle", T0 + 500);
    expect(reconstruct(s.root, s.events).status).toBe("settled");
  });

  it("rejects unauthorized signers and keeps the chain at the last valid action", () => {
    const s = setup();
    s.act(s.agent.sk, "core/accept", T0 + 60);
    s.act(s.agent.sk, "core/secure", T0 + 120); // agent is not the escrow
    const state = reconstruct(s.root, s.events);
    expect(state.status).toBe("accepted");
    expect(state.rejected[0].reason).toMatch(/escrow/);
  });

  it("rejects acceptance after expires_at", () => {
    const s = setup();
    s.act(s.agent.sk, "core/accept", T0 + 601);
    expect(reconstruct(s.root, s.events).status).toBe("proposed");
  });

  it("freezes on a fork", () => {
    const s = setup();
    const accept = s.act(s.agent.sk, "core/accept", T0 + 60);
    s.act(s.escrow.sk, "core/secure", T0 + 120, undefined, accept.id);
    s.act(s.customer.sk, "core/cancel", T0 + 121, undefined, accept.id);
    const state = reconstruct(s.root, s.events);
    expect(state.forked).toBe(true);
    expect(state.status).toBe("accepted");
    expect(state.forkIds).toHaveLength(2);
  });

  it("refunds when fiat is never sent", () => {
    const s = setup();
    s.act(s.agent.sk, "core/accept", T0 + 60);
    s.act(s.escrow.sk, "core/secure", T0 + 120);
    s.act(s.agent.sk, "core/authorize_refund", T0 + 3000); // too early
    expect(reconstruct(s.root, s.events).status).toBe("secured");
    s.events.pop();
    const st = reconstruct(s.root, s.events);
    const prev = st.tip;
    s.act(s.agent.sk, "core/authorize_refund", T0 + 3601, undefined, prev);
    s.act(s.escrow.sk, "core/refund", T0 + 3700);
    expect(reconstruct(s.root, s.events).status).toBe("refunded");
  });

  it("requires matching payment references", () => {
    const s = setup();
    s.act(s.agent.sk, "core/accept", T0 + 60);
    s.act(s.escrow.sk, "core/secure", T0 + 120);
    s.act(s.customer.sk, "swap/fiat_sent", T0 + 300, { payment_reference: ref });
    s.act(s.agent.sk, "swap/fiat_confirmed", T0 + 400, { payment_reference: commit("OTHER") });
    expect(reconstruct(s.root, s.events).status).toBe("fiat_sent");
  });

  it("freezes progress during a dispute until the resolver acts", () => {
    const s = setup();
    s.act(s.agent.sk, "core/accept", T0 + 60);
    s.act(s.escrow.sk, "core/secure", T0 + 120);
    s.act(s.customer.sk, "swap/fiat_sent", T0 + 300, { payment_reference: ref });
    s.act(s.customer.sk, "core/open_dispute", T0 + 8000, { class: "bitcoin_not_released" });
    let st = reconstruct(s.root, s.events);
    expect(st.disputed).toBe(true);
    s.act(s.agent.sk, "swap/fiat_confirmed", T0 + 8001, { payment_reference: ref });
    st = reconstruct(s.root, s.events);
    expect(st.status).toBe("fiat_sent");
    s.events.pop();
    s.act(s.resolver.sk, "core/resolve_dispute", T0 + 9000, { policy: "p", effect: "authorize_settlement" }, st.tip);
    s.act(s.escrow.sk, "core/settle", T0 + 9100);
    st = reconstruct(s.root, s.events);
    expect(st.status).toBe("settled");
    expect(st.resolution?.effect).toBe("authorize_settlement");
  });

  it("ignores actions after a terminal outcome", () => {
    const s = setup();
    s.act(s.agent.sk, "core/decline", T0 + 60);
    s.act(s.agent.sk, "core/accept", T0 + 61);
    expect(reconstruct(s.root, s.events).status).toBe("declined");
  });

  it("rejects roots that reuse a key across roles", () => {
    const agent = key();
    const customer = key();
    const ev = finalizeEvent(
      rootTemplate({
        agent: agent.pk,
        customer: customer.pk,
        escrow: agent.pk,
        resolver: customer.pk,
        descriptorId: "0".repeat(64),
        terms: {
          direction: "fiat_to_btc",
          fiat: { currency: "KES", amount: "1" },
          bitcoin: { amount: "1", unit: "sat", network: "spark" },
          payment_channel: "x@1",
          deadlines: { fiat_pay_by: T0 + 2, fiat_confirm_by: T0 + 3 },
        },
        expiresAt: T0 + 1,
      }),
      customer.sk,
    );
    expect(() => parseRoot(ev)).toThrow(/several roles/);
  });
});

describe("offers and quotes", () => {
  it("validates a root against the agent's own offer", () => {
    const ring = deriveKeyRing("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");
    const customer = key();
    const offerEvent = finalizeEvent(
      offerTemplate({
        direction: "fiat_to_btc",
        currency: "KES",
        channels: ["mpesa_phone_ke_kes@2"],
        channelLabels: ["M-Pesa phone"],
        network: "mainnet",
        layer: "spark",
        price: "13500000",
        min: "100",
        max: "50000",
        premium: "2",
        escrow: escrowAddress(ring.escrow.pk),
        resolver: ring.resolver.pk,
        expires_at: T0 + 7200,
        status: "pending",
      }),
      ring.identity.sk,
    );
    const offer = parseOffer(offerEvent);
    const q = quote(offer, "fiat_to_btc", "1000")!;
    expect(q.sats).toBe(7407n);
    const raw = serializeOffer(offerEvent);
    const descriptor = finalizeEvent(escrowDescriptorTemplate(T0 + 1e6), ring.escrow.sk);
    const make = (sats: string) =>
      parseRoot(
        finalizeEvent(
          rootTemplate({
            agent: ring.identity.pk,
            customer: customer.pk,
            escrow: ring.escrow.pk,
            resolver: ring.resolver.pk,
            descriptorId: descriptor.id,
            terms: {
              direction: "fiat_to_btc",
              fiat: { currency: "KES", amount: "1000" },
              bitcoin: { amount: sats, unit: "sat", network: "spark" },
              payment_channel: "mpesa_phone_ke_kes@2",
              deadlines: { fiat_pay_by: T0 + 3600, fiat_confirm_by: T0 + 7200 },
            },
            expiresAt: T0 + 600,
            commitments: { quote: commit(raw) },
            createdAt: T0,
          }),
          customer.sk,
        ),
      );
    expect(checkRootAgainstOffer(make("7407"), raw, ring.identity.pk, ring.escrow.pk)).toEqual([]);
    expect(checkRootAgainstOffer(make("9000"), raw, ring.identity.pk, ring.escrow.pk)).toContain(
      "Bitcoin amount does not match the quoted price",
    );

    // What a customer actually requests must pass the agent's checks.
    const terms = termsFromOffer(offer, "fiat_to_btc", "1000", "mpesa_phone_ke_kes@2", { fiat_pay_by: T0 + 3600, fiat_confirm_by: T0 + 7200 })!;
    expect(terms.bitcoin).toEqual({ amount: "7407", unit: "sat", network: "spark" });
    const requested = parseRoot(
      finalizeEvent(
        rootTemplate({
          agent: ring.identity.pk,
          customer: customer.pk,
          escrow: ring.escrow.pk,
          resolver: ring.resolver.pk,
          descriptorId: descriptor.id,
          terms,
          expiresAt: T0 + 600,
          commitments: { quote: commit(raw) },
          createdAt: T0,
        }),
        customer.sk,
      ),
    );
    expect(checkRootAgainstOffer(requested, raw, ring.identity.pk, ring.escrow.pk)).toEqual([]);
    expect(termsFromOffer(offer, "fiat_to_btc", "0", "mpesa_phone_ke_kes@2", terms.deadlines)).toBeNull();
  });

  it("publishes offers as NIP-69 orders", () => {
    const ring = deriveKeyRing("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");
    const base = {
      currency: "KES",
      channels: ["mpesa_phone_ke_kes@2"],
      channelLabels: ["M-Pesa phone"],
      network: "mainnet",
      layer: "spark",
      price: "13000000",
      min: "100",
      max: "50000",
      premium: "-2",
      escrow: escrowAddress(ring.escrow.pk),
      resolver: ring.resolver.pk,
      expires_at: T0 + 1800,
      status: "pending" as const,
    };
    const e = finalizeEvent(offerTemplate({ ...base, direction: "btc_to_fiat" }), ring.identity.sk);
    const t = (n: string) => e.tags.find((x) => x[0] === n);
    expect(e.kind).toBe(38383);
    expect(t("k")?.[1]).toBe("buy");
    expect(t("f")?.[1]).toBe("KES");
    expect(t("fa")).toEqual(["fa", "100", "50000"]);
    expect(t("amt")?.[1]).toBe("0");
    expect(t("y")?.[1]).toBe("pontmore");
    expect(t("z")?.[1]).toBe("order");
    expect(t("pm")).toEqual(["pm", "M-Pesa phone"]);
    const parsed = parseOffer(e);
    expect(parsed.direction).toBe("btc_to_fiat");
    expect(parsed.price).toBe("13000000");
    expect(isOfferLive(parsed, T0)).toBe(true);
    const gone = parseOffer(finalizeEvent(offerTemplate({ ...base, direction: "btc_to_fiat", status: "canceled", channels: [] }), ring.identity.sk));
    expect(isOfferLive(gone, T0)).toBe(false);
  });

  it("honours a quote only near the agent's current price", () => {
    const sell = { direction: "fiat_to_btc" as const, price: "10000000" };
    const buy = { direction: "btc_to_fiat" as const, price: "10000000" };
    // Agent sells: a quote below the current price costs the agent.
    expect(priceStillHonoured(sell as never, "10050000", 1)).toBe(true);
    expect(priceStillHonoured(sell as never, "10200000", 1)).toBe(false);
    expect(priceStillHonoured(sell as never, "9000000", 1)).toBe(true);
    // Agent buys: a quote above the current price costs the agent.
    expect(priceStillHonoured(buy as never, "9950000", 1)).toBe(true);
    expect(priceStillHonoured(buy as never, "9800000", 1)).toBe(false);
  });
});

describe("keys and private payloads", () => {
  it("derives distinct NIP-06 keys and deterministic preimages", () => {
    // NIP-06 test vector for account 0.
    const ring = deriveKeyRing("leader monkey parrot ring guide accident before fence cannon height naive bean");
    expect(ring.identity.pk).toBe("17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917");
    expect(new Set([ring.identity.pk, ring.escrow.pk, ring.resolver.pk]).size).toBe(3);
    const p = htlcPreimage(ring.identity.sk, "ab".repeat(32));
    expect(p).toBe(htlcPreimage(ring.identity.sk, "ab".repeat(32)));
    expect(paymentHashOf(p)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("round-trips gift-wrapped payloads and chat to both parties", () => {
    const a = key();
    const b = key();
    const root = "cd".repeat(32);
    const [toB, toSelf] = wrapPayload(a.sk, a.pk, b.pk, root, [a.pk, b.pk], { type: "release", preimage: "00" });
    const got = openWrap(toB, b.sk)!;
    expect(got.payload?.type).toBe("release");
    expect(got.from).toBe(a.pk);
    expect(openWrap(toSelf, a.sk)?.coordination).toBe(root);
    expect(openWrap(toB, a.sk)).toBeNull();
    const [declined] = wrapPayload(a.sk, a.pk, b.pk, root, [a.pk, b.pk], { type: "declined", reasons: ["Price has moved since this offer"] });
    expect(openWrap(declined, b.sk)?.payload).toMatchObject({ type: "declined", reasons: ["Price has moved since this offer"] });
    const [chat] = wrapChat(a.sk, a.pk, b.pk, root, "hello");
    expect(openWrap(chat, b.sk)?.text).toBe("hello");
  });
});

export type { SwapRoot };
