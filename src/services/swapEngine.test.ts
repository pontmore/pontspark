jest.mock("@react-native-async-storage/async-storage", () => {
  const disk: Record<string, string> = {};
  return {
    getItem: jest.fn(async (k: string) => disk[k] ?? null),
    setItem: jest.fn(async (k: string, v: string) => { disk[k] = v; }),
    removeItem: jest.fn(async (k: string) => { delete disk[k]; }),
  };
});
jest.mock("./secure", () => ({
  getSecret: jest.fn(async () => "cc".repeat(32)), setSecret: jest.fn(async () => undefined),
}));
jest.mock("./wallet", () => ({ findHtlc: jest.fn() }));
jest.mock("./nostr", () => ({}));
jest.mock("../store/agent", () => ({}));
jest.mock("../store/session", () => ({}));
jest.mock("../store/wallet", () => ({}));

import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { actionTemplate, rootTemplate } from "../protocol/events";
import { SWAP_PROFILE } from "../protocol/constants";
import { useSwaps, hydrateSwaps, persistPaymentBindings } from "../store/swaps";
import { verifyIncomingLock } from "./swapEngine";
import * as wallet from "./wallet";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { encryptedSwapStorage } from "./swapStorage";
import type { PayloadBody, SwapPayload } from "../protocol/payloads";

const customerSk = generateSecretKey();
const customer = getPublicKey(customerSk);
const agentSk = generateSecretKey();
const escrowSk = generateSecretKey();
const agent = getPublicKey(agentSk);
const escrow = getPublicKey(escrowSk);
const resolver = getPublicKey(generateSecretKey());
const hash = "aa".repeat(32);
let serial = 0;
function swap() {
  const root = finalizeEvent(rootTemplate({
    agent, customer, escrow, resolver, descriptorId: "bb".repeat(32),
    createdAt: 100 + serial++, expiresAt: 700,
    terms: { direction: "btc_to_fiat", fiat: { currency: "KES", amount: "100" },
      bitcoin: { unit: "sat", network: "spark", amount: "1000" }, payment_channel: "cash_ke_kes@2",
      deadlines: { fiat_pay_by: 4500, fiat_confirm_by: 10800 } },
  }), customerSk);
  useSwaps.getState().upsertRoot(root, agent);
  return root.id;
}
function message(id: string, body: PayloadBody) {
  useSwaps.getState().addInbox({ id: String(serial++), from: customer, to: agent, createdAt: 100,
    coordination: id, kind: "payload", payload: { v: 1, profile: SWAP_PROFILE, coordination: id,
      participants: [agent, customer], commitment_scheme: "sha256-bytes@1", ...body } as SwapPayload });
}
function announce(id: string, paymentHash = hash) {
  message(id, { type: "request", quote: "{}", private_terms: "{}", payment_hash: paymentHash });
  message(id, { type: "locked", payment_hash: paymentHash, amount: "1000", expires_at: 14400 });
}

beforeEach(async () => {
  await hydrateSwaps();
  useSwaps.getState().clear();
  jest.mocked(wallet.findHtlc).mockResolvedValue({ id: "single-payment", amountSats: 1000n,
    htlc: { paymentHash: hash, status: "waiting", expiresAt: 14400 } } as wallet.WalletTx);
});

it("allows only one swap to verify a shared HTLC concurrently and retains the binding after reload", async () => {
  const ids = [swap(), swap()];
  ids.forEach((id) => announce(id));
  const results = await Promise.all(ids.map(verifyIncomingLock));
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  const winner = ids[results.findIndex((r) => r.ok)];
  expect((await verifyIncomingLock(winner)).ok).toBe(true);
  const snapshot = jest.mocked(AsyncStorage.setItem).mock.calls.at(-1)![1];
  useSwaps.setState({ paymentBindings: {} });
  jest.mocked(AsyncStorage.getItem).mockResolvedValueOnce(snapshot);
  await useSwaps.persist.rehydrate();
  expect(useSwaps.getState().paymentBindings[hash].coordination).toBe(winner);
  expect((await verifyIncomingLock(ids.find((id) => id !== winner)!)).ok).toBe(false);
});

