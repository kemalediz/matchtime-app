/**
 * AN ORGANISER PUTS SOMEBODY ON A MONTH, the writes (2026-11-03): the join
 * mirrors /admin/months "Add a player, Regular"; only an organiser's
 * request acts; a name nobody knows is a new player plus ONE "who is
 * this?" DM; his "Zak is 3" folds the new player into that member with
 * the user-merge tool, or links the member. Database and model mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  membershipFindFirst: vi.fn(),
  membershipFindMany: vi.fn(),
  aliasFindMany: vi.fn(async () => []),
  orgFindUnique: vi.fn(async () => ({ language: "en" })),
  userFindUnique: vi.fn(async () => ({ phoneNumber: "+447700900001" })),
  notifCreate: vi.fn(async () => ({})),
  notifFindFirst: vi.fn(),
  notifUpdate: vi.fn(async () => ({})),
  notifDeleteMany: vi.fn(async () => ({ count: 1 })),
  botJobCreate: vi.fn(async () => ({})),
  applySignup: vi.fn(async () => ({ ok: true, changed: true, locked: false, outcome: "regular", unknownDays: [] })),
  commitMonthGames: vi.fn(async () => true),
  loadSignupMonth: vi.fn(async () => ({ firstKickoff: new Date("2026-11-02T20:30:00Z"), kickoffs: [new Date("2026-11-09T20:30:00Z"), new Date("2026-11-16T20:30:00Z"), new Date("2026-11-23T20:30:00Z")] })),
  loadLiveMonths: vi.fn(),
  claimMonthPaid: vi.fn(async () => true),
  reconcileLeavers: vi.fn(async () => undefined),
  createProvisionalByName: vi.fn(async () => ({ userId: "u-zak-new" })),
  loadNamelessMembers: vi.fn(async () => [{ userId: "u-luca", phone: "+447700900010" }, { userId: "u-p11", phone: "+447700900011" }]),
  nameMemberFromList: vi.fn(async () => undefined),
  loadSeenAs: vi.fn(async () => new Map([["u-luca", "Luca"]])),
  applyUserMerge: vi.fn(async (): Promise<{ ok: boolean; noop?: boolean; plan: { blockers: string[] } }> => ({ ok: true, noop: false, plan: { blockers: [] } })),
  readSeedReply: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    membership: { findFirst: (...a: unknown[]) => m.membershipFindFirst(...a), findMany: (...a: unknown[]) => m.membershipFindMany(...a) },
    userAlias: { findMany: (...a: unknown[]) => m.aliasFindMany(...(a as [])) },
    organisation: { findUnique: (...a: unknown[]) => m.orgFindUnique(...(a as [])) },
    user: { findUnique: (...a: unknown[]) => m.userFindUnique(...(a as [])) },
    sentNotification: { create: (...a: unknown[]) => m.notifCreate(...(a as [])), findFirst: (...a: unknown[]) => m.notifFindFirst(...a), update: (...a: unknown[]) => m.notifUpdate(...(a as [])), deleteMany: (...a: unknown[]) => m.notifDeleteMany(...(a as [])) },
    botJob: { create: (...a: unknown[]) => m.botJobCreate(...(a as [])) },
  },
}));
vi.mock("@/lib/month-signup", () => ({ applySignup: m.applySignup, commitMonthGames: m.commitMonthGames, loadSignupMonth: m.loadSignupMonth, loadLiveMonths: m.loadLiveMonths }));
vi.mock("@/lib/month-payment", () => ({ claimMonthPaid: m.claimMonthPaid }));
vi.mock("@/lib/month-close", () => ({ reconcileLeavers: m.reconcileLeavers }));
vi.mock("@/lib/resolve-sender", () => ({ createProvisionalByName: m.createProvisionalByName }));
vi.mock("@/lib/month-seed-match", () => ({ loadNamelessMembers: m.loadNamelessMembers, nameMemberFromList: m.nameMemberFromList }));
vi.mock("@/lib/player-display-name", () => ({ loadSeenAs: m.loadSeenAs }));
vi.mock("@/lib/user-merge", () => ({ applyUserMerge: m.applyUserMerge }));
vi.mock("@/lib/month-seed-reply", () => ({ readSeedReply: m.readSeedReply }));
vi.mock("@/lib/ai-budget", () => ({ withOrgAiBudget: (_k: string, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/club-quiet-hours", () => ({ loadClubQuietHours: async () => null }));
vi.mock("@/lib/app-url", () => ({ appUrl: (p: string) => `https://mt.test${p}` }));

import { applyMonthAdd, handleNewcomerDmReply, joinMonthAsOrganiser } from "@/lib/month-newcomers";
import { NEWCOMER_ASK_KIND, type NewcomerQuestion } from "@/lib/month-newcomer-rules";
import type { MonthlyReading } from "@/lib/monthly-reader-prompt";

const NOW = new Date("2026-11-05T12:00:00Z");
const ROSTER = [
  { role: "OWNER", user: { id: "u-davide", name: "Davide Russo", phoneNumber: "+447700900001" } },
  { role: "MEMBER", user: { id: "u-shane", name: "Shane Walton", phoneNumber: "+447700900002" } },
  { role: "MEMBER", user: { id: "u-tom", name: "Tom Hale", phoneNumber: "+447700900003" } },
  { role: "MEMBER", user: { id: "u-luca", name: null, phoneNumber: "+447700900010" } },
  { role: "MEMBER", user: { id: "u-p11", name: null, phoneNumber: "+447700900011" } },
];
const MONTH = {
  id: "month-nov",
  monthNumber: 11,
  firstKickoff: new Date("2026-11-02T20:30:00Z"),
  kickoffs: [new Date("2026-11-02T20:30:00Z"), new Date("2026-11-09T20:30:00Z")],
  members: [{ userId: "u-davide", out: false }, { userId: "u-shane", out: false }],
};
const line = { payg: false, paygDays: [], paid: true, paidPence: null, games: null };
type AddReading = Extract<MonthlyReading, { kind: "add" }>;
const add = (person: { memberId: string | null; name: string }, over: Partial<AddReading> = {}): AddReading => ({
  kind: "add",
  month: 11,
  choice: "in",
  days: [],
  games: null,
  person,
  paid: true,
  paidPence: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  m.membershipFindMany.mockResolvedValue(ROSTER);
  m.membershipFindFirst.mockImplementation(async (a: { where: { userId: string } }) => ROSTER.find((r) => r.user.id === a.where.userId) ?? null);
  m.loadLiveMonths.mockResolvedValue([MONTH]);
});

describe("the join, as the months page's 'Add a player, Regular'", () => {
  it("applySignup by the organiser (source admin), then 'says paid' from the organiser and the games", async () => {
    const r = await joinMonthAsOrganiser({ orgId: "o", monthId: "month-nov", userId: "u-tom", line: { ...line, games: 2 }, organiserUserId: "u-davide", now: NOW });
    expect(m.applySignup).toHaveBeenCalledWith(expect.objectContaining({ monthId: "month-nov", userId: "u-tom", choice: "in", source: "admin", byOrganiser: true, actorUserId: "u-davide" }));
    expect(m.claimMonthPaid).toHaveBeenCalledWith(expect.objectContaining({ userId: "u-tom", source: "organiser" }));
    expect(m.commitMonthGames).toHaveBeenCalledWith("month-nov", "u-tom", 2);
    expect(r).toMatchObject({ ok: true, changed: true, outcome: "regular", gamesLeft: 3 });
  });
  it("a PAYG line is PAYG for the days it names, or the next game", async () => {
    await joinMonthAsOrganiser({ orgId: "o", monthId: "month-nov", userId: "u-tom", line: { ...line, payg: true, paid: false }, organiserUserId: "u-davide", weekDay: 9, now: NOW });
    expect(m.applySignup).toHaveBeenCalledWith(expect.objectContaining({ choice: "payg", days: [9] }));
    expect(m.claimMonthPaid).not.toHaveBeenCalled();
  });
});

describe("a tagged request ('@Match Time add Tom to the November list, he's paid')", () => {
  it("from a player who is not an organiser: nobody is added, and he is told by DM", async () => {
    const r = await applyMonthAdd({ orgId: "o", reading: add({ memberId: "u-tom", name: "Tom" }), senderUserId: "u-shane", sourceRef: "wa1", tellRefused: true, now: NOW });
    expect(r).toMatchObject({ outcome: "month-add-not-organiser", changed: false });
    expect(m.applySignup).not.toHaveBeenCalled();
    expect(m.createProvisionalByName).not.toHaveBeenCalled();
    expect(m.botJobCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ phone: "447700900002", text: expect.stringContaining("Only an organiser") }) }));
  });

  it("a named member: he joins, and the answer says the games left and 'says paid'", async () => {
    const r = await applyMonthAdd({ orgId: "o", reading: add({ memberId: "u-tom", name: "Tom" }), senderUserId: "u-davide", sourceRef: "wa1", now: NOW });
    expect(r.outcome).toBe("month-add-done");
    expect(r.replyText).toBe("✅ Tom is on the November list as a regular for the 3 games left, marked as says paid.");
    expect(m.createProvisionalByName).not.toHaveBeenCalled();
    expect(m.botJobCreate).not.toHaveBeenCalled();
  });

  it("the reader matched nobody: the name lookup finds a member by his whole name", async () => {
    await applyMonthAdd({ orgId: "o", reading: add({ memberId: null, name: "Tom Hale" }), senderUserId: "u-davide", sourceRef: "wa1", now: NOW });
    expect(m.applySignup).toHaveBeenCalledWith(expect.objectContaining({ userId: "u-tom" }));
  });

  it("a name that is nobody: a new player joins, and ONE DM numbers the members with no name, by phone", async () => {
    const r = await applyMonthAdd({ orgId: "o", reading: add({ memberId: null, name: "Zak" }), senderUserId: "u-davide", sourceRef: "wa1", now: NOW });
    expect(m.createProvisionalByName).toHaveBeenCalledWith("o", "Zak", null, { deliberate: true });
    expect(m.applySignup).toHaveBeenCalledWith(expect.objectContaining({ userId: "u-zak-new" }));
    expect(r.outcome).toBe("month-add-done");
    const dms = m.botJobCreate.mock.calls.map((c) => (c as unknown as [{ data: { text: string; phone: string } }])[0].data);
    expect(dms).toHaveLength(1);
    expect(dms[0].phone).toBe("447700900001");
    expect(dms[0].text).toContain("Zak is on it now as a new player");
    expect(dms[0].text).toContain("1. +44 7700 900010 (WhatsApp: Luca)");
    expect(dms[0].text).toContain('for example "Zak is 1"');
    const stored = (m.notifCreate.mock.calls.find((c) => (c as unknown as [{ data: { kind: string } }])[0].data.kind === NEWCOMER_ASK_KIND) as unknown as [{ data: { text: string } }])[0].data;
    expect(JSON.parse(stored.text)).toMatchObject({ monthId: "month-nov", names: [{ ref: "u1", name: "Zak", userId: "u-zak-new" }] });
  });

  it("a member with no name the reader matched: nobody added, nobody created, he is asked", async () => {
    const r = await applyMonthAdd({ orgId: "o", reading: add({ memberId: "u-luca", name: "Luca" }), senderUserId: "u-davide", sourceRef: "wa1", now: NOW });
    expect(r.outcome).toBe("month-add-asked");
    expect(m.applySignup).not.toHaveBeenCalled();
    expect(m.createProvisionalByName).not.toHaveBeenCalled();
    expect(m.botJobCreate).toHaveBeenCalledTimes(1);
  });

  it("with nobody with no name to choose from, nothing is sent and the name is not marked asked", async () => {
    m.loadNamelessMembers.mockResolvedValueOnce([]);
    const r = await applyMonthAdd({ orgId: "o", reading: add({ memberId: "u-luca", name: "Luca" }), senderUserId: "u-davide", sourceRef: "wa1", now: NOW });
    expect(r.outcome).toBe("month-add-asked");
    expect(m.botJobCreate).not.toHaveBeenCalled();
    expect(m.notifDeleteMany).toHaveBeenCalledWith({ where: { key: { in: ["org-o:month-newcomers-asked:month-nov:luca"] } } });
  });

  it("already on the month, or no such month: nothing written, and said so", async () => {
    expect((await applyMonthAdd({ orgId: "o", reading: add({ memberId: "u-shane", name: "Shane" }), senderUserId: "u-davide", sourceRef: "wa1", now: NOW })).outcome).toBe("month-add-already");
    expect((await applyMonthAdd({ orgId: "o", reading: add({ memberId: "u-tom", name: "Tom" }, { month: 12 }), senderUserId: "u-davide", sourceRef: "wa1", now: NOW })).outcome).toBe("month-add-no-month");
    expect(m.applySignup).not.toHaveBeenCalled();
  });
});

describe("his answer: 'Zak is 2'", () => {
  const q: NewcomerQuestion = {
    v: 1,
    orgId: "o",
    monthId: "month-nov",
    dm: "the question",
    names: [
      { ref: "u1", name: "Zak", userId: "u-zak-new", line },
      { ref: "u2", name: "Luca", userId: null, line },
    ],
    nameless: [
      { n: 1, userId: "u-luca" },
      { n: 2, userId: "u-p11" },
    ],
  };
  const reply = (over: Partial<Parameters<typeof handleNewcomerDmReply>[0]> = {}) =>
    handleNewcomerDmReply({ userId: "u-davide", text: "Zak is 2, Luca is 1", replyPhone: "447700900001", waMessageId: "dm1", answering: async () => "the question", now: NOW, ...over });

  beforeEach(() => {
    m.notifFindFirst.mockResolvedValue({ id: "n1", text: JSON.stringify(q) });
    m.readSeedReply.mockResolvedValue({
      kind: "change",
      changes: [
        { action: "match", userId: "u-p11", listed: "u1" },
        { action: "match", userId: "u-luca", listed: "u2" },
      ],
    });
  });

  it("the new Zak is folded into member 2 with the user-merge tool; Luca's member joins; both are named; the question closes", async () => {
    const r = await reply();
    expect(r).toEqual({ handled: "month-newcomers-matched", matched: 2, failed: 0 });
    expect(m.applyUserMerge).toHaveBeenCalledWith(expect.anything(), "u-zak-new", "u-p11", expect.objectContaining({ actorUserId: "u-davide", actorKind: "admin" }));
    expect(m.applySignup).toHaveBeenCalledWith(expect.objectContaining({ userId: "u-luca", source: "admin", byOrganiser: true }));
    expect(m.nameMemberFromList).toHaveBeenCalledWith("o", "u-p11", "Zak");
    expect(m.nameMemberFromList).toHaveBeenCalledWith("o", "u-luca", "Luca");
    expect(m.notifUpdate).toHaveBeenCalledWith({ where: { id: "n1" }, data: { kind: `${NEWCOMER_ASK_KIND}-closed` } });
    const text = (m.botJobCreate.mock.calls.at(-1) as unknown as [{ data: { text: string } }])[0].data.text;
    expect(text).toContain("Zak is the member on +44 7700 900011");
  });

  it("a merge the planner blocks writes nothing for that name, is reported, and the name stays open", async () => {
    m.applyUserMerge.mockResolvedValueOnce({ ok: false, plan: { blockers: ["both paid"] } });
    const r = await reply();
    expect(r).toMatchObject({ matched: 1, failed: 1 });
    expect(m.nameMemberFromList).not.toHaveBeenCalledWith("o", "u-p11", "Zak");
    const stored = (m.notifUpdate.mock.calls[0] as unknown as [{ data: { text?: string } }])[0].data.text;
    expect(JSON.parse(stored ?? "{}").names.map((n: { name: string }) => n.name)).toEqual(["Zak"]);
  });

  it("not the message he answers, not an organiser, or not a match: nothing, and the DM goes on", async () => {
    expect(await reply({ answering: async () => "something else" })).toBeNull();
    m.readSeedReply.mockResolvedValueOnce({ kind: "yes" });
    expect(await reply({ waMessageId: "dm2" })).toBeNull();
    expect(await reply({ userId: "u-shane", waMessageId: "dm3" })).toBeNull();
    expect(m.applyUserMerge).not.toHaveBeenCalled();
  });
});
