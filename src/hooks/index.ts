import { useEffect, useMemo, useState } from "react";

import { settledAt, swapProfit } from "../lib/earnings";
import { formatDecimal, formatFiat, formatSats } from "../lib/money";
import { currencyInfo } from "../lib/channels";
import { bitcoinProvider, isTerminal } from "../protocol/swap";
import { useSession } from "../store/session";
import { swapState, useSwaps, type SwapRecord } from "../store/swaps";
import { useWallet } from "../store/wallet";
import { celebrate } from "../ui/celebrate";
import type { SwapState } from "../protocol/swap";

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export interface SwapItem {
  rec: SwapRecord;
  st: SwapState;
}

export function useSwapList(filter?: (i: SwapItem) => boolean): SwapItem[] {
  const records = useSwaps((s) => s.records);
  return useMemo(() => {
    const items: SwapItem[] = [];
    for (const rec of Object.values(records)) {
      try {
        items.push({ rec, st: swapState(rec) });
      } catch {
        // Unparseable cached root; ignore.
      }
    }
    items.sort((a, b) => b.rec.updatedAt - a.rec.updatedAt);
    return filter ? items.filter(filter) : items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records]);
}

export function useActiveSwaps(role?: "agent" | "customer"): SwapItem[] {
  const now = useNow(15000);
  const all = useSwapList();
  return useMemo(
    () =>
      all.filter(
        (i) =>
          (!role || i.rec.role === role) &&
          !isTerminal(i.st) &&
          !(i.st.status === "proposed" && now >= i.st.root.expiresAt),
      ),
    [all, role, now],
  );
}

export function useSwap(id: string): SwapItem | null {
  const rec = useSwaps((s) => s.records[id]);
  return useMemo(() => {
    if (!rec) return null;
    try {
      return { rec, st: swapState(rec) };
    } catch {
      return null;
    }
  }, [rec]);
}

/** Format sats in the user's display currency, if a rate is known. */
export function useFiatOf(): (sats: number | bigint) => string | null {
  const currency = useSession((s) => s.currency);
  const rate = useWallet((s) => s.rates[currency]);
  return (sats) => {
    if (!rate) return null;
    const info = currencyInfo(currency);
    return formatFiat((Number(sats) / 1e8) * rate, currency, info.decimals);
  };
}

export function useMe(): string {
  return useSession((s) => s.keys?.identity.pk ?? "");
}

/**
 * Celebrate each swap the moment it completes, on whatever screen the person
 * is: once per swap, and only for swaps that finished in the last 15 minutes
 * (not ones that arrive later from relays or a restore).
 */
export function useCelebrateFinishedSwaps() {
  const me = useMe();
  const records = useSwaps((s) => s.records);
  useEffect(() => {
    if (!me) return;
    const now = Math.floor(Date.now() / 1000);
    for (const rec of Object.values(records)) {
      if (rec.local.celebratedAt) continue;
      let st: SwapState;
      try {
        st = swapState(rec);
      } catch {
        continue;
      }
      if (st.status !== "settled") continue;
      useSwaps.getState().patchLocal(rec.id, { celebratedAt: now });
      const at = settledAt(st);
      if (at === null || now - at > 15 * 60) continue;
      const getsBitcoin = bitcoinProvider(st.root) !== me;
      const fiat = `${st.root.terms.fiat.currency} ${formatDecimal(st.root.terms.fiat.amount, 0)}`;
      const sats = formatSats(st.root.terms.bitcoin.amount);
      const them = rec.local.counterpartyName || (rec.role === "agent" ? "the customer" : "the agent");
      const profit = swapProfit(rec, st);
      celebrate({
        fiatCode: st.root.terms.fiat.currency,
        amountLabel: getsBitcoin ? `+${sats}` : `+${fiat}`,
        caption:
          profit !== null
            ? `You earned ≈ ${st.root.terms.fiat.currency} ${profit.toFixed(2)}`
            : getsBitcoin
              ? `Bought from ${them} for ${fiat}`
              : `Sold ${sats} to ${them}`,
      });
      return; // one at a time
    }
  }, [records, me]);
}
