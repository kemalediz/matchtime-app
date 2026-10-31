/**
 * Teams proposed and approved in a club's admin group (2026-10-14): the
 * impure half, against an in-memory database.
 *
 *   - the commands write `TeamAssignment` (swap, move), build through the
 *     shared generator (teams, reshuffle) and repost the teams;
 *   - YES makes them final (TEAMS_PUBLISHED) and posts NOTHING in the
 *     players' group while the organisers announce;
 *   - one question at a time: a team proposal supersedes a pasted list
 *     waiting for YES, and a pasted list sets the teams aside;
 *   - the scheduled proposal at "Teams ready", the one reminder at kickoff
 *     minus 2 hours, and the change notices after approval.
 *
 * The generator is injected (it is `generateTeamsForMatch`, which has its
 * own tests). No model, no real database.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown> & { id: string };

const store = vi.hoisted(() => ({ tables: {} as Record<string, Row[]>, seq: 0 }));

function matches(row: Row, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    if (k === "OR") {
      if (!(cond as Array<Record<string, unknown>>).some((w) => matches(row, w))) return false;
      continue;
    }
    const v = row[k];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond)) {
      const c = cond as Record<string, unknown>;
      if ("in" in c && !(c.in as unknown[]).includes(v)) return false;
      if ("not" in c && (c.not === null ? v === null || v === undefined : v === c.not)) return false;
      const n = (x: unknown) => (x instanceof Date ? x.getTime() : (x as number));
      if ("gte" in c && !(v != null && n(v) >= n(c.gte))) return false;
      if ("gt" in c && !(v != null && n(v) > n(c.gt))) return false;
      if ("lte" in c && !(v != null && n(v) <= n(c.lte))) return false;
      if ("lt" in c && !(v != null && n(v) < n(c.lt))) return false;
      continue;
    }
    if (cond instanceof Date) {
      if (!(v instanceof Date) || v.getTime() !== cond.getTime()) return false;
      continue;
    }
    if ((v ?? null) !== cond) return false;
  }
  return true;
}

function table(name: string) {
  const rows = () => (store.tables[name] ??= []);
  const sort = (list: Row[], orderBy?: Record<string, "asc" | "desc">) => {
    if (!orderBy) return list;
    const [[k, dir]] = Object.entries(orderBy);
    const val = (x: unknown) => (x instanceof Date ? x.getTime() : (x as string | number));
    return [...list].sort((a, b) => (val(a[k]) < val(b[k]) ? -1 : val(a[k]) > val(b[k]) ? 1 : 0) * (dir === "desc" ? -1 : 1));
  };
  return {
    findMany: vi.fn(async (a: { where?: Record<string, unknown>; orderBy?: Record<string, "asc" | "desc">; take?: number } = {}) =>
      sort(rows().filter((r) => matches(r, a.where)), a.orderBy).slice(0, a.take ?? Infinity).map((r) => ({ ...r })),
    ),
    findFirst: vi.fn(async (a: { where?: Record<string, unknown>; orderBy?: Record<string, "asc" | "desc"> } = {}) => {
      const r = sort(rows().filter((x) => matches(x, a.where)), a.orderBy)[0];
      return r ? { ...r } : null;
    }),
    findUnique: vi.fn(async (a: { where: Record<string, unknown> }) => {
      const w = a.where;
      const flat = Object.fromEntries(
        Object.entries(w).flatMap(([k, v]) => (v && typeof v === "object" && !(v instanceof Date) ? Object.entries(v) : [[k, v]])),
      );
      const r = rows().find((x) => matches(x, flat));
      return r ? { ...r } : null;
    }),
    count: vi.fn(async (a: { where?: Record<string, unknown> } = {}) => rows().filter((r) => matches(r, a.where)).length),
    create: vi.fn(async (a: { data: Record<string, unknown> }) => {
      if (name === "sentNotification" && rows().some((r) => r.key === a.data.key)) {
        throw Object.assign(new Error("unique"), { code: "P2002" });
      }
      const row = { id: `${name}-${++store.seq}`, createdAt: new Date(store.seq), updatedAt: new Date(store.seq), ...a.data } as Row;
      rows().push(row);
      return { ...row };
    }),
    update: vi.fn(async (a: { where: { id: string }; data: Record<string, unknown> }) => {
      const r = rows().find((x) => x.id === a.where.id);
      if (!r) throw new Error(`${name} ${a.where.id} not found`);
      Object.assign(r, a.data, { updatedAt: new Date(++store.seq) });
      return { ...r };
    }),
    updateMany: vi.fn(async (a: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const hit = rows().filter((r) => matches(r, a.where));
      for (const r of hit) Object.assign(r, a.data, { updatedAt: new Date(++store.seq) });
      return { count: hit.length };
    }),
    upsert: vi.fn(async (a: { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }) => {
      const r = rows().find((x) => matches(x, a.where));
      if (r) {
        Object.assign(r, a.update, { updatedAt: new Date(++store.seq) });
        return { ...r };
      }
      const row = { id: `${name}-${++store.seq}`, createdAt: new Date(store.seq), updatedAt: new Date(store.seq), ...a.create } as Row;
      rows().push(row);
      return { ...row };
    }),
    createMany: vi.fn(async (a: { data: Array<Record<string, unknown>> }) => {
      for (const d of a.data) rows().push({ id: `${name}-${++store.seq}`, ...d } as Row);
      return { count: a.data.length };
    }),
    deleteMany: vi.fn(async (a: { where: Record<string, unknown> }) => {
      const keep = rows().filter((r) => !matches(r, a.where));
      const n = rows().length - keep.length;
      store.tables[name] = keep;
      return { count: n };
    }),
  };
}

const dbMock = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/team-generation", () => ({
  generateTeamsForMatch: vi.fn(),
  matchRatingsFor: vi.fn(async (_m: string, _o: string, ids: string[]) => new Map(ids.map((id) => [id, 5]))),
}));
const graphics = vi.hoisted(() => ({ sendGraphicToAdminChannel: vi.fn() }));
vi.mock("@/lib/admin-group-graphics", () => graphics);
const announcer = vi.hoisted(() => ({ loadOrganisersAnnounce: vi.fn() }));
vi.mock("@/lib/list-announcer-store", () => announcer);
const hqLog = vi.hoisted(() => ({ recordMatchTimeQuestion: vi.fn(), teamsAskRef: (id: string) => `teams:${id}` }));
vi.mock("@/lib/admin-group-log", () => hqLog);

import {
  answerTeamsYes,
  handleTeamCommand,
  setAsideTeamProposal,
  teamProposalJobs,
  type TeamProposalDeps,
} from "../team-proposal";
import type { TeamCommand } from "../team-proposal-rules";

const ORG = "org-fnf";
const MATCH = "m-fri";
// Friday 16 Oct 2026, kickoff 20:00 London = 19:00 UTC.
const KICKOFF = new Date("2026-10-16T19:00:00.000Z");
const NOON = new Date("2026-10-16T11:00:00.000Z");

const PLAYERS: Array<[string, string]> = [
  ["u-ali", "Ali Khan"],
  ["u-bilal", "Bilal Ahmed"],
  ["u-tom", "Tom Third"],
  ["u-sheh", "Shehryar Malik"],
  ["u-zara", "Zara Zest"],
];

function seed() {
  store.tables = {};
  store.seq = 0;
  for (const k of [
    "organisation",
    "activity",
    "match",
    "teamAssignment",
    "attendance",
    "user",
    "userAlias",
    "adminTeamProposal",
    "adminSquadProposal",
    "botJob",
    "sentNotification",
    "sport",
    "adminTeamSheet",
  ]) {
    dbMock[k] = table(k);
  }
  dbMock.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(dbMock));
  dbMock.$executeRaw = vi.fn(async () => 1);
  store.tables.organisation = [
    { id: ORG, name: "FNF", language: "en", teamLabels: [], adminGroupId: "hq@g.us", squadMode: "weekly", teamsReadyTime: "10:00", billingStatus: null },
  ];
  store.tables.sport = [{ id: "sp", playersPerTeam: 2, teamLabels: [] }];
  store.tables.activity = [{ id: "act", orgId: ORG, sportId: "sp", venue: "Goals Sutton" }];
  store.tables.match = [{ id: MATCH, activityId: "act", date: KICKOFF, status: "UPCOMING", teamLabels: [], maxPlayers: 4 }];
  store.tables.user = PLAYERS.map(([id, name]) => ({ id, name }));
  store.tables.attendance = PLAYERS.slice(0, 4).map(([userId], i) => ({ id: `att-${i}`, matchId: MATCH, userId, status: "CONFIRMED" }));
  store.tables.userAlias = [{ id: "al-1", orgId: ORG, userId: "u-sheh", alias: "shez" }];
}

/** Red: Ali, Bilal. Yellow: Tom, Shehryar. In sheet order. */
function seedSheet(status = "TEAMS_GENERATED") {
  store.tables.teamAssignment = [
    { id: "ta-1", matchId: MATCH, userId: "u-ali", team: "RED" },
    { id: "ta-2", matchId: MATCH, userId: "u-bilal", team: "RED" },
    { id: "ta-3", matchId: MATCH, userId: "u-tom", team: "YELLOW" },
    { id: "ta-4", matchId: MATCH, userId: "u-sheh", team: "YELLOW" },
  ];
  (store.tables.match[0] as Row).status = status;
}

