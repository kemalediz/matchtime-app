/**
 * A volunteer and the ROUND's number (partner discovery P4, 2026-10-22).
 * Plan: MDs/partner-discovery-plan-2026-10-21.md, section 4.
 *
 * A FIRST-COME asking club: a guest volunteer takes a place only while the
 * round is below its number. The fill check and the place are written
 * under one lock per match, so two volunteers at once can never both take
 * the last wanted place; the one after gets "the place has gone".
 * An ORGANISER-PICK asking club is unchanged: every volunteer goes on the
 * bench for its organisers to pick. Only the ASKING club's mode counts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  partnerAsk: { findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
  sentNotification: { create: vi.fn() },
  $executeRaw: vi.fn(),
  $transaction: vi.fn(),
  organisation: { findUnique: vi.fn() },
  membership: { findUnique: vi.fn(), upsert: vi.fn() },
  attendance: { findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn() },
  user: { findUnique: vi.fn() },
  botJob: { create: vi.fn() },
}));
vi.mock("../db", () => ({ db: dbMock }));
const att = vi.hoisted(() => ({ registerAttendance: vi.fn(), cancelAttendance: vi.fn() }));
vi.mock("../attendance", () => att);
const notice = vi.hoisted(() => ({ sendAdminNotice: vi.fn() }));
vi.mock("../admin-channel", () => notice);
const closer = vi.hoisted(() => ({ closeRoundIfDue: vi.fn() }));
vi.mock("../partner-ask", () => closer);

import { handlePartnerVolunteer } from "../partner-guest";

const KICKOFF = new Date("2026-10-30T20:30:00Z");
const NOW = new Date("2026-10-30T15:00:00Z");
const ASK = {
  id: "ask1",
  roundId: "r1",
  places: 1,
  status: "posted",
  closesAt: KICKOFF,
  askerOrgId: "fnf",
  partnerOrgId: "sutton",
  matchId: "m-fnf",
  volunteerUserIds: [] as string[],
  pickedUserIds: [] as string[],
  match: { date: KICKOFF, status: "UPCOMING", activity: { matchDurationMins: 60 } },
};
let pickMode: string | null = null;
/** Who has a CONFIRMED row on the asking club's match. */
let confirmed = new Set<string>();
/** The round's asks as the database holds them now. */
let roundAsks: Array<{ places: number; volunteerUserIds: string[]; pickedUserIds: string[] }> = [];

const write = (userId: string, sourceMessageId = `wa-${userId}`) => ({ askId: "ask1", userId, name: `${userId} Smith`, polarity: "in" as const, sourceMessageId });

beforeEach(() => {
  vi.clearAllMocks();
  pickMode = null;
  confirmed = new Set();
  roundAsks = [{ places: 1, volunteerUserIds: [], pickedUserIds: [] }, { places: 1, volunteerUserIds: [], pickedUserIds: [] }];
  dbMock.partnerAsk.findUnique.mockImplementation(() => Promise.resolve({ ...ASK, volunteerUserIds: roundAsks[0].volunteerUserIds }));
  dbMock.partnerAsk.findMany.mockImplementation(() => Promise.resolve(roundAsks));
  dbMock.organisation.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
    Promise.resolve(
      where.id === "fnf" ? { id: "fnf", name: "FNF", language: "en", benchPickMode: pickMode } : { id: "sutton", name: "Sutton FC", language: "en" },
    ),
  );
  dbMock.membership.findUnique.mockImplementation(({ where }: { where: { userId_orgId: { orgId: string } } }) =>
    Promise.resolve(where.userId_orgId.orgId === "sutton" ? { leftAt: null, guestFromOrgId: null } : null),
  );
  dbMock.attendance.findUnique.mockResolvedValue(null);
  dbMock.attendance.findMany.mockResolvedValue([]);
  dbMock.attendance.count.mockImplementation(({ where }: { where: { userId: { in: string[] } } }) =>
    Promise.resolve(where.userId.in.filter((u) => confirmed.has(u)).length),
  );
  dbMock.partnerAsk.updateMany.mockImplementation(({ data }: { data: { volunteerUserIds?: { push: string } } }) => {
    if (data.volunteerUserIds?.push) roundAsks[0].volunteerUserIds = [...roundAsks[0].volunteerUserIds, data.volunteerUserIds.push];
    return Promise.resolve({ count: 1 });
  });
  // One lock: transactions run one after another, like pg_advisory_xact_lock.
  let chain: Promise<unknown> = Promise.resolve();
  dbMock.$transaction.mockImplementation((cb: (tx: typeof dbMock) => Promise<unknown>) => {
    const run = chain.then(() => cb(dbMock));
    chain = run.catch(() => undefined);
    return run;
  });
  att.registerAttendance.mockImplementation(async (userId: string) => {
    if (pickMode === "organiser") return { status: "BENCH" };
    confirmed.add(userId);
    return { status: "CONFIRMED" };
  });
  notice.sendAdminNotice.mockResolvedValue({ channel: "dm", queued: 1 });
  dbMock.sentNotification.create.mockResolvedValue({});
  dbMock.user.findUnique.mockResolvedValue({ phoneNumber: "+447700900111" });
  dbMock.botJob.create.mockResolvedValue({ id: "dm1" });
});

