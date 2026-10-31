/**
 * QUIET HOURS BY WHATSAPP (2026-10-31, MT Test: "@Match Time turn off quiet
 * hours now" got "I can't change that by message"). The admin extractor
 * reads the words into `quietOff`, `quietFrom` and `quietTo`; this maps
 * those facts onto the one save core (`saveQuietHours`, which the settings
 * page uses too) and says what was set, in the club's language.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ findUnique: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { organisation: { findUnique: h.findUnique } } }));
vi.mock("@/lib/quiet-hours-save", () => ({ saveQuietHours: h.save }));

import { applyQuietHoursWords, quietHoursAsked } from "../quiet-hours-words";

const NOW = new Date("2026-10-31T11:31:00Z");
const ON = { quietHoursEnabled: true, quietHoursFrom: "23:00", quietHoursTo: "09:00" };
const OFF = { ...ON, quietHoursEnabled: false };
const URL_RE = /https?:\/\/\S+\/admin\/settings#quiet-hours/;

const saved = (value: { enabled: boolean; from: string; to: string }, released = 0) => ({
  ok: true as const,
  before: { enabled: true, from: "23:00", to: "09:00" },
  value,
  released,
  retimed: Array.from({ length: released }, (_, i) => `j${i}`),
});

beforeEach(() => {
  vi.clearAllMocks();
  h.findUnique.mockResolvedValue(ON);
});

describe("quietHoursAsked (pure): the facts onto the settings input", () => {
  const cur = { enabled: true, from: "23:00", to: "09:00" };
  it("off is off, whatever times came with it", () => {
    expect(quietHoursAsked(cur, { off: true, from: null, to: null })).toEqual({ enabled: false });
    expect(quietHoursAsked(cur, { off: true, from: "22:00", to: null })).toEqual({ enabled: false });
  });
  it("on with no times keeps the saved times (off keeps them, so on restores them)", () => {
    expect(quietHoursAsked({ ...cur, enabled: false }, { off: false, from: null, to: null })).toEqual({ enabled: true, from: "23:00", to: "09:00" });
  });
  it("times said replace the saved ones; a time not said is kept", () => {
    expect(quietHoursAsked(cur, { off: false, from: "22:00", to: "08:00" })).toEqual({ enabled: true, from: "22:00", to: "08:00" });
    expect(quietHoursAsked(cur, { off: false, from: null, to: "07:30" })).toEqual({ enabled: true, from: "23:00", to: "07:30" });
    expect(quietHoursAsked(cur, { off: false, from: "21:00", to: null })).toEqual({ enabled: true, from: "21:00", to: "09:00" });
  });
});

describe("applyQuietHoursWords", () => {
  it("off, with two held messages: saved through the core, and the reply says both go out now", async () => {
    h.save.mockResolvedValue(saved({ enabled: false, from: "23:00", to: "09:00" }, 2));
    const r = await applyQuietHoursWords({ orgId: "org1", off: true, from: null, to: null, lang: "en", now: NOW });
    expect(h.save).toHaveBeenCalledWith({ orgId: "org1", input: { enabled: false }, now: NOW });
    expect(r).toEqual({ outcome: "quiet-hours-off", replyText: "✅ Quiet hours are off. The 2 messages I was holding go out now." });
  });

  it("off, one held message: said in the singular", async () => {
    h.save.mockResolvedValue(saved({ enabled: false, from: "23:00", to: "09:00" }, 1));
    const r = await applyQuietHoursWords({ orgId: "org1", off: true, from: null, to: null, lang: "en", now: NOW });
    expect(r.replyText).toBe("✅ Quiet hours are off. The message I was holding goes out now.");
  });

  it("off, nothing held: one short line", async () => {
    h.save.mockResolvedValue(saved({ enabled: false, from: "23:00", to: "09:00" }, 0));
    const r = await applyQuietHoursWords({ orgId: "org1", off: true, from: null, to: null, lang: "en", now: NOW });
    expect(r.replyText).toBe("✅ Quiet hours are off. I'll post at any time of day.");
  });

  it("on with times: saved, and the reply names them", async () => {
    h.findUnique.mockResolvedValue(OFF);
    h.save.mockResolvedValue(saved({ enabled: true, from: "22:00", to: "08:00" }));
    const r = await applyQuietHoursWords({ orgId: "org1", off: false, from: "22:00", to: "08:00", lang: "en", now: NOW });
    expect(h.save).toHaveBeenCalledWith({ orgId: "org1", input: { enabled: true, from: "22:00", to: "08:00" }, now: NOW });
    expect(r).toEqual({ outcome: "quiet-hours-on", replyText: "✅ Quiet hours are on, from 22:00 to 08:00. I'll hold my messages in that time." });
  });

  it("new times that free held messages: the reply says how many go out now", async () => {
    h.save.mockResolvedValue(saved({ enabled: true, from: "23:00", to: "05:00" }, 3));
    const r = await applyQuietHoursWords({ orgId: "org1", off: false, from: null, to: "05:00", lang: "en", now: NOW });
    expect(r.replyText).toBe("✅ Quiet hours are on, from 23:00 to 05:00. I'll hold my messages in that time.\nThe 3 messages I was holding go out now.");
  });

  it("already as asked: said so, nothing saved", async () => {
    h.findUnique.mockResolvedValue(OFF);
    const off = await applyQuietHoursWords({ orgId: "org1", off: true, from: null, to: null, lang: "en", now: NOW });
    expect(off).toEqual({ outcome: "quiet-hours-unchanged", replyText: "Quiet hours are already off." });
    h.findUnique.mockResolvedValue(ON);
    const on = await applyQuietHoursWords({ orgId: "org1", off: false, from: "23:00", to: null, lang: "en", now: NOW });
    expect(on).toEqual({ outcome: "quiet-hours-unchanged", replyText: "Quiet hours are already on, from 23:00 to 09:00." });
    expect(h.save).not.toHaveBeenCalled();
  });

  it("times the core refuses: said, with the settings link, nothing changed", async () => {
    h.save.mockResolvedValue({ ok: false, error: "same-time" });
    const same = await applyQuietHoursWords({ orgId: "org1", off: false, from: "08:00", to: "08:00", lang: "en", now: NOW });
    expect(same.outcome).toBe("quiet-hours-refused");
    expect(same.replyText).toMatch(/^Quiet hours need two different times, for example from 22:00 to 08:00\. You can also set them here: /);
    expect(same.replyText).toMatch(URL_RE);
    h.save.mockResolvedValue({ ok: false, error: "bad-time" });
    const bad = await applyQuietHoursWords({ orgId: "org1", off: false, from: "25:00", to: null, lang: "en", now: NOW });
    expect(bad.outcome).toBe("quiet-hours-refused");
    expect(bad.replyText).toMatch(/^I couldn't read those times\./);
    expect(bad.replyText).toMatch(URL_RE);
  });

  it("a Turkish club hears it in Turkish", async () => {
    h.save.mockResolvedValue(saved({ enabled: false, from: "23:00", to: "09:00" }, 2));
    const r = await applyQuietHoursWords({ orgId: "org1", off: true, from: null, to: null, lang: "tr", now: NOW });
    expect(r.replyText).toBe("✅ Sessiz saatler kapalı. Beklettiğim 2 mesaj şimdi gidiyor.");
  });
});