const teamOf = (userId: string) => store.tables.teamAssignment.find((r) => r.userId === userId)?.team;
const proposal = () => store.tables.adminTeamProposal?.[0];
const groupJobs = () => (store.tables.botJob ?? []).filter((j) => j.kind === "group");
const adminJobs = () => (store.tables.botJob ?? []).filter((j) => j.kind === "admin-group");

const generate = vi.fn(async (matchId: string) => {
  seedSheet();
  return { ok: true as const, groupPost: "GROUP POST", matchId };
});
const quiet: TeamProposalDeps = { generate, announce: () => true };
const loud: TeamProposalDeps = { generate, announce: () => false };

/**
 * What the shared teams extractor reads from these words, as the command
 * `admin-group-understand.ts` hands over (`teamCommandFromFacts`). The
 * reading itself is the model's and is tested live; this file tests what
 * the command does.
 */
const change = (more: Partial<Extract<TeamCommand, { kind: "change" }>>): TeamCommand => ({
  kind: "change",
  swapSides: false,
  moves: [],
  sides: [],
  together: [],
  ...more,
});
function asCommand(text: string): TeamCommand {
  if (text === "teams" || text === "takımlar") return { kind: "show" };
  if (text === "reshuffle") return { kind: "reshuffle", sides: [], together: [] };
  let m = /^swap (\S+) (\S+)$/.exec(text);
  if (m) return change({ moves: [m[1], m[2]] });
  m = /^(\S+) ile (\S+) değiş$/.exec(text);
  if (m) return change({ moves: [m[1], m[2]] });
  m = /^move (\S+)$/.exec(text);
  if (m) return change({ moves: [m[1]] });
  m = /^(\S+) taşı$/.exec(text);
  if (m) return change({ moves: [m[1]] });
  throw new Error(`no command for ${text}`);
}
const cmd = (text: string, deps = quiet, now = NOON, addressed = true) =>
  handleTeamCommand({ addressed, orgId: ORG, lang: "en", command: asCommand(text), senderUserId: "u-admin", messageId: `wa-${text}`, now, deps });
const yes = (deps = quiet, now = NOON) =>
  answerTeamsYes({ orgId: ORG, lang: "en", senderUserId: "u-admin", messageId: "wa-yes", now, deps });

beforeEach(() => {
  vi.clearAllMocks();
  seed();
  graphics.sendGraphicToAdminChannel.mockResolvedValue({ queued: true, jobId: "job-g" });
  announcer.loadOrganisersAnnounce.mockResolvedValue(true);
});

