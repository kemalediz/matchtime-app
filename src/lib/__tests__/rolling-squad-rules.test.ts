/**
 * Rolling squad, the pure rules (slice 1 of
 * MDs/friday-group-features-plan-2026-09-30.md, sections 1.2 to 1.4
 * and 1.6). No database, no clock.
 *
 *   pickSeedSource   which match is "last week's" for a target
 *   pickSeedTarget   which match of a fixture is seeded next
 *   rollingSeedDueAt the first 08:00 London after the source ends
 *   decideSeed       who is carried over, in what order, and overflow
 *   isLateDrop       an OUT after the drop-out deadline, by SEND time
 *   adminNoticeSendAfter  admin notices wait for 08:00, never at night
 */
import { describe, it, expect } from "vitest";
import {
  ROLLING_LOOKBACK_DAYS,
  adminNoticeSendAfter,
  carryOverExclusion,
  decideSeed,
  isLateDrop,
  pickSeedSource,
  pickSeedTarget,
  rollingSeedDue,
  rollingSeedDueAt,
  type FixtureMatch,
  type SeedSourceRow,
} from "../rolling-squad-rules";

const DAY = 24 * 60 * 60 * 1000;
const FRI = { orgId: "org-fnf", venue: "Powerleague", dayOfWeek: 5 };
const OTHER_VENUE = { orgId: "org-fnf", venue: "Goals", dayOfWeek: 5 };
const OTHER_DAY = { orgId: "org-fnf", venue: "Powerleague", dayOfWeek: 2 };

/** Fri 9 Oct 2026, 20:30 London (BST, 19:30 UTC). */
const TARGET_DATE = new Date("2026-10-09T19:30:00.000Z");

function m(id: string, daysBefore: number, over: Partial<FixtureMatch> = {}): FixtureMatch {
  return {
    id,
    date: new Date(TARGET_DATE.getTime() - daysBefore * DAY),
    status: "COMPLETED",
    isHistorical: false,
    activityId: "act-9",
    activity: FRI,
    rollingSeededAt: null,
    ...over,
  };
}

const target = m("target", 0, { status: "UPCOMING" });

describe("pickSeedSource", () => {
  it("picks last week's completed match of the same fixture", () => {
    expect(pickSeedSource(target, [m("wk-2", 14), m("wk-1", 7)])?.id).toBe("wk-1");
  });

  it("only the same fixture: another venue or weekday never counts", () => {
    const src = pickSeedSource(target, [
      m("other-venue", 7, { activity: OTHER_VENUE }),
      m("other-day", 3, { activity: OTHER_DAY }),
      m("wk-2", 14),
    ]);
    expect(src?.id).toBe("wk-2");
  });

  it("a format-switched source on the other activity still counts (fixture, not activityId)", () => {
    expect(pickSeedSource(target, [m("switched", 7, { activityId: "act-7" })])?.id).toBe("switched");
  });

  it("skips a CANCELLED week and uses the one before it (D1)", () => {
    expect(pickSeedSource(target, [m("wk-2", 14), m("cancelled", 7, { status: "CANCELLED" })])?.id).toBe("wk-2");
  });

  it("skips historical matches and live ones", () => {
    const src = pickSeedSource(target, [
      m("hist", 7, { isHistorical: true }),
      m("live", 7, { status: "UPCOMING" }),
    ]);
    expect(src).toBeNull();
  });

  it(`looks back ${ROLLING_LOOKBACK_DAYS} days and no further`, () => {
    expect(ROLLING_LOOKBACK_DAYS).toBe(21);
    expect(pickSeedSource(target, [m("wk-3", 21)])?.id).toBe("wk-3");
    expect(pickSeedSource(target, [m("wk-4", 28)])).toBeNull();
  });

  it("the admin button can look further back (a summer break)", () => {
    expect(pickSeedSource(target, [m("june", 70)], { lookbackDays: Infinity })?.id).toBe("june");
  });

  it("never picks a match on or after the target", () => {
    expect(pickSeedSource(target, [m("same", 0), m("later", -7)])).toBeNull();
  });
});

