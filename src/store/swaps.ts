/**
 * Local cache of swaps: the signed public events plus private inbox items.
 * The cache is an overlay; derived state always comes from replaying the
 * signed events (protocol/swap.ts).
 */
import type { Event } from "nostr-tools/pure";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { parseRoot, reconstruct, type SwapRoot, type SwapState } from "../protocol/swap";
import type { InboxItem, PayloadBody, SwapPayload } from "../protocol/payloads";
import { encryptedSwapStorage } from "../services/swapStorage";

export type SwapRole = "agent" | "customer";

export interface SwapLocal {
  quoteBytes?: string;
  privateTermsBytes?: string;
  counterpartyName?: string;
  /** Set before an HTLC lock is attempted; the lock itself is idempotent. */
  lockStartedAt?: number;
  lockTxId?: string;
  claimedAt?: number;
  releasedAt?: number;
  referenceText?: string;
  lastReadAt?: number;
  problems?: string[];
  lastError?: string;
  /** The completion animation already played for this swap. */
  celebratedAt?: number;
}

export interface SwapRecord {
  id: string;
  root: Event;
  actions: Event[];
  inbox: InboxItem[];
  role: SwapRole;
  local: SwapLocal;
  updatedAt: number;
}

interface SwapsState {
  records: Record<string, SwapRecord>;
  paymentBindings: Record<string, { coordination: string; paymentId?: string }>;
  bindPayment(rootId: string, hash: string, paymentId?: string): boolean;
  upsertRoot(root: Event, myPk: string): SwapRecord | null;
  addActions(rootId: string, events: Event[]): boolean;
  addInbox(item: InboxItem): boolean;
  patchLocal(rootId: string, patch: Partial<SwapLocal>): void;
  markRead(rootId: string): void;
  clear(): void;
}

export const useSwaps = create<SwapsState>()(
  persist(
    (set, get) => ({
      records: {},
      paymentBindings: {},

      bindPayment(rootId, hash, paymentId) {
        const s = get();
        if (!s.records[rootId] || !/^[0-9a-f]{64}$/.test(hash)) return false;
        const existing = s.paymentBindings[hash];
        if (existing && (existing.coordination !== rootId ||
            (existing.paymentId && paymentId && existing.paymentId !== paymentId))) return false;
        if (Object.entries(s.paymentBindings).some(([h, b]) =>
          (b.coordination === rootId && h !== hash) ||
          (paymentId && b.paymentId === paymentId && b.coordination !== rootId))) return false;
        // Old caches may already contain a secured lock without a binding.
        if (Object.values(s.records).some((r) => r.id !== rootId &&
            ((paymentId && r.local.lockTxId === paymentId) ||
             (swapState(r).chain.some((a) => a.action === "core/secure") &&
              r.inbox.some((i) => i.payload?.type === "locked" && i.payload.payment_hash === hash))))) return false;
        set({ paymentBindings: { ...s.paymentBindings, [hash]: { coordination: rootId, paymentId: paymentId ?? existing?.paymentId } } });
        return true;
      },

      upsertRoot(root, myPk) {
        const existing = get().records[root.id];
        if (existing) return existing;
        let parsed: SwapRoot;
        try {
          parsed = parseRoot(root);
        } catch {
          return null;
        }
        const role: SwapRole | null = parsed.agent === myPk ? "agent" : parsed.customer === myPk ? "customer" : null;
        if (!role) return null;
        const record: SwapRecord = { id: root.id, root, actions: [], inbox: [], role, local: {}, updatedAt: root.created_at };
        set((s) => ({ records: { ...s.records, [root.id]: record } }));
        return record;
      },

      addActions(rootId, events) {
        const rec = get().records[rootId];
        if (!rec) return false;
        const known = new Set(rec.actions.map((e) => e.id));
        const fresh = events.filter((e) => !known.has(e.id));
        if (!fresh.length) return false;
        const now = Math.floor(Date.now() / 1000);
        set((s) => ({
          records: { ...s.records, [rootId]: { ...rec, actions: [...rec.actions, ...fresh], updatedAt: now } },
        }));
        return true;
      },

      addInbox(item) {
        const rec = get().records[item.coordination];
        if (!rec || rec.inbox.some((i) => i.id === item.id)) return false;
        const inbox = [...rec.inbox, item].sort((a, b) => a.createdAt - b.createdAt);
        set((s) => ({
          records: { ...s.records, [rec.id]: { ...rec, inbox, updatedAt: Math.max(rec.updatedAt, item.createdAt) } },
        }));
        return true;
      },

      patchLocal(rootId, patch) {
        const rec = get().records[rootId];
        if (!rec) return;
        set((s) => ({ records: { ...s.records, [rootId]: { ...rec, local: { ...rec.local, ...patch } } } }));
      },

      markRead(rootId) {
        // Message times come from the sender's clock, which may run ahead of ours.
        const newest = Math.max(0, ...(get().records[rootId]?.inbox.map((i) => i.createdAt) ?? []));
        get().patchLocal(rootId, { lastReadAt: Math.max(Math.floor(Date.now() / 1000), newest) });
      },

      clear: () => set({ records: {}, paymentBindings: {} }),
    }),
    {
      name: "pontmore.swaps",
      storage: createJSONStorage(() => ({
        ...encryptedSwapStorage,
        // Zustand does not await background writes. Critical actions use the
        // explicit checkpoint below and propagate any storage failure.
        setItem: async (name, value) => {
          try { await encryptedSwapStorage.setItem(name, value); } catch { /* Retry on the next update. */ }
        },
      })),
      skipHydration: true,
      partialize: persistedSwaps,
    },
  ),
);

