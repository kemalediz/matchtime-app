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
 *
 * Phase 5 adds the second half of that rule. `WA_DRIVER=baileys` is now a
 * real value, but ONLY together with `WA_SHADOW=1`. Baileys has never run
 * against a real WhatsApp group; the shadow week on a throwaway number is
 * what proves it. Until somebody edits this file, there is no
 * configuration in which a Baileys process can send.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { WaDriver } from "./driver.js";
import {
  BAILEYS_LIVE_ENV,
  baileysLiveBanner,
  createDriver,
  resolveBaileysLive,
  selectDriver,
} from "./driver-select.js";
import { SHADOW_ENV, resolveShadowMode, _test_resetShadow } from "./shadow.js";

const SHADOW_ON = { [SHADOW_ENV]: "1" };
const LIVE_ON = { WA_BAILEYS_LIVE: "1" };

beforeEach(() => {
  _test_resetShadow();
  delete process.env[SHADOW_ENV];
  delete process.env.WA_BAILEYS_LIVE;
});

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

  it("refuses baileys with NEITHER switch, and names both of them", () => {
    expect(() => selectDriver("baileys")).toThrow(/WA_SHADOW=1/);
    expect(() => selectDriver("baileys")).toThrow(/WA_BAILEYS_LIVE=1/);
    expect(() => selectDriver("  Baileys ")).toThrow(/WA_BAILEYS_LIVE=1/);
    expect(() => selectDriver("baileys", resolveShadowMode({}), false)).toThrow(/WA_BAILEYS_LIVE=1/);
    // It no longer claims groups are missing: they are built.
    expect(() => selectDriver("baileys")).not.toThrow(/cannot list its groups/);
  });

  it("accepts baileys WITH the explicit live switch and no shadow", () => {
    expect(selectDriver("baileys", resolveShadowMode({}), true)).toBe("baileys");
    expect(selectDriver("  BAILEYS ", resolveShadowMode({}), true)).toBe("baileys");
  });

  it("the live switch changes nothing for whatsapp-web.js or a typo", () => {
    expect(selectDriver(undefined, resolveShadowMode({}), true)).toBe("wwebjs");
    expect(() => selectDriver("wweb", resolveShadowMode({}), true)).toThrow(/not a known driver/);
  });

  it("accepts baileys WITH the shadow switch", () => {
    expect(selectDriver("baileys", resolveShadowMode(SHADOW_ON))).toBe("baileys");
    expect(selectDriver("  BAILEYS ", resolveShadowMode(SHADOW_ON))).toBe("baileys");
  });

  it("refuses a typo instead of defaulting", () => {
    expect(() => selectDriver("wweb")).toThrow(/not a known driver/);
    expect(() => selectDriver("whatsapp-web.js")).toThrow(/not a known driver/);
    expect(() => selectDriver("wweb", resolveShadowMode(SHADOW_ON))).toThrow(/not a known driver/);
  });
});

// ── What createDriver actually builds ───────────────────────────────

/** Only the two members these tests touch; everything else is absent. */
function stubDriver(name: string): WaDriver {
  const sent: string[] = [];
  return {
    name,
    sent,
    sendText: async (chatId: string, text: string) => {
      sent.push(`${chatId}:${text}`);
      return { id: { _serialized: "x" } };
    },
  } as unknown as WaDriver;
}

function factories() {
  const built: string[] = [];
  return {
    built,
    wwebjs: () => {
      built.push("wwebjs");
      return stubDriver("whatsapp-web.js");
    },
    baileys: async () => {
      built.push("baileys");
      return stubDriver("baileys");
    },
  };
}

