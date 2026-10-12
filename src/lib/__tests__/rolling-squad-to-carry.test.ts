/**
 * DOES MATCHTIME ALREADY HAVE A SQUAD TO CARRY OVER? (2026-10-13)
 *
 * The group hello told a newly live rolling club "if you played last
 * time, you're in next time too" when MatchTime had no last time: the
 * first game's list was empty. `hasSquadToCarry` answers with the same
 * rule the seeding uses (`pickSeedSource`, `carryOverExclusion`), so the
 * hello and the 08:00 carry-over can never disagree.
 */
import { describe, expect, it } from "vitest";
import { hasSquadToCarry, type FixtureMatch, type SeedSourceRow } from "../rolling-squad-rules";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-13T12:00:00.000Z");
const FIX = { orgId: "o1", venue: "Pitch", dayOfWeek: 2 };
const OTHER = { orgId: "o1", venue: "Dome", dayOfWeek: 4 };

const m = (id: string, offsetDays: number, status: string, over: Partial<FixtureMatch> = {}): FixtureMatch => ({
  id,
  date: new Date(NOW.getTime() + offsetDays * DAY),
  status,
  isHistorical: false,
  activity: FIX,
  rollingSeededAt: null,
  ...over,
});

const row = (userId: string, over: Partial<SeedSourceRow> = {}): SeedSourceRow => ({
  userId,
  status: "CONFIRMED",
  position: 1,
  phoneNumber: "+447700900001",
  email: `${userId}@example.invalid`,
  isActive: true,
  membership: { leftAt: null, provisionallyAddedAt: null },
  ...over,
});

const rows = (by: Record<string, SeedSourceRow[]>) => new Map(Object.entries(by));
const check = (matches: FixtureMatch[], by: Record<string, SeedSourceRow[]> = {}) =>
  hasSquadToCarry({ matches, rows: rows(by), now: NOW });

describe("hasSquadToCarry", () => {
  it("a new club, one game ahead and nothing played: no", () => {
    expect(check([m("next", 2, "UPCOMING")])).toBe(false);
    expect(check([])).toBe(false);
  });

  it("last week's game was completed with players on it: yes", () => {
    expect(check([m("last", -5, "COMPLETED"), m("next", 2, "UPCOMING")], { last: [row("a"), row("b")] })).toBe(true);
  });

  it("last week's game was completed with nobody on it: no", () => {
    expect(check([m("last", -5, "COMPLETED"), m("next", 2, "UPCOMING")], { last: [] })).toBe(false);
    expect(check([m("last", -5, "COMPLETED"), m("next", 2, "UPCOMING")])).toBe(false);
  });

  it("only players the seeding would carry count: the bench, a leaver, a deactivated user and a phoneless guest do not", () => {
    const none = [
      row("bench", { status: "BENCH" }),
      row("dropped", { status: "DROPPED" }),
      row("left", { membership: { leftAt: new Date(), provisionallyAddedAt: null } }),
      row("gone", { membership: null }),
      row("off", { isActive: false }),
      row("guest", { phoneNumber: null, email: "provisional+x@example.invalid" }),
    ];
    const ms = [m("last", -5, "COMPLETED"), m("next", 2, "UPCOMING")];
    expect(check(ms, { last: none })).toBe(false);
    expect(check(ms, { last: [...none, row("real")] })).toBe(true);
  });

  it("a game that kicked off before now and is still open counts as played: go-live completes it, and the seeding then reads it", () => {
    const ms = [m("kicked-off", -0.2, "UPCOMING"), m("next", 7, "UPCOMING")];
    expect(check(ms, { "kicked-off": [row("a")] })).toBe(true);
    expect(check(ms, { "kicked-off": [] })).toBe(false);
  });

  it("a cancelled or historical week is never the source; the week before it is", () => {
    const ms = [m("older", -12, "COMPLETED"), m("cancelled", -5, "CANCELLED"), m("next", 2, "UPCOMING")];
    expect(check(ms, { cancelled: [row("a")] })).toBe(false);
    expect(check(ms, { older: [row("a")] })).toBe(true);
    expect(check([m("hist", -5, "COMPLETED", { isHistorical: true }), m("next", 2, "UPCOMING")], { hist: [row("a")] })).toBe(false);
  });

  it("a game played longer ago than the lookback is not carried, so it is not a squad to carry", () => {
    const ms = [m("long-ago", -30, "COMPLETED"), m("next", 2, "UPCOMING")];
    expect(check(ms, { "long-ago": [row("a")] })).toBe(false);
  });

  it("another weekly game's squad does not count for this one, but any fixture with a squad is enough", () => {
    const ms = [m("other-last", -5, "COMPLETED", { activity: OTHER }), m("next", 2, "UPCOMING")];
    // The Thursday game has a squad and no next match yet: it is still carried when one is generated.
    expect(check(ms, { "other-last": [row("a")] })).toBe(true);
    // Its next match is here and already past the lookback from the source: nothing to carry.
    const far = [m("other-last", -5, "COMPLETED", { activity: OTHER }), m("other-next", 30, "UPCOMING", { activity: OTHER }), m("next", 2, "UPCOMING")];
    expect(check(far, { "other-last": [row("a")] })).toBe(false);
  });

  it("the next game was seeded already: yes when it has players on it", () => {
    const seeded = m("next", 2, "UPCOMING", { rollingSeededAt: new Date(NOW.getTime() - DAY) });
    expect(check([m("last", -5, "COMPLETED"), seeded], { next: [row("a")] })).toBe(true);
    expect(check([m("last", -5, "COMPLETED"), seeded], { next: [], last: [row("a")] })).toBe(false);
  });

  it("no next game generated yet: a game played in the last fortnight with players is a squad to carry", () => {
    expect(check([m("last", -5, "COMPLETED")], { last: [row("a")] })).toBe(true);
    expect(check([m("last", -20, "COMPLETED")], { last: [row("a")] })).toBe(false);
  });
});
