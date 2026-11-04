/**
 * A BENCHER WITH NO NAME ON THE ORGANISERS' PICK LIST (2026-11-04).
 *
 * The FNF sandbox replay (branch sandbox/club-scenarios) showed HQ
 *
 *   Bench:
 *   3. ? (no position, new)
 *
 * for a member imported with no name: `loadMatchWorld` labelled him
 * `a.user.name ?? "?"`, and that label went straight into the numbered
 * list. Every other surface says the club's word for "unnamed"
 * (`s.unnamed`, through `player-display-name.ts`). The pick list is read
 * by organisers only (the admin group, or their DMs), so like the admin
 * roster (`adminPlayerLabel`) it shows his phone when MatchTime has one:
 * that is how an organiser knows who "3" is. A guest's phone is never
 * shown (D7): he stays the club's word for "unnamed", with his club.
 *
 * Drives the real sweep (`sweepOrganiserPicks`) with the db mocked, so the
 * label is the one the admin notice really carries. No model, no network.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type UserRow = { id: string; name: string | null; phoneNumber: string | null; email: string | null };

const state = vi.hoisted(() => ({
  users: [] as Array<{ id: string; name: string | null; phoneNumber: string | null; email: string | null }>,
  guests: [] as Array<{ userId: string; guestFromOrgId: string | null; guestMatchId: string | null }>,
  lang: "en",
}));

const dbMock = vi.hoisted(() => ({
  organisation: { findUnique: vi.fn(), findMany: vi.fn(async () => [{ id: "home", name: "Sutton FC" }]) },
  match: { findMany: vi.fn(), findUnique: vi.fn() },
  organiserPickRound: { findMany: vi.fn(async () => []), create: vi.fn(async () => ({ id: "round1" })), updateMany: vi.fn() },
  membership: { findMany: vi.fn() },
  user: { findMany: vi.fn() },
  userAlias: { findMany: vi.fn(async () => []) },
  analyzedMessage: { findMany: vi.fn(async () => []) },
  attendanceEvent: { findMany: vi.fn(async () => []) },
  benchSlotOffer: { count: vi.fn(async () => 0) },
  adminSquadProposal: { count: vi.fn(async () => 0) },
  sentNotification: { create: vi.fn(async () => ({})) },
  playerActivityPosition: { findMany: vi.fn(async () => []) },
  rating: { findMany: vi.fn(async () => []) },
  attendance: { count: vi.fn(async () => 12) },
  botJob: { create: vi.fn(async () => ({})) },
}));
vi.mock("../db", () => ({ db: dbMock }));
vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("../org-features", () => ({ getOrgFeatures: vi.fn(async () => ({ attendance: true })) }));
vi.mock("../partner-guest-standing", () => ({ loadGuestStandings: vi.fn(async () => new Map()) }));
const sendAdminNotice = vi.hoisted(() => vi.fn(async () => ({ channel: "admin-group", queued: 1 })));
vi.mock("../admin-channel", () => ({
  sendAdminNotice,
  loadAdminChannel: vi.fn(async () => ({ cfg: { mode: "admin-group", adminGroupId: "hq@g.us" }, admins: [] })),
}));

const readPickReply = vi.hoisted(() => vi.fn(async () => ({ kind: "not-a-pick" })));
vi.mock("../organiser-pick-reader", () => ({ readPickReply }));

import { announcePickToGroupAndPlayers, handlePickReply, sweepOrganiserPicks } from "../organiser-pick";

/** Wednesday 18 November 2026, 12:00 GMT: inside the pick hours. */
const NOW = new Date("2026-11-18T12:00:00.000Z");
const KICKOFF = new Date("2026-11-20T20:30:00.000Z");

function given(bench: UserRow[], lang = "en") {
  state.lang = lang;
  const squad: UserRow[] = [{ id: "u-hamzah", name: "Hamzah Ali", phoneNumber: "+447700900001", email: null }];
  state.users = [...squad, ...bench];
  dbMock.organisation.findUnique.mockResolvedValue({
    id: "club",
    name: "FNF",
    language: lang,
    benchPickMode: "organiser",
    benchPickFallback: "leave-empty",
    approvalStatus: "approved",
    dormantAt: null,
    billingStatus: "none",
    dropOutDeadlineDay: null,
    dropOutDeadlineTime: null,
  });
  const live = {
    id: "m1",
    date: KICKOFF,
    createdAt: new Date("2026-11-10T10:00:00.000Z"),
    status: "UPCOMING",
    activityId: "act",
    isHistorical: false,
    activity: { orgId: "club", venue: "Goals", dayOfWeek: 5 },
  };
  dbMock.match.findMany.mockResolvedValue([live]);
  dbMock.match.findUnique.mockResolvedValue({
    id: "m1",
    date: KICKOFF,
    maxPlayers: 18,
    activityId: "act",
    activity: { name: "Friday Night", venue: "Goals", orgId: "club", org: { language: lang } },
    attendances: [
      ...squad.map((u, i) => ({ userId: u.id, status: "CONFIRMED", position: i + 1, user: { name: u.name } })),
      ...bench.map((u, i) => ({ userId: u.id, status: "BENCH", position: squad.length + i + 1, user: { name: u.name } })),
    ],
  });
}

