/**
 * Unit tests for block bookings (2026-07-20).
 *
 * Sutton FC books the pitch as a BLOCK: N consecutive weekly matches paid
 * up-front to the venue. These tests pin the pure core:
 *
 *   1. Occurrence generation — one match per weekly occurrence of the
 *      activity's dayOfWeek at the block's London wall-clock time, from
 *      startDate to endDate (or `count` matches), inclusive. THE DST TRAP:
 *      the real booking runs 25 Aug → 27 Oct 2026, Tuesdays 21:30. BST
 *      ends Sun 25 Oct 2026, so 20 Oct 21:30 BST = 20:30 UTC but
 *      27 Oct 21:30 GMT = 21:30 UTC. A naive fixed-offset implementation
 *      puts the last match an hour out.
 *
 *   2. Idempotent generation — re-running the planner against matches the
 *      previous run (or the weekly cron) already created creates nothing,
 *      via the same slot-dedupe notion as src/lib/match-slot.ts
 *      (org+venue+dayOfWeek + instant proximity).
 *
 *   3. Posting horizon — with a 10-match block only the SOONEST live match
 *      is postable (isNextUpcomingForPosting); the other 9 are suppressed.
 *      When the soonest completes OR is cancelled, the next becomes
 *      postable. Cancelled matches are never postable.
 *
 *   4. Bulk cancel/restore selection + announcement — cancelling a date
 *      range selects exactly the live matches in range, and produces NO
 *      group announcement unless the admin explicitly opts in.
 *
 *   5. Block deletion partition — matches that carry history (completed,
 *      or any attendances/ratings/votes/team assignments) are DETACHED,
 *      never deleted; only empty unplayed shells may be deleted.
 *
 * Pure logic — no DB.
 */
import { describe, it, expect } from "vitest";
import {
  generateBlockOccurrences,
  planBlockGeneration,
  selectCancellable,
  selectRestorable,
  buildBulkCancelAnnouncement,
  partitionBlockMatchesForDeletion,
  MAX_BLOCK_MATCHES,
  type BlockOccurrence,
} from "@/lib/block-booking";
import { hasMatchForSlot } from "@/lib/match-slot";
import {
  isNextUpcomingForPosting,
  type SchedulerMatch,
} from "@/lib/next-upcoming-match";

/** The real Sutton FC booking: Tuesdays 21:30, 25 Aug → 27 Oct 2026. */
const SUTTON_SPEC = {
  startDate: "2026-08-25",
  endDate: "2026-10-27",
  dayOfWeek: 2, // Tuesday
  time: "21:30",
  deadlineHours: 5,
};

const SUTTON_FIXTURE = {
  orgId: "sutton-fc",
  venue: "Goals North Cheam",
  dayOfWeek: 2,
};

// ─────────────────────────── 1. Occurrence generation ─────────────────────

