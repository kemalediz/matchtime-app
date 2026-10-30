/**
 * A squad list pasted in the admin group (2026-10-14): proposed, never
 * applied at once; applied on an admin's YES within 30 minutes, against
 * the squad as it stands at the YES. db and the attendance writers are
 * mocked; WHAT the message is comes from the HQ squad reader, a model,
 * stubbed here with the answer it would give (2026-10-29).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  match: { findMany: vi.fn(), findUnique: vi.fn() },
  activity: { findMany: vi.fn() },
  attendance: { findMany: vi.fn(), count: vi.fn() },
  membership: { findMany: vi.fn() },
  userAlias: { findMany: vi.fn() },
  user: { findMany: vi.fn() },
  adminSquadProposal: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
  adminGroupMessage: { findMany: vi.fn() },
  teamAssignment: { findMany: vi.fn() },
  adminTeamProposal: { findUnique: vi.fn() },
  organisation: { findUnique: vi.fn() },
  sport: { findUnique: vi.fn() },
}));
vi.mock("@/lib/ai-budget", () => ({ withOrgAiBudget: (_k: string, fn: () => Promise<unknown>) => fn() }));
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

const seedHq = vi.hoisted(() => ({ applyMonthSeedYes: vi.fn() }));
vi.mock("../month-seed-hq", () => seedHq);
vi.mock("@/lib/month-seed-hq", () => seedHq);

import { answerSquadPasteYes, proposeSquadPaste } from "../admin-group-paste";
import type { PipelineModel } from "../pipeline/llm";

/** The reader's answer, as the model would give it. Members by ref: the
 *  club's members in `people` order are p1 (Shehryar) to p7 (Ben). */
type Line = { name: string; member?: string; section?: "playing" | "bench"; person?: boolean };
let modelCalls: Array<{ user: string }> = [];
function reader(kind: "squad" | "teams" | "other", lines: Line[] = [], out: string[] = []): PipelineModel {
  return {
    name: "stub",
    async complete(req: { user: string }) {
      modelCalls.push({ user: req.user });
      const answer = { kind, lines: lines.map((l) => ({ member: "", section: "playing", person: true, ...l })), out };
      return { text: JSON.stringify(answer), usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "m", costUsd: 0, ms: 1 } as never;
    },
  } as never;
}

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
  dbMock.adminGroupMessage.findMany.mockResolvedValue([]);
  dbMock.teamAssignment.findMany.mockResolvedValue([]);
  dbMock.adminTeamProposal.findUnique.mockResolvedValue(null);
  dbMock.organisation.findUnique.mockResolvedValue({ teamLabels: ["Non Bibs", "Bibs"] });
  dbMock.sport.findUnique.mockResolvedValue(null);
  modelCalls = [];
});

const LIST = "Friday 8pm\n1. Bilal\n2. Ali\n3. Tom\n4. Sam\n5. Naim";
/** The reader's reading of LIST: Shehryar and Clarence left off on purpose. */
const LIST_READ = () =>
  reader("squad", [{ name: "Bilal", member: "p2" }, { name: "Ali", member: "p4" }, { name: "Tom", member: "p5" }, { name: "Sam", member: "p6" }, { name: "Naim" }], ["p1", "p3"]);
const base = { orgId: "org", lang: "en", messageId: "wa-paste", senderUserId: "u-admin", now: NOW };

