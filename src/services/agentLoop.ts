/**
 * Keeps an online agent's offers fresh. Offers expire on their own, so a
 * phone that dies simply drops out of discovery within SWAP_TIMING.offerLifetime.
 */
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";

import { ensureDescriptor, publishIdentity, publishOffers, retractOffers } from "./agentPublisher";
import { useAgent } from "../store/agent";
import { requireKeys, useSession } from "../store/session";
import { useWallet } from "../store/wallet";

const REFRESH_MS = 10 * 60 * 1000;
const KEEP_AWAKE_TAG = "pontmore-agent";
let timer: ReturnType<typeof setInterval> | null = null;

async function publishNow(withIdentity: boolean): Promise<void> {
  const keys = requireKeys();
  const wallet = useWallet.getState();
  if (wallet.status !== "ready") await wallet.start();
  await Promise.all([useWallet.getState().refresh(), useWallet.getState().refreshRates()]);
  const { rates, balance, lightningAddress } = useWallet.getState();
  const { markets } = useAgent.getState();
  const missing = markets.filter((m) => !rates[m.currency]).map((m) => m.currency);
  if (missing.length === markets.length) throw new Error("Market prices are unavailable right now");

  await ensureDescriptor(keys);
  if (withIdentity) {
    const { profile, relays } = useSession.getState();
    await publishIdentity(keys, { ...profile, lud16: lightningAddress }, relays);
  }
  const count = await publishOffers(keys, markets, rates, balance ?? 0, useSession.getState().profile.name);
  if (count === 0) throw new Error("Nothing to offer yet. Add payment details, or bitcoin to sell.");
  useAgent.getState().setPublished(Math.floor(Date.now() / 1000), null);
}

function startLoop() {
  stopLoop();
  timer = setInterval(() => {
    publishNow(false).catch((e: Error) => useAgent.getState().setPublished(useAgent.getState().lastPublishedAt, e.message));
  }, REFRESH_MS);
  void activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => undefined);
}

function stopLoop() {
  if (timer) clearInterval(timer);
  timer = null;
  void deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => undefined);
}

export async function setAgentOnline(online: boolean): Promise<void> {
  const agent = useAgent.getState();
  if (online) {
    await publishNow(true);
    agent.setOnline(true);
    startLoop();
    return;
  }
  stopLoop();
  agent.setOnline(false);
  const keys = requireKeys();
  await retractOffers(keys, agent.markets);
}

/** Called at startup: resume publishing if the agent was online. */
export function resumeAgent(): void {
  const { online, configured } = useAgent.getState();
  if (!online || !configured || useSession.getState().mode !== "agent") return;
  publishNow(true).catch((e: Error) => useAgent.getState().setPublished(null, e.message));
  startLoop();
}

export function suspendAgent(): void {
  stopLoop();
}
