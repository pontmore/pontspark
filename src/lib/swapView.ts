/**
 * Plain-language presentation of a swap for whoever is holding the phone.
 */
import { channelInfo } from "./channels";
import { formatDecimal, formatSats } from "./money";
import type { SwapRecord } from "../store/swaps";
import { fiatSender, type SwapState } from "../protocol/swap";
import type { Tone } from "../ui/components";

export const STEPS = ["Requested", "Accepted", "Bitcoin locked", "Payment sent", "Payment confirmed", "Complete"];

const STEP_OF: Record<string, number> = {
  proposed: 0,
  accepted: 1,
  secured: 2,
  fiat_sent: 3,
  fiat_confirmed: 4,
  settlement_authorized: 4,
  refund_authorized: 2,
  settled: 5,
  refunded: 5,
  declined: 0,
  cancelled: 1,
  expired: 0,
};

export type MyAction = "accept" | "pay" | "confirm" | "resolve" | null;

export interface SwapView {
  title: string;
  headline: string;
  detail: string;
  tone: Tone;
  step: number;
  myTurn: boolean;
  action: MyAction;
  fiatLabel: string;
  satsLabel: string;
  done: boolean;
}

export function fiatLabel(st: SwapState): string {
  return `${st.root.terms.fiat.currency} ${formatDecimal(st.root.terms.fiat.amount, 0)}`;
}

export function describeSwap(rec: SwapRecord, st: SwapState, me: string, now = Math.floor(Date.now() / 1000)): SwapView {
  const { root } = st;
  const buying = root.terms.direction === "fiat_to_btc"; // from the customer's side
  const isAgent = rec.role === "agent";
  const iPayFiat = fiatSender(root) === me;
  const fiat = fiatLabel(st);
  const sats = formatSats(root.terms.bitcoin.amount);
  const channel = channelInfo(root.terms.payment_channel).short;
  const cash = channelInfo(root.terms.payment_channel).fields.length === 0;
  const them = rec.local.counterpartyName || (isAgent ? "the customer" : "the agent");
  const title = isAgent
    ? buying
      ? `Sell ${sats} for ${fiat}`
      : `Buy ${sats} for ${fiat}`
    : buying
      ? `Buy bitcoin with ${fiat}`
      : `Sell bitcoin for ${fiat}`;

  const v = (headline: string, detail: string, tone: Tone, myTurn = false, action: MyAction = null): SwapView => ({
    title,
    headline,
    detail,
    tone,
    step: STEP_OF[st.status] ?? 0,
    myTurn,
    action,
    fiatLabel: fiat,
    satsLabel: sats,
    done: ["settled", "refunded", "declined", "cancelled", "expired"].includes(st.status),
  });

  if (st.forked) return v("Frozen", "Two conflicting updates were published. Funds stay locked until the lock expires.", "danger");
  if (st.disputed) {
    return v(
      "In dispute",
      isAgent ? "Review the conversation and resolve it." : "Progress is paused. Talk to the agent in chat.",
      "danger",
      isAgent,
      isAgent ? "resolve" : null,
    );
  }

  switch (st.status) {
    case "proposed":
      if (now >= root.expiresAt) return v("Request expired", `${capital(them)} didn't respond in time.`, "neutral");
      if (isAgent) {
        if (rec.local.problems?.length) return v("Can't take this one", rec.local.problems[0], "danger");
        return v("New request", `${fiat} via ${channel}. Accept to start.`, "accent", true, "accept");
      }
      return v("Waiting for the agent", "Agents usually reply within a minute.", "info");
    case "accepted":
      if (iPayFiat) return v("Locking bitcoin", `${capital(them)} is locking ${sats} for you.`, "info");
      return v("Locking your bitcoin", `Your ${sats} are being locked so ${them} can pay safely.`, "info");
    case "secured":
      if (iPayFiat) {
        if (now >= root.terms.deadlines.fiat_pay_by) return v("Payment window closed", "The locked bitcoin will return to its owner.", "warning");
        return cash
          ? v(`Hand over ${fiat}`, `Give ${them} ${fiat} in cash, then tell us it's done.`, "accent", true, "pay")
          : v(`Send ${fiat}`, `Pay ${them} via ${channel}, then tell us it's done.`, "accent", true, "pay");
      }
      return cash
        ? v(`Waiting for ${fiat}`, `${capital(them)} will hand you ${fiat} in cash.`, "info")
        : v(`Waiting for ${fiat}`, `${capital(them)} is sending you ${fiat} via ${channel}.`, "info");
    case "fiat_sent":
      if (iPayFiat) return v("Waiting for confirmation", `${capital(them)} is checking for your ${fiat}.`, "info");
      return cash
        ? v(`Collect ${fiat}`, `${capital(them)} says they paid ${fiat} in cash. Confirm only once you have it.`, "accent", true, "confirm")
        : v(`Check your ${channel}`, `${capital(them)} says they sent ${fiat}. Confirm only once it's in your account.`, "accent", true, "confirm");
    case "fiat_confirmed":
    case "settlement_authorized":
      return v("Releasing bitcoin", iPayFiat ? `Your ${sats} are on the way.` : "Bitcoin is being released.", "info");
    case "settled":
      return v("Complete", iPayFiat ? `You received ${sats}.` : `You received ${fiat}.`, "success");
    case "refund_authorized":
      return v("Refunding", "The locked bitcoin goes back to its owner when the lock expires.", "warning");
    case "refunded":
      return v("Refunded", "The bitcoin went back to its owner.", "neutral");
    case "declined":
      return v("Declined", isAgent ? "You declined this request." : `${capital(them)} couldn't take this swap. Try another agent.`, "neutral");
    case "cancelled":
      return v("Cancelled", "This swap was cancelled.", "neutral");
    case "expired":
      return v("Expired", "Nobody accepted this request in time.", "neutral");
  }
}

/** "the agent" -> "The agent", but people's chosen names stay as they wrote them. */
function capital(s: string) {
  return s.startsWith("the ") ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

export function shortPk(pk: string) {
  return `${pk.slice(0, 6)}…${pk.slice(-4)}`;
}

export function timeAgo(ts: number, now = Math.floor(Date.now() / 1000)): string {
  const d = Math.max(0, now - ts);
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

export function countdown(until: number, now = Math.floor(Date.now() / 1000)): string {
  const d = until - now;
  if (d <= 0) return "now";
  const h = Math.floor(d / 3600);
  const m = Math.floor((d % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m ${d % 60}s`;
}
