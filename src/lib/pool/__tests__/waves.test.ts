/**
 * A round's waves and send times (slice L4): up to 8, about 4 first, the
 * rest POOL_ROUND.secondWaveAfterMins later only while places are open;
 * no night hold (Kemal, 2026-10-29: the pool's quiet hours are removed);
 * nothing sent or open past the club's cut-off.
 */
import { describe, expect, it } from "vitest";
import { londonDateTimeToUtc } from "../../london-time";
import * as rules from "../rules";
import { POOL_ROUND } from "../rules";
import * as waves from "../waves";
import { firstWaveSize, offerExpiresAt, secondWave } from "../waves";

const at = (date: string, time: string) => londonDateTimeToUtc(date, time);
const MIN = 60_000;
const HOUR = 60 * MIN;

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
  it("no night hold: a second wave due at 22:10 London goes at 22:10, not 08:30", () => {
    const late = at("2026-10-27", "21:10");
    const due = new Date(late.getTime() + POOL_ROUND.secondWaveAfterMins * MIN);
    const cutoff = at("2026-10-28", "18:00");
    expect(secondWave({ ...base, wave1SentAt: late, cutoff, now: new Date(due.getTime() - MIN) })).toEqual({ kind: "wait", at: due });
    expect(secondWave({ ...base, wave1SentAt: late, cutoff, now: due })).toEqual({ kind: "send", size: POOL_ROUND.maxOffers - 4 });
  });
  it("its time is at or past the cut-off: none (too late)", () => {
    const r1 = secondWave({ ...base, cutoff: new Date(wave1At.getTime() + POOL_ROUND.secondWaveAfterMins * MIN), now: wave1At });
    expect(r1).toEqual({ kind: "none", reason: "too-late" });
  });
});

describe("the pool has no quiet hours of its own (Kemal, 2026-10-29)", () => {
  it("no pool quiet-hours constant and no send-time hold exist", () => {
    expect("POOL_QUIET_HOURS" in rules).toBe(false);
    expect("poolSendAt" in waves).toBe(false);
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
