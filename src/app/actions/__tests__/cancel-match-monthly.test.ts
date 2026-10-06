/**
 * Monthly squad, slice 6: the cancel and restore actions are SHARED with
 * every weekly club, so this pins both sides of the one branch added to
 * each:
 *
 *  - a club on "weekly" (Sutton FC and every club before this): the
 *    month-close module is never loaded or called, and the announcement is
 *    byte for byte what `buildMatchCancelledAnnouncement` /
 *    `buildBulkCancelAnnouncement` produce on their own;
 *  - a club on "monthly": the credits are reconciled, and the SAME
 *    announcement carries one extra line (one post per event), only when a
 *    game actually credited somebody.
 *
 * auth / db / org / next-cache / month-close are mocked: no live DB.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildMatchCancelledAnnouncement } from "@/lib/group-copy";
import { buildBulkCancelAnnouncement } from "@/lib/block-booking";
import { dayTimeLabel } from "@/lib/i18n/dates";

const authMock = vi.fn();
const requireOrgAdmin = vi.fn();
const matchFindUnique = vi.fn();
const matchFindMany = vi.fn();
const matchUpdate = vi.fn();
const matchUpdateMany = vi.fn();
const orgFindUnique = vi.fn();
const botJobCreate = vi.fn();
const afterMatchesCancelled = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/org", () => ({ requireOrgAdmin: (...a: unknown[]) => requireOrgAdmin(...a) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/attendance-events", () => ({ recordAttendanceEvent: vi.fn() }));
vi.mock("@/lib/email", () => ({ sendRatingEmails: vi.fn() }));
vi.mock("@/lib/membership-elo", () => ({ applyMembershipEloDeltas: vi.fn(), loadMembershipEloInputs: vi.fn() }));
vi.mock("@/lib/rolling-squad", () => ({ findCarryOverSource: vi.fn(), seedRollingSquad: vi.fn() }));
vi.mock("@/lib/month-close", () => ({ afterMatchesCancelled: (...a: unknown[]) => afterMatchesCancelled(...a) }));
vi.mock("@/lib/db", () => ({
  db: {
    match: {
      findUnique: (...a: unknown[]) => matchFindUnique(...a),
      findMany: (...a: unknown[]) => matchFindMany(...a),
      update: (...a: unknown[]) => matchUpdate(...a),
      updateMany: (...a: unknown[]) => matchUpdateMany(...a),
    },
    organisation: { findUnique: (...a: unknown[]) => orgFindUnique(...a) },
    botJob: { create: (...a: unknown[]) => botJobCreate(...a) },
  },
}));

import { cancelMatch } from "../matches";
import { bulkCancelMatches, bulkRestoreMatches } from "../block-bookings";

const DATE = new Date("2026-10-19T19:00:00.000Z");
const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
const single = (squadMode: string, language = "en") => ({
  id: "m1",
  status: "UPCOMING",
  date: DATE,
  activity: { orgId: "org1", name: "Monday 7-a-side", org: { language, squadMode } },
});
const WEEKLY_TEXT = buildMatchCancelledAnnouncement({ activityName: "Monday 7-a-side", whenLabel: dayTimeLabel("en", DATE), lang: "en" });

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: "admin" } });
  requireOrgAdmin.mockResolvedValue(undefined);
  matchUpdate.mockResolvedValue({});
  matchUpdateMany.mockResolvedValue({ count: 1 });
  botJobCreate.mockResolvedValue({});
  afterMatchesCancelled.mockResolvedValue({ creditedGames: 0 });
});

describe("cancelMatch", () => {
  it("a weekly club: the announcement is unchanged and the month is never consulted", async () => {
    matchFindUnique.mockResolvedValue(single("weekly"));
    await cancelMatch("m1");
    expect(afterMatchesCancelled).not.toHaveBeenCalled();
    expect(botJobCreate).toHaveBeenCalledTimes(1);
    expect(botJobCreate.mock.calls[0][0]).toEqual({ data: { orgId: "org1", kind: "group", text: WEEKLY_TEXT } });
  });

  it("a monthly club whose game credited the regulars: one post, with one more line", async () => {
    matchFindUnique.mockResolvedValue(single("monthly"));
    afterMatchesCancelled.mockResolvedValue({ creditedGames: 1 });
    await cancelMatch("m1");
    expect(afterMatchesCancelled).toHaveBeenCalledWith("org1", ["m1"]);
    expect(botJobCreate).toHaveBeenCalledTimes(1);
    expect(botJobCreate.mock.calls[0][0].data.text).toBe(`${WEEKLY_TEXT}\nRegulars get 1 game credit for it.`);
  });

  it("a monthly club whose game is in no month: the plain announcement", async () => {
    matchFindUnique.mockResolvedValue(single("monthly"));
    await cancelMatch("m1");
    expect(afterMatchesCancelled).toHaveBeenCalledTimes(1);
    expect(botJobCreate.mock.calls[0][0].data.text).toBe(WEEKLY_TEXT);
  });

  it("the line is in the club's language", async () => {
    matchFindUnique.mockResolvedValue(single("monthly", "tr"));
    afterMatchesCancelled.mockResolvedValue({ creditedGames: 1 });
    await cancelMatch("m1");
    expect(botJobCreate.mock.calls[0][0].data.text.endsWith("\nDaimi oyunculara 1 maç kredisi yazıldı.")).toBe(true);
  });

  it("cancelling an already cancelled match does nothing at all", async () => {
    matchFindUnique.mockResolvedValue({ ...single("monthly"), status: "CANCELLED" });
    await cancelMatch("m1");
    expect(matchUpdate).not.toHaveBeenCalled();
    expect(afterMatchesCancelled).not.toHaveBeenCalled();
    expect(botJobCreate).not.toHaveBeenCalled();
  });
});

describe("bulkCancelMatches", () => {
  const rows = (squadMode: string) => [
    { id: "m1", date: FUTURE, status: "UPCOMING", isHistorical: false, activity: { orgId: "org1", name: "Monday 7-a-side", org: { squadMode } } },
    { id: "m2", date: new Date(FUTURE.getTime() + 7 * 24 * 60 * 60 * 1000), status: "UPCOMING", isHistorical: false, activity: { orgId: "org1", name: "Monday 7-a-side", org: { squadMode } } },
  ];
  const plain = (r: ReturnType<typeof rows>) =>
    buildBulkCancelAnnouncement({ activityName: "Monday 7-a-side", dates: r.map((m) => m.date), announce: true, lang: "en" });

  it("a weekly club: the announcement is unchanged and the month is never consulted", async () => {
    const r = rows("weekly");
    matchFindMany.mockResolvedValue(r);
    orgFindUnique.mockResolvedValue({ language: "en", squadMode: "weekly" });
    await bulkCancelMatches({ matchIds: ["m1", "m2"], announce: true });
    expect(afterMatchesCancelled).not.toHaveBeenCalled();
    expect(botJobCreate.mock.calls[0][0].data.text).toBe(plain(r));
  });

  it("a monthly club: the credits are written, and the announced batch says so once", async () => {
    const r = rows("monthly");
    matchFindMany.mockResolvedValue(r);
    orgFindUnique.mockResolvedValue({ language: "en", squadMode: "monthly" });
    afterMatchesCancelled.mockResolvedValue({ creditedGames: 2 });
    await bulkCancelMatches({ matchIds: ["m1", "m2"], announce: true });
    expect(afterMatchesCancelled).toHaveBeenCalledWith("org1", ["m1", "m2"]);
    expect(botJobCreate).toHaveBeenCalledTimes(1);
    expect(botJobCreate.mock.calls[0][0].data.text).toBe(`${plain(r)}\nRegulars get a game credit for each of the 2 games.`);
  });

  it("a monthly club, not announced: the credits are still written, and nothing is posted", async () => {
    matchFindMany.mockResolvedValue(rows("monthly"));
    orgFindUnique.mockResolvedValue({ language: "en", squadMode: "monthly" });
    afterMatchesCancelled.mockResolvedValue({ creditedGames: 2 });
    await bulkCancelMatches({ matchIds: ["m1", "m2"] });
    expect(afterMatchesCancelled).toHaveBeenCalledTimes(1);
    expect(botJobCreate).not.toHaveBeenCalled();
  });
});

describe("bulkRestoreMatches", () => {
  const row = (squadMode: string) => [{ id: "m1", date: FUTURE, status: "CANCELLED", isHistorical: false, activity: { orgId: "org1", org: { squadMode } } }];

  it("a weekly club: the month is never consulted", async () => {
    matchFindMany.mockResolvedValue(row("weekly"));
    await bulkRestoreMatches({ matchIds: ["m1"] });
    expect(matchUpdateMany).toHaveBeenCalledTimes(1);
    expect(afterMatchesCancelled).not.toHaveBeenCalled();
  });

  it("a monthly club: the game is on again, so its credits are worked out again", async () => {
    matchFindMany.mockResolvedValue(row("monthly"));
    await bulkRestoreMatches({ matchIds: ["m1"] });
    expect(afterMatchesCancelled).toHaveBeenCalledWith("org1", []);
  });

  it("always silent", async () => {
    matchFindMany.mockResolvedValue(row("monthly"));
    await bulkRestoreMatches({ matchIds: ["m1"] });
    expect(botJobCreate).not.toHaveBeenCalled();
  });
});
