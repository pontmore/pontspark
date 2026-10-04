/**
 * Breez SDK (Spark) wallet.
 *
 * Self-custodial: the BIP39 phrase is generated on the device, kept in the
 * keychain, and never leaves it. The same phrase derives the Nostr keys
 * (see lib/keys.ts), so one backup restores everything.
 */
import { Paths } from "expo-file-system";
import {
  connect as breezConnect,
  defaultConfig,
  InputType,
  Network,
  OnchainConfirmationSpeed,
  PaymentDetails,
  PaymentDetailsFilter,
  PaymentMethod,
  PaymentRequest,
  PaymentStatus,
  PaymentType,
  ReceivePaymentMethod,
  Seed,
  SendPaymentOptions,
  SparkHtlcStatus,
  type BreezSdkInterface,
  type LnurlPayRequestDetails,
  type Payment,
  type SdkEvent,
} from "@breeztech/breez-sdk-spark-react-native";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import { BREEZ_API_KEY, BREEZ_NETWORK } from "./config";
import { deleteSecret, getSecret, setSecret } from "./secure";
import { isValidMnemonic, newMnemonic, normaliseMnemonic } from "../lib/keys";

const MNEMONIC_KEY = "wallet.mnemonic";
const STORAGE_DIR = "breez-spark";

export class WalletConfigError extends Error {}

let sdk: BreezSdkInterface | null = null;
let connecting: Promise<BreezSdkInterface> | null = null;
let listenerId: string | null = null;
const listeners = new Set<(e: WalletEvent) => void>();

export type WalletEvent = { type: "synced" } | { type: "payment"; payment: WalletTx };

// -- seed --------------------------------------------------------------------

export async function storedMnemonic(): Promise<string | null> {
  return getSecret(MNEMONIC_KEY);
}

export async function createMnemonic(): Promise<string> {
  const m = newMnemonic();
  await setSecret(MNEMONIC_KEY, m);
  return m;
}

export async function restoreMnemonic(input: string): Promise<string> {
  const m = normaliseMnemonic(input);
  if (!isValidMnemonic(m)) throw new Error("That recovery phrase isn't valid. Check the words and their order.");
  await disconnect();
  await setSecret(MNEMONIC_KEY, m);
  return m;
}

export async function wipeWallet(): Promise<void> {
  await disconnect();
  await deleteSecret(MNEMONIC_KEY);
  try {
    const { Directory } = await import("expo-file-system");
    const dir = new Directory(Paths.document, STORAGE_DIR);
    if (dir.exists) dir.delete();
  } catch {
    // Storage is rebuilt from the seed on next connect.
  }
}

// -- connection --------------------------------------------------------------

function storageDir(): string {
  return `${Paths.document.uri.replace(/^file:\/\//, "").replace(/\/$/, "")}/${STORAGE_DIR}`;
}

