/** Test-only: a minimal valid KES offer template with a given premium. */
import { offerTemplate as template } from "./events";
import { escrowAddress } from "./constants";

export { serializeOffer } from "./offer";

export function offerTemplate(premium: string) {
  return template({
    direction: premium.startsWith("-") ? "btc_to_fiat" : "fiat_to_btc",
    currency: "KES",
    channels: ["cash_ke_kes@2"],
    channelLabels: ["Cash"],
    network: "mainnet",
    layer: "spark",
    price: "11000000",
    min: "1",
    max: "100",
    premium,
    escrow: escrowAddress("ab".repeat(32)),
    resolver: "cd".repeat(32),
    expires_at: 2_000_000_000,
    status: "pending",
  });
}