describe("generateBlockOccurrences", () => {
  it("generates exactly 10 Tuesday matches for 25 Aug → 27 Oct 2026", () => {
    const occ = generateBlockOccurrences(SUTTON_SPEC);
    expect(occ.map((o) => o.date)).toEqual([
      "2026-08-25",
      "2026-09-01",
      "2026-09-08",
      "2026-09-15",
      "2026-09-22",
      "2026-09-29",
      "2026-10-06",
      "2026-10-13",
      "2026-10-20",
      "2026-10-27",
    ]);
  });

  it("THE DST CASE: 20 Oct 2026 21:30 BST is 20:30 UTC; 27 Oct 2026 21:30 GMT is 21:30 UTC", () => {
    const occ = generateBlockOccurrences(SUTTON_SPEC);
    const oct20 = occ.find((o) => o.date === "2026-10-20")!;
    const oct27 = occ.find((o) => o.date === "2026-10-27")!;
    expect(oct20.kickoffUtc.toISOString()).toBe("2026-10-20T20:30:00.000Z");
    expect(oct27.kickoffUtc.toISOString()).toBe("2026-10-27T21:30:00.000Z");
  });

  it("resolves every BST-period kickoff to 20:30 UTC (wall clock stays 21:30 London)", () => {
    const occ = generateBlockOccurrences(SUTTON_SPEC);
    for (const o of occ) {
      const expected = o.date <= "2026-10-24" ? "20:30" : "21:30";
      expect(o.kickoffUtc.toISOString().slice(11, 16)).toBe(expected);
    }
  });

  it("attendanceDeadline is kickoff minus deadlineHours, per occurrence", () => {
    const occ = generateBlockOccurrences(SUTTON_SPEC);
    for (const o of occ) {
      expect(o.kickoffUtc.getTime() - o.attendanceDeadline.getTime()).toBe(
        5 * 60 * 60 * 1000,
      );
    }
    // Spot-check the DST-straddling one: 27 Oct 21:30 GMT − 5h = 16:30 UTC.
    const oct27 = occ.find((o) => o.date === "2026-10-27")!;
    expect(oct27.attendanceDeadline.toISOString()).toBe(
      "2026-10-27T16:30:00.000Z",
    );
  });

  it("count-based spec: count=10 from 25 Aug lands the last match on 27 Oct", () => {
    const occ = generateBlockOccurrences({
      startDate: "2026-08-25",
      count: 10,
      dayOfWeek: 2,
      time: "21:30",
      deadlineHours: 5,
    });
    expect(occ).toHaveLength(10);
    expect(occ[0].date).toBe("2026-08-25");
    expect(occ[9].date).toBe("2026-10-27");
  });

  it("rolls a startDate that is not on the activity's weekday forward to the next occurrence", () => {
    // 2026-08-23 is a Sunday; first Tuesday on/after is 25 Aug.
    const occ = generateBlockOccurrences({
      ...SUTTON_SPEC,
      startDate: "2026-08-23",
    });
    expect(occ[0].date).toBe("2026-08-25");
    expect(occ).toHaveLength(10);
  });

  it("endDate is inclusive: ending exactly on a match day includes it", () => {
    const occ = generateBlockOccurrences({
      ...SUTTON_SPEC,
      endDate: "2026-09-01",
    });
    expect(occ.map((o) => o.date)).toEqual(["2026-08-25", "2026-09-01"]);
  });

  it("returns [] when the range contains no occurrence of the weekday", () => {
    const occ = generateBlockOccurrences({
      ...SUTTON_SPEC,
      startDate: "2026-08-26", // Wednesday
      endDate: "2026-08-31", // Monday — no Tuesday in range
    });
    expect(occ).toEqual([]);
  });

  it("rejects malformed input and missing/conflicting range specs", () => {
    expect(() =>
      generateBlockOccurrences({ ...SUTTON_SPEC, startDate: "25/08/2026" }),
    ).toThrow();
    expect(() =>
      generateBlockOccurrences({ ...SUTTON_SPEC, time: "9pm" }),
    ).toThrow();
    expect(() =>
      generateBlockOccurrences({ ...SUTTON_SPEC, dayOfWeek: 7 }),
    ).toThrow();
    // Neither endDate nor count:
    expect(() =>
      generateBlockOccurrences({
        startDate: "2026-08-25",
        dayOfWeek: 2,
        time: "21:30",
        deadlineHours: 5,
      }),
    ).toThrow();
    // Both endDate and count:
    expect(() =>
      generateBlockOccurrences({ ...SUTTON_SPEC, count: 10 }),
    ).toThrow();
    // endDate before startDate:
    expect(() =>
      generateBlockOccurrences({ ...SUTTON_SPEC, endDate: "2026-08-01" }),
    ).toThrow();
    // count out of bounds:
    expect(() =>
      generateBlockOccurrences({
        startDate: "2026-08-25",
        count: 0,
        dayOfWeek: 2,
        time: "21:30",
        deadlineHours: 5,
      }),
    ).toThrow();
    expect(() =>
      generateBlockOccurrences({
        startDate: "2026-08-25",
        count: MAX_BLOCK_MATCHES + 1,
        dayOfWeek: 2,
        time: "21:30",
        deadlineHours: 5,
      }),
    ).toThrow();
  });
});

// ─────────────────────────── 2. Idempotent generation ─────────────────────

const occToExisting = (o: BlockOccurrence) => ({
  date: o.kickoffUtc,
  activity: SUTTON_FIXTURE,
});

