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
 * Cancelled-day hold (2026-10-13, Sutton FC): the Tue 13 Oct match was
 * cancelled on the Monday evening, and at 09:00 on Tuesday the bot
 * announced the Tue 20 Oct match, with its 17:00 squad post the same
 * evening: next week's posts began on the very day the cancelled game
 * would have been played. A CANCELLED earlier match in the same fixture
 * suppressed nothing. It must now hold the later match's announcement and
 * 17:00 post until its own London calendar day is over, so the weekly
 * rhythm is the same whether the game was played or cancelled.
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

  it("after the 2026-09-08 kickoff fix, a switched match is no longer CO-TIMED with a ghost — the earlier-in-fixture rule decides, not the id tie-break", () => {
    // Pre-fix, a 5-a-side ghost and the real 7-a-side match shared the
    // exact same timestamp and only the lowest `id` won — arbitrary.
    // The match now moves to 21:15 while a ghost under the still-active
    // 7-a-side Activity would sit at 21:30, so rule (1) decides: the
    // earlier match in the same fixture is the one that posts, whatever
    // the ids happen to be. (Rule (2) stays as belt-and-braces for any
    // genuinely co-timed pair.)
    const real = m({
      id: "zzz-5aside", // deliberately the HIGHER id
      activityId: "tuesday-5aside",
      date: at("2026-09-08T20:15:00Z"), // 21:15 BST — moved by the fix
    });
    const ghost = m({
      id: "aaa-7aside",
      activityId: "tuesday-7aside",
      date: at("2026-09-08T20:30:00Z"), // 21:30 BST
    });
    const all = [real, ghost];
    expect(isNextUpcomingForPosting(all, real)).toBe(true);
    expect(isNextUpcomingForPosting(all, ghost)).toBe(false);
  });

  it("the 2026-07-14 rollover guard still holds once this week's match has moved 15 minutes", () => {
    // This week switched to 5-a-side and moved to 21:15; next week's
    // auto-generated 7-a-side match is at 21:30 a week later. Same
    // fixture, so next week must stay silent.
    const thisWeek = m({
      id: "this",
      activityId: "tuesday-5aside",
      date: at("2026-09-08T20:15:00Z"),
    });
    const nextWeek = m({
      id: "next",
      activityId: "tuesday-7aside",
      date: at("2026-09-15T20:30:00Z"),
    });
    const all = [thisWeek, nextWeek];
    expect(isNextUpcomingForPosting(all, thisWeek)).toBe(true);
    expect(isNextUpcomingForPosting(all, nextWeek)).toBe(false);
  });
});