describe("pickSeedTarget", () => {
  const now = new Date(TARGET_DATE.getTime() - 6 * DAY);

  it("the soonest live match of the fixture that is in the future", () => {
    const got = pickSeedTarget(
      [m("next", 0, { status: "UPCOMING" }), m("after", -7, { status: "UPCOMING" }), m("wk-1", 7)],
      FRI,
      now,
    );
    expect(got?.id).toBe("next");
  });

  it("none when the soonest one is already seeded (it never skips ahead)", () => {
    const got = pickSeedTarget(
      [
        m("next", 0, { status: "UPCOMING", rollingSeededAt: new Date(now) }),
        m("after", -7, { status: "UPCOMING" }),
      ],
      FRI,
      now,
    );
    expect(got).toBeNull();
  });

  it("an earlier live match still ahead is the target, never next week's", () => {
    const got = pickSeedTarget(
      [m("tonight", 1, { status: "UPCOMING" }), m("next", 0, { status: "UPCOMING" })],
      FRI,
      new Date(TARGET_DATE.getTime() - 2 * DAY),
    );
    // The in-flight match is the soonest live one; it is in the future
    // relative to `now`, so IT is the target, never next week's.
    expect(got?.id).toBe("tonight");
  });

  it("none while a kicked-off match of the fixture is not yet completed (it would skip a week)", () => {
    const got = pickSeedTarget(
      [m("kicked-off", 7, { status: "UPCOMING" }), m("next", 0, { status: "UPCOMING" })],
      FRI,
      now,
    );
    expect(got).toBeNull();
  });

  it("ignores cancelled and historical rows, and other fixtures", () => {
    const got = pickSeedTarget(
      [
        m("cancelled", 0, { status: "CANCELLED" }),
        m("hist", 0, { status: "UPCOMING", isHistorical: true }),
        m("other", 0, { status: "UPCOMING", activity: OTHER_VENUE }),
      ],
      FRI,
      now,
    );
    expect(got).toBeNull();
  });
});

describe("rollingSeedDueAt / rollingSeedDue", () => {
  it("a Friday 22:00 end is due at 08:00 London on Saturday (BST)", () => {
    const end = new Date("2026-10-09T21:00:00.000Z"); // 22:00 BST
    expect(rollingSeedDueAt(end).toISOString()).toBe("2026-10-10T07:00:00.000Z");
    expect(rollingSeedDue(end, new Date("2026-10-10T06:59:00.000Z"))).toBe(false);
    expect(rollingSeedDue(end, new Date("2026-10-10T07:00:00.000Z"))).toBe(true);
  });

  it("across the BST to GMT change (last Sunday of October)", () => {
    // Sat 24 Oct 2026, 22:00 BST end; clocks go back at 02:00 on Sun 25.
    const end = new Date("2026-10-24T21:00:00.000Z");
    expect(rollingSeedDueAt(end).toISOString()).toBe("2026-10-25T08:00:00.000Z"); // 08:00 GMT
  });

  it("an end just after midnight is still due at 08:00 that same morning", () => {
    const end = new Date("2026-10-09T23:30:00.000Z"); // 00:30 BST Saturday
    expect(rollingSeedDueAt(end).toISOString()).toBe("2026-10-10T07:00:00.000Z");
  });

  it("an end after 08:00 waits for the next morning", () => {
    const end = new Date("2026-10-10T09:00:00.000Z"); // 10:00 BST Saturday
    expect(rollingSeedDueAt(end).toISOString()).toBe("2026-10-11T07:00:00.000Z");
  });
});

function row(userId: string, over: Partial<SeedSourceRow> = {}): SeedSourceRow {
  return {
    userId,
    status: "CONFIRMED",
    position: 1,
    phoneNumber: `+44770090${userId.length}${userId}`,
    email: `${userId}@example.com`,
    isActive: true,
    membership: { leftAt: null, provisionallyAddedAt: null },
    ...over,
  };
}

