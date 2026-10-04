/**
 * DEV ONLY: drive wallet primitives from adb to probe escrow options, e.g.
 *   adb shell am start -a android.intent.action.VIEW -d "pontmore://devprobe/hodl?amount=20" xyz.pontmore.pontspark.dev
 * Results are logged to Metro as "[probe] ...".
 */
import * as Linking from "expo-linking";
import { PaymentRequest, PaymentType, ReceivePaymentMethod } from "@breeztech/breez-sdk-spark-react-native";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import { errorText } from "../lib/errors";
import { celebrate } from "../ui/celebrate";
import { connect } from "./wallet";

const PREIMAGE = "11".repeat(32);
const HASH = bytesToHex(sha256(hexToBytes(PREIMAGE)));
const log = (...a: unknown[]) => console.log("[probe]", ...a.map((x) => (typeof x === "string" ? x : JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v)))));

async function run(url: string) {
  const { path, queryParams } = Linking.parse(url);
  const q = (k: string) => String(queryParams?.[k] ?? "");
  const s = await connect();
  try {
    switch (path) {
      case "hodl": {
        const res = await s.receivePayment({
          paymentMethod: new ReceivePaymentMethod.Bolt11Invoice({
            description: "pontspark escrow probe",
            amountSats: BigInt(q("amount") || "20"),
            expirySecs: 3600,
            paymentHash: q("hash") || HASH,
            receiverIdentityPublicKey: undefined,
          }),
        });
        log("hodl invoice", res.paymentRequest);
        break;
      }
      case "pay": {
        const prepared = await s.prepareSendPayment({
          paymentRequest: new PaymentRequest.Input({ input: q("bolt11") }),
          amount: undefined,
          tokenIdentifier: undefined,
          conversionOptions: undefined,
          feePolicy: undefined,
        });
        log("prepared", prepared.paymentMethod?.tag, "fee", (prepared as unknown as { paymentMethod: { inner: unknown } }).paymentMethod?.inner);
        const res = await s.sendPayment({ prepareResponse: prepared, options: undefined, idempotencyKey: undefined });
        log("paid", res.payment);
        break;
      }
      case "list": {
        const { payments } = await s.listPayments({
          typeFilter: q("type") === "send" ? [PaymentType.Send] : q("type") === "receive" ? [PaymentType.Receive] : undefined,
          statusFilter: undefined,
          assetFilter: undefined,
          paymentDetailsFilter: undefined,
          fromTimestamp: undefined,
          toTimestamp: undefined,
          offset: undefined,
          limit: Number(q("limit") || "5"),
          sortAscending: false,
        });
        payments.forEach((p) => log("payment", p));
        break;
      }
      case "claim": {
        const res = await s.claimHtlcPayment({ preimage: q("preimage") || PREIMAGE });
        log("claimed", res.payment);
        break;
      }
      case "celebrate":
        celebrate({ fiatCode: "KES", amountLabel: q("amount") || "+176 sats", caption: q("caption") || "Bought from robotop for KES 20" });
        break;
      default:
        log("unknown probe", path);
    }
  } catch (e) {
    log("FAILED", path, errorText(e));
  }
}

export function installDevProbe() {
  if (!__DEV__) return;
  Linking.addEventListener("url", ({ url }) => {
    if (url.includes("devprobe/")) void run(url);
  });
  log("ready; hash", HASH);
}