describe("createDriver", () => {
  it("builds whatsapp-web.js and does NOT wrap it when shadow mode is off", async () => {
    const f = factories();
    const driver = await createDriver({}, f);
    expect(f.built).toEqual(["wwebjs"]);
    expect(driver.name).toBe("whatsapp-web.js");
    // No guard means the raw driver, which is the point: today's Pi is
    // untouched by any of this, and a send goes straight through.
    expect((driver as unknown as { shadowGuarded?: boolean }).shadowGuarded).toBeUndefined();
    await driver.sendText("120363@g.us", "hello");
    expect((driver as unknown as { sent: string[] }).sent).toEqual(["120363@g.us:hello"]);
  });

  it("never even constructs the Baileys driver with neither switch", async () => {
    const f = factories();
    await expect(createDriver({ WA_DRIVER: "baileys" }, f)).rejects.toThrow(/WA_BAILEYS_LIVE/);
    await expect(createDriver({ WA_DRIVER: "baileys", WA_BAILEYS_LIVE: "0" }, f)).rejects.toThrow(
      /WA_BAILEYS_LIVE/,
    );
    expect(f.built).toEqual([]);
  });

  it("builds Baileys LIVE with WA_BAILEYS_LIVE=1: UNGUARDED, so a send goes through", async () => {
    const f = factories();
    const driver = await createDriver({ WA_DRIVER: "baileys", ...LIVE_ON }, f);
    expect(f.built).toEqual(["baileys"]);
    expect(driver.name).toBe("baileys");
    expect((driver as unknown as { shadowGuarded?: boolean }).shadowGuarded).toBeUndefined();
    await driver.sendText("120363@g.us", "hello");
    expect((driver as unknown as { sent: string[] }).sent).toEqual(["120363@g.us:hello"]);
  });

  it("shadow WINS over the live switch: both set means guarded, sends refused", async () => {
    const f = factories();
    const driver = await createDriver({ WA_DRIVER: "baileys", ...SHADOW_ON, ...LIVE_ON }, f);
    expect(f.built).toEqual(["baileys"]);
    expect((driver as unknown as { shadowGuarded?: boolean }).shadowGuarded).toBe(true);
    await expect(driver.sendText("120363@g.us", "hello")).rejects.toThrow(/shadow mode/i);
  });

  it("refuses a WA_BAILEYS_LIVE typo instead of guessing", async () => {
    const f = factories();
    await expect(createDriver({ WA_DRIVER: "baileys", WA_BAILEYS_LIVE: "yes please" }, f)).rejects.toThrow(
      /WA_BAILEYS_LIVE/,
    );
    expect(f.built).toEqual([]);
  });

  it("builds Baileys in shadow mode, and hands back a GUARDED driver", async () => {
    const f = factories();
    const driver = await createDriver({ WA_DRIVER: "baileys", ...SHADOW_ON }, f);
    expect(f.built).toEqual(["baileys"]);
    expect(driver.name).toBe("baileys");
    expect((driver as unknown as { shadowGuarded?: boolean }).shadowGuarded).toBe(true);
    await expect(driver.sendText("120363@g.us", "hello")).rejects.toThrow(/shadow mode/i);
  });

  it("guards whatsapp-web.js too when shadow mode is on, because the mode is the mode", async () => {
    const f = factories();
    const driver = await createDriver({ ...SHADOW_ON }, f);
    expect(f.built).toEqual(["wwebjs"]);
    await expect(driver.sendText("120363@g.us", "hello")).rejects.toThrow(/shadow mode/i);
  });
});

// ── WA_BAILEYS_LIVE and the startup banner ──────────────────────────

describe("resolveBaileysLive", () => {
  it("is off when unset, blank or a no", () => {
    expect(BAILEYS_LIVE_ENV).toBe("WA_BAILEYS_LIVE");
    expect(resolveBaileysLive({})).toBe(false);
    expect(resolveBaileysLive({ WA_BAILEYS_LIVE: "  " })).toBe(false);
    for (const v of ["0", "false", "no", "off", "OFF"]) expect(resolveBaileysLive({ WA_BAILEYS_LIVE: v })).toBe(false);
  });

  it("is on for a yes", () => {
    for (const v of ["1", "true", "yes", "on", " TRUE "]) expect(resolveBaileysLive({ WA_BAILEYS_LIVE: v })).toBe(true);
  });

  it("throws on anything else", () => {
    expect(() => resolveBaileysLive({ WA_BAILEYS_LIVE: "2" })).toThrow(/WA_BAILEYS_LIVE/);
  });
});

describe("baileysLiveBanner", () => {
  const off = resolveShadowMode({});
  const on = resolveShadowMode(SHADOW_ON);

  it("says, unmistakably, that a live Baileys run SENDS", () => {
    const banner = baileysLiveBanner("baileys", off, LIVE_ON);
    expect(banner).toMatch(/Baileys LIVE: sends ENABLED/);
    expect(banner).toMatch(/WA_BAILEYS_LIVE/);
    expect(banner).not.toMatch(/SHADOW MODE IS ON/);
  });

  it("says the live switch is IGNORED when shadow is on too", () => {
    const banner = baileysLiveBanner("baileys", on, LIVE_ON);
    expect(banner).toMatch(/IGNORED/);
    expect(banner).toMatch(/WA_SHADOW/);
    expect(banner).not.toMatch(/sends ENABLED/);
  });

  it("says nothing for whatsapp-web.js, or for a shadow run that did not ask for live", () => {
    expect(baileysLiveBanner("whatsapp-web.js", off, {})).toBeNull();
    expect(baileysLiveBanner("whatsapp-web.js", off, LIVE_ON)).toBeNull();
    expect(baileysLiveBanner("baileys", on, {})).toBeNull();
  });
});
