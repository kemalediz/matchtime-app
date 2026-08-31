/**
 * Unit tests for the RECRUIT CHASE-UP pure core.
 *
 * Feature (owner, 2026-08-31): when the recruit blast DMs recent players
 * to fill a short squad, some never reply. Send exactly ONE follow-up
 * chase to the ones who stayed completely silent, and never a second.
 *
 * The owner's rules, restated as assertions:
 *   - ONE chase only. Two messages per player per match, ever.
 *   - ANY response at all stops the chase. Only true silence is chased.
 *   - Roughly 3h after that player's own invite DM.
 *   - Only while the squad is still short and the match is still live.
 *   - Never to a player who opted out of match-invite DMs.
 *   - Never in the middle of the night.
 *
 * Pure logic — no DB, no LLM, no clock except the injected `now`.
 */
import { describe, it, expect } from "vitest";
import {
  RECRUIT_CHASE_AFTER_MS,
  RECRUIT_CHASE_HOUR_START,
  RECRUIT_CHASE_HOUR_END,
  shouldChaseRecruit,
  isSociableChaseHour,
  isMatchChaseable,
  recruitChaseKey,
  buildRecruitChaseText,
  type ShouldChaseRecruitInput,
} from "@/lib/recruit-chase";

const HOUR = 60 * 60 * 1000;

/** A London wall-clock instant, DST-safe enough for these fixed dates. */
function london(iso: string): Date {
  // September 2026 is BST (UTC+1).
  return new Date(`${iso}+01:00`);
}

/** Midday on a normal day — comfortably inside the sociable window. */
const NOON = london("2026-09-01T12:00:00");

/** The happy path: invited 3h ago, silent, squad short, all clear. */
function base(): ShouldChaseRecruitInput {
  return {
    invitedAt: new Date(NOON.getTime() - 3 * HOUR),
    now: NOON,
    hasResponded: false,
    squadShort: true,
    matchLive: true,
    subscribed: true,
    alreadyChased: false,
  };
}

describe("RECRUIT_CHASE_AFTER_MS", () => {
  it("is 3 hours", () => {
    expect(RECRUIT_CHASE_AFTER_MS).toBe(3 * HOUR);
  });
});

describe("shouldChaseRecruit", () => {
  it("chases a silent player 3h after their invite while the squad is short", () => {
    expect(shouldChaseRecruit(base())).toBe(true);
  });

  it("chases when well past 3h too (a late poll still fires the one chase)", () => {
    expect(
      shouldChaseRecruit({ ...base(), invitedAt: new Date(NOON.getTime() - 9 * HOUR) }),
    ).toBe(true);
  });

  it("does NOT chase before 3h have elapsed", () => {
    expect(
      shouldChaseRecruit({ ...base(), invitedAt: new Date(NOON.getTime() - 2.9 * HOUR) }),
    ).toBe(false);
  });

  it("fires exactly at the 3h boundary", () => {
    expect(
      shouldChaseRecruit({ ...base(), invitedAt: new Date(NOON.getTime() - RECRUIT_CHASE_AFTER_MS) }),
    ).toBe(true);
  });

  it("does NOT chase when we have no record of inviting them", () => {
    expect(shouldChaseRecruit({ ...base(), invitedAt: null })).toBe(false);
  });

  it("does NOT chase when the player responded (any route, any answer)", () => {
    expect(shouldChaseRecruit({ ...base(), hasResponded: true })).toBe(false);
  });

  it("does NOT chase a second time — one chase per player per match, ever", () => {
    expect(shouldChaseRecruit({ ...base(), alreadyChased: true })).toBe(false);
  });

  it("does NOT chase once the squad has filled", () => {
    expect(shouldChaseRecruit({ ...base(), squadShort: false })).toBe(false);
  });

  it("does NOT chase when the match is no longer live", () => {
    expect(shouldChaseRecruit({ ...base(), matchLive: false })).toBe(false);
  });

  it("does NOT chase a player who opted out of match-invite DMs", () => {
    expect(shouldChaseRecruit({ ...base(), subscribed: false })).toBe(false);
  });

  it("does NOT chase in the middle of the night", () => {
    const threeAm = london("2026-09-01T03:00:00");
    expect(
      shouldChaseRecruit({
        ...base(),
        now: threeAm,
        invitedAt: new Date(threeAm.getTime() - 4 * HOUR),
      }),
    ).toBe(false);
  });

  it("still refuses when several stop-conditions apply at once", () => {
    expect(
      shouldChaseRecruit({
        ...base(),
        hasResponded: true,
        squadShort: false,
        subscribed: false,
        alreadyChased: true,
      }),
    ).toBe(false);
  });
});