it("rejects unannounced and changed hashes without verifying the payment", async () => {
  const id = swap();
  message(id, { type: "locked", payment_hash: hash, amount: "1000", expires_at: 14400 });
  expect((await verifyIncomingLock(id)).ok).toBe(false);
  message(id, { type: "request", quote: "{}", private_terms: "{}", payment_hash: "dd".repeat(32) });
  expect((await verifyIncomingLock(id)).ok).toBe(false);
});

it("rejects a wallet transaction returned for another hash", async () => {
  const id = swap(); announce(id);
  const tx = await wallet.findHtlc(hash, "in");
  jest.mocked(wallet.findHtlc).mockResolvedValue({ ...tx!, htlc: { ...tx!.htlc!, paymentHash: "dd".repeat(32) } });
  expect((await verifyIncomingLock(id)).ok).toBe(false);
});

it("binds payment IDs across different hashes and refuses hash or ID replacement", () => {
  const first = swap(); const second = swap();
  const bind = useSwaps.getState().bindPayment;
  expect(bind(first, hash, "payment")).toBe(true);
  expect(bind(second, "dd".repeat(32), "payment")).toBe(false);
  expect(bind(first, hash, "replacement")).toBe(false);
  expect(bind(first, "dd".repeat(32), "new-payment")).toBe(false);
});

it.each([
  { amountSats: 999n },
  { htlc: { paymentHash: hash, status: "returned", expiresAt: 14400 } },
  { htlc: { paymentHash: hash, status: "waiting", expiresAt: 10000 } },
])("rejects unsafe locks %#", async (patch) => {
  const id = swap(); announce(id);
  const tx = await wallet.findHtlc(hash, "in");
  jest.mocked(wallet.findHtlc).mockResolvedValue({ ...tx!, ...patch } as wallet.WalletTx);
  expect((await verifyIncomingLock(id)).ok).toBe(false);
});

it("omits completed preimages from persisted snapshots", async () => {
  const id = swap();
  message(id, { type: "release", preimage: "ee".repeat(32) });
  useSwaps.getState().patchLocal(id, { claimedAt: 200 });
  await persistPaymentBindings();
  const written = jest.mocked(AsyncStorage.setItem).mock.calls.at(-1)![1];
  jest.mocked(AsyncStorage.getItem).mockResolvedValueOnce(written);
  const opened = await encryptedSwapStorage.getItem("pontmore.swaps");
  expect(opened).not.toContain("ee".repeat(32));
  expect(useSwaps.getState().records[id].inbox).toHaveLength(1);
});


it("refuses successful verification if its binding cannot be persisted", async () => {
  const id = swap(); announce(id);
  jest.mocked(AsyncStorage.setItem).mockRejectedValue(new Error("disk full"));
  try {
    await expect(verifyIncomingLock(id)).rejects.toThrow("disk full");
  } finally {
    jest.mocked(AsyncStorage.setItem).mockResolvedValue(undefined);
  }
});

it("refuses a changed announcement even when the original lock was already verified", async () => {
  const id = swap(); announce(id);
  expect((await verifyIncomingLock(id)).ok).toBe(true);
  message(id, { type: "request", quote: "{}", private_terms: "{}", payment_hash: "dd".repeat(32) });
  expect((await verifyIncomingLock(id)).ok).toBe(false);
});


it("does not reuse a legacy secured payment whose cache predates bindings", async () => {
  const legacy = swap(); announce(legacy);
  const accept = finalizeEvent(actionTemplate(legacy, legacy, "core/accept", undefined, [], 500), agentSk);
  const secure = finalizeEvent(actionTemplate(legacy, accept.id, "core/secure", undefined, [], 501), escrowSk);
  useSwaps.getState().addActions(legacy, [accept, secure]);
  const candidate = swap(); announce(candidate);
  expect((await verifyIncomingLock(candidate)).ok).toBe(false);
});