describe("isNextUpcomingForPosting: a cancelled match holds next week's posts until its day is over", () => {
  /** Tue 13 Oct 2026 21:30 London (BST, UTC+1). Cancelled Mon 12 Oct 18:00. */
  const cancelled13 = m({ id: "tue-13", date: at("2026-10-13T20:30:00Z"), status: "CANCELLED" });
  /** Tue 20 Oct 2026 21:30 London (BST). */
  const upcoming20 = m({ id: "tue-20", date: at("2026-10-20T20:30:00Z") });
  /** Tue 27 Oct 2026 21:30 London (GMT: the clocks went back on 25 Oct). */
  const upcoming27 = m({ id: "tue-27", date: at("2026-10-27T21:30:00Z") });

  it("THE 2026-10-13 INCIDENT: 09:00 London on the cancelled match's day, next week's match is held", () => {
    const all = [cancelled13, upcoming20];
    expect(isNextUpcomingForPosting(all, upcoming20, at("2026-10-13T08:00:00Z"))).toBe(false);
  });

  it("the 17:00 post on the cancelled day is held too, and so is the last minute of that London day", () => {
    const all = [cancelled13, upcoming20];
    expect(isNextUpcomingForPosting(all, upcoming20, at("2026-10-13T16:00:00Z"))).toBe(false);
    // 23:59 London on 13 Oct = 22:59 UTC (BST).
    expect(isNextUpcomingForPosting(all, upcoming20, at("2026-10-13T22:59:00Z"))).toBe(false);
  });

  it("the gate opens at London midnight after the cancelled day, so 09:00 the next morning announces", () => {
    const all = [cancelled13, upcoming20];
    // 00:00 London on 14 Oct = 23:00 UTC on 13 Oct (BST).
    expect(isNextUpcomingForPosting(all, upcoming20, at("2026-10-13T23:00:00Z"))).toBe(true);
    expect(isNextUpcomingForPosting(all, upcoming20, at("2026-10-14T08:00:00Z"))).toBe(true);
  });

  it("held from the moment of cancellation, not only on the day itself (Mon 12 Oct 18:05 London)", () => {
    const all = [cancelled13, upcoming20];
    expect(isNextUpcomingForPosting(all, upcoming20, at("2026-10-12T17:05:00Z"))).toBe(false);
  });

  it("several cancelled weeks in a row: 13 and 20 Oct cancelled, 27 Oct waits until 21 Oct", () => {
    const cancelled20 = { ...upcoming20, status: "CANCELLED" };
    const all = [cancelled13, cancelled20, upcoming27];
    expect(isNextUpcomingForPosting(all, upcoming27, at("2026-10-14T08:00:00Z"))).toBe(false);
    expect(isNextUpcomingForPosting(all, upcoming27, at("2026-10-20T08:00:00Z"))).toBe(false);
    expect(isNextUpcomingForPosting(all, upcoming27, at("2026-10-20T22:59:00Z"))).toBe(false);
    expect(isNextUpcomingForPosting(all, upcoming27, at("2026-10-21T08:00:00Z"))).toBe(true);
  });

  it("a cancelled match whose day has already passed suppresses nothing", () => {
    const all = [cancelled13, upcoming20];
    expect(isNextUpcomingForPosting(all, upcoming20, at("2026-10-15T08:00:00Z"))).toBe(true);
    expect(isNextUpcomingForPosting(all, upcoming20, at("2026-10-19T16:00:00Z"))).toBe(true);
  });

  it("a cancelled match in a DIFFERENT fixture (another weekday, or another venue) suppresses nothing", () => {
    const now = at("2026-10-13T08:00:00Z");
    const otherDay = m({
      id: "thu-cancelled",
      activityId: "thursday-5aside",
      date: at("2026-10-13T19:00:00Z"),
      status: "CANCELLED",
      activity: { ...TUE_SLOT, dayOfWeek: 4 },
    });
    const otherVenue = m({
      id: "wimbledon-cancelled",
      activityId: "tuesday-wimbledon",
      date: at("2026-10-13T19:00:00Z"),
      status: "CANCELLED",
      activity: { ...TUE_SLOT, venue: "Goals Wimbledon" },
    });
    expect(isNextUpcomingForPosting([otherDay, otherVenue, upcoming20], upcoming20, now)).toBe(true);
  });

  it("a cancelled match LATER than the target, or co-timed with it, suppresses nothing", () => {
    const now = at("2026-10-13T08:00:00Z");
    const live13 = { ...cancelled13, status: "UPCOMING" };
    const cancelled20 = { ...upcoming20, status: "CANCELLED" };
    expect(isNextUpcomingForPosting([live13, cancelled20], live13, now)).toBe(true);
    // A cancelled ghost sharing the kickoff instant (format switch) is not
    // "strictly earlier" and must never silence the real match.
    const ghost = m({ id: "aaa-ghost", activityId: "tuesday-5aside", date: live13.date, status: "CANCELLED" });
    expect(isNextUpcomingForPosting([ghost, live13], live13, now)).toBe(true);
  });

  it("a format-switched cancelled match (other activity, same fixture) still holds next week", () => {
    const switched = { ...cancelled13, activityId: "tuesday-5aside", date: at("2026-10-13T20:15:00Z") };
    expect(isNextUpcomingForPosting([switched, upcoming20], upcoming20, at("2026-10-13T08:00:00Z"))).toBe(false);
  });

  it("a historical cancelled match suppresses nothing", () => {
    const hist = { ...cancelled13, isHistorical: true };
    expect(isNextUpcomingForPosting([hist, upcoming20], upcoming20, at("2026-10-13T08:00:00Z"))).toBe(true);
  });

  it("the hold is opt-in: without a clock the gate ignores cancelled matches, as it always did", () => {
    // The callers tied to the next match's own clock (weekly deadlines,
    // the month's list, the organiser pick, the deadline summary) pass no
    // clock and are not held.
    expect(isNextUpcomingForPosting([cancelled13, upcoming20], upcoming20)).toBe(true);
  });

  it("a live earlier match still suppresses with a clock, whatever the time", () => {
    const live13 = { ...cancelled13, status: "TEAMS_PUBLISHED" };
    expect(isNextUpcomingForPosting([live13, upcoming20], upcoming20, at("2026-10-14T08:00:00Z"))).toBe(false);
  });

  describe("across a clock change (London days are 25 and 23 hours long)", () => {
    it("autumn: cancelled Sun 25 Oct 2026 (the 25-hour day) holds until London midnight, which is 00:00 UTC on the 26th", () => {
      const sunSlot = { ...TUE_SLOT, dayOfWeek: 0 };
      // Sun 25 Oct 10:00 London (GMT by then) and Sun 1 Nov 10:00 London.
      const cancelled = m({ id: "sun-25", date: at("2026-10-25T10:00:00Z"), status: "CANCELLED", activity: sunSlot });
      const next = m({ id: "sun-01", date: at("2026-11-01T10:00:00Z"), activity: sunSlot });
      const all = [cancelled, next];
      // 00:30 BST on the 25th = 23:30 UTC on the 24th: already the cancelled day.
      expect(isNextUpcomingForPosting(all, next, at("2026-10-24T23:30:00Z"))).toBe(false);
      // 23:30 GMT on the 25th. A 24-hour day counted from London midnight
      // (23:00 UTC on the 24th) would have ended half an hour ago.
      expect(isNextUpcomingForPosting(all, next, at("2026-10-25T23:30:00Z"))).toBe(false);
      expect(isNextUpcomingForPosting(all, next, at("2026-10-26T00:00:00Z"))).toBe(true);
      expect(isNextUpcomingForPosting(all, next, at("2026-10-26T09:00:00Z"))).toBe(true);
    });

    it("autumn, the Tuesday fixture: cancelled 20 Oct (BST) opens on 21 Oct; cancelled 27 Oct (GMT) opens on 28 Oct", () => {
      const cancelled20 = { ...upcoming20, status: "CANCELLED" };
      expect(isNextUpcomingForPosting([cancelled20, upcoming27], upcoming27, at("2026-10-20T22:59:00Z"))).toBe(false);
      expect(isNextUpcomingForPosting([cancelled20, upcoming27], upcoming27, at("2026-10-20T23:00:00Z"))).toBe(true);
      const cancelled27 = { ...upcoming27, status: "CANCELLED" };
      const upcoming03 = m({ id: "tue-03", date: at("2026-11-03T21:30:00Z") });
      // 23:30 London (GMT) on 27 Oct: an hour-off (BST) reading would call this the 28th.
      expect(isNextUpcomingForPosting([cancelled27, upcoming03], upcoming03, at("2026-10-27T23:30:00Z"))).toBe(false);
      expect(isNextUpcomingForPosting([cancelled27, upcoming03], upcoming03, at("2026-10-28T00:00:00Z"))).toBe(true);
    });

    it("spring: cancelled Sun 29 Mar 2026 (the 23-hour day) holds until 23:00 UTC, London midnight in BST", () => {
      const sunSlot = { ...TUE_SLOT, dayOfWeek: 0 };
      const cancelled = m({ id: "sun-29", date: at("2026-03-29T09:00:00Z"), status: "CANCELLED", activity: sunSlot });
      const next = m({ id: "sun-05", date: at("2026-04-05T09:00:00Z"), activity: sunSlot });
      const all = [cancelled, next];
      expect(isNextUpcomingForPosting(all, next, at("2026-03-29T22:59:00Z"))).toBe(false);
      expect(isNextUpcomingForPosting(all, next, at("2026-03-29T23:00:00Z"))).toBe(true);
    });
  });
});

