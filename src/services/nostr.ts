/**
 * Relay access. One pool for the app; every event that reaches application
 * logic has had its signature verified by the pool.
 */
import { SimplePool } from "nostr-tools/pool";
import { finalizeEvent, type Event, type EventTemplate } from "nostr-tools/pure";
import type { Filter } from "nostr-tools/filter";

let pool: SimplePool | null = null;
let relays: string[] = [];

export function setRelays(urls: string[]) {
  relays = [...new Set(urls)];
}

export function getRelays(): string[] {
  return relays;
}

function p(): SimplePool {
  if (!pool) {
    pool = new SimplePool({ enablePing: true, enableReconnect: true });
  }
  return pool;
}

export function sign(template: EventTemplate, sk: Uint8Array): Event {
  return finalizeEvent(template, sk);
}

/**
 * Publish to all relays; resolves when at least one accepts. Relays that
 * missed it get it again in the background, so e.g. withdrawn offers don't
 * linger on one relay for half an hour.
 */
export async function publish(event: Event): Promise<Event> {
  if (!relays.length) throw new Error("No relays configured");
  const targets = [...relays];
  const results = await Promise.allSettled(p().publish(targets, event, { maxWait: 8000 }));
  if (!results.some((r) => r.status === "fulfilled")) {
    const reason = results.map((r) => (r.status === "rejected" ? String(r.reason) : "")).find(Boolean);
    throw new Error(`No relay accepted the event${reason ? `: ${reason}` : ""}`);
  }
  const missed = targets.filter((_, i) => results[i].status === "rejected");
  if (missed.length) retryPublish(event, missed, 1);
  return event;
}

const RETRY_DELAYS = [5_000, 30_000, 120_000];

function retryPublish(event: Event, urls: string[], attempt: number) {
  setTimeout(async () => {
    const results = await Promise.allSettled(p().publish(urls, event, { maxWait: 8000 }));
    const still = urls.filter((_, i) => results[i].status === "rejected");
    if (still.length && attempt < RETRY_DELAYS.length) retryPublish(event, still, attempt + 1);
  }, RETRY_DELAYS[attempt - 1]);
}

export async function publishAll(events: Event[]): Promise<void> {
  await Promise.all(events.map(publish));
}

export async function query(filter: Filter, maxWait = 5000): Promise<Event[]> {
  if (!relays.length) return [];
  return p().querySync(relays, filter, { maxWait });
}

/** Latest replaceable/addressable event per (pubkey, d) from a result set. */
export function latestByAddress(events: Event[]): Event[] {
  const best = new Map<string, Event>();
  for (const e of events) {
    const d = e.tags.find((t) => t[0] === "d")?.[1] ?? "";
    const key = `${e.kind}:${e.pubkey}:${d}`;
    const cur = best.get(key);
    // NIP-01: newest wins; ties break on lowest id.
    if (!cur || e.created_at > cur.created_at || (e.created_at === cur.created_at && e.id < cur.id)) best.set(key, e);
  }
  return [...best.values()];
}

/**
 * Live subscription that survives dropped connections. nostr-tools reconnects
 * a relay whose socket closes, but when an open socket *errors* (common on
 * Android after a network change or with the screen off) it drops the relay
 * and closes its subscriptions for good. Without this, an agent stays
 * "online" while no request ever reaches it.
 */
/**
 * Live subscription that survives dropped connections. nostr-tools reconnects
 * a relay whose socket closes, but when an open socket *errors* (common on
 * Android after a network change or with the screen off) it drops the relay
 * and closes its subscriptions for good. Without this, an agent stays
 * "online" while no request ever reaches it. Each relay is subscribed on its
 * own so one dead relay recovers even while the others are fine.
 */
export function subscribe(filters: Filter[], onEvent: (e: Event) => void, onEose?: () => void): () => void {
  if (!relays.length) return () => undefined;
  let stopped = false;
  let eosePending = relays.length;
  const seen = new Set<string>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const closers = new Map<string, () => void>();

  const deliver = (e: Event) => {
    if (seen.has(e.id)) return;
    seen.add(e.id);
    onEvent(e);
  };

  const open = (url: string, f: Filter, key: string, attempt: number) => {
    let eosed = false;
    const sub = p().subscribeMany([url], f, {
      onevent: deliver,
      oneose: () => {
        if (!eosed && attempt === 0 && key.endsWith("#0") && --eosePending === 0) onEose?.();
        eosed = true;
      },
      onclose: (reasons) => {
        if (stopped) return;
        // e.g. relay.damus.io serves gift wraps only after NIP-42 AUTH, which it
        // doesn't support; asking again won't change that.
        if (reasons.some((r) => r.reason.includes("auth-required:"))) return;
        if (__DEV__) console.warn("[nostr] subscription dropped, reopening", url, JSON.stringify(f), JSON.stringify(reasons));
        const next = eosed ? 1 : attempt + 1;
        const timer = setTimeout(() => {
          timers.delete(timer);
          if (!stopped) closers.set(key, open(url, f, key, next));
        }, Math.min(60_000, 1_000 * 2 ** next));
        timers.add(timer);
      },
    });
    return () => sub.close();
  };

  for (const url of relays) filters.forEach((f, i) => closers.set(`${url}#${i}`, open(url, f, `${url}#${i}`, 0)));
  return () => {
    stopped = true;
    timers.forEach(clearTimeout);
    closers.forEach((close) => close());
  };
}

export function relayStatus(): Map<string, boolean> {
  return pool ? pool.listConnectionStatus() : new Map();
}

export function resetPool() {
  pool?.destroy();
  pool = null;
}
