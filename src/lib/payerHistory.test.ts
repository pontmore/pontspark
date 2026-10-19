import { normalizePayer, payerKey, payerSignal } from "./payerHistory";

const secret = new Uint8Array(32).fill(7);
const customer = "ab".repeat(32);

it("treats formatting differences as the same account", () => {
  expect(normalizePayer(" +254 (712) 345-678 ")).toBe("254712345678");
  expect(payerKey(secret, customer, "mpesa_phone_ke_kes@2", "+254 712 345678"))
    .toBe(payerKey(secret, customer, "mpesa_phone_ke_kes@3", "254712345678"));
});

it("never stores the account in readable form", () => {
  const key = payerKey(secret, customer, "mpesa_phone_ke_kes@2", "0712345678");
  expect(key).not.toContain("0712345678");
  expect(key).not.toBe(payerKey(new Uint8Array(32).fill(8), customer, "mpesa_phone_ke_kes@2", "0712345678"));
});

it("reports history for the account and counts the customer's other accounts", () => {
  const known = payerKey(secret, customer, "mpesa_phone_ke_kes@2", "0712345678");
  const other = payerKey(secret, customer, "mpesa_phone_ke_kes@2", "0799999999");
  const elsewhere = payerKey(secret, "cd".repeat(32), "mpesa_phone_ke_kes@2", "0711111111");
  const history = { [known]: { swaps: 3, firstAt: 10, lastAt: 30 }, [other]: { swaps: 1, firstAt: 5, lastAt: 5 }, [elsewhere]: { swaps: 9, firstAt: 1, lastAt: 9 } };
  expect(payerSignal(history, known, customer, "mpesa_phone_ke_kes@2", "0712345678")).toEqual({ payer: "0712345678", account: history[known], otherAccounts: 1 });
  const fresh = payerKey(secret, customer, "mpesa_phone_ke_kes@2", "0700000000");
  expect(payerSignal(history, fresh, customer, "mpesa_phone_ke_kes@2", "0700000000")).toEqual({ payer: "0700000000", account: undefined, otherAccounts: 2 });
});
