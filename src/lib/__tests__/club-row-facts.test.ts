/**
 * The club's row facts, from a row the caller read or in one read of their
 * own (club summary, slices A3 and A4): the summary's facts of that row, or,
 * when they cannot be built or read, null / "unreadable" with one log line,
 * never a throw.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VETS, featuresFor } from "../club-summary/__tests__/fixtures";
import { clubRowFacts } from "../club-summary/derive";

const calls: Array<Record<string, unknown>> = [];
const db = { row: null as Record<string, unknown> | null, fail: false };
vi.mock("../db", () => ({
  db: {
    organisation: {
      findUnique: async (args: Record<string, unknown>) => {
        calls.push(args);
        if (db.fail) throw new Error("db down");
        return db.row;
      },
    },
  },
}));

import { CLUB_ROW_SELECT, clubRowFactsOf, loadClubRowFacts } from "../club-row-facts";

/** The Vets' row as `CLUB_ROW_SELECT` reads it. */
const VETS_ROW = {
  ...VETS.org,
  featureAttendance: true,
  featureBench: true,
  featureTeamBalancing: true,
  featureMomVoting: true,
  featurePlayerRating: true,
  featureReminders: true,
  featureStatsQa: true,
  featureSquadFromList: false,
  featureBadgeAnnouncements: true,
  featureGearReminder: true,
};

beforeEach(() => {
  calls.length = 0;
  db.row = null;
  db.fail = false;
});
afterEach(() => vi.restoreAllMocks());

describe("clubRowFactsOf", () => {
  it("is clubRowFacts of the row with the row's own switches", () => {
    expect(clubRowFactsOf(VETS_ROW, "test")).toEqual(clubRowFacts(VETS.org, featuresFor(VETS.org)));
  });

  it("a row it cannot build from: null and one log line", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(clubRowFactsOf({ ...VETS_ROW, seasonBreakMonths: undefined } as never, "test")).toBeNull();
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0][0])).toBe("[test] org org-vets: the club summary could not be read; this request reads each fact itself, as before:");
  });
});

describe("loadClubRowFacts", () => {
  it("one read with CLUB_ROW_SELECT, the facts of that row", async () => {
    db.row = VETS_ROW;
    expect(await loadClubRowFacts("org-vets", "test")).toEqual(clubRowFactsOf(VETS_ROW, "test"));
    expect(calls).toEqual([{ where: { id: "org-vets" }, select: CLUB_ROW_SELECT }]);
  });

  it("null for no such club", async () => {
    expect(await loadClubRowFacts("nope", "test")).toBeNull();
  });

  it("the read fails: 'unreadable' and one log line", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    db.fail = true;
    expect(await loadClubRowFacts("org-vets", "test")).toBe("unreadable");
    expect(err).toHaveBeenCalledTimes(1);
  });
});