describe("proposeSquadPaste", () => {
  it("one line: not asked, not handled", async () => {
    const m = LIST_READ();
    expect(await proposeSquadPaste({ ...base, text: "Shehryar out", deps: { model: m } })).toBeNull();
    expect(modelCalls).toHaveLength(0);
    expect(dbMock.adminSquadProposal.create).not.toHaveBeenCalled();
  });

  it("the reader says it is not the squad (teams, other): not handled, so it goes on to the pipeline", async () => {
    expect(await proposeSquadPaste({ ...base, text: LIST, deps: { model: reader("teams") } })).toBeNull();
    expect(await proposeSquadPaste({ ...base, text: LIST, deps: { model: reader("other") } })).toBeNull();
    expect(await proposeSquadPaste({ ...base, text: LIST, deps: { model: null } })).toBeNull();
    expect(dbMock.adminSquadProposal.create).not.toHaveBeenCalled();
  });

  it("a list: says the exact changes, asks for YES, applies NOTHING", async () => {
    const r = await proposeSquadPaste({ ...base, text: LIST, deps: { model: LIST_READ() } });
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
      removeUserIds: ["u-shehryar", "u-clarence"],
      expiresAt: new Date(NOW.getTime() + 30 * 60 * 1000),
    });
    // The reader saw the squad, the members and the message.
    expect(modelCalls[0].user).toContain("Playing (5): p1 Shehryar Khan, p3 Clarence Obi");
    expect(modelCalls[0].user.trim().endsWith("5. Naim")).toBe(true);
  });

  it("the reader leaves off two players but does not say they are out: nobody is taken out, and it says so", async () => {
    const m = reader("squad", [{ name: "Bilal", member: "p2" }, { name: "Ali", member: "p4" }, { name: "Tom", member: "p5" }, { name: "Sam", member: "p6" }]);
    const r = await proposeSquadPaste({ ...base, text: "1. Bilal\n2. Ali\n3. Tom\n4. Sam", deps: { model: m } });
    expect(r).toEqual({
      outcome: "paste-proposed",
      replyText:
        "Adding: Bilal Ahmed. I haven't taken anyone out: 2 players in the squad are not on this list (Shehryar Khan, Clarence Obi). If any of them are out, tell me who by name. Reply YES to apply.",
    });
    expect(dbMock.adminSquadProposal.create.mock.calls[0][0].data.removeUserIds).toEqual([]);
  });

  it("nothing to add and players left off without a word: one line, nothing stored, no YES", async () => {
    const m = reader("squad", [{ name: "Ali", member: "p4" }, { name: "Tom", member: "p5" }, { name: "Sam", member: "p6" }]);
    const r = await proposeSquadPaste({ ...base, text: "Ali\nTom\nSam", deps: { model: m } });
    expect(r).toEqual({
      outcome: "paste-held",
      replyText:
        "I haven't taken anyone out: 2 players in the squad are not on this list (Shehryar Khan, Clarence Obi). If any of them are out, tell me who by name.",
    });
    expect(dbMock.adminSquadProposal.create).not.toHaveBeenCalled();
  });

  it("a new paste supersedes the open one", async () => {
    await proposeSquadPaste({ ...base, text: LIST, deps: { model: LIST_READ() } });
    expect(dbMock.adminSquadProposal.updateMany).toHaveBeenCalledWith({
      where: { orgId: "org", resolvedAt: null },
      data: { resolvedAt: NOW, outcome: "superseded" },
    });
  });

  it("identical to the squad: says so, nothing stored", async () => {
    const m = reader("squad", ["p1", "p3", "p4", "p5", "p6"].map((member) => ({ name: member, member })));
    const r = await proposeSquadPaste({ ...base, text: "1. Shehryar\n2. Clarence\n3. Ali\n4. Tom\n5. Sam", deps: { model: m } });
    expect(r).toEqual({ outcome: "paste-same", replyText: "That matches the squad, nothing to change." });
    expect(dbMock.adminSquadProposal.create).not.toHaveBeenCalled();
  });

  it("Turkish club: Turkish proposal, and the Turkish kept line", async () => {
    const r = await proposeSquadPaste({ ...base, lang: "tr", text: LIST, deps: { model: LIST_READ() } });
    expect(r?.replyText).toBe(
      "Eklenecek: Bilal Ahmed. Çıkarılacak: Shehryar Khan, Clarence Obi. Tanımadığım isimler: Naim (henüz üye değil, yeni oyuncu olarak ekleyeceğim). Uygulamak için EVET yazın.",
    );
    const m = reader("squad", [{ name: "Ali", member: "p4" }, { name: "Tom", member: "p5" }, { name: "Sam", member: "p6" }, { name: "Clarence", member: "p3" }]);
    const kept = await proposeSquadPaste({ ...base, lang: "tr", text: "Ali\nTom\nSam\nClarence", deps: { model: m } });
    expect(kept?.replyText).toBe("Kimseyi çıkarmadım: Shehryar Khan kadroda ama bu listede yok. Gelmiyorsa ismiyle söyleyin.");
  });

  it("a name the reader says is not a person is never added as a player", async () => {
    const m = reader("squad", [
      { name: "Swap", person: false },
      ...["p1", "p3", "p4", "p5", "p6"].map((member) => ({ name: member, member })),
      { name: "With", person: false },
    ]);
    const r = await proposeSquadPaste({ ...base, text: "Swap\nShehryar\nClarence\nAli\nTom\nSam\nWith", deps: { model: m } });
    expect(r?.outcome).toBe("paste-same");
  });

  // 2026-10-17: these tests started failing at 01:00 London because the
  // match was picked against the wall clock, not the `now` passed in.
  it("picks the match against the `now` it is given, not the wall clock", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-17T00:30:00Z")); // the day after MATCH
      const r = await proposeSquadPaste({ ...base, text: LIST, deps: { model: LIST_READ() } });
      expect(r?.outcome).toBe("paste-proposed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a Pi retry of the same paste is not proposed twice", async () => {
    dbMock.adminSquadProposal.create.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" }));
    expect(await proposeSquadPaste({ ...base, text: LIST, deps: { model: LIST_READ() } })).toBeNull();
  });

  // 2026-10-15 (FNF): the organiser pasted the squad a minute after going
  // live, before any game existed, and heard nothing.
  describe("no game to put it on", () => {
    beforeEach(() => dbMock.match.findMany.mockResolvedValue([]));

    it("a weekly game is set up: says there is no game yet and when the next one is made (BST: 01:00 London)", async () => {
      const r = await proposeSquadPaste({ ...base, now: new Date("2026-10-15T21:13:00Z"), text: LIST, deps: { model: LIST_READ() } });
      expect(r).toEqual({
        outcome: "paste-no-match",
        replyText:
          "There's no upcoming game to put this list on yet. MatchTime adds the next game every night at 01:00 (London time). Paste the list again after that.",
      });
      expect(dbMock.adminSquadProposal.create).not.toHaveBeenCalled();
      expect(dbMock.adminSquadProposal.updateMany).not.toHaveBeenCalled();
      expect(modelCalls[0].user).toContain("THE NEXT GAME: none yet.");
    });

    it("in winter (GMT) the same run is at 00:00 London", async () => {
      const r = await proposeSquadPaste({ ...base, now: new Date("2026-12-03T21:13:00Z"), text: LIST, deps: { model: LIST_READ() } });
      expect(r?.replyText).toContain("every night at 00:00 (London time)");
    });

    it("Turkish club: Turkish", async () => {
      const r = await proposeSquadPaste({ ...base, lang: "tr", now: new Date("2026-10-15T21:13:00Z"), text: LIST, deps: { model: LIST_READ() } });
      expect(r).toEqual({
        outcome: "paste-no-match",
        replyText:
          "Bu listeyi koyacağım yaklaşan bir maç henüz yok. MatchTime bir sonraki maçı her gece ekler (Londra saatiyle 01:00). Ondan sonra listeyi yeniden yapıştırın.",
      });
    });

    it("no weekly game at all: says to add one under Activities", async () => {
      dbMock.activity.findMany.mockResolvedValue([]);
      const r = await proposeSquadPaste({ ...base, text: LIST, deps: { model: LIST_READ() } });
      expect(r).toEqual({
        outcome: "paste-no-match",
        replyText:
          "This club has no weekly game set up yet, so there's nothing to put this list on. Add the game under Activities on the website, then paste the list again.",
      });
      const tr = await proposeSquadPaste({ ...base, lang: "tr", text: LIST, deps: { model: LIST_READ() } });
      expect(tr?.replyText).toBe(
        "Bu kulübün henüz ayarlanmış haftalık maçı yok, bu yüzden listeyi koyacak bir maç yok. Maçı web sitesinde Etkinlikler bölümünden ekleyin, sonra listeyi yeniden yapıştırın.",
      );
    });

    it("the reader says it is not the squad: still not handled, so it goes on as before", async () => {
      expect(await proposeSquadPaste({ ...base, text: "Shehryar out", deps: { model: LIST_READ() } })).toBeNull();
      expect(await proposeSquadPaste({ ...base, text: "who's free friday?\nanyone?", deps: { model: reader("other") } })).toBeNull();
    });
  });
});

