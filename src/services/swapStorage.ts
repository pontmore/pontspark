import AsyncStorage from "@react-native-async-storage/async-storage";
import { randomBytes, bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { encrypt, decrypt } from "nostr-tools/nip44";
import type { StateStorage } from "zustand/middleware";

import { getSecret, setSecret } from "./secure";

const KEY = "swaps.cache-key.v1";
const PREFIX = "encrypted-v1:";
let queue: Promise<unknown> = Promise.resolve();

// Serialize key creation, migration and writes so an older snapshot cannot win.
function serialized<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work);
  queue = next.catch(() => undefined);
  return next;
}

async function key(): Promise<Uint8Array> {
  const stored = await getSecret(KEY);
  if (stored !== null) {
    if (!/^[0-9a-f]{64}$/.test(stored)) throw new Error("Invalid swap cache key");
    return hexToBytes(stored);
  }
  const fresh = randomBytes(32);
  await setSecret(KEY, bytesToHex(fresh));
  return fresh;
}

async function seal(name: string, value: string): Promise<string> {
  return PREFIX + encrypt(JSON.stringify({ name, value }), await key());
}

export const encryptedSwapStorage: StateStorage = {
  getItem: (name) => serialized(async () => {
    const value = await AsyncStorage.getItem(name);
    if (value === null) return null;
    if (!value.startsWith(PREFIX)) {
      if (await getSecret(KEY)) throw new Error("Refusing plaintext downgrade of the swap cache");
      // Upgrade in place before exposing any legacy plaintext to the store.
      JSON.parse(value);
      await AsyncStorage.setItem(name, await seal(name, value));
      return value;
    }
    const storedKey = await getSecret(KEY);
    if (!storedKey) throw new Error("Swap cache key is unavailable");
    const opened = JSON.parse(decrypt(value.slice(PREFIX.length), hexToBytes(storedKey)));
    if (opened.name !== name || typeof opened.value !== "string") throw new Error("Invalid swap cache envelope");
    return opened.value;
  }),
  setItem: (name, value) => serialized(async () => {
    await AsyncStorage.setItem(name, await seal(name, value));
  }),
  removeItem: (name) => serialized(() => AsyncStorage.removeItem(name)),
};
