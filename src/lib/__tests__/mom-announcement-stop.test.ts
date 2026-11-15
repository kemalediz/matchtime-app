/**
 * The MoM announcement's next-fixture stop, as ONE pure rule (review
 * 2026-11-15): the scheduler gives up on a match's announcement once the
 * club's next fixture has kicked off, and the last-MoM answer reads the
 * same rule to know that match's result is decided.
 */
import { describe, expect, it } from "vitest";
import { momAnnouncementSuperseded, type MomFixtureMatch } from "../mom-announcement-stop";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-15T12:00:00Z");
const TUE = { orgId: "org-1", venue: "Goals Sutton", dayOfWeek: 2 };

const match = (id: string, daysAgo: number, o: Partial<MomFixtureMatch> = {}): MomFixtureMatch => ({
  id,
  date: new Date(NOW.getTime() - daysAgo * DAY),
  status: "COMPLETED",
  activityId: "act-tue-7",
  activity: TUE,
  ...o,
});

describe("momAnnouncementSuperseded", () => {
  const a = match("a", 4);

  it("a later fixture of the same activity that has kicked off supersedes it", () => {
    expect(momAnnouncementSuperseded(a, [a, match("b", 1)], NOW)).toBe(true);
  });

  it("a format-switched successor (another activity, same fixture) supersedes it", () => {
    expect(momAnnouncementSuperseded(a, [match("b", 1, { activityId: "act-tue-5" })], NOW)).toBe(true);
  });

  it("a later fixture that has not kicked off yet does not", () => {
    expect(momAnnouncementSuperseded(a, [match("b", -1, { status: "UPCOMING" })], NOW)).toBe(false);
  });

  it("a kicked-off match still UPCOMING (not marked completed yet) does", () => {
    expect(momAnnouncementSuperseded(a, [match("b", 1, { status: "UPCOMING" })], NOW)).toBe(true);
  });

  it("a cancelled later fixture does not", () => {
    expect(momAnnouncementSuperseded(a, [match("b", 1, { status: "CANCELLED" })], NOW)).toBe(false);
  });

  it("a co-timed ghost (under a day later) does not", () => {
    expect(momAnnouncementSuperseded(a, [match("ghost", 4 - 2 / 24, { activityId: "act-tue-5" })], NOW)).toBe(false);
  });

  it("another weekly fixture of the club (another day or venue) does not", () => {
    expect(
      momAnnouncementSuperseded(a, [match("thu", 2, { activityId: "act-thu", activity: { ...TUE, dayOfWeek: 4 } })], NOW),
    ).toBe(false);
    expect(
      momAnnouncementSuperseded(a, [match("x", 1, { activityId: "act-x", activity: { ...TUE, orgId: "org-2" } })], NOW),
    ).toBe(false);
  });

  it("the match itself, and older ones, never do", () => {
    expect(momAnnouncementSuperseded(a, [a, match("old", 11)], NOW)).toBe(false);
  });
});
