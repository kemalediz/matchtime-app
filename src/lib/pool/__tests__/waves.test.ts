/**
 * A round's waves and send times (slice L4): up to 8, about 4 first, the
 * rest POOL_ROUND.secondWaveAfterMins later only while places are open;
 * nothing sent in quiet hours (deferred to 08:30 London, never dropped);
 * nothing sent or open past the club's cut-off.
 */
import { describe, expect, it } from "vitest";
import { londonDateTimeToUtc } from "../../london-time";
import { POOL_QUIET_HOURS, POOL_ROUND } from "../rules";
import { firstWaveSize, offerExpiresAt, poolSendAt, secondWave } from "../waves";

const at = (date: string, time: string) => londonDateTimeToUtc(date, time);
const MIN = 60_000;
const HOUR = 60 * MIN;

describe("the quiet hours are the pool's own (21:30 to 08:30 London)", () => {
  it("reads them from rules.ts", () => {
    expect(POOL_QUIET_HOURS).toMatchObject({ enabled: true, from: "21:30", to: "08:30" });
  });
});

describe("poolSendAt: now, or the end of quiet hours (deferred, never dropped)", () => {
  const table: Array<[string, Date, Date]> = [
    ["21:29 goes now", at("2026-10-27", "21:29"), at("2026-10-27", "21:29")],
    ["21:30 exactly waits for 08:30 tomorrow", at("2026-10-27", "21:30"), at("2026-10-28", "08:30")],
    ["23:59 waits for 08:30 tomorrow", at("2026-10-27", "23:59"), at("2026-10-28", "08:30")],
    ["00:00 waits for 08:30 today", at("2026-10-28", "00:00"), at("2026-10-28", "08:30")],
    ["08:29 waits one minute", at("2026-10-28", "08:29"), at("2026-10-28", "08:30")],
    ["08:30 exactly goes now", at("2026-10-28", "08:30"), at("2026-10-28", "08:30")],
    ["summer (BST): 21:30 London is 20:30Z", new Date("2026-07-14T20:30:00Z"), new Date("2026-07-15T07:30:00Z")],
    ["summer: 20:29Z is 21:29 BST, goes now", new Date("2026-07-14T20:29:00Z"), new Date("2026-07-14T20:29:00Z")],
    ["autumn change night: Saturday 22:00 BST waits for Sunday 08:30 GMT", at("2026-10-24", "22:00"), new Date("2026-10-25T08:30:00Z")],
    ["spring change night: Saturday 22:00 GMT waits for Sunday 08:30 BST", at("2027-03-27", "22:00"), new Date("2027-03-28T07:30:00Z")],
  ];
  it.each(table)("%s", (_n, now, want) => {
    expect(poolSendAt(now).toISOString()).toBe(want.toISOString());
  });

  it("property: the send time is never before now and never inside quiet hours", () => {
    const start = at("2026-10-24", "00:00").getTime();
    for (let m = 0; m < 3 * 24 * 60; m += 7) {
      const now = new Date(start + m * MIN);
      const s = poolSendAt(now);
      expect(s.getTime()).toBeGreaterThanOrEqual(now.getTime());
      const hm = s.toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" });
      expect(hm >= "08:30" && hm < "21:30").toBe(true);
    }
  });
});

describe("firstWaveSize: about 4 first, never more than 8 in all", () => {
  const table: Array<[string, number, number, number]> = [
    ["no candidates", 0, 1, 0],
    ["fewer candidates than a wave", 3, 1, 3],
    ["one place: a wave of 4", 10, 1, POOL_ROUND.firstWave],
    ["four places: a wave of 4", 10, 4, 4],
    ["six places: one per place, the first wave is not smaller than the places", 10, 6, 6],
    ["twelve places: never more than 8", 20, 12, POOL_ROUND.maxOffers],
    ["zero places: nothing", 10, 0, 0],
  ];
  it.each(table)("%s", (_n, candidates, places, want) => {
    expect(firstWaveSize(candidates, places)).toBe(want);
  });
});

describe("secondWave: the rest, only if places remain, after the delay", () => {
  const wave1At = at("2026-10-27", "10:00");
  const cutoff = at("2026-10-27", "16:00");
  const base = { wave1SentAt: wave1At, wave1Count: 4, placesOpen: 1, cutoff };
  it("before the delay: wait until wave1 + delay", () => {
    const r = secondWave({ ...base, now: new Date(wave1At.getTime() + 10 * MIN) });
    expect(r).toEqual({ kind: "wait", at: new Date(wave1At.getTime() + POOL_ROUND.secondWaveAfterMins * MIN) });
  });
  it("at the delay exactly: send the rest (8 minus the first wave)", () => {
    const r = secondWave({ ...base, now: new Date(wave1At.getTime() + POOL_ROUND.secondWaveAfterMins * MIN) });
    expect(r).toEqual({ kind: "send", size: POOL_ROUND.maxOffers - 4 });
  });
  it("no places open: none, ever", () => {
    expect(secondWave({ ...base, placesOpen: 0, now: new Date(wave1At.getTime() + HOUR) })).toEqual({ kind: "none", reason: "filled" });
  });
  it("a full first wave of 8: nothing left to send", () => {
    expect(secondWave({ ...base, wave1Count: 8, now: new Date(wave1At.getTime() + HOUR) })).toEqual({ kind: "none", reason: "round-full" });
  });
  it("its time falls in quiet hours: it waits for 08:30", () => {
    const late = at("2026-10-27", "21:10");
    const r = secondWave({ ...base, wave1SentAt: late, cutoff: at("2026-10-28", "18:00"), now: new Date(late.getTime() + HOUR) });
    expect(r).toEqual({ kind: "wait", at: at("2026-10-28", "08:30") });
  });
  it("its time is at or past the cut-off: none (too late), even when deferred by quiet hours", () => {
    const r1 = secondWave({ ...base, cutoff: new Date(wave1At.getTime() + POOL_ROUND.secondWaveAfterMins * MIN), now: wave1At });
    expect(r1).toEqual({ kind: "none", reason: "too-late" });
    const late = at("2026-10-27", "21:10");
    const r2 = secondWave({ ...base, wave1SentAt: late, cutoff: at("2026-10-28", "08:00"), now: late });
    expect(r2).toEqual({ kind: "none", reason: "too-late" });
  });
});

describe("offerExpiresAt: 6 hours after sending or the cut-off, whichever is first", () => {
  const sent = at("2026-10-27", "10:00");
  it("the TTL when the cut-off is later", () => {
    expect(offerExpiresAt(sent, at("2026-10-27", "20:00"))).toEqual(new Date(sent.getTime() + POOL_ROUND.offerTtlHours * HOUR));
  });
  it("the cut-off when it is sooner", () => {
    expect(offerExpiresAt(sent, at("2026-10-27", "12:00"))).toEqual(at("2026-10-27", "12:00"));
  });
  it("equal: either", () => {
    const c = new Date(sent.getTime() + POOL_ROUND.offerTtlHours * HOUR);
    expect(offerExpiresAt(sent, c)).toEqual(c);
  });
});
