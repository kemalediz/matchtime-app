/**
 * Unit tests for the "is this the match the bot should post about?" gate
 * used by the scheduler's announce-match and 17:00 evening-update paths.
 *
 * Original purpose: when next week's match in the SAME activity has just
 * been auto-created, only the current week's match should fire its posts —
 * the announcement/chase should always read "next match", never
 * "next-but-one".
 *
 * Defense-in-depth bug (2026-06-27, Sutton FC ghost): a format switch can
 * leave two matches sharing the EXACT same kickoff timestamp (the real
 * 5-a-side one with players + an empty 7-a-side ghost). The gate keyed on
 * `date < m.date` (STRICT less-than), so neither co-timed match is
 * "strictly earlier" than the other → both passed the gate and both fired
 * their own post. Add a deterministic tie-break: among co-timed matches,
 * only the one with the lowest `id` is treated as next-upcoming.
 *
 * Format-switch rollover bug (2026-07-14, Sutton FC): the "strictly
 * earlier" rollover guard was keyed on `activityId`. `switchMatchFormat`
 * re-points this week's Match to the other-format Activity
 * (tuesday-7aside → tuesday-5aside), so this week's match and next week's
 * auto-generated match no longer shared an activityId — the guard never
 * fired and next week's match was announced while this week's was still
 * live. The guard must key on the recurring FIXTURE — same
 * (orgId, venue, dayOfWeek) — NOT on activityId, and deliberately NOT on
 * the configured kickoff time (the two formats of one fixture have
 * different times: 21:30 vs 21:15).
 *
 * Pure logic — no DB. The scheduler loads the org's matches once and
 * delegates the decision here so it's unit-testable.
 */
import { describe, it, expect } from "vitest";
import {
  isNextUpcomingForPosting,
  type SchedulerMatch,
} from "@/lib/next-upcoming-match";

const at = (iso: string): Date => new Date(iso);

/** Sutton FC's Tuesday fixture: shared by both format activities. */
const TUE_SLOT = { orgId: "sutton-fc", venue: "Goals North Cheam", dayOfWeek: 2 };

const m = (over: Partial<SchedulerMatch> & { id: string }): SchedulerMatch => ({
  activityId: "tuesday-7aside",
  date: at("2026-06-30T19:30:00Z"),
  status: "UPCOMING",
  isHistorical: false,
  activity: TUE_SLOT,
  ...over,
});