describe("planBlockGeneration (slot dedupe / idempotency)", () => {
  it("creates all 10 when nothing exists", () => {
    const occ = generateBlockOccurrences(SUTTON_SPEC);
    const plan = planBlockGeneration(occ, SUTTON_FIXTURE, []);
    expect(plan.toCreate).toHaveLength(10);
    expect(plan.duplicates).toHaveLength(0);
  });

  it("re-running against its own output creates nothing (idempotent)", () => {
    const occ = generateBlockOccurrences(SUTTON_SPEC);
    const existing = occ.map(occToExisting);
    const plan = planBlockGeneration(occ, SUTTON_FIXTURE, existing);
    expect(plan.toCreate).toHaveLength(0);
    expect(plan.duplicates).toHaveLength(10);
  });

  it("fills only the missing weeks when some matches already exist", () => {
    const occ = generateBlockOccurrences(SUTTON_SPEC);
    const existing = [occ[0], occ[3], occ[9]].map(occToExisting);
    const plan = planBlockGeneration(occ, SUTTON_FIXTURE, existing);
    expect(plan.toCreate.map((o) => o.date)).toEqual(
      occ
        .filter((_, i) => ![0, 3, 9].includes(i))
        .map((o) => o.date),
    );
    expect(plan.duplicates.map((o) => o.date)).toEqual([
      "2026-08-25",
      "2026-09-15",
      "2026-10-27",
    ]);
  });

  it("a cron-created match at a slightly different time (21:15 vs 21:30, same fixture) still counts as a duplicate", () => {
    // Same ±90min instant-proximity notion as the weekly cron's dedupe —
    // a format-tweaked kickoff time must not produce a second match.
    const occ = generateBlockOccurrences(SUTTON_SPEC);
    const cronMatch = {
      date: new Date("2026-08-25T20:15:00.000Z"), // 21:15 BST that Tuesday
      activity: SUTTON_FIXTURE,
    };
    const plan = planBlockGeneration(occ, SUTTON_FIXTURE, [cronMatch]);
    expect(plan.duplicates.map((o) => o.date)).toEqual(["2026-08-25"]);
    expect(plan.toCreate).toHaveLength(9);
  });

  it("a same-org match at a DIFFERENT venue/weekday does not block creation", () => {
    const occ = generateBlockOccurrences(SUTTON_SPEC);
    const thursdayGame = {
      date: new Date("2026-08-25T20:30:00.000Z"),
      activity: { orgId: "sutton-fc", venue: "Other Pitch", dayOfWeek: 4 },
    };
    const plan = planBlockGeneration(occ, SUTTON_FIXTURE, [thursdayGame]);
    expect(plan.toCreate).toHaveLength(10);
  });

  it("the weekly cron's own dedupe sees a block-created match in its window and skips (no double-create)", () => {
    // This is exactly the check /api/cron/generate-matches performs:
    // hasMatchForSlot(cron slot, existing slots in ±12h window). With the
    // block's 1 Sep match pre-created, the cron computing the same
    // occurrence must find it and skip.
    const occ = generateBlockOccurrences(SUTTON_SPEC);
    const sep1 = occ.find((o) => o.date === "2026-09-01")!;
    const cronSlot = {
      ...SUTTON_FIXTURE,
      instant: new Date("2026-09-01T20:30:00.000Z"),
    };
    expect(
      hasMatchForSlot(cronSlot, [
        { ...SUTTON_FIXTURE, instant: sep1.kickoffUtc },
      ]),
    ).toBe(true);
  });
});

// ─────────────────────────── 3. Posting horizon ───────────────────────────

/** Build SchedulerMatch rows for the 10-match block. */
function blockAsSchedulerMatches(
  statuses: Partial<Record<number, string>> = {},
): SchedulerMatch[] {
  const occ = generateBlockOccurrences(SUTTON_SPEC);
  return occ.map((o, i) => ({
    id: `blk-${String(i).padStart(2, "0")}`,
    activityId: "tuesday-7aside",
    date: o.kickoffUtc,
    status: statuses[i] ?? "UPCOMING",
    isHistorical: false,
    activity: SUTTON_FIXTURE,
  }));
}