describe("a first-come asking club: the round's number holds", () => {
  it("the fill is checked and the place written under one lock per match", async () => {
    const r = await handlePartnerVolunteer(write("ali"), NOW);
    expect(r.outcome).toBe("registered-in");
    const sql = dbMock.$executeRaw.mock.calls.map((c) => [...(c[0] as string[])].join("?") + JSON.stringify(c.slice(1)));
    expect(sql.some((s) => s.includes("pg_advisory_xact_lock") && s.includes("xask-fill:m-fnf"))).toBe(true);
    expect(dbMock.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(att.registerAttendance.mock.invocationCallOrder[0]);
  });

  it("two volunteers at once, one wanted: exactly one place; the other is told it has gone, nothing left of him", async () => {
    const [a, b] = await Promise.all([handlePartnerVolunteer(write("ali"), NOW), handlePartnerVolunteer(write("bob"), NOW)]);
    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(["closed", "registered-in"]);
    expect(att.registerAttendance).toHaveBeenCalledTimes(1);
    expect(confirmed.size).toBe(1);
    const late = a.outcome === "closed" ? a : b;
    expect(late.dmText).toBe("*FNF*'s place has gone now, thanks for offering.");
    // The late one is taken off the ask again, and no guest membership was made for him.
    expect(dbMock.$executeRaw.mock.calls.some((c) => [...(c[0] as string[])].join("?").includes("array_remove"))).toBe(true);
    expect(dbMock.membership.upsert).toHaveBeenCalledTimes(1);
  });

  it("the place that fills the round closes the round at once", async () => {
    await handlePartnerVolunteer(write("ali"), NOW);
    expect(closer.closeRoundIfDue).toHaveBeenCalledWith("ask1", NOW);
  });

  it("a round of 2: two volunteers both get a place, the third is told it has gone", async () => {
    roundAsks = [{ places: 2, volunteerUserIds: [], pickedUserIds: [] }];
    dbMock.partnerAsk.findUnique.mockImplementation(() => Promise.resolve({ ...ASK, places: 2, volunteerUserIds: roundAsks[0].volunteerUserIds }));
    const first = await handlePartnerVolunteer(write("ali"), NOW);
    expect(closer.closeRoundIfDue).not.toHaveBeenCalled();
    const second = await handlePartnerVolunteer(write("bob"), NOW);
    const third = await handlePartnerVolunteer(write("cem"), NOW);
    expect([first.outcome, second.outcome, third.outcome]).toEqual(["registered-in", "registered-in", "closed"]);
    expect(confirmed).toEqual(new Set(["ali", "bob"]));
  });

  it("a volunteer from ANOTHER ask of the round already has the place: this ask's volunteer is told it has gone", async () => {
    confirmed = new Set(["zed"]);
    roundAsks = [{ places: 1, volunteerUserIds: [], pickedUserIds: [] }, { places: 1, volunteerUserIds: ["zed"], pickedUserIds: [] }];
    const r = await handlePartnerVolunteer(write("ali"), NOW);
    expect(r.outcome).toBe("closed");
    expect(att.registerAttendance).not.toHaveBeenCalled();
  });
});

describe("an organiser-pick asking club (FNF): unchanged", () => {
  it("every volunteer goes on the bench for its organisers to pick, whatever the round's number", async () => {
    pickMode = "organiser";
    const [a, b] = await Promise.all([handlePartnerVolunteer(write("ali"), NOW), handlePartnerVolunteer(write("bob"), NOW)]);
    expect([a.outcome, b.outcome]).toEqual(["registered-bench", "registered-bench"]);
    expect(att.registerAttendance).toHaveBeenCalledTimes(2);
    expect(closer.closeRoundIfDue).not.toHaveBeenCalled();
  });
});