// ── FNF HQ, 29 Oct 2026 (traced): the teams sheet pasted back ────────────
describe("29 Oct: MatchTime's own two-sided teams sheet pasted back", () => {
  const NON_BIBS = ["Feroz", "Alamgir", "Rafi", "Hamza", "Mo", "Uncle Najib", "Abdul-Hafeez", "Mojib", "Yaseen"];
  const BIBS = ["Yorel", "Maj", "Imz", "Hamzah", "Akram", "Mahir", "Shehryar", "Habib", "Ali"];
  const FNF = [...NON_BIBS, ...BIBS].map((name) => [`u-${name.toLowerCase()}`, name] as const);
  const SHEET = `Here’s the teams: \n\n*Non Bibs*:\n${NON_BIBS.map((n, i) => `${i + 1}. ${n}`).join("\n")}\n\n*Bibs*:\n${BIBS.map((n, i) => `${i + 1}. ${n}`).join("\n")}`;
  const SWAP = `Swap \n${NON_BIBS.map((n) => (n === "Uncle Najib" ? "Uncle" : n)).join("\n")}\n\nWith \n\n${["Hamzah", "Yorel", "Akram", "Shehryar", "Imz", "Maj", "Mahir", "Habib", "Ali"].join("\n")}`;
  const ref = (name: string) => `p${FNF.findIndex(([, n]) => n === name) + 1}`;

  beforeEach(() => {
    rows = FNF.map(([userId]) => ({ userId, status: "CONFIRMED" }));
    dbMock.match.findMany.mockResolvedValue([{ ...MATCH, maxPlayers: 18 }]);
    dbMock.membership.findMany.mockResolvedValue(FNF.map(([id, name]) => ({ user: { id, name } })));
    dbMock.user.findMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
      FNF.filter(([id]) => where.id.in.includes(id)).map(([id, name]) => ({ id, name })),
    );
    dbMock.teamAssignment.findMany.mockResolvedValue([
      ...NON_BIBS.map((n) => ({ userId: `u-${n.toLowerCase()}`, team: "RED" })),
      ...BIBS.map((n) => ({ userId: `u-${n.toLowerCase()}`, team: "YELLOW" })),
    ]);
    dbMock.adminTeamProposal.findUnique.mockResolvedValue({ state: "proposed" });
  });

  it("the reader says teams: no proposal, no removal; it goes on to the teams handling", async () => {
    expect(await proposeSquadPaste({ ...base, text: SHEET, deps: { model: reader("teams") } })).toBeNull();
    expect(dbMock.adminSquadProposal.create).not.toHaveBeenCalled();
    // It was shown the teams, by side, and the squad.
    expect(modelCalls[0].user).toContain("Non Bibs: p1 Feroz, p2 Alamgir");
    expect(modelCalls[0].user).toContain("Bibs: p10 Yorel, p11 Maj");
    expect(modelCalls[0].user).toContain("Playing (18):");
  });

  it("even a reader that calls all 18 the squad: the teams' players are never a squad change", async () => {
    const m = reader("squad", [...NON_BIBS, ...BIBS].map((name) => ({ name, member: ref(name) })));
    expect(await proposeSquadPaste({ ...base, text: SHEET, deps: { model: m } })).toBeNull();
    expect(dbMock.adminSquadProposal.create).not.toHaveBeenCalled();
  });

  it("even a reader that repeats the old parser's mistake (9 squad, 9 out): nobody is taken out", async () => {
    const m = reader("squad", NON_BIBS.map((name) => ({ name, member: ref(name) })), BIBS.map(ref));
    const r = await proposeSquadPaste({ ...base, text: SHEET, deps: { model: m } });
    expect(r?.outcome).toBe("paste-held");
    expect(r?.replyText).toBe(
      `I haven't taken anyone out: 9 players in the squad are not on this list (${BIBS.join(", ")}). If any of them are out, tell me who by name.`,
    );
    expect(r?.replyText).not.toContain("Removing");
    expect(dbMock.adminSquadProposal.create).not.toHaveBeenCalled();
  });

  it("18:37 'Swap / 9 names / With / 9 names': the reader says teams; nobody called Swap or With is ever proposed", async () => {
    expect(await proposeSquadPaste({ ...base, text: SWAP, deps: { model: reader("teams") } })).toBeNull();
    // And had it called it the squad, with Swap and With as people: the
    // other 18 are the teams' players, and Swap and With are not in any
    // proposal because nothing is proposed for a list the gates hold.
    const m = reader("squad", [
      { name: "Swap", person: false },
      ...NON_BIBS.map((name) => ({ name: name === "Uncle Najib" ? "Uncle" : name, member: ref(name) })),
      { name: "With", person: false },
      ...BIBS.map((name) => ({ name, member: ref(name) })),
    ]);
    expect(await proposeSquadPaste({ ...base, text: SWAP, deps: { model: m } })).toBeNull();
    expect(dbMock.adminSquadProposal.create).not.toHaveBeenCalled();
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
    removeUserIds: ["u-shehryar", "u-clarence"],
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

  it("the YES takes out ONLY who the preview said: a player confirmed since, or one the gates kept, stays", async () => {
    dbMock.adminSquadProposal.findFirst.mockResolvedValue({ ...open, removeUserIds: ["u-shehryar"] });
    const r = await answerSquadPasteYes(yes);
    expect(r?.replyText).toBe("Done: Shehryar Khan out, Bilal Ahmed in, Naim in. 6 of 6, 1 on the bench (Ben Bench).");
    expect(att.cancelAttendance).toHaveBeenCalledTimes(1);
  });

  it("a list stored before the column (no removeUserIds): its YES takes nobody out", async () => {
    const { removeUserIds: _gone, ...legacy } = open;
    dbMock.adminSquadProposal.findFirst.mockResolvedValue(legacy);
    await answerSquadPasteYes(yes);
    expect(att.cancelAttendance).not.toHaveBeenCalled();
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


// PR #464 review: a monthly club's list for the coming month is marked
// applied only once its YES has started the month.
describe("a month's list waiting for YES", () => {
  const SEED = { id: "p-seed", orgId: "org", waMessageId: "wa-seed", proposedByUserId: "u-owner", matchId: "", monthStart: "2026-11-01", monthSeed: { activityId: "a", games: 5, rows: [] }, expiresAt: new Date(NOW.getTime() + 60_000), resolvedAt: null };
  const yes = () => answerSquadPasteYes({ orgId: "org", lang: "en", messageId: "wa-yes", senderUserId: "u-owner", now: NOW });

  it("a YES that fails leaves the list waiting for another", async () => {
    dbMock.adminSquadProposal.findFirst.mockResolvedValue(SEED);
    dbMock.adminSquadProposal.findUnique.mockResolvedValue({ resolvedAt: null });
    seedHq.applyMonthSeedYes.mockResolvedValue({ outcome: "month-seed-failed", replyText: "no", error: "failed" });
    expect(await yes()).toEqual({ outcome: "month-seed-failed", replyText: "no" });
    expect(dbMock.adminSquadProposal.updateMany).not.toHaveBeenCalled();
  });

  it("a YES that starts the month marks the list applied", async () => {
    dbMock.adminSquadProposal.findFirst.mockResolvedValue(SEED);
    seedHq.applyMonthSeedYes.mockResolvedValue({ outcome: "month-seed-applied", replyText: "ok" });
    expect(await yes()).toEqual({ outcome: "month-seed-applied", replyText: "ok" });
    expect(dbMock.adminSquadProposal.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "p-seed", resolvedAt: null } }));
  });

  it("a month started on the website meanwhile: the list is done with", async () => {
    dbMock.adminSquadProposal.findFirst.mockResolvedValue(SEED);
    dbMock.adminSquadProposal.findUnique.mockResolvedValue({ resolvedAt: null });
    seedHq.applyMonthSeedYes.mockResolvedValue({ outcome: "month-seed-failed", replyText: "already", error: "already-started" });
    await yes();
    expect(dbMock.adminSquadProposal.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ outcome: "superseded" }) }));
  });
});