describe("posting horizon over a 10-match block (isNextUpcomingForPosting)", () => {
  it("with 10 future matches, ONLY the soonest is postable; the other 9 are suppressed", () => {
    const ms = blockAsSchedulerMatches();
    expect(isNextUpcomingForPosting(ms, ms[0])).toBe(true);
    for (let i = 1; i < 10; i++) {
      expect(isNextUpcomingForPosting(ms, ms[i])).toBe(false);
    }
  });

  it("when the soonest is COMPLETED, the next becomes postable (and only it)", () => {
    const ms = blockAsSchedulerMatches({ 0: "COMPLETED" });
    expect(isNextUpcomingForPosting(ms, ms[0])).toBe(false); // completed itself never posts
    expect(isNextUpcomingForPosting(ms, ms[1])).toBe(true);
    for (let i = 2; i < 10; i++) {
      expect(isNextUpcomingForPosting(ms, ms[i])).toBe(false);
    }
  });

  it("when the soonest is CANCELLED, the next becomes postable (and only it)", () => {
    const ms = blockAsSchedulerMatches({ 0: "CANCELLED" });
    expect(isNextUpcomingForPosting(ms, ms[0])).toBe(false);
    expect(isNextUpcomingForPosting(ms, ms[1])).toBe(true);
    for (let i = 2; i < 10; i++) {
      expect(isNextUpcomingForPosting(ms, ms[i])).toBe(false);
    }
  });

  it("a bulk-cancelled holiday gap: matches 0-3 cancelled, match 4 becomes the postable one", () => {
    const ms = blockAsSchedulerMatches({
      0: "CANCELLED",
      1: "CANCELLED",
      2: "CANCELLED",
      3: "CANCELLED",
    });
    for (const i of [0, 1, 2, 3]) {
      expect(isNextUpcomingForPosting(ms, ms[i])).toBe(false);
    }
    expect(isNextUpcomingForPosting(ms, ms[4])).toBe(true);
    for (let i = 5; i < 10; i++) {
      expect(isNextUpcomingForPosting(ms, ms[i])).toBe(false);
    }
  });

  it("cancelled matches NEVER become postable, even with nothing earlier", () => {
    const ms = blockAsSchedulerMatches({ 0: "CANCELLED" });
    expect(isNextUpcomingForPosting([ms[0]], ms[0])).toBe(false);
    expect(isNextUpcomingForPosting(ms, ms[0])).toBe(false);
  });

  it("a live earlier match in TEAMS_PUBLISHED still suppresses the rest of the block", () => {
    const ms = blockAsSchedulerMatches({ 0: "TEAMS_PUBLISHED" });
    expect(isNextUpcomingForPosting(ms, ms[1])).toBe(false);
  });
});

// ─────────────────────────── 4. Bulk cancel / restore ─────────────────────

type BulkRow = {
  id: string;
  date: Date;
  status: string;
  isHistorical?: boolean;
};

function blockAsBulkRows(
  statuses: Partial<Record<number, string>> = {},
): BulkRow[] {
  const occ = generateBlockOccurrences(SUTTON_SPEC);
  return occ.map((o, i) => ({
    id: `blk-${String(i).padStart(2, "0")}`,
    date: o.kickoffUtc,
    status: statuses[i] ?? "UPCOMING",
  }));
}