describe("carryOverExclusion (plan 1.3)", () => {
  it("a confirmed regular is carried", () => {
    expect(carryOverExclusion(row("a"))).toBeNull();
  });
  it("bench and dropped players are not (D2)", () => {
    expect(carryOverExclusion(row("a", { status: "BENCH" }))).toBe("did not play");
    expect(carryOverExclusion(row("a", { status: "DROPPED" }))).toBe("did not play");
  });
  it("left the group, or no membership any more", () => {
    expect(carryOverExclusion(row("a", { membership: { leftAt: new Date(), provisionallyAddedAt: null } }))).toBe(
      "left the group",
    );
    expect(carryOverExclusion(row("a", { membership: null }))).toBe("left the group");
  });
  it("a deactivated user", () => {
    expect(carryOverExclusion(row("a", { isActive: false }))).toBe("deactivated");
  });
  it("a phoneless provisional guest is not; a phoneless admin-confirmed member is", () => {
    expect(carryOverExclusion(row("a", { phoneNumber: null, email: "provisional+gary-x@matchtime.local" }))).toBe(
      "guest without a phone",
    );
    expect(
      carryOverExclusion(
        row("a", { phoneNumber: null, membership: { leftAt: null, provisionallyAddedAt: new Date() } }),
      ),
    ).toBe("guest without a phone");
    expect(carryOverExclusion(row("a", { phoneNumber: null }))).toBeNull();
  });
  it("a provisional member WITH a phone is carried", () => {
    expect(
      carryOverExclusion(row("a", { membership: { leftAt: null, provisionallyAddedAt: new Date() } })),
    ).toBeNull();
  });
});

describe("decideSeed", () => {
  const src = [
    row("c", { position: 3 }),
    row("a", { position: 1 }),
    row("bench", { position: 9, status: "BENCH" }),
    row("b", { position: 2 }),
    row("gone", { position: 4, membership: { leftAt: new Date(), provisionallyAddedAt: null } }),
  ];

  it("carries the confirmed players in last week's order, CONFIRMED", () => {
    const got = decideSeed({ sourceRows: src, targetRows: [], maxPlayers: 18 });
    expect(got.map((d) => [d.userId, d.status])).toEqual([
      ["a", "CONFIRMED"],
      ["b", "CONFIRMED"],
      ["c", "CONFIRMED"],
    ]);
    expect(got[0].note).toBe("carried over");
  });

  it("never touches a player who already has a row on the target (an early OUT stays OUT)", () => {
    const got = decideSeed({
      sourceRows: src,
      targetRows: [
        { userId: "a", status: "DROPPED" },
        { userId: "b", status: "CONFIRMED" },
      ],
      maxPlayers: 18,
    });
    expect(got.map((d) => d.userId)).toEqual(["c"]);
  });

  it("overflow goes to the waiting list in last week's order", () => {
    const got = decideSeed({
      sourceRows: src,
      targetRows: [{ userId: "early", status: "CONFIRMED" }],
      maxPlayers: 2,
    });
    expect(got.map((d) => [d.userId, d.status])).toEqual([
      ["a", "CONFIRMED"],
      ["b", "BENCH"],
      ["c", "BENCH"],
    ]);
    expect(got[1].note).toBe("rolling overflow: no place left");
  });

  it("an empty source seeds nothing", () => {
    expect(decideSeed({ sourceRows: [], targetRows: [], maxPlayers: 18 })).toEqual([]);
  });
});

describe("isLateDrop (plan 1.6): send time decides", () => {
  const deadline = new Date("2026-10-05T20:00:00.000Z"); // Mon 21:00 BST
  it("sent before the deadline is on time, even if it arrived after", () => {
    expect(isLateDrop(new Date("2026-10-05T19:55:00.000Z"), deadline)).toBe(false);
  });
  it("exactly at the deadline is on time", () => {
    expect(isLateDrop(deadline, deadline)).toBe(false);
  });
  it("after the deadline is late", () => {
    expect(isLateDrop(new Date("2026-10-05T20:01:00.000Z"), deadline)).toBe(true);
  });
});

describe("adminNoticeSendAfter: London 08:00 to 21:59, else held to 08:00", () => {
  it("daytime sends now", () => {
    expect(adminNoticeSendAfter(new Date("2026-10-05T12:00:00.000Z"))).toBeNull();
    expect(adminNoticeSendAfter(new Date("2026-10-05T20:59:00.000Z"))).toBeNull(); // 21:59 BST
  });
  it("22:00 or later waits for 08:00 tomorrow", () => {
    expect(adminNoticeSendAfter(new Date("2026-10-05T21:00:00.000Z"))?.toISOString()).toBe(
      "2026-10-06T07:00:00.000Z",
    );
  });
  it("before 08:00 waits for 08:00 today", () => {
    expect(adminNoticeSendAfter(new Date("2026-10-06T05:00:00.000Z"))?.toISOString()).toBe(
      "2026-10-06T07:00:00.000Z",
    );
  });
});
