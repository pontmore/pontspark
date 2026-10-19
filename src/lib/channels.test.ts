import { channelInfo, channelsForCurrency, CURRENCIES, currencyInfo, describeDetails, detailsComplete, validateDetails } from "./channels";

describe("channels", () => {
  it("uses versioned registry ids on the wire", () => {
    const ids = channelsForCurrency("KES").map((c) => c.id);
    expect(ids).toContain("mpesa_phone_ke_kes@2");
    expect(ids.every((id) => /^[a-z0-9_]+@\d+$/.test(id))).toBe(true);
  });

  it("resolves other schema revisions of a known channel", () => {
    expect(channelInfo("mpesa_phone_ke_kes@1").schema?.id).toBe("mpesa_phone_ke_kes");
    expect(channelInfo("mpesa_phone_ke_kes@1").id).toBe("mpesa_phone_ke_kes@2");
  });

  it("validates and normalizes details with the registry schema", () => {
    const check = validateDetails("mpesa_phone_ke_kes@2", { phoneNumber: "0712 345 678" });
    expect(check.valid).toBe(true);
    expect(check.data.phoneNumber).toBe("+254712345678");
    expect(detailsComplete("mpesa_phone_ke_kes@2", { phoneNumber: "12" })).toBe(false);
  });

  it("masks for display but copies the full value", () => {
    const [row] = describeDetails("mpesa_phone_ke_kes@2", { phoneNumber: "+254712345678" });
    expect(row.copyValue).toBe("+254712345678");
    expect(row.value).not.toBe("+254712345678");
  });

  it("needs no details for cash", () => {
    expect(detailsComplete("cash_ke_kes@2", {})).toBe(true);
  });

  it("falls back to free text for channels this build doesn't know", () => {
    const info = channelInfo("orange_money_sn_xof@1");
    expect(info.schema).toBeNull();
    expect(detailsComplete(info.id, { details: "pay +221 77 000 0000" })).toBe(true);
  });

  it("lists currencies with real payment rails first", () => {
    const rails = CURRENCIES.map((c) => channelsForCurrency(c.code).some((ch) => ch.group !== "cash"));
    expect(rails[0]).toBe(true);
    expect(rails.indexOf(false)).toBeGreaterThan(0);
    expect(rails.slice(rails.indexOf(false))).not.toContain(true);
    expect(CURRENCIES.find((c) => c.code === "KES")?.flag).toBe("🇰🇪");
  });

  it("names every registry currency and its country", () => {
    const unnamed = CURRENCIES.filter((c) => c.name === c.code || /^([A-Z]{2}|\d{3})$/.test(c.country));
    expect(unnamed.map((c) => c.code)).toEqual([]);
    expect(currencyInfo("KES")).toMatchObject({ name: "Kenyan Shilling", country: "Kenya", decimals: 0 });
  });

  it("shows shared currencies under their issuer or union", () => {
    expect(currencyInfo("ZAR")).toMatchObject({ country: "South Africa", flag: "🇿🇦" });
    expect(currencyInfo("EUR")).toMatchObject({ country: "European Union", flag: "🇪🇺" });
    expect(currencyInfo("XOF")).toMatchObject({ country: "Western Africa", flag: "🌍" });
  });

  it("uses ISO minor units", () => {
    expect(currencyInfo("JPY").decimals).toBe(0);
    expect(currencyInfo("KWD").decimals).toBe(3);
    expect(currencyInfo("EUR").decimals).toBe(2);
  });

  it("falls back to the code for currencies Intl can't name", () => {
    expect(currencyInfo("usdb")).toMatchObject({ name: "usdb", decimals: 2 });
  });
});
