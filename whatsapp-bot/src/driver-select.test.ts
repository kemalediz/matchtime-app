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
    // Phase 4 gave the Baileys driver groups, participants, joins, leaves
    // and poll votes, so it is no longer blind to its own groups. It is
    // still unselectable: nothing in it has run against a real WhatsApp
    // group (the Phase 5 shadow run), the restart replay does not exist
    // yet, and the phone gate has not been measured on Sutton's group.
    // Making it selectable is Kemal's decision, not a side effect of a PR.
    expect(() => selectDriver("baileys")).toThrow(/Phase 5/);
    expect(() => selectDriver("baileys")).toThrow(/shadow run/);
    expect(() => selectDriver("baileys")).toThrow(/phone gate/);
    expect(() => selectDriver("  Baileys ")).toThrow(/not available yet/);
    // It no longer claims groups are missing: they are built.
    expect(() => selectDriver("baileys")).not.toThrow(/cannot list its groups/);
  });

  it("refuses a typo instead of defaulting", () => {
    expect(() => selectDriver("wweb")).toThrow(/not a known driver/);
    expect(() => selectDriver("whatsapp-web.js")).toThrow(/not a known driver/);
  });
});
