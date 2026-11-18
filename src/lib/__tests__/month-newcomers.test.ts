/**
 * AN ORGANISER PUTS SOMEBODY ON A MONTH, the writes (2026-11-03): the join
 * mirrors /admin/months "Add a player, Regular"; only an organiser's
 * request acts; a name nobody knows is a new player plus ONE "who is
 * this?" DM; his "Zak is 3" folds the new player into that member with
 * the user-merge tool, or links the member. Database and model mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// 2026-11-16: what a regular put on a month under way covers, as STORED:
// the coverage editor's write (`setMonthMemberCoverage`) and its view of
// the rows (`loadCoverageView`), over one in-memory store. A new regular
// joins for the 3 games left (`applySignup`'s own rule).
const cover = vi.hoisted(() => {
  const state = { started: false, gamesLeft: 3, playable: 5, stored: new Map<string, number>(), refuse: false };
  const month = () => ({ gamesLeft: state.gamesLeft, whole: 5, playable: state.playable });
  return {
    state,
    loadCoverageView: vi.fn(async () => ({
      started: state.started,
      month: month(),
      members: new Map([...state.stored].map(([u, g]) => [u, { min: 3, max: 5, gamesCovered: g }])),
    })),
    checkMonthMemberCoverage: vi.fn(async (): Promise<{ ok: true } | { ok: false; error: string }> => (state.refuse ? { ok: false, error: "below-credits" } : { ok: true })),
    setMonthMemberCoverage: vi.fn(async (a: { userId: string; coverage: "whole" | "left" | number }) => {
      if (state.refuse) return { ok: false, error: "below-credits" };
      const g = a.coverage === "whole" ? 5 : a.coverage === "left" ? 3 : a.coverage;
      const changed = state.stored.get(a.userId) !== g;
      state.stored.set(a.userId, g);
      return { ok: true, changed, gamesCovered: g, bounds: { min: 3, max: 5 }, month: month() };
    }),
  };
});

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
  applySignup: vi.fn(async (a: { userId: string; choice: string }) => {
    if (a.choice === "in" && !cover.state.stored.has(a.userId)) cover.state.stored.set(a.userId, cover.state.gamesLeft);
    return { ok: true, changed: true, locked: false, outcome: "regular", unknownDays: [] };
  }),
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
vi.mock("@/lib/month-member-coverage", () => ({ loadCoverageView: cover.loadCoverageView, setMonthMemberCoverage: cover.setMonthMemberCoverage, checkMonthMemberCoverage: cover.checkMonthMemberCoverage }));
vi.mock("@/lib/ai-budget", () => ({ withOrgAiBudget: (_k: string, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/club-quiet-hours", () => ({ loadClubQuietHours: async () => null }));
vi.mock("@/lib/app-url", () => ({ appUrl: (p: string) => `https://mt.test${p}` }));

import { applyMonthAdd, handleNewcomerDmReply, joinMonthAsOrganiser, tellOrganiserOnce } from "@/lib/month-newcomers";
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
  Object.assign(cover.state, { started: false, gamesLeft: 3, playable: 5, refuse: false });
  cover.state.stored.clear();
});

describe("the join, as the months page's 'Add a player, Regular'", () => {
  it("applySignup by the organiser (source admin), then 'says paid' from the organiser and the games", async () => {
    const r = await joinMonthAsOrganiser({ orgId: "o", monthId: "month-nov", userId: "u-tom", line: { ...line, games: 2 }, organiserUserId: "u-davide", now: NOW });
    expect(m.applySignup).toHaveBeenCalledWith(expect.objectContaining({ monthId: "month-nov", userId: "u-tom", choice: "in", source: "admin", byOrganiser: true, actorUserId: "u-davide" }));
    expect(m.claimMonthPaid).toHaveBeenCalledWith(expect.objectContaining({ userId: "u-tom", source: "organiser" }));
    expect(r).toMatchObject({ ok: true, changed: true, outcome: "regular", gamesLeft: 3 });
  });
  it("his games go WITH the join, through applySignup's one fit rule (a paid leaver back is counted from now there), never a second write after it", async () => {
    m.applySignup.mockResolvedValueOnce({ ok: true, changed: false, locked: false, outcome: "regular", unknownDays: [], gamesStored: true } as never);
    const r = await joinMonthAsOrganiser({ orgId: "o", monthId: "month-nov", userId: "u-tom", line: { ...line, games: 2 }, organiserUserId: "u-davide", words: "4. Tom 2 games", now: NOW });
    expect(m.applySignup).toHaveBeenCalledWith(expect.objectContaining({ userId: "u-tom", games: 2, words: "4. Tom 2 games" }));
    expect(m.commitMonthGames).not.toHaveBeenCalled();
    expect(r.changed).toBe(true);
  });
  it("no games on the line: none given to applySignup", async () => {
    await joinMonthAsOrganiser({ orgId: "o", monthId: "month-nov", userId: "u-tom", line: { ...line, games: null }, organiserUserId: "u-davide", now: NOW });
    expect(m.applySignup).toHaveBeenCalledWith(expect.objectContaining({ games: null }));
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

  it("the reader matched nobody: who-is-who, with the message, finds the member (review of #574)", async () => {
    const seen: Array<{ body: string; refs: string[] }> = [];
    const identify = async (req: { messages: Array<{ id: string; body: string; refs: string[] }> }) => {
      seen.push(req.messages[0]);
      return { picks: new Map([[req.messages[0].id, new Map([["Tom Hale", { kind: "member" as const, userId: "u-tom" }]])]]), usage: null, degradations: [] };
    };
    await applyMonthAdd({ orgId: "o", reading: add({ memberId: null, name: "Tom Hale" }), senderUserId: "u-davide", sourceRef: "wa1", now: NOW, text: "add Tom Hale to November", identify });
    expect(seen[0]).toMatchObject({ body: "add Tom Hale to November", refs: ["Tom Hale"] });
    expect(m.applySignup).toHaveBeenCalledWith(expect.objectContaining({ userId: "u-tom" }));
  });

  it("the reader matched nobody and who-is-who is not sure: nobody created, the organiser is asked", async () => {
    const identify = async (req: { messages: Array<{ id: string }> }) => ({
      picks: new Map([[req.messages[0].id, new Map([["Tom", { kind: "ambiguous" as const, userIds: ["u-tom"] }]])]]),
      usage: null,
      degradations: [],
    });
    const r = await applyMonthAdd({ orgId: "o", reading: add({ memberId: null, name: "Tom" }), senderUserId: "u-davide", sourceRef: "wa1", now: NOW, identify });
    expect(m.applySignup).not.toHaveBeenCalled();
    expect(r.changed).toBe(false);
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

describe("a month already under way: the whole month, or the games left (2026-11-16, review of #611)", () => {
  const base = { orgId: "o", senderUserId: "u-davide", sourceRef: "wa1", now: NOW };
  // Round 2, item 5: the organisers' group is named only for a club that has one.
  const NOTE = (names: string, hq = false) =>
    `${names} is on the November list for the games left. If he paid for the whole month, set him to the whole month under Covers on the months page (https://mt.test/admin/months)${hq ? ` or tag me in your organisers' group, for example "@Match Time ${names} covers the whole month"` : ""}; the page then shows what's left to pay or confirm.`;
  beforeEach(() => {
    cover.state.started = true;
  });

  it("ROUND 2, item 5: a club with an organisers' group is told it can tag there; one without is not", async () => {
    m.orgFindUnique.mockResolvedValue({ language: "en", adminGroupId: "hq@g.us", adminChannelMode: "admin-group" } as never);
    const withHq = await applyMonthAdd({ ...base, reading: add({ memberId: "u-tom", name: "Tom" }), viaDm: true });
    expect(withHq.replyText).toContain(NOTE("Tom", true));
    m.orgFindUnique.mockResolvedValue({ language: "en" });
    cover.state.stored.clear();
    const without = await applyMonthAdd({ ...base, reading: add({ memberId: "u-tom", name: "Tom" }), viaDm: true });
    expect(without.replyText).toContain(NOTE("Tom"));
    expect(without.replyText).not.toContain("organisers' group");
  });

  it("ROUND 2, item 5, in Turkish: no organisers' group named without one", async () => {
    const { monthSetupCopy } = await import("@/lib/i18n/month-setup");
    const tr = monthSetupCopy("tr");
    expect(tr.added_left_note({ names: "Tom", count: 1, first: "Tom", month: "Kasım", link: "https://x", group: false })).toBe(
      "Tom, Kasım listesinde kalan maçlar için. Ayın tamamını ödediyse aylar sayfasında Kapsadığı kısmından (https://x) ayın tamamına ayarla; sayfa sonra ödenecek ya da onaylanacak kalanı gösterir.",
    );
    expect(tr.added_left_note({ names: "Tom", count: 1, first: "Tom", month: "Kasım", link: "https://x", group: true })).toContain("yönetici grubunda");
  });

  it("ROUND 2, item 3: the players' group's tagged add of a brand-new name sends the organiser exactly ONE DM: the note folded into 'who is this?'", async () => {
    const r = await applyMonthAdd({ ...base, reading: add({ memberId: null, name: "Zak" }), tellOrganiser: true });
    expect(r.outcome).toBe("month-add-done");
    const dms = m.botJobCreate.mock.calls.map((c) => (c as unknown as [{ data: { text: string } }])[0].data.text);
    expect(dms).toHaveLength(1);
    expect(dms[0]).toContain(NOTE("Zak"));
    expect(dms[0]).toContain("Zak is on it now as a new player");
  });

  it("ROUND 2, item 2: 'he's paid the whole month' records the claim BEFORE the coverage, as a seeded says-paid regular is priced", async () => {
    await applyMonthAdd({ ...base, reading: add({ memberId: "u-tom", name: "Tom" }), readCoverage: async () => ({ coverage: "whole" as const, refs: [] }) });
    const claimed = m.claimMonthPaid.mock.invocationCallOrder[0];
    const covered = cover.setMonthMemberCoverage.mock.invocationCallOrder[0];
    expect(claimed).toBeDefined();
    expect(covered).toBeDefined();
    expect(claimed).toBeLessThan(covered);
  });

  it("the words say the whole month: he joins, the editor's write covers it, and the reply says what is stored", async () => {
    const readCoverage = vi.fn(async () => ({ coverage: "whole" as const, refs: [] as string[] }));
    const r = await applyMonthAdd({ ...base, reading: add({ memberId: "u-tom", name: "Tom" }), readCoverage });
    expect(readCoverage).toHaveBeenCalledTimes(1);
    // The sign-up itself is unchanged; the coverage is the editor's write.
    expect((m.applySignup.mock.calls[0] as unknown as [Record<string, unknown>])[0]).not.toHaveProperty("coverage");
    expect(cover.setMonthMemberCoverage).toHaveBeenCalledWith(expect.objectContaining({ squadMonthId: "month-nov", userId: "u-tom", coverage: "whole" }));
    expect(cover.state.stored.get("u-tom")).toBe(5);
    expect(r).toMatchObject({ outcome: "month-add-done", changed: true });
    expect(r.replyText).toBe("✅ Tom is on the November list as a regular for the whole month, 5 games, marked as says paid.");
    expect(r.coverageAsk).toBeUndefined();
  });

  it("the words say the games left: he joins for them, nothing asked, no note", async () => {
    const r = await applyMonthAdd({ ...base, reading: add({ memberId: "u-tom", name: "Tom" }), readCoverage: async () => ({ coverage: "left" as const, refs: [] }) });
    expect(cover.setMonthMemberCoverage).toHaveBeenCalledWith(expect.objectContaining({ coverage: "left" }));
    expect(r.replyText).toBe("✅ Tom is on the November list as a regular for the 3 games left, marked as says paid.");
    expect(r.coverageAsk).toBeUndefined();
  });

  it("the words say neither ('he's paid'): he joins for the games left and the reply asks once, for the caller to log", async () => {
    const r = await applyMonthAdd({ ...base, reading: add({ memberId: "u-tom", name: "Tom" }), readCoverage: async () => ({ coverage: null, refs: [] }) });
    expect(cover.setMonthMemberCoverage).not.toHaveBeenCalled();
    expect(r.replyText).toBe(
      "✅ Tom is on the November list as a regular for the 3 games left, marked as says paid.\n\n📋 Tom on the November list: whole month, or just the games left? The whole month is 5 games; 3 are left. Tag me with your answer.",
    );
    expect(r.coverageAsk).toEqual({ monthId: "month-nov", userId: "u-tom" });
  });

  it("ROUND 4, item 3: words naming somebody else too give the added player NO coverage; the reply says the other was left alone", async () => {
    const r = await applyMonthAdd({
      ...base,
      reading: add({ memberId: "u-tom", name: "Tom" }),
      // "add Tom for the games left, and Ian has paid the whole month"
      readCoverage: async () => ({ coverage: "whole" as const, refs: ["Tom", "Ian"] }),
    });
    expect(cover.setMonthMemberCoverage).not.toHaveBeenCalled();
    expect(cover.state.stored.get("u-tom")).not.toBe(5);
    expect(r.replyText).toContain("for the 3 games left");
    expect(r.replyText).toContain('I didn\'t change what Ian covers: tag me about that in a message of its own, for example "@Match Time Ian covers the whole month".');
    // Asked once about Tom, never about Ian.
    expect(r.coverageAsk).toEqual({ monthId: "month-nov", userId: "u-tom" });
  });

  it("ROUND 4, item 6: a week called off and every game still on is left: nothing to choose, nothing asked", async () => {
    // 5 games, one called off: 4 playable, and all 4 are still to come.
    Object.assign(cover.state, { gamesLeft: 4, playable: 4 });
    const readCoverage = vi.fn(async () => ({ coverage: null, refs: [] as string[] }));
    const r = await applyMonthAdd({ ...base, reading: add({ memberId: "u-tom", name: "Tom" }), readCoverage });
    expect(readCoverage).not.toHaveBeenCalled();
    expect(r.coverageAsk).toBeUndefined();
    expect(r.replyText).not.toContain("whole month, or just the games left?");
  });

  it("ROUND 4, item 3: only the added player named (as the list has him): his coverage applies", async () => {
    const r = await applyMonthAdd({ ...base, reading: add({ memberId: "u-tom", name: "Tom" }), readCoverage: async () => ({ coverage: "whole" as const, refs: ["tom"] }) });
    expect(cover.state.stored.get("u-tom")).toBe(5);
    expect(r.replyText).not.toContain("I didn't change");
  });

  it("ROUND 4, items 2 and 5: a refused coverage records no claim, and the reply says it was refused", async () => {
    cover.state.stored.set("u-tom", 3);
    cover.state.refuse = true;
    const r = await applyMonthAdd({ ...base, reading: add({ memberId: "u-tom", name: "Tom" }), readCoverage: async () => ({ coverage: "whole" as const, refs: [] }) });
    expect(m.claimMonthPaid).not.toHaveBeenCalled();
    expect(r.replyText).not.toContain("says paid");
    expect(r.replyText).toContain("Tom has more credits taken off November than that, so I didn't change what Tom covers.");
  });

  it("REVIEW ITEM 4: a returning paid regular re-added with 'whole month' is raised to it (a returning row too)", async () => {
    cover.state.stored.set("u-tom", 3);
    const r = await applyMonthAdd({ ...base, reading: add({ memberId: "u-tom", name: "Tom" }), readCoverage: async () => ({ coverage: "whole" as const, refs: [] }) });
    expect(cover.state.stored.get("u-tom")).toBe(5);
    expect(r.replyText).toContain("for the whole month, 5 games");
  });

  it("REVIEW ITEM 4: when the write is refused, the reply says what is stored, never 'whole month'", async () => {
    cover.state.stored.set("u-tom", 3);
    cover.state.refuse = true;
    const r = await applyMonthAdd({ ...base, reading: add({ memberId: "u-tom", name: "Tom" }), readCoverage: async () => ({ coverage: "whole" as const, refs: [] }) });
    expect(cover.state.stored.get("u-tom")).toBe(3);
    expect(r.replyText).not.toContain("whole month");
    expect(r.replyText).toContain("for the 3 games left");
  });

  it("not asked when the month has not started, when the games left are the whole month, or for pay as you go", async () => {
    const readCoverage = vi.fn(async () => ({ coverage: "whole" as const, refs: [] as string[] }));
    cover.state.started = false;
    expect((await applyMonthAdd({ ...base, reading: add({ memberId: "u-tom", name: "Tom" }), readCoverage })).coverageAsk).toBeUndefined();
    cover.state.started = true;
    cover.state.gamesLeft = 5;
    await applyMonthAdd({ ...base, reading: add({ memberId: "u-tom", name: "Tom" }), readCoverage });
    await applyMonthAdd({ ...base, reading: add({ memberId: "u-tom", name: "Tom" }, { choice: "payg" }), readCoverage });
    expect(readCoverage).not.toHaveBeenCalled();
    expect(cover.setMonthMemberCoverage).not.toHaveBeenCalled();
  });

  it("already on the month and the words say the whole month: that is the change, through the editor's write", async () => {
    cover.state.stored.set("u-shane", 3);
    const r = await applyMonthAdd({ ...base, reading: add({ memberId: "u-shane", name: "Shane" }), readCoverage: async () => ({ coverage: "whole" as const, refs: [] }) });
    expect(m.applySignup).not.toHaveBeenCalled();
    expect(cover.setMonthMemberCoverage).toHaveBeenCalledWith(expect.objectContaining({ squadMonthId: "month-nov", userId: "u-shane", coverage: "whole" }));
    expect(r).toEqual({ outcome: "month-coverage-done", replyText: "✅ Shane covers the whole of November: 5 games.", changed: true });
  });

  it("already on the month and the words say neither: 'already on the list', as before", async () => {
    const r = await applyMonthAdd({ ...base, reading: add({ memberId: "u-shane", name: "Shane" }), readCoverage: async () => ({ coverage: null, refs: [] }) });
    expect(r.outcome).toBe("month-add-already");
    expect(cover.setMonthMemberCoverage).not.toHaveBeenCalled();
  });

  it("REVIEW ITEM 9, a DM add: the reply says he was added for the games left and how to change it", async () => {
    const r = await applyMonthAdd({ ...base, reading: add({ memberId: "u-tom", name: "Tom" }), viaDm: true });
    expect(cover.setMonthMemberCoverage).not.toHaveBeenCalled();
    expect(r.replyText).toBe(`✅ Tom is on the November list as a regular for the 3 games left, marked as says paid.\n${NOTE("Tom")}`);
  });

  it("REVIEW ITEM 9, the players' group's tagged add: the organiser is DMed the same, the group hears nothing", async () => {
    const r = await applyMonthAdd({ ...base, reading: add({ memberId: "u-tom", name: "Tom" }), tellOrganiser: true });
    expect(r.gamesLeftNote).toBe(true);
    const dms = m.botJobCreate.mock.calls.map((c) => (c as unknown as [{ data: { text: string; phone: string } }])[0].data);
    expect(dms).toEqual([expect.objectContaining({ phone: "447700900001", text: expect.stringContaining(NOTE("Tom")) })]);
  });

  it("a month not under way: no note", async () => {
    cover.state.started = false;
    const r = await applyMonthAdd({ ...base, reading: add({ memberId: "u-tom", name: "Tom" }), viaDm: true });
    expect(r.replyText).toBe("✅ Tom is on the November list as a regular for the 3 games left, marked as says paid.");
  });
});

describe("the Turkish note (review item 9)", () => {
  it("says the same in Turkish, with no long dash", async () => {
    const { monthSetupCopy } = await import("@/lib/i18n/month-setup");
    const tr = monthSetupCopy("tr").added_left_note({ names: "Tom", count: 1, first: "Tom", month: "Kasım", link: "https://x", group: true });
    expect(tr).toBe('Tom, Kasım listesinde kalan maçlar için. Ayın tamamını ödediyse aylar sayfasında Kapsadığı kısmından (https://x) ya da yönetici grubunda beni etiketleyerek ayın tamamına ayarla, örneğin "@Match Time Tom ayın tamamını kapsıyor"; sayfa sonra ödenecek ya da onaylanacak kalanı gösterir.');
    expect(tr).not.toMatch(/[–—]/);
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

describe("his answer in a month under way (review of #611, item 9)", () => {
  it("a member who joins for the games left: the DM says so, and how to change it", async () => {
    cover.state.started = true;
    const q: NewcomerQuestion = { v: 1, orgId: "o", monthId: "month-nov", dm: "the question", names: [{ ref: "u1", name: "Luca", userId: null, line }], nameless: [{ n: 1, userId: "u-luca" }] };
    m.notifFindFirst.mockResolvedValue({ id: "n1", text: JSON.stringify(q) });
    m.readSeedReply.mockResolvedValue({ kind: "change", changes: [{ action: "match", userId: "u-luca", listed: "u1" }] });
    await handleNewcomerDmReply({ userId: "u-davide", text: "Luca is 1", replyPhone: "447700900001", waMessageId: "dm9", answering: async () => "the question", now: NOW });
    const text = (m.botJobCreate.mock.calls.at(-1) as unknown as [{ data: { text: string } }])[0].data.text;
    expect(text).toContain("Luca is on the November list for the games left. If he paid for the whole month, set him to the whole month under Covers on the months page");
    // Round 4, item 5: true under "a coverage change is never a payment".
    expect(text).toContain("the page then shows what's left to pay or confirm");
  });
});

/**
 * Round 2, item 4: a re-posted list with a new regular puts him both on
 * the games-left note and on the "who is this?" question. The organiser
 * gets exactly ONE DM (`tellOrganiserOnce`, what `monthly-paste.ts` uses).
 */
describe("tellOrganiserOnce: one DM, the note folded into 'who is this?'", () => {
  it("both: the question carries the note; nothing else is sent", async () => {
    const ask = vi.fn(async () => true);
    const send = vi.fn(async () => undefined);
    expect(await tellOrganiserOnce({ note: "the note", ask, send })).toBe("asked");
    expect(ask).toHaveBeenCalledWith("the note");
    expect(send).not.toHaveBeenCalled();
  });

  it("the question could not be sent: the note goes on its own, once", async () => {
    const send = vi.fn(async () => undefined);
    expect(await tellOrganiserOnce({ note: "the note", ask: async () => false, send })).toBe("note");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("the note");
  });

  it("nobody to ask: the note alone; no note: the question alone", async () => {
    const send = vi.fn(async () => undefined);
    expect(await tellOrganiserOnce({ note: "the note", ask: null, send })).toBe("note");
    expect(send).toHaveBeenCalledTimes(1);
    const ask = vi.fn(async () => true);
    expect(await tellOrganiserOnce({ note: null, ask, send })).toBe("asked");
    expect(ask).toHaveBeenCalledWith(null);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