describe("the commands", () => {
  it("records each proposal as MatchTime's question about these teams, for the safe-YES rule", async () => {
    const r = await cmd("teams");
    expect(hqLog.recordMatchTimeQuestion).toHaveBeenCalledWith({ orgId: ORG, askRef: `teams:${MATCH}`, text: r.replyText, now: NOON });
  });

  it("a move to a named team the player is already on: one line, nothing moved", async () => {
    seedSheet();
    const r = await handleTeamCommand({ addressed: true,
      orgId: ORG,
      lang: "en",
      command: change({ sides: [{ name: "Ali", to: "RED" }] }),
      senderUserId: "u-admin",
      messageId: "wa-red",
      now: NOON,
      deps: quiet,
    });
    expect(r).toEqual({ outcome: "teams-already-there", replyText: "Ali Khan is already on Red." });
  });

  it("'teams' with none built: builds them with the shared generator and proposes them", async () => {
    const r = await cmd("teams");
    expect(generate).toHaveBeenCalledWith(MATCH, {});
    expect(r?.outcome).toBe("teams-built");
    expect(r?.replyText).toContain("📝 *Proposed teams*: 20:00 at Goals Sutton");
    expect(r?.replyText).toContain("*Red*:\n1. Ali Khan\n2. Bilal Ahmed");
    expect(r?.replyText).toContain("*Yellow*:\n1. Tom Third\n2. Shehryar Malik");
    expect(r?.replyText).toContain("I won't post them in the players' group.");
    expect(proposal()).toMatchObject({ orgId: ORG, matchId: MATCH, state: "proposed", askedAt: NOON });
    expect(groupJobs()).toEqual([]);
  });

  it("'teams' with teams already built: shows them, does not rebuild", async () => {
    seedSheet();
    const r = await cmd("takımlar");
    expect(generate).not.toHaveBeenCalled();
    expect(r?.outcome).toBe("teams-shown");
    expect(proposal()).toMatchObject({ state: "proposed" });
  });

  it("'teams' with too few players: a whole sentence with the count and what to do, nothing stored", async () => {
    store.tables.attendance = store.tables.attendance.slice(0, 3);
    const short = vi.fn(async () => ({ ok: false as const, reason: "not enough confirmed players (3/4)" }));
    const r = await cmd("teams", { generate: short, announce: () => true });
    expect(r).toEqual({
      outcome: "teams-not-built",
      replyText: "⚠️ Not enough players to make the teams for 20:00: 3 of 4 in. Add players, then ask me for the teams again.",
    });
    expect(proposal()).toBeUndefined();
  });

  it("'takımlar' with too few players, in Turkish", async () => {
    store.tables.attendance = store.tables.attendance.slice(0, 3);
    const short = vi.fn(async () => ({ ok: false as const, reason: "yeterli onaylı oyuncu yok, 3/4" }));
    const r = await handleTeamCommand({ addressed: true,
      orgId: ORG,
      lang: "tr",
      command: { kind: "show" },
      senderUserId: "u-admin",
      messageId: "wa-tr",
      now: NOON,
      deps: { generate: short, announce: () => true },
    });
    expect(r?.replyText).toBe(
      "⚠️ 20:00 maçı için takım kuracak kadar oyuncu yok: 4 kişi gerekiyor, 3 kişi var. Oyuncu ekleyin, sonra takımları yeniden isteyin.",
    );
  });

  it("'teams' refused for another reason: the reason inside a sentence", async () => {
    const refused = vi.fn(async () => ({ ok: false as const, reason: "match is cancelled" }));
    const r = await cmd("teams", { generate: refused, announce: () => true });
    expect(r).toEqual({ outcome: "teams-not-built", replyText: "Can't build teams right now: match is cancelled." });
  });

  it("no upcoming game: says so", async () => {
    (store.tables.match[0] as Row).status = "COMPLETED";
    expect(await cmd("teams")).toEqual({ outcome: "teams-no-match", replyText: "There's no upcoming game to build teams for." });
  });

  it("'reshuffle' always rebuilds", async () => {
    seedSheet();
    const r = await cmd("reshuffle");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(r?.outcome).toBe("teams-built");
  });

  it("'swap Ali Tom' swaps the two in TeamAssignment and reposts", async () => {
    seedSheet();
    const r = await cmd("swap Ali Tom");
    expect(r?.outcome).toBe("teams-swapped");
    expect(teamOf("u-ali")).toBe("YELLOW");
    expect(teamOf("u-tom")).toBe("RED");
    expect(r?.replyText).toContain("*Red*:\n1. Bilal Ahmed\n2. Tom Third");
    expect(dbMock.$executeRaw).toHaveBeenCalled(); // the per-match slot lock
  });

  it("Turkish swap, and an alias", async () => {
    seedSheet();
    const r = await cmd("Ali ile Shez değiş");
    expect(r?.outcome).toBe("teams-swapped");
    expect(teamOf("u-ali")).toBe("YELLOW");
    expect(teamOf("u-sheh")).toBe("RED");
  });

  it("swap two on the same team: nothing written, says so", async () => {
    seedSheet();
    const r = await cmd("swap Ali Bilal");
    expect(r).toEqual({ outcome: "teams-same-team", replyText: "Ali Khan and Bilal Ahmed are on the same team, so there's nothing to swap." });
    expect(teamOf("u-ali")).toBe("RED");
  });

  it("an unknown name: a short reply, nothing written", async () => {
    seedSheet();
    const r = await cmd("swap Ali Zed");
    expect(r).toEqual({ outcome: "teams-name-unclear", replyText: "I can't find Zed in the teams." });
  });

  it("an ambiguous name lists the candidates", async () => {
    seedSheet();
    store.tables.user.push({ id: "u-ali2", name: "Ali Rahman" });
    store.tables.attendance.push({ id: "att-9", matchId: MATCH, userId: "u-ali2", status: "CONFIRMED" });
    store.tables.teamAssignment.push({ id: "ta-5", matchId: MATCH, userId: "u-ali2", team: "YELLOW" });
    const r = await cmd("move Ali");
    expect(r).toEqual({ outcome: "teams-name-unclear", replyText: "Ali could be Ali Khan, Ali Rahman; use the full name." });
  });

  it("a name not on the teams is unknown even when they are in the club", async () => {
    seedSheet();
    expect((await cmd("move Zara"))?.replyText).toBe("I can't find Zara in the teams.");
  });

  it("'move Bilal' moves one player to the other team", async () => {
    seedSheet();
    const r = await cmd("move Bilal");
    expect(r?.outcome).toBe("teams-moved");
    expect(teamOf("u-bilal")).toBe("YELLOW");
  });

  it("swap or move with no teams: tells them to type teams", async () => {
    expect(await cmd("move Bilal")).toEqual({ outcome: "teams-no-teams", replyText: "There are no teams yet. Tag me and ask for them (for example *@Match Time make the teams*) and I'll build them." });
  });

  it("a change after approval keeps the teams final and updates what the group was told", async () => {
    seedSheet();
    await cmd("teams");
    await yes();
    const r = await cmd("move Bilal");
    expect(r?.replyText).toContain("✅ *Final teams*");
    expect(proposal()).toMatchObject({ state: "approved" });
    expect((store.tables.match[0] as Row).status).toBe("TEAMS_PUBLISHED");
    expect(proposal()?.toldSheet).toEqual(expect.arrayContaining([expect.objectContaining({ userId: "u-bilal", team: "YELLOW" })]));
    // No team sheet picture on its own (Kemal, 2026-10-30: only when asked, tagged).
    expect(graphics.sendGraphicToAdminChannel).not.toHaveBeenCalled();
  });

  it("a change before approval: no team sheet graphic", async () => {
    seedSheet();
    await cmd("move Bilal");
    expect(graphics.sendGraphicToAdminChannel).not.toHaveBeenCalled();
  });

  it("'reshuffle' after approval reopens the question", async () => {
    seedSheet();
    await cmd("teams");
    await yes();
    await cmd("reshuffle");
    expect(proposal()).toMatchObject({ state: "proposed", approvedAt: null });
  });

  it("final again after a reshuffle: still no team sheet picture on its own", async () => {
    seedSheet();
    await cmd("teams");
    await yes();
    await cmd("reshuffle");
    await yes();
    expect(graphics.sendGraphicToAdminChannel).not.toHaveBeenCalled();
  });
});

