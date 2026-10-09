import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { createSeal, createWrap } from "nostr-tools/nip59";
import { openWrap, parsePrivateTerms, wrapPayload } from "./payloads";
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
