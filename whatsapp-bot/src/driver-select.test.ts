/**
 * `WA_DRIVER` is the rollback, so it has to be boring and loud.
 *
 * Boring: unset means whatsapp-web.js, which is what the Pi has always
 * run, so merging Phase 2 changes nothing about how the bot starts.
 *
 * Loud: an unrecognised value throws. On the cutover morning (plan
 * Phase 6) somebody sets this variable on a Pi over SSH before a fixture,
 * and "it started fine" must not be able to mean "it started fine on the
 * library you were trying to leave".
 */
import { describe, it, expect } from "vitest";
import { selectDriver } from "./driver-select.js";

describe("selectDriver", () => {
  it("defaults to whatsapp-web.js when WA_DRIVER is unset or blank", () => {
    expect(selectDriver(undefined)).toBe("wwebjs");
    expect(selectDriver("")).toBe("wwebjs");
    expect(selectDriver("   ")).toBe("wwebjs");
  });

  it("accepts wwebjs however it is cased or padded", () => {
    expect(selectDriver("wwebjs")).toBe("wwebjs");
    expect(selectDriver("  WWebJS  ")).toBe("wwebjs");
  });

  it("refuses baileys with the reason, rather than silently running wwebjs", () => {
    // Phase 3 built the Baileys driver's OUTBOUND half only. With no
    // lifecycle, inbound or group wiring, a bot that came up on it could
    // not hear anybody, and deaf looks like healthy. It stays unselectable
    // until those land.
    expect(() => selectDriver("baileys")).toThrow(/outbound half only/);
    expect(() => selectDriver("  Baileys ")).toThrow(/outbound half only/);
  });

  it("refuses a typo instead of defaulting", () => {
    expect(() => selectDriver("wweb")).toThrow(/not a known driver/);
    expect(() => selectDriver("whatsapp-web.js")).toThrow(/not a known driver/);
  });
});
