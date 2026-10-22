/**
 * The one path that cancels a match and puts it back on (2026-10-22),
 * shared by the web page and HQ. The database is mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildMatchCancelledAnnouncement } from "../group-copy";
import { dayTimeLabel } from "../i18n/dates";

const dbMock = vi.hoisted(() => ({
  match: { findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
  botJob: { create: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
const monthClose = vi.hoisted(() => ({ afterMatchesCancelled: vi.fn() }));
vi.mock("@/lib/month-close", () => monthClose);

import { cancelMatchById, hqCancelOrRestore, restoreMatchById } from "../match-cancel";

const NOW = new Date("2026-10-22T14:00:00Z");
const FRI = new Date("2026-10-23T19:30:00Z");
const row = (status: string, lang = "en", squadMode = "weekly") => ({
  id: "m1",
  status,
  date: FRI,
  activity: { orgId: "org1", name: "Friday Night Football", org: { language: lang, squadMode } },
});

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.match.updateMany.mockResolvedValue({ count: 1 });
  dbMock.botJob.create.mockResolvedValue({});
  monthClose.afterMatchesCancelled.mockResolvedValue({ creditedGames: 0 });
});

describe("cancelMatchById", () => {
  it("a weekly club: CANCELLED from the status read, and the players' group told", async () => {
    dbMock.match.findUnique.mockResolvedValue(row("TEAMS_GENERATED"));
    expect(await cancelMatchById("m1")).toEqual({ kind: "cancelled", activityName: "Friday Night Football", date: FRI });
    expect(dbMock.match.updateMany).toHaveBeenCalledWith({ where: { id: "m1", status: "TEAMS_GENERATED" }, data: { status: "CANCELLED" } });
    expect(dbMock.botJob.create).toHaveBeenCalledWith({
      data: {
        orgId: "org1",
        kind: "group",
        text: buildMatchCancelledAnnouncement({ activityName: "Friday Night Football", whenLabel: dayTimeLabel("en", FRI), lang: "en" }),
      },
    });
    expect(monthClose.afterMatchesCancelled).not.toHaveBeenCalled();
  });

  it("completed or already cancelled: nothing written", async () => {
    dbMock.match.findUnique.mockResolvedValue(row("COMPLETED"));
    expect((await cancelMatchById("m1")).kind).toBe("completed");
    dbMock.match.findUnique.mockResolvedValue(row("CANCELLED"));
    expect((await cancelMatchById("m1")).kind).toBe("already");
    expect(dbMock.match.updateMany).not.toHaveBeenCalled();
    expect(dbMock.botJob.create).not.toHaveBeenCalled();
  });

  it("another door cancelled it first: announced once", async () => {
    dbMock.match.findUnique.mockResolvedValue(row("UPCOMING"));
    dbMock.match.updateMany.mockResolvedValue({ count: 0 });
    expect((await cancelMatchById("m1")).kind).toBe("already");
    expect(dbMock.botJob.create).not.toHaveBeenCalled();
  });
});

describe("restoreMatchById", () => {
  it("a cancelled match still to come: UPCOMING again, and the players' group told", async () => {
    dbMock.match.findUnique.mockResolvedValue(row("CANCELLED"));
    expect((await restoreMatchById("m1", NOW)).kind).toBe("restored");
    expect(dbMock.match.updateMany).toHaveBeenCalledWith({ where: { id: "m1", status: "CANCELLED" }, data: { status: "UPCOMING" } });
    expect(dbMock.botJob.create.mock.calls[0][0].data.text).toBe(
      `✅ *Match back on*: Friday Night Football on ${dayTimeLabel("en", FRI)}. It goes ahead as planned.`,
    );
  });

  it("its kickoff has passed: not restored", async () => {
    dbMock.match.findUnique.mockResolvedValue(row("CANCELLED"));
    expect((await restoreMatchById("m1", new Date("2026-10-24T00:00:00Z"))).kind).toBe("past");
    expect(dbMock.match.updateMany).not.toHaveBeenCalled();
  });
});

describe("hqCancelOrRestore", () => {
  it("cancels the next match and words HQ's reply, EN and TR", async () => {
    dbMock.match.findMany.mockResolvedValue([{ id: "m1", date: FRI, status: "UPCOMING" }]);
    dbMock.match.findUnique.mockResolvedValue(row("UPCOMING"));
    const en = await hqCancelOrRestore({ orgId: "org1", lang: "en", mode: "cancel", dayPhrase: null, addressed: false, now: NOW });
    expect(en).toEqual({
      outcome: "hq-match-cancelled",
      replyText: `Done: Friday Night Football, ${dayTimeLabel("en", FRI)} is cancelled. I've told the players' group.`,
    });
    dbMock.match.findUnique.mockResolvedValue(row("UPCOMING", "tr"));
    const tr = await hqCancelOrRestore({ orgId: "org1", lang: "tr", mode: "cancel", dayPhrase: null, addressed: false, now: NOW });
    expect(tr?.replyText).toBe(`Tamam: Friday Night Football, ${dayTimeLabel("tr", FRI)} iptal edildi. Oyuncu grubuna haber verdim.`);
  });

  it("no match on the day named: says so, cancels nothing", async () => {
    dbMock.match.findMany.mockResolvedValue([{ id: "m1", date: FRI, status: "UPCOMING" }]);
    const r = await hqCancelOrRestore({ orgId: "org1", lang: "en", mode: "cancel", dayPhrase: "Tuesday", addressed: true, now: NOW });
    expect(r).toEqual({ outcome: "hq-cancel-none", replyText: `I can't find an upcoming match for "Tuesday".` });
    expect(dbMock.match.updateMany).not.toHaveBeenCalled();
  });

  it("put back on with nothing cancelled: a line when asked, silent when not", async () => {
    dbMock.match.findMany.mockResolvedValue([{ id: "m1", date: FRI, status: "UPCOMING" }]);
    expect(await hqCancelOrRestore({ orgId: "org1", lang: "en", mode: "restore", dayPhrase: null, addressed: false, now: NOW })).toBeNull();
    expect((await hqCancelOrRestore({ orgId: "org1", lang: "en", mode: "restore", dayPhrase: null, addressed: true, now: NOW }))?.replyText).toBe(
      "There's no cancelled match still to come to put back on.",
    );
  });
});
