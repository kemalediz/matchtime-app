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
 * Pure logic — no DB. The scheduler loads the org's matches once and
 * delegates the decision here so it's unit-testable.
 */
import { describe, it, expect } from "vitest";
import {
  isNextUpcomingForPosting,
  type SchedulerMatch,
} from "@/lib/next-upcoming-match";

const at = (iso: string): Date => new Date(iso);

const m = (over: Partial<SchedulerMatch> & { id: string }): SchedulerMatch => ({
  activityId: "tuesday-7aside",
  date: at("2026-06-30T19:30:00Z"),
  status: "UPCOMING",
  isHistorical: false,
  ...over,
});

describe("isNextUpcomingForPosting", () => {
  it("single match is next-upcoming", () => {
    const a = m({ id: "a" });
    expect(isNextUpcomingForPosting([a], a)).toBe(true);
  });

  it("THE BUG: two co-timed matches (different activities, same timestamp) — only the lower id fires", () => {
    const real = m({ id: "aaa-5aside", activityId: "tuesday-5aside" });
    const ghost = m({ id: "zzz-7aside", activityId: "tuesday-7aside" });
    const all = [real, ghost];
    expect(isNextUpcomingForPosting(all, real)).toBe(true); // lower id
    expect(isNextUpcomingForPosting(all, ghost)).toBe(false); // co-timed, higher id → suppressed
  });

  it("this week's match wins; next week's same-activity match is NOT next-upcoming", () => {
    const thisWeek = m({ id: "this", date: at("2026-06-30T19:30:00Z") });
    const nextWeek = m({ id: "next", date: at("2026-07-07T19:30:00Z") });
    const all = [thisWeek, nextWeek];
    expect(isNextUpcomingForPosting(all, thisWeek)).toBe(true);
    expect(isNextUpcomingForPosting(all, nextWeek)).toBe(false);
  });

  it("preserves multi-activity orgs: different activity at a DIFFERENT time does not suppress", () => {
    // A Tuesday game and a Thursday game are separate slots — each is its
    // own next-upcoming. An earlier-but-different-activity match must not
    // suppress the later one.
    const tue = m({ id: "tue", activityId: "tue", date: at("2026-06-30T19:30:00Z") });
    const thu = m({ id: "thu", activityId: "thu", date: at("2026-07-02T19:30:00Z") });
    const all = [tue, thu];
    expect(isNextUpcomingForPosting(all, tue)).toBe(true);
    expect(isNextUpcomingForPosting(all, thu)).toBe(true);
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

  it("treats TEAMS_GENERATED / TEAMS_PUBLISHED as live blockers", () => {
    const earlier = m({ id: "earlier", date: at("2026-06-23T19:30:00Z"), status: "TEAMS_PUBLISHED" });
    const target = m({ id: "target", date: at("2026-06-30T19:30:00Z") });
    expect(isNextUpcomingForPosting([earlier, target], target)).toBe(false);
  });
});
