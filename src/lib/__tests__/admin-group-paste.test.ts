/**
 * A squad list pasted in the admin group (2026-10-14): proposed, never
 * applied at once; applied on an admin's YES within 30 minutes, against
 * the squad as it stands at the YES. db and the attendance writers are
 * mocked. No model.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  match: { findMany: vi.fn(), findUnique: vi.fn() },
  activity: { findMany: vi.fn() },
  attendance: { findMany: vi.fn(), count: vi.fn() },
  membership: { findMany: vi.fn() },
  userAlias: { findMany: vi.fn() },
  user: { findMany: vi.fn() },
  adminSquadProposal: { findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
const att = vi.hoisted(() => ({ registerAttendance: vi.fn(), cancelAttendance: vi.fn() }));
vi.mock("@/lib/attendance", () => att);
const prov = vi.hoisted(() => ({ resolveOrProvisionByName: vi.fn() }));
vi.mock("@/lib/resolve-or-provision-name", () => prov);
// The count line's facts (squad-count.ts), read off the same rows.
vi.mock("@/lib/squad-count", () => ({
  loadSquadCount: async () => ({
    confirmed: rows.filter((r) => r.status === "CONFIRMED").length,
    maxPlayers: 6,
    bench: rows.filter((r) => r.status === "BENCH").map((r) => people.find(([id]) => id === r.userId)?.[1] ?? r.userId),
    benchPickMode: null,
  }),
}));

import { answerSquadPasteYes, proposeSquadPaste } from "../admin-group-paste";

const NOW = new Date("2026-10-14T12:00:00Z");
const MATCH = { id: "m1", date: new Date("2026-10-16T19:00:00Z"), status: "UPCOMING", maxPlayers: 6 };
const people = [
  ["u-shehryar", "Shehryar Khan"],
  ["u-bilal", "Bilal Ahmed"],
  ["u-clarence", "Clarence Obi"],
  ["u-ali", "Ali Raza"],
  ["u-tom", "Tom Third"],
  ["u-sam", "Sam Stone"],
  ["u-ben", "Ben Bench"],
] as const;

let rows: Array<{ userId: string; status: string }>;

beforeEach(() => {
  vi.clearAllMocks();
  rows = [
    { userId: "u-shehryar", status: "CONFIRMED" },
    { userId: "u-clarence", status: "CONFIRMED" },
    { userId: "u-ali", status: "CONFIRMED" },
    { userId: "u-tom", status: "CONFIRMED" },
    { userId: "u-sam", status: "CONFIRMED" },
    { userId: "u-ben", status: "BENCH" },
  ];
  dbMock.match.findMany.mockResolvedValue([MATCH]);
  dbMock.match.findUnique.mockResolvedValue(MATCH);
  dbMock.activity.findMany.mockResolvedValue([{ sport: { playersPerTeam: 3 } }]);
  dbMock.attendance.findMany.mockImplementation(async () => rows.map((r) => ({ ...r })));
  dbMock.attendance.count.mockImplementation(async () => rows.filter((r) => r.status === "CONFIRMED").length);
  dbMock.membership.findMany.mockResolvedValue(people.map(([id, name]) => ({ user: { id, name } })));
  dbMock.userAlias.findMany.mockResolvedValue([]);
  dbMock.user.findMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
    people.filter(([id]) => where.id.in.includes(id)).map(([id, name]) => ({ id, name })),
  );
  dbMock.adminSquadProposal.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "p1", ...data }));
  dbMock.adminSquadProposal.updateMany.mockResolvedValue({ count: 1 });
  att.cancelAttendance.mockImplementation(async (userId: string) => {
    rows.find((r) => r.userId === userId)!.status = "DROPPED";
    return { status: "DROPPED" };
  });
  att.registerAttendance.mockImplementation(async (userId: string, _m: string, o: { benchIntent?: string }) => {
    const status = o.benchIntent === "explicit" ? "BENCH" : "CONFIRMED";
    const row = rows.find((r) => r.userId === userId);
    if (row) row.status = status;
    else rows.push({ userId, status });
    return { status };
  });
  prov.resolveOrProvisionByName.mockImplementation(async (_o: string, name: string) => ({ userId: `new-${name.toLowerCase()}`, name }));
});

const LIST = "Friday 8pm\n1. Bilal\n2. Ali\n3. Tom\n4. Sam\n5. Naim";
const base = { orgId: "org", lang: "en", messageId: "wa-paste", senderUserId: "u-admin", now: NOW };

describe("proposeSquadPaste", () => {
  it("not a list: not handled", async () => {
    expect(await proposeSquadPaste({ ...base, text: "Shehryar out" })).toBeNull();
    expect(dbMock.adminSquadProposal.create).not.toHaveBeenCalled();
  });

  it("a list: says the exact changes, asks for YES, applies NOTHING", async () => {
    const r = await proposeSquadPaste({ ...base, text: LIST });
    expect(r).toEqual({
      outcome: "paste-proposed",
      replyText:
        "Adding: Bilal Ahmed. Removing: Shehryar Khan, Clarence Obi. Unknown names: Naim (not a member yet, I'll add them as a new player). Reply YES to apply.",
    });
    expect(att.registerAttendance).not.toHaveBeenCalled();
    expect(att.cancelAttendance).not.toHaveBeenCalled();
    const data = dbMock.adminSquadProposal.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      orgId: "org",
      matchId: "m1",
      waMessageId: "wa-paste",
      proposedByUserId: "u-admin",
      playingUserIds: ["u-bilal", "u-ali", "u-tom", "u-sam"],
      playingNewNames: ["Naim"],
      expiresAt: new Date(NOW.getTime() + 30 * 60 * 1000),
    });
  });

  it("a new paste supersedes the open one", async () => {
    await proposeSquadPaste({ ...base, text: LIST });
    expect(dbMock.adminSquadProposal.updateMany).toHaveBeenCalledWith({
      where: { orgId: "org", resolvedAt: null },
      data: { resolvedAt: NOW, outcome: "superseded" },
    });
  });

  it("identical to the squad: says so, nothing stored", async () => {
    const r = await proposeSquadPaste({ ...base, text: "1. Shehryar\n2. Clarence\n3. Ali\n4. Tom\n5. Sam" });
    expect(r).toEqual({ outcome: "paste-same", replyText: "That matches the squad, nothing to change." });
    expect(dbMock.adminSquadProposal.create).not.toHaveBeenCalled();
  });

  it("Turkish club: Turkish proposal", async () => {
    const r = await proposeSquadPaste({ ...base, lang: "tr", text: LIST });
    expect(r?.replyText).toBe(
      "Eklenecek: Bilal Ahmed. Çıkarılacak: Shehryar Khan, Clarence Obi. Tanımadığım isimler: Naim (henüz üye değil, yeni oyuncu olarak ekleyeceğim). Uygulamak için EVET yazın.",
    );
  });

  // 2026-10-17: these tests started failing at 01:00 London because the
  // match was picked against the wall clock, not the `now` passed in.
  it("picks the match against the `now` it is given, not the wall clock", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-17T00:30:00Z")); // the day after MATCH
      const r = await proposeSquadPaste({ ...base, text: LIST });
      expect(r?.outcome).toBe("paste-proposed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a Pi retry of the same paste is not proposed twice", async () => {
    dbMock.adminSquadProposal.create.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" }));
    expect(await proposeSquadPaste({ ...base, text: LIST })).toBeNull();
  });

  // 2026-10-15 (FNF): the organiser pasted the squad a minute after going
  // live, before any game existed, and heard nothing.
  describe("no game to put it on", () => {
    beforeEach(() => dbMock.match.findMany.mockResolvedValue([]));

    it("a weekly game is set up: says there is no game yet and when the next one is made (BST: 01:00 London)", async () => {
      const r = await proposeSquadPaste({ ...base, now: new Date("2026-10-15T21:13:00Z"), text: LIST });
      expect(r).toEqual({
        outcome: "paste-no-match",
        replyText:
          "There's no upcoming game to put this list on yet. MatchTime adds the next game every night at 01:00 (London time). Paste the list again after that.",
      });
      expect(dbMock.adminSquadProposal.create).not.toHaveBeenCalled();
      expect(dbMock.adminSquadProposal.updateMany).not.toHaveBeenCalled();
    });

    it("in winter (GMT) the same run is at 00:00 London", async () => {
      const r = await proposeSquadPaste({ ...base, now: new Date("2026-12-03T21:13:00Z"), text: LIST });
      expect(r?.replyText).toContain("every night at 00:00 (London time)");
    });

    it("Turkish club: Turkish", async () => {
      const r = await proposeSquadPaste({ ...base, lang: "tr", now: new Date("2026-10-15T21:13:00Z"), text: LIST });
      expect(r).toEqual({
        outcome: "paste-no-match",
        replyText:
          "Bu listeyi koyacağım yaklaşan bir maç henüz yok. MatchTime bir sonraki maçı her gece ekler (Londra saatiyle 01:00). Ondan sonra listeyi yeniden yapıştırın.",
      });
    });

    it("no weekly game at all: says to add one under Activities", async () => {
      dbMock.activity.findMany.mockResolvedValue([]);
      const r = await proposeSquadPaste({ ...base, text: LIST });
      expect(r).toEqual({
        outcome: "paste-no-match",
        replyText:
          "This club has no weekly game set up yet, so there's nothing to put this list on. Add the game under Activities on the website, then paste the list again.",
      });
      const tr = await proposeSquadPaste({ ...base, lang: "tr", text: LIST });
      expect(tr?.replyText).toBe(
        "Bu kulübün henüz ayarlanmış haftalık maçı yok, bu yüzden listeyi koyacak bir maç yok. Maçı web sitesinde Etkinlikler bölümünden ekleyin, sonra listeyi yeniden yapıştırın.",
      );
    });

    it("chatter is not a list: still not handled, so it goes on as before", async () => {
      expect(await proposeSquadPaste({ ...base, text: "Shehryar out" })).toBeNull();
      expect(await proposeSquadPaste({ ...base, text: "who's free friday?\nanyone?" })).toBeNull();
    });

    it("too short to be the squad (under half the places of the weekly game): not handled", async () => {
      dbMock.activity.findMany.mockResolvedValue([{ sport: { playersPerTeam: 9 } }]);
      // 18 places: a list needs 9 names.
      expect(await proposeSquadPaste({ ...base, text: LIST })).toBeNull();
    });
  });
});

describe("answerSquadPasteYes", () => {
  const open = {
    id: "p1",
    orgId: "org",
    matchId: "m1",
    waMessageId: "wa-paste",
    proposedByUserId: "u-admin",
    playingUserIds: ["u-bilal", "u-ali", "u-tom", "u-sam"],
    playingNewNames: ["Naim"],
    reserveUserIds: [],
    reserveNewNames: [],
    expiresAt: new Date(NOW.getTime() + 60_000),
    resolvedAt: null,
  };
  const yes = { orgId: "org", lang: "en", messageId: "wa-yes", senderUserId: "u-admin2", now: NOW };

  it("nothing open: null (the caller stays silent)", async () => {
    dbMock.adminSquadProposal.findFirst.mockResolvedValue(null);
    expect(await answerSquadPasteYes(yes)).toBeNull();
  });

  it("any admin's YES applies it: out first, then in, then reports the count", async () => {
    dbMock.adminSquadProposal.findFirst.mockResolvedValue(open);
    const r = await answerSquadPasteYes(yes);
    expect(r).toEqual({
      outcome: "paste-applied",
      replyText: "Done: Shehryar Khan out, Clarence Obi out, Bilal Ahmed in, Naim in. 5 of 6, 1 on the bench (Ben Bench).",
    });
    // Claimed once, atomically, before any write.
    expect(dbMock.adminSquadProposal.updateMany).toHaveBeenCalledWith({
      where: { id: "p1", resolvedAt: null },
      data: { resolvedAt: NOW, outcome: "applied", resolvedByUserId: "u-admin2" },
    });
    const order = [
      ...att.cancelAttendance.mock.invocationCallOrder.map((n) => [n, "out"]),
      ...att.registerAttendance.mock.invocationCallOrder.map((n) => [n, "in"]),
    ]
      .sort((a, b) => (a[0] as number) - (b[0] as number))
      .map((x) => x[1]);
    expect(order).toEqual(["out", "out", "in", "in"]);
    expect(att.cancelAttendance.mock.calls[0][2]).toEqual({
      cause: "admin-message",
      actorKind: "admin",
      actorUserId: "u-admin2",
      // Marked as the admin group's, so the rolling squad knows an admin
      // added these players (admin-added.ts).
      sourceRef: "admin-group:wa-paste",
    });
    expect(att.registerAttendance.mock.calls[0][2]).toMatchObject({ promoteFromBench: true, actorIsAdmin: true });
    expect(prov.resolveOrProvisionByName).toHaveBeenCalledWith("org", "Naim", { adminConfirmed: true });
  });

  it("the diff is worked out again at the YES: a change made since is not undone twice", async () => {
    dbMock.adminSquadProposal.findFirst.mockResolvedValue(open);
    rows.find((r) => r.userId === "u-shehryar")!.status = "DROPPED";
    const r = await answerSquadPasteYes(yes);
    expect(r?.replyText).toBe("Done: Clarence Obi out, Bilal Ahmed in, Naim in. 5 of 6, 1 on the bench (Ben Bench).");
  });

  it("another admin got there first: the claim fails, nothing is written, silent", async () => {
    dbMock.adminSquadProposal.findFirst.mockResolvedValue(open);
    dbMock.adminSquadProposal.updateMany.mockResolvedValue({ count: 0 });
    expect(await answerSquadPasteYes(yes)).toBeNull();
    expect(att.cancelAttendance).not.toHaveBeenCalled();
  });

  it("too late: says so, applies nothing", async () => {
    dbMock.adminSquadProposal.findFirst.mockResolvedValue({ ...open, expiresAt: new Date(NOW.getTime() - 1) });
    const r = await answerSquadPasteYes(yes);
    expect(r).toEqual({
      outcome: "paste-expired",
      replyText: "That list is more than 30 minutes old, so I haven't applied it. Paste it again if it still stands.",
    });
    expect(att.cancelAttendance).not.toHaveBeenCalled();
    expect(att.registerAttendance).not.toHaveBeenCalled();
  });

  it("reserves go to the waiting list explicitly", async () => {
    dbMock.adminSquadProposal.findFirst.mockResolvedValue({
      ...open,
      playingUserIds: ["u-shehryar", "u-ali", "u-tom", "u-sam"],
      playingNewNames: [],
      reserveUserIds: ["u-clarence"],
    });
    const r = await answerSquadPasteYes(yes);
    expect(att.registerAttendance).toHaveBeenCalledWith("u-clarence", "m1", expect.objectContaining({ benchIntent: "explicit" }));
    expect(att.cancelAttendance).not.toHaveBeenCalled();
    expect(r?.replyText).toBe("Done: Clarence Obi on the bench. 4 of 6, 2 on the bench (Clarence Obi and Ben Bench).");
  });

  it("a write that throws is reported, the rest still applied", async () => {
    dbMock.adminSquadProposal.findFirst.mockResolvedValue(open);
    att.cancelAttendance.mockRejectedValueOnce(new Error("boom"));
    const r = await answerSquadPasteYes(yes);
    expect(r?.replyText).toMatch(/^Done: Clarence Obi out, Bilal Ahmed in, Naim in\. I couldn't change Shehryar Khan\./);
  });
});