describe("isNextUpcomingForPosting", () => {
  it("single match is next-upcoming", () => {
    const a = m({ id: "a" });
    expect(isNextUpcomingForPosting([a], a)).toBe(true);
  });

  it("THE 2026-07-14 REGRESSION: after a format switch, this week's match (other activity, same fixture) suppresses next week's", () => {
    // Prod scenario: admin switched THIS WEEK's match to 5-a-side, so it
    // now lives on tuesday-5aside; next week's auto-generated match is on
    // tuesday-7aside. Same org, same venue, same weekday — the SAME
    // recurring fixture. Next week's match must NOT be announced while
    // this week's is still live.
    const thisWeek = m({
      id: "match-a",
      activityId: "tuesday-5aside",
      date: at("2026-07-14T20:30:00Z"),
    });
    const nextWeek = m({
      id: "match-b",
      activityId: "tuesday-7aside",
      date: at("2026-07-21T20:30:00Z"),
    });
    const all = [thisWeek, nextWeek];
    expect(isNextUpcomingForPosting(all, thisWeek)).toBe(true);
    expect(isNextUpcomingForPosting(all, nextWeek)).toBe(false);
  });

  it("this week's match wins; next week's same-activity match is NOT next-upcoming", () => {
    const thisWeek = m({ id: "this", date: at("2026-06-30T19:30:00Z") });
    const nextWeek = m({ id: "next", date: at("2026-07-07T19:30:00Z") });
    const all = [thisWeek, nextWeek];
    expect(isNextUpcomingForPosting(all, thisWeek)).toBe(true);
    expect(isNextUpcomingForPosting(all, nextWeek)).toBe(false);
  });

  it("THE BUG (2026-06-27): two co-timed matches (different activities, same timestamp) — only the lower id fires", () => {
    const real = m({ id: "aaa-5aside", activityId: "tuesday-5aside" });
    const ghost = m({ id: "zzz-7aside", activityId: "tuesday-7aside" });
    const all = [real, ghost];
    expect(isNextUpcomingForPosting(all, real)).toBe(true); // lower id
    expect(isNextUpcomingForPosting(all, ghost)).toBe(false); // co-timed, higher id → suppressed
  });

  it("preserves multi-activity orgs: a different weekday is a different fixture — an earlier Tuesday does NOT suppress a later Thursday", () => {
    const tue = m({
      id: "tue",
      activityId: "tue",
      date: at("2026-06-30T19:30:00Z"),
      activity: { ...TUE_SLOT, dayOfWeek: 2 },
    });
    const thu = m({
      id: "thu",
      activityId: "thu",
      date: at("2026-07-02T19:30:00Z"),
      activity: { ...TUE_SLOT, dayOfWeek: 4 },
    });
    const all = [tue, thu];
    expect(isNextUpcomingForPosting(all, tue)).toBe(true);
    expect(isNextUpcomingForPosting(all, thu)).toBe(true);
  });

  it("preserves multi-activity orgs: a different venue on the SAME weekday is a different fixture", () => {
    const cheam = m({
      id: "cheam",
      activityId: "tue-cheam",
      date: at("2026-06-30T19:30:00Z"),
    });
    const wimbledon = m({
      id: "wimbledon",
      activityId: "tue-wimbledon",
      date: at("2026-07-07T20:00:00Z"),
      activity: { ...TUE_SLOT, venue: "PowerLeague Wimbledon" },
    });
    const all = [cheam, wimbledon];
    expect(isNextUpcomingForPosting(all, cheam)).toBe(true);
    expect(isNextUpcomingForPosting(all, wimbledon)).toBe(true);
  });

  it("falls back to activityId comparison when slot fields are absent", () => {
    // Callers that can't supply activity slot data keep the original
    // same-activity rollover behaviour.
    const thisWeek = m({ id: "this", activity: undefined, date: at("2026-06-30T19:30:00Z") });
    const nextWeek = m({ id: "next", activity: undefined, date: at("2026-07-07T19:30:00Z") });
    const otherAct = m({
      id: "other",
      activity: undefined,
      activityId: "thursday-6aside",
      date: at("2026-07-02T19:30:00Z"),
    });
    const all = [thisWeek, nextWeek, otherAct];
    expect(isNextUpcomingForPosting(all, thisWeek)).toBe(true);
    expect(isNextUpcomingForPosting(all, nextWeek)).toBe(false); // same activityId, earlier live match
    expect(isNextUpcomingForPosting(all, otherAct)).toBe(true); // different activityId → independent
  });

  it("same activityId always suppresses, even when only one side carries slot fields", () => {
    const thisWeek = m({ id: "this", activity: undefined, date: at("2026-06-30T19:30:00Z") });
    const nextWeek = m({ id: "next", date: at("2026-07-07T19:30:00Z") });
    expect(isNextUpcomingForPosting([thisWeek, nextWeek], nextWeek)).toBe(false);
  });

  it("ignores historical and completed/cancelled matches", () => {
    const target = m({ id: "target" });
    const historical = m({ id: "aaa-hist", isHistorical: true });
    const completed = m({ id: "aaa-done", status: "COMPLETED" });
    const cancelled = m({ id: "aaa-cxl", status: "CANCELLED" });
    const all = [target, historical, completed, cancelled];
    // Even though hist/done/cxl have lower ids and same timestamp, they
    // don't count as live blockers → target still fires.
    expect(isNextUpcomingForPosting(all, target)).toBe(true);
  });

  it("historical/completed/cancelled matches on the same fixture don't block next week's match either", () => {
    const lastWeekDone = m({
      id: "done",
      activityId: "tuesday-5aside",
      date: at("2026-07-14T20:30:00Z"),
      status: "COMPLETED",
    });
    const nextWeek = m({ id: "next", date: at("2026-07-21T20:30:00Z") });
    expect(isNextUpcomingForPosting([lastWeekDone, nextWeek], nextWeek)).toBe(true);
  });

  it("treats TEAMS_GENERATED / TEAMS_PUBLISHED as live blockers", () => {
    const earlier = m({ id: "earlier", date: at("2026-06-23T19:30:00Z"), status: "TEAMS_PUBLISHED" });
    const target = m({ id: "target", date: at("2026-06-30T19:30:00Z") });
    expect(isNextUpcomingForPosting([earlier, target], target)).toBe(false);
  });
});