export async function connect(): Promise<BreezSdkInterface> {
  if (sdk) return sdk;
  if (connecting) return connecting;
  if (!BREEZ_API_KEY) {
    throw new WalletConfigError("This build has no Breez API key. Set EXPO_PUBLIC_BREEZ_API_KEY and rebuild.");
  }
  const mnemonic = await storedMnemonic();
  if (!mnemonic) throw new Error("No wallet on this device yet");

  connecting = (async () => {
    const config = {
      ...defaultConfig(BREEZ_NETWORK === "regtest" ? Network.Regtest : Network.Mainnet),
      apiKey: BREEZ_API_KEY,
      // Spark-to-Spark keeps swaps and in-app transfers instant and cheap.
      preferSparkOverLightning: true,
    };
    const instance = await breezConnect({
      config,
      seed: new Seed.Mnemonic({ mnemonic, passphrase: undefined }),
      storageDir: storageDir(),
    });
    listenerId = await instance.addEventListener({
      onEvent: async (event: SdkEvent) => {
        const tagged = event as unknown as { tag?: string; inner?: { payment?: Payment } };
        if (tagged.inner?.payment) emit({ type: "payment", payment: toTx(tagged.inner.payment) });
        else if (tagged.tag === "Synced" || tagged.tag === "ClaimedDeposits") emit({ type: "synced" });
      },
    });
    sdk = instance;
    return instance;
  })();

  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

export async function disconnect(): Promise<void> {
  const instance = sdk;
  sdk = null;
  if (!instance) return;
  try {
    if (listenerId) await instance.removeEventListener(listenerId);
    await instance.disconnect();
  } catch {
    // Already gone.
  } finally {
    listenerId = null;
  }
}

function emit(e: WalletEvent) {
  listeners.forEach((l) => {
    try {
      l(e);
    } catch {
      // A broken listener must not stop the others.
    }
  });
}

export function onWalletEvent(listener: (e: WalletEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// -- balance, rates, history -------------------------------------------------

/** `synced` waits for the wallet to catch up first, e.g. before committing funds. */
export async function balanceSats(synced = false): Promise<bigint> {
  const s = await connect();
  const info = await s.getInfo({ ensureSynced: synced });
  return BigInt(info.balanceSats);
}

/** Market price of 1 BTC per fiat currency code, from Breez. */
export async function fiatRates(): Promise<Record<string, number>> {
  const s = await connect();
  const { rates } = await s.listFiatRates();
  return Object.fromEntries(rates.map((r) => [r.coin.toUpperCase(), r.value]));
}

export type TxKind = "lightning" | "spark" | "onchain" | "htlc" | "other";

export interface WalletTx {
  id: string;
  direction: "in" | "out";
  amountSats: bigint;
  feeSats: bigint;
  status: "complete" | "pending" | "failed";
  timestamp: number;
  kind: TxKind;
  description?: string;
  htlc?: { paymentHash: string; status: "waiting" | "released" | "returned"; expiresAt: number };
}

function htlcOf(p: Payment): WalletTx["htlc"] {
  const d = p.details;
  if (!d) return undefined;
  const details =
    PaymentDetails.Spark.instanceOf(d) || PaymentDetails.Lightning.instanceOf(d) ? d.inner.htlcDetails : undefined;
  if (!details) return undefined;
  return {
    paymentHash: details.paymentHash,
    status:
      details.status === SparkHtlcStatus.WaitingForPreimage
        ? "waiting"
        : details.status === SparkHtlcStatus.PreimageShared
          ? "released"
          : "returned",
    expiresAt: Number(details.expiryTime),
  };
}

export function toTx(p: Payment): WalletTx {
  const d = p.details;
  const isSpark = !!d && PaymentDetails.Spark.instanceOf(d);
  const htlc = isSpark ? htlcOf(p) : undefined;
  const kind: TxKind = htlc
    ? "htlc"
    : p.method === PaymentMethod.Lightning
      ? "lightning"
      : p.method === PaymentMethod.Spark
        ? "spark"
        : p.method === PaymentMethod.Deposit || p.method === PaymentMethod.Withdraw
          ? "onchain"
          : "other";
  const description = d && PaymentDetails.Lightning.instanceOf(d) ? d.inner.description : undefined;
  return {
    id: p.id,
    direction: p.paymentType === PaymentType.Send ? "out" : "in",
    amountSats: BigInt(p.amount),
    feeSats: BigInt(p.fees),
    status: p.status === PaymentStatus.Completed ? "complete" : p.status === PaymentStatus.Failed ? "failed" : "pending",
    timestamp: Number(p.timestamp),
    kind,
    description: description ?? undefined,
    htlc,
  };
}

export async function listTransactions(limit = 50): Promise<WalletTx[]> {
  const s = await connect();
  const { payments } = await s.listPayments({
    typeFilter: undefined,
    statusFilter: undefined,
    assetFilter: undefined,
    paymentDetailsFilter: undefined,
    fromTimestamp: undefined,
    toTimestamp: undefined,
    offset: undefined,
    limit,
    sortAscending: false,
  });
  return payments.map(toTx);
}

// -- receive -----------------------------------------------------------------

export async function receiveInvoice(amountSats: bigint | undefined, description: string): Promise<string> {
  const s = await connect();
  const res = await s.receivePayment({
    paymentMethod: new ReceivePaymentMethod.Bolt11Invoice({
      description,
      amountSats,
      expirySecs: undefined,
      paymentHash: undefined,
      receiverIdentityPublicKey: undefined,
    }),
  });
  return res.paymentRequest;
}

export async function sparkAddress(): Promise<string> {
  const s = await connect();
  const res = await s.receivePayment({ paymentMethod: new ReceivePaymentMethod.SparkAddress() });
  return res.paymentRequest;
}

export async function bitcoinAddress(): Promise<string> {
  const s = await connect();
  const res = await s.receivePayment({ paymentMethod: new ReceivePaymentMethod.BitcoinAddress({ newAddress: undefined }) });
  return res.paymentRequest;
}

export async function lightningAddress(): Promise<string | null> {
  const s = await connect();
  const info = await s.getLightningAddress();
  return info?.lightningAddress ?? null;
}

export async function claimLightningAddress(username: string): Promise<string> {
  const s = await connect();
  const clean = username.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,30}$/.test(clean)) throw new Error("Use 3–31 letters, numbers, dots or dashes.");
  const free = await s.checkLightningAddressAvailable({ username: clean });
  if (!free) throw new Error("That name is taken. Try another.");
  const info = await s.registerLightningAddress({ username: clean, description: "Pontspark wallet" });
  return info.lightningAddress;
}

// -- send --------------------------------------------------------------------

export type ParsedInput =
  | { type: "bolt11"; raw: string; amountSats?: bigint; description?: string }
  | { type: "lnurl"; raw: string; address?: string; payRequest: LnurlPayRequestDetails; minSats: bigint; maxSats: bigint }
  | { type: "onchain"; raw: string; address: string; amountSats?: bigint }
  | { type: "spark"; raw: string; address: string; amountSats?: bigint };

export async function parseInput(text: string): Promise<ParsedInput> {
  const s = await connect();
  const raw = text.trim().replace(/^lightning:/i, "");
  const input = await s.parse(raw);
  return fromInput(input, raw);
}

function fromInput(input: InputType, raw: string, amountHint?: bigint): ParsedInput {
  if (InputType.Bolt11Invoice.instanceOf(input)) {
    const d = input.inner[0];
    return {
      type: "bolt11",
      raw: d.invoice.bolt11,
      amountSats: d.amountMsat !== undefined ? BigInt(d.amountMsat) / 1000n : undefined,
      description: d.description ?? undefined,
    };
  }
  if (InputType.LightningAddress.instanceOf(input)) {
    const d = input.inner[0];
    return {
      type: "lnurl",
      raw,
      address: d.address,
      payRequest: d.payRequest,
      minSats: (BigInt(d.payRequest.minSendable) + 999n) / 1000n,
      maxSats: BigInt(d.payRequest.maxSendable) / 1000n,
    };
  }
  if (InputType.LnurlPay.instanceOf(input)) {
    const d = input.inner[0];
    return {
      type: "lnurl",
      raw,
      address: d.address ?? undefined,
      payRequest: d,
      minSats: (BigInt(d.minSendable) + 999n) / 1000n,
      maxSats: BigInt(d.maxSendable) / 1000n,
    };
  }
  if (InputType.BitcoinAddress.instanceOf(input)) {
    return { type: "onchain", raw, address: input.inner[0].address, amountSats: amountHint };
  }
  if (InputType.SparkAddress.instanceOf(input)) {
    return { type: "spark", raw, address: input.inner[0].address, amountSats: amountHint };
  }
  if (InputType.Bip21.instanceOf(input)) {
    const d = input.inner[0];
    const amount = d.amountSat !== undefined ? BigInt(d.amountSat) : undefined;
    // Prefer Lightning, then Spark, then on-chain from a unified QR.
    const order = [InputType.Bolt11Invoice, InputType.SparkAddress, InputType.BitcoinAddress] as const;
    for (const t of order) {
      const m = d.paymentMethods.find((pm) => t.instanceOf(pm));
      if (m) return fromInput(m, raw, amount);
    }
  }
  throw new Error("That doesn't look like something Pontspark can pay yet.");
}

export interface PreparedSend {
  amountSats: bigint;
  feeSats: bigint;
  send: () => Promise<WalletTx>;
}

export async function prepareSend(input: ParsedInput, amountSats?: bigint, comment?: string): Promise<PreparedSend> {
  const s = await connect();
  if (input.type === "lnurl") {
    if (!amountSats) throw new Error("Enter an amount");
    const prepared = await s.prepareLnurlPay({
      amount: amountSats,
      payRequest: input.payRequest,
      comment,
      validateSuccessActionUrl: undefined,
      tokenIdentifier: undefined,
      conversionOptions: undefined,
      feePolicy: undefined,
    });
    return {
      amountSats: BigInt(prepared.amountSats),
      feeSats: BigInt(prepared.feeSats),
      send: async () => {
        const res = await s.lnurlPay({ prepareResponse: prepared, idempotencyKey: undefined });
        return toTx(res.payment);
      },
    };
  }
  const amount = input.type === "bolt11" ? undefined : (amountSats ?? input.amountSats);
  if (input.type !== "bolt11" && !amount) throw new Error("Enter an amount");
  const prepared = await s.prepareSendPayment({
    paymentRequest: new PaymentRequest.Input({ input: input.type === "bolt11" ? input.raw : input.address }),
    amount,
    tokenIdentifier: undefined,
    conversionOptions: undefined,
    feePolicy: undefined,
  });
  const fee = estimateFee(prepared.paymentMethod);
  return {
    amountSats: BigInt(prepared.amount),
    feeSats: fee,
    send: async () => {
      const options =
        input.type === "onchain"
          ? new SendPaymentOptions.BitcoinAddress({ confirmationSpeed: OnchainConfirmationSpeed.Medium })
          : undefined;
      const res = await s.sendPayment({ prepareResponse: prepared, options, idempotencyKey: undefined });
      return toTx(res.payment);
    },
  };
}

/** Best-effort fee read from a prepared send; shapes differ per method. */
function estimateFee(method: unknown): bigint {
  const inner = (method as { inner?: Record<string, unknown> })?.inner ?? {};
  const candidates = [
    inner.sparkTransferFeeSats,
    inner.lightningFeeSats,
    inner.fee,
    (inner.feeQuote as { speedMedium?: { userFeeSat?: bigint; l1BroadcastFeeSat?: bigint } } | undefined)?.speedMedium
      ?.userFeeSat,
  ];
  for (const c of candidates) {
    if (typeof c === "bigint") return c;
    if (typeof c === "number") return BigInt(c);
  }
  const med = (inner.feeQuote as { speedMedium?: { userFeeSat?: bigint; l1BroadcastFeeSat?: bigint } } | undefined)
    ?.speedMedium;
  if (med) return BigInt(med.userFeeSat ?? 0n) + BigInt(med.l1BroadcastFeeSat ?? 0n);
  return 0n;
}

// -- HTLC escrow -------------------------------------------------------------

/** Deterministic UUID so a retried lock can never pay twice. */
export function idempotencyUuid(seed: string): string {
  const h = bytesToHex(sha256(utf8ToBytes(seed)));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export async function lockHtlc(params: {
  sparkAddress: string;
  amountSats: bigint;
  paymentHash: string;
  expirySecs: number;
  idempotencySeed: string;
}): Promise<WalletTx> {
  const s = await connect();
  const prepared = await s.prepareSendPayment({
    paymentRequest: new PaymentRequest.Input({ input: params.sparkAddress }),
    amount: params.amountSats,
    tokenIdentifier: undefined,
    conversionOptions: undefined,
    feePolicy: undefined,
  });
  const res = await s.sendPayment({
    prepareResponse: prepared,
    options: new SendPaymentOptions.SparkAddress({
      htlcOptions: { paymentHash: params.paymentHash, expiryDurationSecs: BigInt(Math.max(60, Math.floor(params.expirySecs))) },
    }),
    idempotencyKey: idempotencyUuid(params.idempotencySeed),
  });
  return toTx(res.payment);
}

export async function claimHtlc(preimage: string): Promise<WalletTx> {
  const s = await connect();
  const res = await s.claimHtlcPayment({ preimage });
  return toTx(res.payment);
}

/** Find our side of an HTLC by payment hash, sent or received. */
export async function findHtlc(paymentHash: string, direction: "in" | "out"): Promise<WalletTx | null> {
  const s = await connect();
  await s.syncWallet({}).catch(() => undefined);
  const { payments } = await s.listPayments({
    typeFilter: [direction === "in" ? PaymentType.Receive : PaymentType.Send],
    statusFilter: undefined,
    assetFilter: undefined,
    paymentDetailsFilter: [new PaymentDetailsFilter.Spark({ htlcStatus: undefined, conversionRefundNeeded: undefined })],
    fromTimestamp: undefined,
    toTimestamp: undefined,
    offset: undefined,
    limit: 200,
    sortAscending: false,
  });
  const match = payments.map(toTx).find((t) => t.htlc?.paymentHash === paymentHash);
  return match ?? null;
}