describe("isSociableChaseHour", () => {
  it("matches the bench-slot-offer daytime gate: 08:00 to 21:59 London", () => {
    expect(RECRUIT_CHASE_HOUR_START).toBe(8);
    expect(RECRUIT_CHASE_HOUR_END).toBe(22);
  });

  it("is false at 07:59 and true from 08:00", () => {
    expect(isSociableChaseHour(london("2026-09-01T07:59:00"))).toBe(false);
    expect(isSociableChaseHour(london("2026-09-01T08:00:00"))).toBe(true);
  });

  it("is true at 21:59 and false from 22:00", () => {
    expect(isSociableChaseHour(london("2026-09-01T21:59:00"))).toBe(true);
    expect(isSociableChaseHour(london("2026-09-01T22:00:00"))).toBe(false);
  });

  it("is false at 03:00", () => {
    expect(isSociableChaseHour(london("2026-09-01T03:00:00"))).toBe(false);
  });

  it("reads the LONDON hour, not UTC (BST offset)", () => {
    // 07:30 UTC on a BST day is 08:30 London — inside the window.
    expect(isSociableChaseHour(new Date("2026-09-01T07:30:00Z"))).toBe(true);
    // 22:30 UTC on a BST day is 23:30 London — outside it.
    expect(isSociableChaseHour(new Date("2026-09-01T22:30:00Z"))).toBe(false);
  });
});

describe("isMatchChaseable", () => {
  const now = NOON;
  const deadline = new Date(NOON.getTime() + 5 * HOUR);

  it("is true for an UPCOMING match before its attendance deadline", () => {
    expect(isMatchChaseable({ status: "UPCOMING", attendanceDeadline: deadline, now })).toBe(true);
  });

  it("is true once teams are generated or published (squad can still change)", () => {
    expect(
      isMatchChaseable({ status: "TEAMS_GENERATED", attendanceDeadline: deadline, now }),
    ).toBe(true);
    expect(
      isMatchChaseable({ status: "TEAMS_PUBLISHED", attendanceDeadline: deadline, now }),
    ).toBe(true);
  });

  it("is false for a CANCELLED match", () => {
    expect(isMatchChaseable({ status: "CANCELLED", attendanceDeadline: deadline, now })).toBe(false);
  });

  it("is false for a COMPLETED match", () => {
    expect(isMatchChaseable({ status: "COMPLETED", attendanceDeadline: deadline, now })).toBe(false);
  });

  it("is false once the attendance deadline has passed", () => {
    expect(
      isMatchChaseable({
        status: "UPCOMING",
        attendanceDeadline: new Date(NOON.getTime() - 1),
        now,
      }),
    ).toBe(false);
  });
});

describe("recruitChaseKey", () => {
  it("is scoped per match and per user", () => {
    expect(recruitChaseKey("match-1", "user-1")).toBe("match-1:recruit-chase:user-1");
  });

  it("never collides with the invite key it follows", () => {
    expect(recruitChaseKey("match-1", "user-1")).not.toBe("match-1:recruit-dm:user-1");
  });
});

describe("buildRecruitChaseText", () => {
  const text = buildRecruitChaseText({
    playerName: "Ian Innes",
    activityName: "Tuesday Football",
    matchWhen: "Tue 2 Sep, 20:00",
    need: 2,
  });

  it("opens on the player's first name only", () => {
    expect(text).toContain("Ian");
    expect(text).not.toContain("Innes");
  });

  it("says how many are still needed, and names the match and the time", () => {
    expect(text).toContain("2 players");
    expect(text).toContain("Tuesday Football");
    expect(text).toContain("Tue 2 Sep, 20:00");
  });

  it("tells them how to make it stop", () => {
    expect(text).toMatch(/\*OUT\*/);
    expect(text).toMatch(/stop asking/i);
  });

  it("offers the one-word IN reply", () => {
    expect(text).toMatch(/\*IN\*/);
  });

  it("singularises a one-player shortfall", () => {
    const one = buildRecruitChaseText({
      playerName: "Ian Innes",
      activityName: "Tuesday Football",
      matchWhen: "Tue 2 Sep, 20:00",
      need: 1,
    });
    expect(one).toContain("1 player");
    expect(one).not.toContain("1 players");
  });

  it("falls back gracefully when we have no name on file", () => {
    const anon = buildRecruitChaseText({
      playerName: null,
      activityName: "Tuesday Football",
      matchWhen: "Tue 2 Sep, 20:00",
      need: 1,
    });
    expect(anon).toContain("👋");
    expect(anon).not.toContain("null");
  });

  it("keeps house style: no em dashes and no slashes", () => {
    expect(text).not.toMatch(/[—–]/);
    expect(text).not.toContain("/");
  });

  it("stays short enough to read on a lock screen", () => {
    expect(text.length).toBeLessThanOrEqual(200);
  });
});
