/**
 * Fiat currencies and payment channels, from the open
 * `@minmoto/payment-channels` registry.
 *
 * The registry owns each channel's identity, fields, validation, masking and
 * instructions. This module adds Pontmore policy on top: which channel groups
 * may carry a swap, the versioned wire id, and display metadata for
 * currencies.
 *
 * A channel's wire id (`<registry id>@<schema version>`, e.g.
 * `mpesa_phone_ke_kes@2`) is what goes public in `terms.payment_channel`;
 * pontmore/swap@1 requires it to be versioned. The detail values — phone
 * numbers, account numbers — only ever travel inside gift-wrapped payloads.
 */
import {
  PaymentChannelGroup,
  PaymentFieldType,
  createPaymentChannelRegistry,
  getPaymentChannelSchema,
  listPaymentChannelSchemas,
  renderDetailRows,
  validatePaymentChannelData,
  type PaymentChannelField,
  type PaymentChannelSchema,
  type ValidationIssue,
} from "@minmoto/payment-channels";

export type CurrencyCode = string;

/** Payment details for one channel, keyed by the schema's field keys. */
export type ChannelDetails = Record<string, string>;

const registry = createPaymentChannelRegistry();

/**
 * Pontmore policy: every swap is settled by people confirming a payment
 * themselves, so any mobile money, bank or cash channel can carry one. Card
 * channels can be charged back after the bitcoin is released, so they never
 * can. A schema's `automation` mode is irrelevant here: no provider API is
 * called.
 */
const SWAP_GROUPS = new Set<string>([PaymentChannelGroup.MobileMoney, PaymentChannelGroup.Bank, PaymentChannelGroup.Cash]);

const allowed = (s: PaymentChannelSchema) => SWAP_GROUPS.has(s.display.group);

// -- channels ----------------------------------------------------------------

export interface PaymentChannel {
  /** Versioned wire id. */
  id: string;
  label: string;
  /** Short name used on chips. */
  short: string;
  description: string;
  group: string;
  currency: CurrencyCode | null;
  fields: readonly PaymentChannelField[];
  /** What the payer records as proof of payment. */
  referenceLabel: string;
  referenceRequired: boolean;
  payerInstructions: readonly string[];
  /** The registry schema, or null for a channel this build doesn't know. */
  schema: PaymentChannelSchema | null;
}

export const wireId = (s: PaymentChannelSchema) => `${s.id}@${s.version}`;

/** Registry id of a wire id. Other schema revisions of the same id still resolve. */
function registryId(id: string): string {
  return id.replace(/@\d+$/, "");
}

function schemaFor(id: string): PaymentChannelSchema | null {
  const schema = getPaymentChannelSchema(registry, registryId(id) as Lowercase<string>);
  return schema && allowed(schema) ? schema : null;
}

const GENERIC_FIELD: PaymentChannelField = {
  key: "details",
  label: "Payment details",
  type: PaymentFieldType.Text,
  required: true,
};

export function channelInfo(id: string): PaymentChannel {
  const schema = schemaFor(id);
  if (!schema) {
    const name = registryId(id);
    return {
      id,
      label: name,
      short: name,
      description: "",
      group: "",
      currency: null,
      fields: [GENERIC_FIELD],
      referenceLabel: "Reference",
      referenceRequired: true,
      payerInstructions: [],
      schema: null,
    };
  }
  const evidence = schema.evidence?.[0];
  return {
    id: wireId(schema),
    label: schema.display.label,
    short: schema.display.shortLabel,
    description: schema.display.description,
    group: schema.display.group,
    currency: schema.network.currency,
    fields: schema.fields,
    referenceLabel: evidence?.label ?? "Reference",
    referenceRequired: evidence?.required ?? false,
    // The registry's cash copy ("keep local receipt evidence") reads like a form.
    payerInstructions: schema.fields.length ? (schema.instructions?.payer ?? []) : ["Meet in person and hand over the exact amount. Agree where in the chat."],
    schema,
  };
}

export function channelsForCurrency(code: CurrencyCode): PaymentChannel[] {
  return listPaymentChannelSchemas(registry, { currency: code as Uppercase<string> })
    .filter(allowed)
    .map((s) => channelInfo(wireId(s)));
}

/** True when `id` names a channel this build can collect and validate details for. */
export function isKnownChannel(id: string): boolean {
  return schemaFor(id) !== null;
}

// -- details -----------------------------------------------------------------

export interface DetailsCheck {
  valid: boolean;
  /** Normalized values; use these, not the raw input. */
  data: ChannelDetails;
  issues: ValidationIssue[];
}

export function validateDetails(channelId: string, details: ChannelDetails | undefined): DetailsCheck {
  const schema = schemaFor(channelId);
  if (schema) return validatePaymentChannelData(schema, details ?? {});
  const value = (details?.[GENERIC_FIELD.key] ?? "").trim();
  return value
    ? { valid: true, data: { [GENERIC_FIELD.key]: value }, issues: [] }
    : { valid: false, data: {}, issues: [{ field: GENERIC_FIELD.key, message: "Payment details are required" }] };
}

export function detailsComplete(channelId: string, details: ChannelDetails | undefined): boolean {
  return details !== undefined && validateDetails(channelId, details).valid;
}

