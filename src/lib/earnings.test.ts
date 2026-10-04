import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";

import { earningsIn, swapProfit } from "./earnings";
import { offerTemplate, serializeOffer } from "../protocol/offer.test-helpers";

const sk = generateSecretKey();

function swap(premium: string, fiat: string, settled: number | null, currency = "KES") {
  const offer = finalizeEvent(offerTemplate(premium), sk);
  const st = {
    status: settled === null ? "secured" : "settled",
    root: { terms: { fiat: { currency, amount: fiat } } },
    chain: settled === null ? [] : [{ action: "core/settle", createdAt: settled }],
  };
  const rec = { role: "agent", local: { quoteBytes: serializeOffer(offer) } };
  return { rec, st } as never as { rec: Parameters<typeof swapProfit>[0]; st: Parameters<typeof swapProfit>[1] };
}

describe("agent earnings", () => {
  it("earns the margin on both sides", () => {
    const sell = swap("2", "102", 1);
    expect(swapProfit(sell.rec, sell.st)).toBeCloseTo(2, 6);
    const buy = swap("-2", "98", 1);
    expect(swapProfit(buy.rec, buy.st)).toBeCloseTo(2, 6);
    const open = swap("2", "102", null);
    expect(swapProfit(open.rec, open.st)).toBeNull();
  });

  it("totals today, this week and a streak", () => {
    const now = Math.floor(new Date(2026, 9, 7, 12).getTime() / 1000); // Wednesday
    const day = 86400;
    const items = [
      swap("2", "102", now - 60), // today
      swap("2", "102", now - day), // Tuesday
      swap("2", "102", now - 2 * day), // Monday
      swap("2", "102", now - 4 * day), // last Saturday: breaks the streak, not this week
      swap("2", "102", now - 60, "USD"),
    ];
    const e = earningsIn(items, "KES", now);
    expect(e.today).toBeCloseTo(2);
    expect(e.swapsToday).toBe(1);
    expect(e.week).toBeCloseTo(6);
    expect(e.total).toBeCloseTo(8);
    expect(e.streakDays).toBe(3);
  });
});
