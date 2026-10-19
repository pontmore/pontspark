import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { createRumor, createSeal, createWrap } from "nostr-tools/nip59";
import { openWrap, parsePaymentReference, parsePrivateTerms, paymentReferenceBytes, wrapChat, wrapPayload } from "./payloads";
import { KIND } from "./constants";

const sender = generateSecretKey();
const recipient = generateSecretKey();
const from = getPublicKey(sender);
const to = getPublicKey(recipient);
const root = "aa".repeat(32);

it.each([null, {}, [null], [["e", root], ["p", 42]]])("rejects malformed encrypted rumor tags %j without throwing", (tags) => {
  const rumor = { id: "bb".repeat(32), pubkey: from, kind: KIND.chat, created_at: 100, content: "hi", tags };
  const wrap = createWrap(createSeal(rumor as never, sender, to), to);
  expect(openWrap(wrap, recipient)).toBeNull();
});

it.each([
  { type: "release", preimage: null },
  { type: "release", preimage: "00" },
  { type: "locked", payment_hash: "aa".repeat(32), amount: {}, expires_at: 100 },
  { type: "locked", payment_hash: "aa".repeat(32), amount: "1", expires_at: "100" },
  { type: "declined", reasons: [null] },
  { type: "request", quote: "{}", private_terms: "null" },
  { type: "accept", payment: { channel: "x", details: { phone: 42 } } },
])("rejects malformed encrypted payload %j", (body) => {
  const [wrap] = wrapPayload(sender, from, to, root, [from, to], body as never);
  expect(openWrap(wrap, recipient)).toBeNull();
});

it("requires the commitment scheme and both participants", () => {
  const [wrap] = wrapPayload(sender, from, to, root, [from], { type: "claimed" });
  expect(openWrap(wrap, recipient)).toBeNull();
  expect(parsePrivateTerms('{"payout":{"channel":"x","details":null}}')).toBeNull();
});

it("signs rumors so the recipient can show them to a third party", () => {
  const [toThem, toMe] = wrapChat(sender, from, to, root, "paid from 0712");
  const item = openWrap(toThem, recipient);
  expect(item?.event).toMatchObject({ pubkey: from, content: "paid from 0712" });
  expect(verifyEvent(item!.event!)).toBe(true);
  // Both copies carry the same signed rumor.
  expect(openWrap(toMe, sender)?.event?.id).toBe(item!.event!.id);
});

it("rejects unsigned and tampered rumors", () => {
  const unsigned = createRumor({ kind: KIND.chat, content: "hi", tags: [["p", to], ["e", root, "", "root"]] }, sender);
  expect(openWrap(createWrap(createSeal(unsigned, sender, to), to), recipient)).toBeNull();
  const signed = finalizeEvent({ kind: KIND.chat, created_at: 100, content: "hi", tags: [["p", to], ["e", root, "", "root"]] }, sender);
  const tampered = { ...signed, content: "bye" };
  expect(openWrap(createWrap(createSeal(tampered as never, sender, to), to), recipient)).toBeNull();
  expect(openWrap(createWrap(createSeal(signed as never, sender, to), to), recipient)?.text).toBe("hi");
});

it("commits the declared paying account with the reference", () => {
  expect(parsePaymentReference(paymentReferenceBytes(root, " QJK3 ", " 0712 345678 "))).toEqual({ reference: "QJK3", payer: "0712 345678" });
  expect(parsePaymentReference(paymentReferenceBytes(root, "QJK3", "  "))).toEqual({ reference: "QJK3" });
  expect(parsePaymentReference('{"reference":1}')).toBeNull();
});
