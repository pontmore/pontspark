import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { BREEZ_NETWORK } from "../services/config";
import { discoverAgents, fetchAgent, type AgentListing } from "../services/discovery";
import { useSession } from "./session";
import { checkLimits, isOfferLive, offerSide, type Offer } from "../protocol/offer";
import type { Direction } from "../protocol/swap";
import type { ChannelDetails } from "../lib/channels";

interface DiscoveryState {
  byCurrency: Record<string, { listings: AgentListing[]; at: number }>;
  agents: Record<string, AgentListing>;
  loading: boolean;
  error: string | null;
  load(currency: string, force?: boolean): Promise<AgentListing[]>;
  loadAgent(pk: string): Promise<AgentListing | null>;
}

const FRESH_MS = 60_000;

export const useDiscovery = create<DiscoveryState>()((set, get) => ({
  byCurrency: {},
  agents: {},
  loading: false,
  error: null,

  async load(currency, force) {
    const cached = get().byCurrency[currency];
    if (!force && cached && Date.now() - cached.at < FRESH_MS) return cached.listings;
    set({ loading: true, error: null });
    try {
      // Our own agent offer (from agent mode on this identity) isn't someone to swap with.
      const me = useSession.getState().keys?.identity.pk;
      const listings = (await discoverAgents(BREEZ_NETWORK, currency)).filter((l) => l.pk !== me);
      set((s) => ({
        byCurrency: { ...s.byCurrency, [currency]: { listings, at: Date.now() } },
        agents: { ...s.agents, ...Object.fromEntries(listings.map((l) => [l.pk, l])) },
        loading: false,
      }));
      return listings;
    } catch (e) {
      set({ loading: false, error: (e as Error).message });
      return cached?.listings ?? [];
    }
  },

  async loadAgent(pk) {
    const listing = await fetchAgent(BREEZ_NETWORK, pk);
    if (listing) set((s) => ({ agents: { ...s.agents, [pk]: listing } }));
    return listing;
  },
}));

export interface Match {
  listing: AgentListing;
  offer: Offer;
}

/** Best live offer for a direction and amount: cheapest to buy, richest to sell. */
export function rankOffers(listings: AgentListing[], currency: string, direction: Direction, amount?: string): Match[] {
  const out: Match[] = [];
  for (const listing of listings) {
    for (const offer of listing.offers) {
      if (offer.currency !== currency || !isOfferLive(offer) || !offerSide(offer, direction)) continue;
      if (amount && Number(amount) > 0 && checkLimits(offer, direction, amount) !== "ok") continue;
      out.push({ listing, offer });
    }
  }
  return out.sort((a, b) => {
    const pa = Number(offerSide(a.offer, direction)!.price);
    const pb = Number(offerSide(b.offer, direction)!.price);
    return direction === "fiat_to_btc" ? pa - pb : pb - pa;
  });
}

/** Remembered payout details for selling, per channel. Stays on the device. */
export const usePayouts = create<{ saved: Record<string, ChannelDetails>; save(channel: string, d: ChannelDetails): void }>()(
  persist(
    (set) => ({
      saved: {},
      save: (channel, d) => set((s) => ({ saved: { ...s.saved, [channel]: d } })),
    }),
    { name: "pontmore.payouts", storage: createJSONStorage(() => AsyncStorage) },
  ),
);