describe("YES", () => {
  it("makes the proposed teams final: TEAMS_PUBLISHED, 'Teams are final.', nothing in the players' group", async () => {
    await cmd("teams");
    const r = await yes();
    expect(r).toEqual({ outcome: "teams-final", replyText: "Teams are final." });
    expect((store.tables.match[0] as Row).status).toBe("TEAMS_PUBLISHED");
    expect(proposal()).toMatchObject({ state: "approved", approvedByUserId: "u-admin", approvedAt: NOON });
    expect(groupJobs()).toEqual([]);
    expect(adminJobs()).toEqual([]);
  });

  it("when the organisers do NOT announce, the final teams go to the players' group once", async () => {
    await cmd("teams", loud);
    const r = await yes(loud);
    expect(r?.replyText).toBe("Teams are final. I've posted them in the players' group.");
    expect(groupJobs()).toHaveLength(1);
    expect(groupJobs()[0].text).toContain("Ali Khan");
  });

  it("YES draws no team sheet picture: it is drawn only when asked, tagged (Kemal, 2026-10-30)", async () => {
    await cmd("teams");
    await yes();
    expect(graphics.sendGraphicToAdminChannel).not.toHaveBeenCalled();
    expect(adminJobs()).toEqual([]);
  });

  it("with no announce dependency injected, the club's own setting is read", async () => {
    await cmd("teams", { generate });
    announcer.loadOrganisersAnnounce.mockResolvedValue(false);
    expect((await yes({ generate }))?.replyText).toBe("Teams are final. I've posted them in the players' group.");
    expect(announcer.loadOrganisersAnnounce).toHaveBeenCalledWith(ORG);
  });

  it("nothing proposed: null (a pasted list's YES may still be waiting)", async () => {
    expect(await yes()).toBeNull();
  });

  it("a second YES finds nothing waiting", async () => {
    await cmd("teams");
    await yes();
    expect(await yes()).toBeNull();
  });

  it("teams cleared since they were proposed: nothing to approve", async () => {
    await cmd("teams");
    store.tables.teamAssignment = [];
    expect(await yes()).toEqual({ outcome: "teams-no-teams", replyText: "There are no teams yet. Tag me and ask for them (for example *@Match Time make the teams*) and I'll build them." });
    expect(proposal()).toMatchObject({ state: "set-aside" });
  });
});

describe("one question at a time", () => {
  it("a team proposal supersedes a pasted list waiting for YES, and says so", async () => {
    store.tables.adminSquadProposal = [
      { id: "asp-1", orgId: ORG, matchId: MATCH, resolvedAt: null, expiresAt: new Date(NOON.getTime() + 60_000), createdAt: NOON },
    ];
    const r = await cmd("teams");
    expect(store.tables.adminSquadProposal[0]).toMatchObject({ outcome: "superseded", resolvedAt: NOON });
    expect(r?.replyText).toContain("The list pasted earlier was not applied.");
  });

  it("a pasted list sets the teams aside: YES no longer approves them", async () => {
    await cmd("teams");
    expect(await setAsideTeamProposal(ORG)).toBe(1);
    expect(proposal()).toMatchObject({ state: "set-aside" });
    expect(await yes()).toBeNull();
    expect((store.tables.match[0] as Row).status).toBe("TEAMS_GENERATED");
    // "teams" asks again, and then YES approves.
    await cmd("teams");
    expect((await yes())?.outcome).toBe("teams-final");
  });

  it("setting aside with nothing proposed changes nothing", async () => {
    expect(await setAsideTeamProposal(ORG)).toBe(0);
  });
});

const orgRow = () => store.tables.organisation[0] as Row & { id: string; language: string };
const tick = (now: Date, deps = quiet) =>
  teamProposalJobs({ org: orgRow() as unknown as Parameters<typeof teamProposalJobs>[0]["org"], now, deps });