/** Providers derive their preimages; recipients retain them only until claiming. */
function persistedSwaps(s: SwapsState) {
  return {
    paymentBindings: s.paymentBindings,
    records: Object.fromEntries(Object.entries(s.records).map(([id, rec]) => [id, {
      ...rec,
      inbox: (rec.local.claimedAt || rec.local.releasedAt) ? rec.inbox.filter((i) => i.payload?.type !== "release") : rec.inbox,
    }])),
  };
}

let hydration: Promise<void> | undefined;
export function hydrateSwaps(): Promise<void> {
  return hydration ??= Promise.resolve(useSwaps.persist.rehydrate()).then(() => {
    if (!useSwaps.persist.hasHydrated()) throw new Error("Could not unlock the swap cache");
  }).catch((error: unknown) => {
    hydration = undefined;
    throw error;
  });
}

/** Money-related actions must wait until their binding is durable. */
export async function persistPaymentBindings(): Promise<void> {
  await encryptedSwapStorage.setItem("pontmore.swaps", JSON.stringify({ state: persistedSwaps(useSwaps.getState()), version: 0 }));
}

// -- derived ---------------------------------------------------------------

const cache = new WeakMap<Event[], SwapState>();
const rootCache = new Map<string, SwapRoot>();

export function swapState(rec: SwapRecord): SwapState {
  const hit = cache.get(rec.actions);
  if (hit) return hit;
  let root = rootCache.get(rec.id);
  if (!root) {
    root = parseRoot(rec.root, { verify: false }); // verified on ingest
    rootCache.set(rec.id, root);
  }
  const state = reconstruct(root, rec.actions, { verify: false }); // verified by the pool
  cache.set(rec.actions, state);
  return state;
}

export function payloadFrom<T extends PayloadBody["type"]>(
  rec: SwapRecord,
  from: string,
  type: T,
): (SwapPayload & { type: T }) | undefined {
  const items = rec.inbox.filter((i) => i.kind === "payload" && i.from === from && i.payload?.type === type);
  return items[items.length - 1]?.payload as (SwapPayload & { type: T }) | undefined;
}

export function chatOf(rec: SwapRecord): InboxItem[] {
  return rec.inbox.filter((i) => i.kind === "chat");
}

export function unreadCount(rec: SwapRecord, myPk: string): number {
  const since = rec.local.lastReadAt ?? 0;
  return rec.inbox.filter((i) => i.kind === "chat" && i.from !== myPk && i.createdAt > since).length;
}
