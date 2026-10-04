/**
 * What an agent made on its swaps. An agent's margin is the gap between its
 * quoted price and the market price it was built from (the offer's signed
 * `premium`), so the profit on a swap of F fiat is F·|p|/(100+p): selling
 * bitcoin at +2% earns F − F/1.02, buying at −2% earns F/0.98 − F.
 * Network fees (a few sats) aren't included.
 */
import type { Event } from "nostr-tools/pure";

import { parseOffer } from "../protocol/offer";
import type { SwapState } from "../protocol/swap";
import type { SwapRecord } from "../store/swaps";

export function swapProfit(rec: SwapRecord, st: SwapState): number | null {
  if (rec.role !== "agent" || st.status !== "settled" || !rec.local.quoteBytes) return null;
  let premium: number;
  try {
    premium = Number(parseOffer(JSON.parse(rec.local.quoteBytes) as Event, { verify: false }).premium);
  } catch {
    return null;
  }
  const fiat = Number(st.root.terms.fiat.amount);
  if (!Number.isFinite(premium) || premium <= -100 || !Number.isFinite(fiat)) return null;
  return Math.abs(fiat - fiat / (1 + premium / 100));
}

export function settledAt(st: SwapState): number | null {
  return st.chain.find((a) => a.action === "core/settle")?.createdAt ?? null;
}

export interface Earnings {
  currency: string;
  today: number;
  week: number;
  total: number;
  swapsToday: number;
  /** Consecutive days, ending today or yesterday, with at least one completed swap. */
  streakDays: number;
}

const DAY = 86400;

function dayIndex(ts: number): number {
  const d = new Date(ts * 1000);
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000 / DAY);
}

/** Earnings in one currency; `now` in unix seconds. Weeks start on Monday. */
export function earningsIn(items: { rec: SwapRecord; st: SwapState }[], currency: string, now: number): Earnings {
  const today = dayIndex(now);
  const weekday = (new Date(now * 1000).getDay() + 6) % 7;
  const out: Earnings = { currency, today: 0, week: 0, total: 0, swapsToday: 0, streakDays: 0 };
  const days = new Set<number>();
  for (const { rec, st } of items) {
    const at = settledAt(st);
    if (at === null || st.root.terms.fiat.currency !== currency) continue;
    const profit = swapProfit(rec, st) ?? 0;
    const day = dayIndex(at);
    days.add(day);
    out.total += profit;
    if (day > today - weekday - 1) out.week += profit;
    if (day === today) {
      out.today += profit;
      out.swapsToday += 1;
    }
  }
  let d = days.has(today) ? today : today - 1;
  while (days.has(d)) {
    out.streakDays += 1;
    d -= 1;
  }
  return out;
}