/** The pick message as the admin group would get it. */
async function pickMessageText(): Promise<string> {
  await sweepOrganiserPicks("club", NOW);
  expect(sendAdminNotice).toHaveBeenCalledTimes(1);
  const req = (sendAdminNotice.mock.calls[0] as unknown as [{ text: (link: string, audience: "dm" | "group") => string }])[0];
  return req.text("", "group");
}

beforeEach(() => {
  vi.clearAllMocks();
  state.guests = [];
  dbMock.user.findMany.mockImplementation(async (args: { where: { id: { in: string[] } } }) =>
    state.users.filter((u) => args.where.id.in.includes(u.id)),
  );
  // Nobody has left; the guest rows are the test's own; the club's active
  // members (no user filter) are everybody.
  dbMock.membership.findMany.mockImplementation(async (args: { where: Record<string, unknown> }) => {
    if (args.where.leftAt) return [];
    const ids = (args.where.userId as { in: string[] } | undefined)?.in;
    if (!ids) return state.users.map((u) => ({ user: u }));
    return state.guests.filter((g) => ids.includes(g.userId));
  });
});

describe("the pick list's label for a bencher with no name", () => {
  it("is his phone when MatchTime has one, never '?'", async () => {
    given([
      { id: "u-idris", name: "Idris Bello", phoneNumber: "+447700900011", email: null },
      { id: "u-anon", name: null, phoneNumber: "+447700900123", email: null },
    ]);
    const text = await pickMessageText();
    expect(text).toContain("1. Idris Bello (no position, new)");
    expect(text).toContain("2. +44 7700 900123 (no position, new)");
    expect(text).not.toMatch(/\d\. \? \(/);
  });

  it("is the phone a WhatsApp-imported placeholder email carries, when the phone column is empty", async () => {
    given([{ id: "u-anon", name: null, phoneNumber: null, email: "wa-447700900456@placeholder.matchtime" }]);
    const text = await pickMessageText();
    expect(text).toContain("1. +44 7700 900456 (no position, new)");
  });

  it("is the club's word for unnamed when there is no phone either, in English and Turkish", async () => {
    given([{ id: "u-anon", name: null, phoneNumber: null, email: null }]);
    expect(await pickMessageText()).toContain("1. (unnamed) (no position, new)");
    vi.clearAllMocks();
    given([{ id: "u-anon", name: null, phoneNumber: null, email: null }], "tr");
    dbMock.user.findMany.mockImplementation(async (args: { where: { id: { in: string[] } } }) =>
      state.users.filter((u) => args.where.id.in.includes(u.id)),
    );
    const tr = await pickMessageText();
    expect(tr).toContain("1. (isimsiz)");
    expect(tr).not.toMatch(/\d\. \? \(/);
  });

  it("uses the name MatchTime knows him by (an alias here) before any phone", async () => {
    given([{ id: "u-anon", name: null, phoneNumber: "+447700900123", email: null }]);
    dbMock.userAlias.findMany.mockResolvedValueOnce([{ userId: "u-anon", orgId: "club", alias: "big sam" }] as never);
    const text = await pickMessageText();
    expect(text).toContain("1. Big Sam (no position, new)");
    expect(text).not.toContain("900123");
  });

  it("never shows a partner guest's phone: he is the word for unnamed, with his club", async () => {
    given([{ id: "u-guest", name: null, phoneNumber: "+447700900777", email: null }]);
    state.guests = [{ userId: "u-guest", guestFromOrgId: "home", guestMatchId: "m1" }];
    const text = await pickMessageText();
    expect(text).not.toContain("900777");
    expect(text).toContain("1. (unnamed) (Sutton FC");
  });
});

describe("an admin's reply to that list", () => {
  it("shows the pick reader the same label, and the club's members in a stable order", async () => {
    given([
      { id: "u-idris", name: "Idris Bello", phoneNumber: "+447700900011", email: null },
      { id: "u-anon", name: null, phoneNumber: "+447700900123", email: null },
    ]);
    dbMock.organiserPickRound.findMany.mockResolvedValueOnce([
      {
        id: "round1",
        matchId: "m1",
        channel: "admin-group",
        recipientUserIds: [],
        listUserIds: ["u-idris", "u-anon"],
        resolvedAt: null,
        pendingConfirmUserId: null,
        pendingConfirmAskedAt: null,
        createdAt: NOW,
      },
    ] as never);
    const out = await handlePickReply({ orgId: "club", door: "admin-group", senderUserId: "u-hamzah", text: "2", now: NOW });
    expect(out.handled).toBe(false);
    const ctx = (readPickReply.mock.calls[0] as unknown as [unknown, { list: Array<{ ref: string; name: string }> }])[1];
    expect(ctx.list.map((p) => `${p.ref}:${p.name}`)).toEqual(["p1:Idris Bello", "p2:+44 7700 900123"]);
    const members = dbMock.membership.findMany.mock.calls.find((c) => {
      const w = (c[0] as { where: Record<string, unknown> }).where;
      return w.leftAt === null && w.userId === undefined;
    });
    expect((members?.[0] as { orderBy?: unknown }).orderBy).toEqual([{ createdAt: "asc" }, { id: "asc" }]);
  });
});

describe("the players' group post after a pick (A2)", () => {
  it("never names him by his phone: the club's word for unnamed there", async () => {
    dbMock.match.findUnique.mockResolvedValue({
      id: "m1",
      maxPlayers: 18,
      date: KICKOFF,
      teamLabels: [],
      activity: { venue: "Goals", sport: { teamLabels: [] }, org: { id: "club", name: "FNF", teamLabels: [], language: "en", listAnnouncer: "matchtime" } },
    });
    dbMock.user.findMany.mockResolvedValue([{ id: "u-anon", phoneNumber: null, memberships: [] }] as never);
    await announcePickToGroupAndPlayers("m1", {
      applied: [{ userId: "u-anon", name: "+44 7700 900123", replacedName: "+44 7700 900999", groupName: "(unnamed)", groupReplacedName: "(unnamed)", team: null }],
      alreadyIn: [],
      notOnWaitingList: [],
      noPlaceFor: [],
      confirmedAfter: 12,
      maxPlayers: 18,
      filled: false,
    });
    const post = (dbMock.botJob.create.mock.calls as unknown as Array<[{ data: { kind: string; text: string } }]>).map((c) => c[0].data).find((d) => d.kind === "group");
    expect(post?.text).toBe("✅ *(unnamed)* is in, replacing *(unnamed)*. Squad *12/18*.");
  });
});

/**
 * K5 (club summary, slice B4, Kemal 2026-11-04): the organiser pick is a post
 * about the next match, so it holds on the day of an earlier game of the
 * fixture that was cancelled, as the announcement does. Before B4 the sweep
 * passed no clock to the posting rule and never loaded a cancelled match.
 */
describe("K5: the pick holds on a cancelled game's day", () => {
  const bencher = { id: "u-idris", name: "Idris Bello", phoneNumber: "+447700900011", email: null };
  /** An earlier game of the same fixture today (Wed 18 Nov 20:30), cancelled. */
  const cancelledToday = {
    id: "m0",
    date: new Date("2026-11-18T20:30:00.000Z"),
    createdAt: new Date("2026-11-01T10:00:00.000Z"),
    status: "CANCELLED",
    activityId: "act",
    isHistorical: false,
    activity: { orgId: "club", venue: "Goals", dayOfWeek: 5 },
  };

  it("asks for the live matches and the cancelled ones whose day may not be over", async () => {
    given([bencher]);
    await sweepOrganiserPicks("club", NOW);
    const where = (dbMock.match.findMany.mock.calls[0] as unknown as [{ where: { OR: unknown[] } }])[0].where;
    expect(where.OR).toContainEqual({ status: "CANCELLED", date: { gte: new Date(NOW.getTime() - 24 * 60 * 60 * 1000) } });
  });

  it("no pick message for the next game on the cancelled game's day; the cancelled game is never swept", async () => {
    given([bencher]);
    const live = (await dbMock.match.findMany()) as unknown[];
    dbMock.match.findMany.mockResolvedValue([cancelledToday, ...live]);
    await sweepOrganiserPicks("club", NOW);
    expect(sendAdminNotice).not.toHaveBeenCalled();
    expect(dbMock.organiserPickRound.findMany.mock.calls.map((c) => (c as unknown as [{ where: { matchId: string } }])[0].where.matchId)).toEqual(["m1"]);
  });

  it("CONTROL: the next morning the pick message goes out", async () => {
    given([bencher]);
    const live = (await dbMock.match.findMany()) as unknown[];
    dbMock.match.findMany.mockResolvedValue([cancelledToday, ...live]);
    await sweepOrganiserPicks("club", new Date("2026-11-19T12:00:00.000Z"));
    expect(sendAdminNotice).toHaveBeenCalledTimes(1);
  });
});