describe("the scheduled proposal ('Teams ready')", () => {
  it("before the ready time: nothing", async () => {
    expect(await tick(new Date("2026-10-16T08:59:00.000Z"))).toBe(0);
    expect(generate).not.toHaveBeenCalled();
  });

  it("at the ready time with a full enough squad: builds and posts the proposal in the admin group, once", async () => {
    expect(await tick(new Date("2026-10-16T09:00:00.000Z"))).toBe(1);
    expect(generate).toHaveBeenCalledWith(MATCH, {});
    expect(adminJobs()).toHaveLength(1);
    expect(adminJobs()[0].text).toContain("📝 *Proposed teams*");
    expect(groupJobs()).toEqual([]);
    expect(proposal()).toMatchObject({ state: "proposed" });
    expect(await tick(new Date("2026-10-16T09:01:00.000Z"))).toBe(0);
    expect(adminJobs()).toHaveLength(1);
  });

  it("too few to balance (the balancer's own minimum): HQ is told once, and the proposal follows when the squad fills", async () => {
    store.tables.attendance = store.tables.attendance.slice(0, 3);
    expect(await tick(new Date("2026-10-16T09:00:00.000Z"))).toBe(1);
    expect(generate).not.toHaveBeenCalled();
    expect(adminJobs().map((j) => j.text)).toEqual([
      "⚠️ Not enough players to make the teams for 20:00: 3 of 4 in. Add players, then ask me for the teams again.",
    ]);
    expect(groupJobs()).toEqual([]);
    // Not repeated on every tick.
    expect(await tick(new Date("2026-10-16T09:05:00.000Z"))).toBe(0);
    expect(await tick(new Date("2026-10-16T10:00:00.000Z"))).toBe(0);
    expect(adminJobs()).toHaveLength(1);
    store.tables.attendance.push({ id: "att-x", matchId: MATCH, userId: "u-zara", status: "CONFIRMED" });
    expect(await tick(new Date("2026-10-16T10:30:00.000Z"))).toBe(1);
    expect(adminJobs()).toHaveLength(2);
    expect(adminJobs()[1].text).toContain("📝 *Proposed teams*");
  });

  it("too few, before the ready time: nothing yet", async () => {
    store.tables.attendance = store.tables.attendance.slice(0, 3);
    expect(await tick(new Date("2026-10-16T08:59:00.000Z"))).toBe(0);
    expect(adminJobs()).toEqual([]);
  });

  it("teams already built: proposes those, does not rebuild", async () => {
    seedSheet();
    expect(await tick(NOON)).toBe(1);
    expect(generate).not.toHaveBeenCalled();
  });

  it("teams already final from the website: nothing", async () => {
    seedSheet("TEAMS_PUBLISHED");
    expect(await tick(NOON)).toBe(0);
  });

  it("admins already typed 'teams': no second proposal", async () => {
    await cmd("teams", quiet, new Date("2026-10-16T08:00:00.000Z"));
    expect(await tick(NOON)).toBe(0);
  });

  it("nothing stored and the organisers announce: the default 10:00 applies", async () => {
    orgRow().teamsReadyTime = null;
    orgRow().listAnnouncer = "organisers";
    expect(await tick(new Date("2026-10-16T08:59:00.000Z"))).toBe(0);
    expect(await tick(new Date("2026-10-16T09:00:00.000Z"))).toBe(1);
  });

  it("nothing stored and MatchTime announces: Off, nothing proposed", async () => {
    orgRow().teamsReadyTime = null;
    orgRow().listAnnouncer = "matchtime";
    expect(await tick(NOON)).toBe(0);
    expect(generate).not.toHaveBeenCalled();
  });

  it("an explicit time wins even when MatchTime announces", async () => {
    orgRow().teamsReadyTime = "11:00";
    orgRow().listAnnouncer = "matchtime";
    expect(await tick(new Date("2026-10-16T09:30:00.000Z"))).toBe(0);
    expect(await tick(new Date("2026-10-16T10:00:00.000Z"))).toBe(1);
  });

  it("off, no admin group, a monthly club, or not match day: nothing", async () => {
    orgRow().teamsReadyTime = "off";
    expect(await tick(NOON)).toBe(0);
    orgRow().teamsReadyTime = "10:00";
    orgRow().adminGroupId = null;
    expect(await tick(NOON)).toBe(0);
    orgRow().adminGroupId = "hq@g.us";
    orgRow().squadMode = "monthly";
    expect(await tick(NOON)).toBe(0);
    orgRow().squadMode = "weekly";
    expect(await tick(new Date("2026-10-15T11:00:00.000Z"))).toBe(0);
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("the reminder at kickoff minus 2 hours", () => {
  it("once, in the admin group, when nobody approved", async () => {
    await tick(NOON);
    expect(await tick(new Date("2026-10-16T16:59:00.000Z"))).toBe(0);
    expect(await tick(new Date("2026-10-16T17:00:00.000Z"))).toBe(1);
    expect(adminJobs()[1].text).toBe("⏰ The teams for 20:00 aren't final yet. Tag me and ask to see them, in your own words (for example *@Match Time show me the teams*), then say *@Match Time YES*.");
    expect(await tick(new Date("2026-10-16T17:30:00.000Z"))).toBe(0);
    expect(groupJobs()).toEqual([]);
  });

  it("not when they were approved", async () => {
    await tick(NOON);
    await yes();
    expect(await tick(new Date("2026-10-16T17:00:00.000Z"))).toBe(0);
  });
});

describe("after approval: a squad change is told to the admin group", () => {
  it("a replacement inheriting the dropped player's slot", async () => {
    await cmd("teams");
    await yes();
    // The engine's slot fill (team-slot-fill.ts): Bilal out, Zara in, Zara takes Bilal's row.
    (store.tables.attendance.find((a) => a.userId === "u-bilal") as Row).status = "DROPPED";
    store.tables.attendance.push({ id: "att-z", matchId: MATCH, userId: "u-zara", status: "CONFIRMED" });
    (store.tables.teamAssignment.find((r) => r.userId === "u-bilal") as Row).userId = "u-zara";
    expect(await tick(new Date("2026-10-16T13:00:00.000Z"))).toBe(1);
    const text = adminJobs().at(-1)?.text as string;
    expect(text.startsWith("🔄 *Team change*: Zara Zest replaces Bilal Ahmed on Red.")).toBe(true);
    expect(text).toContain("✅ *Final teams*");
    // Told once.
    expect(await tick(new Date("2026-10-16T13:01:00.000Z"))).toBe(0);
    expect(groupJobs()).toEqual([]);
    // No updated team sheet picture on its own (Kemal, 2026-10-30).
    expect(graphics.sendGraphicToAdminChannel).not.toHaveBeenCalled();
  });

  it("a drop-out with nobody yet: the place is open", async () => {
    await cmd("teams");
    await yes();
    (store.tables.attendance.find((a) => a.userId === "u-tom") as Row).status = "DROPPED";
    expect(await tick(new Date("2026-10-16T13:00:00.000Z"))).toBe(1);
    expect(adminJobs().at(-1)?.text).toContain("Tom Third is out, Yellow has a place open.");
    expect(adminJobs().at(-1)?.text).toContain("1. Tom Third  (out, place open)");
  });

  it("nothing changed: nothing said", async () => {
    await cmd("teams");
    await yes();
    expect(await tick(new Date("2026-10-16T13:00:00.000Z"))).toBe(0);
  });
});

// ── Uneven sides (2026-10-14, the FNF rehearsal: `move A` left 8 v 10 and
//    YES finalised it without a word) ────────────────────────────────────

/** Five confirmed, Red: Ali, Bilal, Tom. Yellow: Shehryar, Zara. 3 v 2: as even as five can be. */
function seedFive() {
  store.tables.attendance.push({ id: "att-z", matchId: MATCH, userId: "u-zara", status: "CONFIRMED" });
  store.tables.teamAssignment = [
    { id: "ta-1", matchId: MATCH, userId: "u-ali", team: "RED" },
    { id: "ta-2", matchId: MATCH, userId: "u-bilal", team: "RED" },
    { id: "ta-3", matchId: MATCH, userId: "u-tom", team: "RED" },
    { id: "ta-4", matchId: MATCH, userId: "u-sheh", team: "YELLOW" },
    { id: "ta-5", matchId: MATCH, userId: "u-zara", team: "YELLOW" },
  ];
  (store.tables.match[0] as Row).status = "TEAMS_GENERATED";
}

describe("uneven sides", () => {
  it("'move Bilal' leaving 3 v 1: the proposal says the sides are uneven", async () => {
    seedSheet();
    const r = await cmd("move Bilal");
    expect(r?.replyText).toContain("⚠️ The sides are uneven: Red 1, Yellow 3.");
  });

  it("even sides, and an odd total split one apart, say nothing about it", async () => {
    seedSheet();
    expect((await cmd("teams"))?.replyText).not.toContain("uneven");
    seedFive();
    expect((await cmd("teams"))?.replyText).not.toContain("uneven");
  });

  it("YES on uneven sides asks again; a second YES makes them final", async () => {
    seedSheet();
    await cmd("move Bilal");
    const first = await yes();
    expect(first).toEqual({
      outcome: "teams-uneven",
      replyText: "The sides are uneven: Red 1, Yellow 3. Say *@Match Time YES* again to make them final as they are, or first tag me and say who to move, in your own words.",
    });
    expect((store.tables.match[0] as Row).status).toBe("TEAMS_GENERATED");
    const second = await yes();
    expect(second?.outcome).toBe("teams-final");
    expect((store.tables.match[0] as Row).status).toBe("TEAMS_PUBLISHED");
  });

  it("a change after the warning asks the question afresh: evened up, one YES is enough", async () => {
    seedSheet();
    await cmd("move Bilal");
    expect((await yes())?.outcome).toBe("teams-uneven");
    await cmd("move Bilal");
    expect((await yes())?.outcome).toBe("teams-final");
  });

  it("a pasted list sets aside teams waiting for the second YES too", async () => {
    seedSheet();
    await cmd("move Bilal");
    await yes();
    expect(await setAsideTeamProposal(ORG)).toBe(1);
    expect(await yes()).toBeNull();
  });

  it("Turkish", async () => {
    seedSheet();
    await handleTeamCommand({ addressed: true, orgId: ORG, lang: "tr", command: asCommand("Bilal taşı"), senderUserId: "u-admin", messageId: "wa-tr", now: NOON, deps: quiet });
    const r = await answerTeamsYes({ orgId: ORG, lang: "tr", senderUserId: "u-admin", messageId: "wa-yes", now: NOON, deps: quiet });
    expect(r?.replyText).toBe(
      "Takımlar dengesiz: Kırmızı 1, Sarı 3. Böyle kesinleşsin istiyorsanız yine *@Match Time EVET* yazın, ya da önce beni etiketleyip kimin diğer takıma geçeceğini kendi cümlelerinizle yazın.",
    );
  });
});

// ── 2026-10-29, FNF HQ: many names, the sides swapped, pairings, "Recommend swaps" ──

const run = (command: TeamCommand, deps: TeamProposalDeps = quiet, lang = "en") =>
  handleTeamCommand({ addressed: true, orgId: ORG, lang, command, senderUserId: "u-admin", messageId: "wa-x", now: NOON, deps });

describe("one change with any number of names", () => {
  it("three names all change side in one change, and the teams are reposted once", async () => {
    seedSheet();
    const r = await run(change({ moves: ["Ali", "Tom", "Shehryar"] }));
    expect(r.outcome).toBe("teams-changed");
    expect(teamOf("u-ali")).toBe("YELLOW");
    expect(teamOf("u-tom")).toBe("RED");
    expect(teamOf("u-sheh")).toBe("RED");
    expect(teamOf("u-bilal")).toBe("RED");
    expect(r.replyText).toContain("📝 *Proposed teams*");
  });

  it("two pairs on separate lines (four names) swap both pairs", async () => {
    seedSheet();
    const r = await run(change({ moves: ["Ali", "Tom", "Bilal", "Shehryar"] }));
    expect(r.outcome).toBe("teams-changed");
    expect([teamOf("u-ali"), teamOf("u-bilal"), teamOf("u-tom"), teamOf("u-sheh")]).toEqual(["YELLOW", "YELLOW", "RED", "RED"]);
  });

  it("one name that does not resolve rejects the whole change, names it, and writes nothing", async () => {
    seedSheet();
    const r = await run(change({ moves: ["Ali", "Tom", "Zed"] }));
    expect(r).toEqual({ outcome: "teams-name-unclear", replyText: "I can't find Zed in the teams." });
    expect(teamOf("u-ali")).toBe("RED");
    expect(teamOf("u-tom")).toBe("YELLOW");
  });

  it("every name of one side and nobody else ('switch all 9'): the two sides swap over, never one side empty", async () => {
    seedSheet();
    store.tables.attendance.push({ id: "att-z", matchId: MATCH, userId: "u-zara", status: "CONFIRMED" });
    store.tables.teamAssignment.push({ id: "ta-5", matchId: MATCH, userId: "u-zara", team: "YELLOW" });
    const r = await run(change({ moves: ["Tom", "Shehryar", "Zara"] }));
    expect(r.outcome).toBe("teams-changed");
    expect(["u-ali", "u-bilal", "u-tom", "u-sheh", "u-zara"].map(teamOf)).toEqual(["YELLOW", "YELLOW", "RED", "RED", "RED"]);
  });

  it("the two sides swapped over: everyone changes side", async () => {
    seedSheet();
    const r = await run(change({ swapSides: true }));
    expect(r.outcome).toBe("teams-changed");
    expect([teamOf("u-ali"), teamOf("u-bilal"), teamOf("u-tom"), teamOf("u-sheh")]).toEqual(["YELLOW", "YELLOW", "RED", "RED"]);
    expect(r.replyText).toContain("*Red*:\n1. Tom Third\n2. Shehryar Malik");
  });
});

describe("put together, or on a side, on teams that exist: a targeted change", () => {
  it("'Ali and Tom on one team': the fewest move, the sides stay even, and it says who else moved", async () => {
    seedSheet();
    const r = await run(change({ together: [["Ali", "Tom"]] }));
    expect(generate).not.toHaveBeenCalled();
    expect(r.outcome).toBe("teams-changed");
    expect(teamOf("u-ali")).toBe(teamOf("u-tom"));
    const red = store.tables.teamAssignment.filter((x) => x.team === "RED").length;
    expect(red).toBe(2);
    expect(r.replyText).toContain("To keep the sides even, I also moved Bilal Ahmed to Yellow.");
  });

  it("'Ali in Yellow': moved there and one comes back", async () => {
    seedSheet();
    const r = await run(change({ sides: [{ name: "Ali", to: "YELLOW" }] }));
    expect(teamOf("u-ali")).toBe("YELLOW");
    expect(store.tables.teamAssignment.filter((x) => x.team === "RED").length).toBe(2);
    expect(r.replyText).toMatch(/To keep the sides even, I also moved (Tom Third|Shehryar Malik) to Red\./);
  });

  it("a pair already together: one line, nothing written", async () => {
    seedSheet();
    const r = await run(change({ together: [["Ali", "Bilal"]] }));
    expect(r).toEqual({ outcome: "teams-unchanged", replyText: "The teams are already like that, so nothing changed." });
  });

  it("Turkish line for the one moved back", async () => {
    seedSheet();
    const r = await run(change({ together: [["Ali", "Tom"]] }), quiet, "tr");
    expect(r.replyText).toContain("Takımlar dengeli kalsın diye Bilal Ahmed oyuncusunu da Sarı takımına aldım.");
  });

  it("with no teams yet: they are built with the pair on one side", async () => {
    const r = await run(change({ together: [["Ali", "Tom"]] }));
    expect(r.outcome).toBe("teams-built");
    expect(generate).toHaveBeenCalledWith(MATCH, { pinnedToTeam: { "u-ali": "RED", "u-tom": "RED" } });
  });

  it("a name that is not in the squad stops a build too", async () => {
    const r = await run(change({ together: [["Ali", "Zed"]] }));
    expect(r).toEqual({ outcome: "teams-name-unclear", replyText: "I can't find Zed in the teams." });
    expect(generate).not.toHaveBeenCalled();
  });

  it("new teams asked for with a pair and a side: the generator keeps both", async () => {
    seedSheet();
    await run({ kind: "reshuffle", sides: [{ name: "Shehryar", to: "YELLOW" }], together: [["Ali", "Tom"]] });
    expect(generate).toHaveBeenCalledWith(MATCH, { pinnedToTeam: { "u-sheh": "YELLOW", "u-ali": "RED", "u-tom": "RED" } });
  });

  it("a plain reshuffle passes no pins", async () => {
    seedSheet();
    await run({ kind: "reshuffle", sides: [], together: [] });
    expect(generate).toHaveBeenCalledWith(MATCH, {});
  });
});

describe("'Recommend swaps'", () => {
  // Red: Ali 9, Bilal 7. Yellow: Tom 5, Shehryar 3. Swapping Ali and Tom gives 12 v 12.
  const R: Record<string, number> = { "u-ali": 9, "u-bilal": 7, "u-tom": 5, "u-sheh": 3 };
  const rated: TeamProposalDeps = { ...quiet, ratings: async (_m, _o, ids) => new Map(ids.map((id) => [id, R[id] ?? 5])) };

  it("on proposed teams: makes the swap that evens the ratings most, says so, and asks for YES", async () => {
    seedSheet();
    const r = await run({ kind: "suggest" }, rated);
    expect(r.outcome).toBe("teams-suggested");
    expect(r.replyText).toContain("My suggestion, to even the ratings: swap Ali Khan and Tom Third.");
    expect(r.replyText).toContain("📝 *Proposed teams*");
    expect(teamOf("u-ali")).toBe("YELLOW");
    expect(teamOf("u-tom")).toBe("RED");
    expect(proposal()).toMatchObject({ state: "proposed" });
  });

  it("on final teams: says the swap and changes nothing", async () => {
    seedSheet();
    await cmd("teams");
    await yes();
    const r = await run({ kind: "suggest" }, rated);
    expect(r.outcome).toBe("teams-suggested-final");
    expect(r.replyText).toContain("I'd swap Ali Khan and Tom Third");
    expect(teamOf("u-ali")).toBe("RED");
  });

  it("when no swap helps: one line", async () => {
    seedSheet();
    const even: TeamProposalDeps = { ...quiet, ratings: async (_m, _o, ids) => new Map(ids.map((id) => [id, 5])) };
    expect(await run({ kind: "suggest" }, even)).toEqual({ outcome: "teams-suggest-none", replyText: "These teams are already as even as one swap can make them." });
  });

  it("with no teams: says there are none", async () => {
    expect((await run({ kind: "suggest" }, rated)).outcome).toBe("teams-no-teams");
  });
});


// ── 2026-10-30, Kemal: making or remaking teams needs the tag ─────────
describe("a build only when asked of MatchTime by fact (a tag, or a reply to MatchTime)", () => {
  const untagged = (text: string) => cmd(text, quiet, NOON, false);
  it("an untagged reshuffle: nothing built, nothing said", async () => {
    seedSheet();
    const before = store.tables.teamAssignment.map((r) => ({ ...r }));
    expect(await untagged("reshuffle")).toEqual({ outcome: "teams-not-asked", replyText: null });
    expect(generate).not.toHaveBeenCalled();
    expect(store.tables.teamAssignment).toEqual(before);
  });
  it("untagged 'teams' with none built: nothing built, nothing said", async () => {
    expect(await untagged("teams")).toEqual({ outcome: "teams-not-asked", replyText: null });
    expect(generate).not.toHaveBeenCalled();
    expect(proposal()).toBeUndefined();
  });
  it("an untagged pair with no teams yet: no build", async () => {
    const r = await handleTeamCommand({ addressed: false, orgId: ORG, lang: "en", command: change({ together: [["Ali", "Bilal"]] }), senderUserId: "u-admin", messageId: "wa-p", now: NOON, deps: quiet });
    expect(r).toEqual({ outcome: "teams-not-asked", replyText: null });
    expect(generate).not.toHaveBeenCalled();
  });
  it("an untagged single change on teams that exist still works", async () => {
    seedSheet();
    expect((await untagged("move Bilal")).outcome).toBe("teams-moved");
    expect(teamOf("u-bilal")).toBe("YELLOW");
  });
  it("29 Oct: an untagged pairing on proposed teams is a targeted change, never a reshuffle", async () => {
    seedSheet();
    const r = await handleTeamCommand({ addressed: false, orgId: ORG, lang: "en", command: change({ together: [["Ali", "Tom"]] }), senderUserId: "u-admin", messageId: "wa-stick", now: NOON, deps: quiet });
    expect(["teams-changed", "teams-unchanged"]).toContain(r.outcome);
    expect(generate).not.toHaveBeenCalled();
    expect(teamOf("u-ali")).toBe(teamOf("u-tom"));
  });
  it("a tagged reshuffle builds", async () => {
    seedSheet();
    expect((await cmd("reshuffle")).outcome).toBe("teams-built");
    expect(generate).toHaveBeenCalled();
  });
});

// ── 2026-10-30, FNF HQ: an earlier set of teams brought back ─────────
describe("restore and set: the teams of an earlier sheet, or of a pasted one, as a proposal needing YES", () => {
  const run = (command: TeamCommand, quotedSheet: unknown = null) =>
    handleTeamCommand({ addressed: true, orgId: ORG, lang: "en", command, senderUserId: "u-admin", messageId: "wa-r", now: NOON, deps: quiet, quotedSheet: quotedSheet as never });
  const sheets = () => store.tables.adminTeamSheet ?? [];
  const firstSheet = () => {
    const r = sheets()[0];
    return { id: r.id, matchId: r.matchId as string, slots: r.slots as never, createdAt: new Date("2026-10-13T17:09:00.000Z") };
  };

  it("every proposal is kept as a sheet with its sides", async () => {
    seedSheet();
    await cmd("teams");
    expect(sheets()).toHaveLength(1);
    expect(sheets()[0]).toMatchObject({ orgId: ORG, matchId: MATCH, slots: expect.arrayContaining([{ userId: "u-ali", team: "RED" }, { userId: "u-tom", team: "YELLOW" }]) });
  });

  it("restore: the earlier sheet's teams come back, proposed, saying they are the earlier ones", async () => {
    seedSheet();
    await cmd("teams");
    const earlier = firstSheet();
    await cmd("swap Bilal Tom");
    expect(teamOf("u-bilal")).toBe("YELLOW");
    const r = await run({ kind: "restore" }, earlier);
    expect(r.outcome).toBe("teams-restored");
    expect(r.replyText?.startsWith("These are the earlier teams, from Tue 13 Oct at 18:09. They need your *@Match Time YES* again.\n\n📝 *Proposed teams*")).toBe(true);
    expect(teamOf("u-bilal")).toBe("RED");
    expect(teamOf("u-tom")).toBe("YELLOW");
    expect(proposal()).toMatchObject({ state: "proposed" });
    // The YES then approves exactly that sheet.
    await yes();
    expect((store.tables.match[0] as Row).status).toBe("TEAMS_PUBLISHED");
    expect(teamOf("u-bilal")).toBe("RED");
  });

  it("restore after approval: proposed again, needing YES", async () => {
    seedSheet();
    await cmd("teams");
    const earlier = firstSheet();
    await cmd("swap Bilal Tom");
    await yes();
    const r = await run({ kind: "restore" }, earlier);
    expect(r.outcome).toBe("teams-restored");
    expect((store.tables.match[0] as Row).status).toBe("TEAMS_GENERATED");
    expect(proposal()).toMatchObject({ state: "proposed", approvedAt: null });
  });

  it("restore of the teams as they stand: said so, nothing rewritten", async () => {
    seedSheet();
    await cmd("teams");
    const r = await run({ kind: "restore" }, firstSheet());
    expect(r.outcome).toBe("teams-restore-same");
    expect(r.replyText?.startsWith("Those are the teams as they stand.")).toBe(true);
  });

  it("restore with no sheet to bring back: one line", async () => {
    seedSheet();
    expect(await run({ kind: "restore" }, null)).toEqual({
      outcome: "teams-restore-none",
      replyText: "I can't find those teams. Reply to my team sheet you want back with *@Match Time use these*, or tag me and paste the two teams here.",
    });
  });

  it("restore of a sheet with someone no longer in the squad: one line, nothing written", async () => {
    seedSheet();
    await cmd("teams");
    const earlier = firstSheet();
    await cmd("swap Bilal Tom");
    (store.tables.attendance.find((a) => a.userId === "u-ali") as Row).status = "DROPPED";
    store.tables.attendance.push({ id: "att-z", matchId: MATCH, userId: "u-zara", status: "CONFIRMED" });
    const before = store.tables.teamAssignment.map((r) => ({ ...r }));
    const r = await run({ kind: "restore" }, earlier);
    expect(r.outcome).toBe("teams-sheet-invalid");
    expect(r.replyText).toBe("Not in the squad now: Ali Khan. I can't use those teams as they are. On neither team: Zara Zest. Everyone in the squad needs a side.");
    expect(store.tables.teamAssignment).toEqual(before);
  });

  it("set: a pasted sheet becomes the teams, proposed", async () => {
    seedSheet();
    const r = await run({ kind: "set", red: ["Ali", "Tom"], yellow: ["Bilal", "shez"] });
    expect(r.outcome).toBe("teams-set");
    expect(r.replyText?.startsWith("These are the teams you sent. They need your *@Match Time YES*.\n\n📝 *Proposed teams*")).toBe(true);
    expect([teamOf("u-ali"), teamOf("u-tom"), teamOf("u-bilal"), teamOf("u-sheh")]).toEqual(["RED", "RED", "YELLOW", "YELLOW"]);
    expect(proposal()).toMatchObject({ state: "proposed" });
  });

  it("set: a pasted sheet MatchTime posted before is named as the earlier one", async () => {
    seedSheet();
    await cmd("teams");
    await cmd("swap Bilal Tom");
    const r = await run({ kind: "set", red: ["Ali", "Bilal"], yellow: ["Tom", "Shehryar"] });
    expect(r.outcome).toBe("teams-restored");
    expect(r.replyText).toMatch(/^These are the earlier teams, from /);
  });

  it("set: a name not in the squad, a name twice, uneven sides, someone left out: one line each, nothing written", async () => {
    seedSheet();
    const before = store.tables.teamAssignment.map((r) => ({ ...r }));
    expect((await run({ kind: "set", red: ["Ali", "Zed"], yellow: ["Tom", "Shehryar"] })).replyText).toBe("I can't find Zed in the squad.");
    expect((await run({ kind: "set", red: ["Ali", "Bilal"], yellow: ["Tom", "Ali Khan"] })).replyText).toBe("On the teams twice: Ali Khan. Each player goes on one side.");
    expect((await run({ kind: "set", red: ["Ali", "Bilal", "Tom"], yellow: ["Shehryar"] })).replyText).toBe("Those sides are uneven: Red 3, Yellow 1. Send them again with the sides even.");
    expect((await run({ kind: "set", red: ["Ali"], yellow: ["Tom"] })).replyText).toBe("On neither team: Bilal Ahmed, Shehryar Malik. Everyone in the squad needs a side.");
    expect(store.tables.teamAssignment).toEqual(before);
  });

  it("set in Turkish", async () => {
    seedSheet();
    const r = await handleTeamCommand({ addressed: true, orgId: ORG, lang: "tr", command: { kind: "set", red: ["Ali", "Tom"], yellow: ["Bilal", "Shehryar"] }, senderUserId: "u-admin", messageId: "wa-tr", now: NOON, deps: quiet });
    expect(r.replyText?.startsWith("Gönderdiğiniz takımlar bunlar. *@Match Time EVET* yazmanız gerekiyor.")).toBe(true);
  });
});
