jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(), setItem: jest.fn(), removeItem: jest.fn(),
}));
jest.mock("./secure", () => ({ getSecret: jest.fn(), setSecret: jest.fn() }));

import AsyncStorage from "@react-native-async-storage/async-storage";
import { getSecret, setSecret } from "./secure";
import { encryptedSwapStorage as storage } from "./swapStorage";

let disk: Record<string, string>;
let secret: string | null;
beforeEach(() => {
  disk = {};
  secret = null;
  jest.mocked(AsyncStorage.getItem).mockImplementation(async (k) => disk[k] ?? null);
  jest.mocked(AsyncStorage.setItem).mockImplementation(async (k, v) => { disk[k] = v; });
  jest.mocked(getSecret).mockImplementation(async () => secret);
  jest.mocked(setSecret).mockImplementation(async (_k, v) => { secret = v; });
});

it("encrypts large private snapshots, serializes writes and reopens with the protected key", async () => {
  const value = JSON.stringify({ preimage: "secret-preimage", details: "private-phone", chat: "💚".repeat(40000) });
  await Promise.all([storage.setItem("swaps", "old"), storage.setItem("swaps", value)]);
  expect(disk.swaps).not.toContain("secret-preimage");
  expect(disk.swaps).not.toContain("private-phone");
  expect(await storage.getItem("swaps")).toBe(value);
  expect(secret).toMatch(/^[0-9a-f]{64}$/);
});

it("migrates legacy plaintext before returning it", async () => {
  const value = JSON.stringify({ state: { inbox: [{ preimage: "legacy-secret" }] } });
  disk.swaps = value;
  expect(await storage.getItem("swaps")).toBe(value);
  expect(disk.swaps).toMatch(/^encrypted-v1:/);
  expect(disk.swaps).not.toContain("legacy-secret");
});

it("fails closed on tampering, copying to another key, or missing device key", async () => {
  await storage.setItem("swaps", "private");
  disk.other = disk.swaps;
  await expect(storage.getItem("other")).rejects.toThrow();
  const original = disk.swaps;
  disk.swaps = original.slice(0, 25) + (original[25] === "A" ? "B" : "A") + original.slice(26);
  await expect(storage.getItem("swaps")).rejects.toThrow();
  disk.swaps = original;
  disk.swaps = JSON.stringify({ state: {} });
  await expect(storage.getItem("swaps")).rejects.toThrow(/downgrade/);
  disk.swaps = original;
  secret = null;
  await expect(storage.getItem("swaps")).rejects.toThrow(/unavailable/);
});

it("does not write plaintext when protected key creation fails", async () => {
  jest.mocked(setSecret).mockRejectedValueOnce(new Error("locked device"));
  await expect(storage.setItem("swaps", "private")).rejects.toThrow("locked device");
  expect(disk.swaps).toBeUndefined();
});