export interface DetailLine {
  label: string;
  /** Masked where the schema says so. */
  value: string;
  /** Unmasked, for an explicit copy action; absent when the row isn't copyable. */
  copyValue?: string;
}

/**
 * Rows to show for a counterparty's payment details. Details from another
 * client are validated against this build's schema; whatever doesn't match is
 * still shown as plain rows so the payer is never left without instructions.
 */
export function describeDetails(channelId: string, details: ChannelDetails): DetailLine[] {
  const schema = schemaFor(channelId);
  if (!schema) {
    return Object.entries(details)
      .filter(([, v]) => v)
      .map(([k, v]) => ({ label: k === GENERIC_FIELD.key ? GENERIC_FIELD.label : k, value: v, copyValue: v }));
  }
  const { data } = validatePaymentChannelData(schema, details);
  const rows: DetailLine[] = renderDetailRows(schema, data)
    .filter((r) => r.value)
    .map((r) => ({ label: r.label, value: r.value, copyValue: r.copyValue }));
  const shown = new Set(schema.detailRows.flatMap((r) => r.fields));
  for (const f of schema.fields) {
    if (!shown.has(f.key) && data[f.key]) rows.push({ label: f.label, value: data[f.key] });
  }
  for (const [k, v] of Object.entries(details)) {
    if (v && !schema.fields.some((f) => f.key === k)) rows.push({ label: k, value: v });
  }
  return rows;
}

// -- currencies --------------------------------------------------------------

export interface CurrencyInfo {
  code: CurrencyCode;
  name: string;
  country: string;
  flag: string;
  /** Digits shown after the decimal point. */
  decimals: number;
}

/** Display names; the registry carries only codes. */
const NAMES: Record<string, string> = {
  AOA: "Angolan Kwanza",
  BIF: "Burundian Franc",
  BWP: "Botswana Pula",
  DZD: "Algerian Dinar",
  EGP: "Egyptian Pound",
  ETB: "Ethiopian Birr",
  GBP: "British Pound",
  INR: "Indian Rupee",
  KES: "Kenyan Shilling",
  LSL: "Lesotho Loti",
  LYD: "Libyan Dinar",
  MAD: "Moroccan Dirham",
  MUR: "Mauritian Rupee",
  MWK: "Malawian Kwacha",
  MZN: "Mozambican Metical",
  NAD: "Namibian Dollar",
  NGN: "Nigerian Naira",
  PKR: "Pakistani Rupee",
  RWF: "Rwandan Franc",
  SDG: "Sudanese Pound",
  SSP: "South Sudanese Pound",
  SZL: "Swazi Lilangeni",
  TND: "Tunisian Dinar",
  TZS: "Tanzanian Shilling",
  UGX: "Ugandan Shilling",
  USD: "US Dollar",
  ZAR: "South African Rand",
  ZMW: "Zambian Kwacha",
};

const COUNTRIES: Record<string, string> = {
  AO: "Angola", BI: "Burundi", BW: "Botswana", DZ: "Algeria", EG: "Egypt", ET: "Ethiopia",
  GB: "United Kingdom", IN: "India", KE: "Kenya", LS: "Lesotho", LY: "Libya", MA: "Morocco",
  MU: "Mauritius", MW: "Malawi", MZ: "Mozambique", NA: "Namibia", NG: "Nigeria", PK: "Pakistan",
  RW: "Rwanda", SD: "Sudan", SS: "South Sudan", SZ: "Eswatini", TN: "Tunisia", TZ: "Tanzania",
  UG: "Uganda", US: "United States", ZA: "South Africa", ZM: "Zambia",
};

/** Currencies whose minor units aren't used day to day. */
const WHOLE_UNITS = new Set(["BIF", "KES", "MWK", "NGN", "RWF", "TZS", "UGX"]);

function flagOf(country: string): string {
  if (!/^[A-Z]{2}$/.test(country)) return "🏳️";
  return String.fromCodePoint(...[...country].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

function buildCurrencies(): CurrencyInfo[] {
  const byCode = new Map<string, CurrencyInfo>();
  for (const s of registry.values()) {
    if (!allowed(s) || byCode.has(s.network.currency)) continue;
    const { currency: code, country } = s.network;
    byCode.set(code, {
      code,
      name: NAMES[code] ?? code,
      country: COUNTRIES[country] ?? country,
      flag: flagOf(country),
      decimals: WHOLE_UNITS.has(code) ? 0 : 2,
    });
  }
  // Currencies with real payment rails first, then cash-only ones.
  const rails = (code: string) => channelsForCurrency(code).some((c) => c.group !== PaymentChannelGroup.Cash);
  return [...byCode.values()].sort((a, b) => Number(rails(b.code)) - Number(rails(a.code)) || a.name.localeCompare(b.name));
}

/** Every currency at least one allowed registry channel settles in. */
export const CURRENCIES: CurrencyInfo[] = buildCurrencies();

export function currencyInfo(code: CurrencyCode): CurrencyInfo {
  return (
    CURRENCIES.find((c) => c.code === code) ?? {
      code,
      name: NAMES[code] ?? code,
      country: "",
      flag: "🏳️",
      decimals: WHOLE_UNITS.has(code) ? 0 : 2,
    }
  );
}