describe("selectCancellable / selectRestorable", () => {
  it("selects exactly the live matches inside the date range (the holiday case)", () => {
    // Holiday: cancel all of September.
    const rows = blockAsBulkRows({ 0: "COMPLETED" });
    const selected = selectCancellable(rows, {
      from: new Date("2026-09-01T00:00:00Z"),
      to: new Date("2026-09-30T23:59:59Z"),
    });
    expect(selected.map((m) => m.id)).toEqual([
      "blk-01",
      "blk-02",
      "blk-03",
      "blk-04",
      "blk-05",
    ]);
  });

  it("excludes COMPLETED, already-CANCELLED and historical matches from cancellation", () => {
    const rows = blockAsBulkRows({ 1: "COMPLETED", 2: "CANCELLED" });
    rows[3].isHistorical = true;
    const selected = selectCancellable(rows, {
      from: new Date("2026-08-01T00:00:00Z"),
      to: new Date("2026-12-31T00:00:00Z"),
    });
    expect(selected.map((m) => m.id)).toEqual([
      "blk-00",
      "blk-04",
      "blk-05",
      "blk-06",
      "blk-07",
      "blk-08",
      "blk-09",
    ]);
  });

  it("range boundaries are inclusive of matches at the exact instants", () => {
    const rows = blockAsBulkRows();
    const selected = selectCancellable(rows, {
      from: new Date("2026-09-01T20:30:00.000Z"),
      to: new Date("2026-09-08T20:30:00.000Z"),
    });
    expect(selected.map((m) => m.id)).toEqual(["blk-01", "blk-02"]);
  });

  it("selectRestorable picks only CANCELLED (non-historical) matches in range", () => {
    const rows = blockAsBulkRows({ 1: "CANCELLED", 2: "CANCELLED" });
    rows[4].status = "CANCELLED";
    rows[4].isHistorical = true;
    const selected = selectRestorable(rows, {
      from: new Date("2026-08-01T00:00:00Z"),
      to: new Date("2026-12-31T00:00:00Z"),
    });
    expect(selected.map((m) => m.id)).toEqual(["blk-01", "blk-02"]);
  });
});

describe("buildBulkCancelAnnouncement (silent by default)", () => {
  const dates = [
    new Date("2026-09-01T20:30:00.000Z"),
    new Date("2026-09-08T20:30:00.000Z"),
  ];

  it("returns null when announce is false — bulk cancel queues NO group message", () => {
    expect(
      buildBulkCancelAnnouncement({
        activityName: "Tuesday 7-a-side",
        dates,
        announce: false,
      }),
    ).toBeNull();
  });

  it("returns null when nothing was cancelled, even with announce ticked", () => {
    expect(
      buildBulkCancelAnnouncement({
        activityName: "Tuesday 7-a-side",
        dates: [],
        announce: true,
      }),
    ).toBeNull();
  });

  it("returns ONE summary message when announce is explicitly ticked, listing London dates", () => {
    const text = buildBulkCancelAnnouncement({
      activityName: "Tuesday 7-a-side",
      dates,
      announce: true,
    });
    expect(text).toBeTruthy();
    expect(text).toContain("Tuesday 7-a-side");
    expect(text).toContain("Tue 1 Sep");
    expect(text).toContain("Tue 8 Sep");
  });
});

// ─────────────────────────── 5. Block deletion partition ──────────────────

describe("partitionBlockMatchesForDeletion (never destroy history)", () => {
  const shell = (id: string, status: string) => ({
    id,
    status,
    isHistorical: false,
    attendanceCount: 0,
    ratingCount: 0,
    momVoteCount: 0,
    teamAssignmentCount: 0,
  });

  it("deletes only empty unplayed shells; detaches everything with history", () => {
    const result = partitionBlockMatchesForDeletion([
      shell("empty-upcoming", "UPCOMING"),
      shell("empty-cancelled", "CANCELLED"),
      { ...shell("played", "COMPLETED") }, // completed → always detach
      { ...shell("has-attendance", "UPCOMING"), attendanceCount: 3 },
      { ...shell("has-ratings", "CANCELLED"), ratingCount: 2 },
      { ...shell("has-mom", "UPCOMING"), momVoteCount: 1 },
      { ...shell("has-teams", "TEAMS_GENERATED"), teamAssignmentCount: 10 },
      { ...shell("historical", "COMPLETED"), isHistorical: true },
    ]);
    expect(result.deleteIds.sort()).toEqual([
      "empty-cancelled",
      "empty-upcoming",
    ]);
    expect(result.detachIds.sort()).toEqual([
      "has-attendance",
      "has-mom",
      "has-ratings",
      "has-teams",
      "historical",
      "played",
    ]);
  });

  it("a COMPLETED match is detached even when its counts are all zero", () => {
    const result = partitionBlockMatchesForDeletion([
      shell("done-but-empty", "COMPLETED"),
    ]);
    expect(result.deleteIds).toEqual([]);
    expect(result.detachIds).toEqual(["done-but-empty"]);
  });
});
