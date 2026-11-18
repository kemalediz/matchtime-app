/**
 * What a monthly regular covers, by tagging MatchTime in HQ (review of
 * #611, round 3):
 *   item 1: a message naming two players changes both, and says so;
 *   item 2: an answer to a question about a player merged since follows
 *           the merge (its `UserMerge` tombstone) to the surviving player;
 *           "That player was merged..." only when no survivor is found.
 * Database, the month and the coverage write mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  userFind: vi.fn(),
  mergeFind: vi.fn(),
  monthFindFirst: vi.fn(async () => ({ id: "mo1" })),
  check: vi.fn(async (): Promise<{ ok: true } | { ok: false; error: string }> => ({ ok: true })),
  claim: vi.fn(async () => true),
  money: vi.fn(async (): Promise<Record<string, { balances: Record<string, number>; refunded: Record<string, number>; leavers: unknown[] }>> => ({})),
  aliasFindMany: vi.fn(async () => []),
  loadLiveMonths: vi.fn(),
  loadSignupMonth: vi.fn(async () => ({ id: "mo1", firstKickoff: new Date("2026-11-02T20:30:00Z") })),
  setCoverage: vi.fn(async (a: { userId: string }) => ({
    ok: true,
    changed: true,
    gamesCovered: 5,
    bounds: { min: 3, max: 5 },
    month: { gamesLeft: 2, whole: 5, playable: 5 },
    creditedCancelled: 0,
    userId: a.userId,
  })),
}));
vi.mock("@/lib/db", () => ({
  db: {
    user: { findUnique: (...a: unknown[]) => m.userFind(...a), findMany: async () => [{ id: "u-dan", name: "Dan Daly" }, { id: "u-ben", name: "Ben Bench" }] },
    userMerge: { findFirst: (...a: unknown[]) => m.mergeFind(...a) },
    squadMonth: { findFirst: m.monthFindFirst },
    userAlias: { findMany: m.aliasFindMany },
  },
}));
vi.mock("@/lib/month-payment", () => ({ claimMonthPaid: m.claim }));
vi.mock("@/lib/month-close", () => ({ loadMonthMoney: m.money }));
vi.mock("@/lib/admin-group-log", () => ({ recordMatchTimeLine: vi.fn(async () => undefined), recordMatchTimeQuestion: vi.fn(async () => undefined) }));
vi.mock("@/lib/month-signup", () => ({ loadLiveMonths: m.loadLiveMonths, loadSignupMonth: m.loadSignupMonth, hasStarted: () => true }));
vi.mock("@/lib/month-member-coverage", () => ({ setMonthMemberCoverage: m.setCoverage, loadCoverageView: async () => ({ started: true, month: { gamesLeft: 2, whole: 5, playable: 5 }, members: new Map() }), checkMonthMemberCoverage: m.check }));

import { answerCoverageQuestion, applyMonthCoverageWords, askWhichCoveragePlayer, COVERAGE_WHICH_LINE_PREFIX } from "@/lib/month-coverage-words";
import { coverageAskRef } from "@/lib/month-coverage-rules";
import type { HqLogRow } from "@/lib/admin-group-log";
import type { PersonPicker } from "@/lib/pipeline/who-is-who";

const NOW = new Date("2026-11-14T12:00:00Z");
const MONTH = {
  id: "mo1",
  firstKickoff: new Date("2026-11-02T20:30:00Z"),
  members: [
    { userId: "u-dan", name: "Dan Daly", kind: "regular", out: false, waiting: false },
    { userId: "u-ben", name: "Ben Bench", kind: "regular", out: false, waiting: false },
  ],
};
const picker = (map: Record<string, string>): PersonPicker => async (req) => ({
  picks: new Map(req.messages.map((msg) => [msg.id, new Map(msg.refs.map((r) => [r, map[r] ? { kind: "member" as const, userId: map[r] } : { kind: "none" as const }]))])),
  usage: null,
  degradations: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  m.loadLiveMonths.mockResolvedValue([MONTH]);
});

describe("round 3, item 1: a message naming two players", () => {
  it("'Dan and Ben cover the whole month': both change, and the reply names both", async () => {
    const r = await applyMonthCoverageWords({
      orgId: "o",
      lang: "en",
      refs: ["Dan", "Ben"],
      coverage: "whole",
      body: "@Match Time Dan and Ben cover the whole month",
      senderName: "Alex",
      senderUserId: "u-admin",
      now: NOW,
      identify: picker({ Dan: "u-dan", Ben: "u-ben" }),
    });
    expect(m.setCoverage.mock.calls.map((c) => (c as unknown as [{ userId: string }])[0].userId)).toEqual(["u-dan", "u-ben"]);
    expect(r.outcome).toBe("month-coverage-done");
    expect(r.replyText).toContain("Dan Daly covers the whole of November");
    expect(r.replyText).toContain("Ben Bench covers the whole of November");
  });

  it("one name nobody on the list is: the other still changes, and the reply says which it could not tell", async () => {
    const r = await applyMonthCoverageWords({
      orgId: "o",
      lang: "en",
      refs: ["Dan", "Zed"],
      coverage: "whole",
      body: "@Match Time Dan and Zed cover the whole month",
      senderName: "Alex",
      senderUserId: "u-admin",
      now: NOW,
      identify: picker({ Dan: "u-dan" }),
    });
    expect(m.setCoverage).toHaveBeenCalledTimes(1);
    expect(r.replyText).toContain("Dan Daly covers the whole of November");
    expect(r.replyText).toContain("I couldn't tell which regular on the month's list Zed is");
  });
});

describe("round 3, item 2: an answer about a player merged since", () => {
  const answer = () => answerCoverageQuestion({ orgId: "o", lang: "en", asked: { monthId: "mo1", userId: "u-old" }, coverage: "whole", now: NOW });

  it("follows the merge to the surviving player and applies it to him", async () => {
    // As applyUserMerge leaves it: the old user switched off, a tombstone to the survivor.
    m.userFind.mockImplementation(async (a: { where: { id: string } }) =>
      a.where.id === "u-old" ? { name: null, isActive: false } : a.where.id === "u-member" ? { name: "Zak", isActive: true } : null,
    );
    m.mergeFind.mockImplementation(async (a: { where: { oldUserId: string } }) => (a.where.oldUserId === "u-old" ? { survivorUserId: "u-member" } : null));
    const r = await answer();
    expect(m.setCoverage).toHaveBeenCalledWith(expect.objectContaining({ squadMonthId: "mo1", userId: "u-member", coverage: "whole" }));
    expect(r).toMatchObject({ outcome: "month-coverage-done", replyText: "✅ Zak covers the whole of November: 5 games." });
  });

  it("follows a chain of merges, never round a cycle", async () => {
    m.userFind.mockImplementation(async (a: { where: { id: string } }) => (a.where.id === "u-c" ? { name: "Cal", isActive: true } : { name: null, isActive: false }));
    m.mergeFind.mockImplementation(async (a: { where: { oldUserId: string } }) => ({ "u-old": { survivorUserId: "u-b" }, "u-b": { survivorUserId: "u-c" } })[a.where.oldUserId] ?? null);
    await answer();
    expect(m.setCoverage).toHaveBeenCalledWith(expect.objectContaining({ userId: "u-c" }));
    m.setCoverage.mockClear();
    m.mergeFind.mockImplementation(async (a: { where: { oldUserId: string } }) => ({ "u-old": { survivorUserId: "u-b" }, "u-b": { survivorUserId: "u-old" } })[a.where.oldUserId] ?? null);
    m.userFind.mockResolvedValue({ name: null, isActive: false });
    expect((await answer())?.outcome).toBe("month-coverage-merged");
    expect(m.setCoverage).not.toHaveBeenCalled();
  });

  it("no survivor anywhere: 'That player was merged ...', nothing changed", async () => {
    m.userFind.mockResolvedValue(null);
    m.mergeFind.mockResolvedValue(null);
    expect(await answer()).toEqual({ outcome: "month-coverage-merged", replyText: "That player was merged into another one since I asked, so I changed nothing. Please add them again." });
    expect(m.setCoverage).not.toHaveBeenCalled();
  });

  it("not merged at all: the player asked about", async () => {
    m.userFind.mockResolvedValue({ name: "Ben Bench", isActive: true });
    m.mergeFind.mockResolvedValue(null);
    await answer();
    expect(m.setCoverage).toHaveBeenCalledWith(expect.objectContaining({ userId: "u-old" }));
  });
});

describe("round 4: coverage never a payment, questions handed back, per-name replies", () => {
  const words = (over: Partial<Parameters<typeof applyMonthCoverageWords>[0]> = {}) =>
    applyMonthCoverageWords({
      orgId: "o",
      lang: "en",
      refs: ["Dan"],
      coverage: "whole",
      body: "@Match Time Dan paid for the whole month",
      senderName: "Alex",
      senderUserId: "u-admin",
      now: NOW,
      identify: picker({ Dan: "u-dan", Ben: "u-ben" }),
      ...over,
    });

  it("option a: 'Dan paid for the whole month' read as coverage changes the coverage only: no claim recorded, changed or cleared", async () => {
    await words();
    expect(m.claim).not.toHaveBeenCalled();
    expect(m.check).not.toHaveBeenCalled();
    expect(m.setCoverage).toHaveBeenCalledWith(expect.objectContaining({ userId: "u-dan", coverage: "whole" }));
    expect(m.setCoverage.mock.calls[0][0]).not.toHaveProperty("claimCovers");
  });

  it("option a: an answer to the question never records a claim either", async () => {
    m.userFind.mockResolvedValue({ name: "Ian", isActive: true });
    m.mergeFind.mockResolvedValue(null);
    await answerCoverageQuestion({ orgId: "o", lang: "en", asked: { monthId: "mo1", userId: "u-ian" }, coverage: "whole", now: NOW });
    expect(m.claim).not.toHaveBeenCalled();
    expect(m.setCoverage.mock.calls[0][0]).not.toHaveProperty("claimCovers");
  });

  it("item 4: the change leaves him owing more: the reply says so, with the page's number", async () => {
    m.money.mockResolvedValueOnce({ mo1: { balances: { "u-dan": 1500 }, refunded: {}, leavers: [] } });
    const r = await words({ body: "@Match Time Dan covers the whole month" });
    expect(r.replyText).toBe("✅ Dan Daly covers the whole of November: 5 games. He still shows £15 to pay.");
  });

  it("item 4: owed money back: said; nothing either way: no line", async () => {
    m.money.mockResolvedValueOnce({ mo1: { balances: { "u-dan": -750 }, refunded: {}, leavers: [] } });
    expect((await words({ coverage: "left" })).replyText).toMatch(/ He shows £7\.50 to give back\.$/);
    m.money.mockResolvedValueOnce({ mo1: { balances: {}, refunded: {}, leavers: [] } });
    expect((await words()).replyText).toBe("✅ Dan Daly covers the whole of November: 5 games.");
  });

  it("item 4, Turkish", async () => {
    m.money.mockResolvedValueOnce({ mo1: { balances: { "u-dan": 1500 }, refunded: {}, leavers: [] } });
    expect((await words({ lang: "tr" })).replyText).toMatch(/ Hâlâ ödemesi gereken £15 görünüyor\.$/);
    m.money.mockResolvedValueOnce({ mo1: { balances: { "u-dan": -750 }, refunded: {}, leavers: [] } });
    expect((await words({ lang: "tr" })).replyText).toMatch(/ Ona geri verilecek £7\.50 görünüyor\.$/);
  });

  it("item 4: coverage not said: the questions are handed back, for the caller to log with the whole reply", async () => {
    const r = await words({ refs: ["Dan", "Ben"], coverage: null, body: "@Match Time Dan and Ben joined late" });
    expect(r.outcome).toBe("month-coverage-asked");
    expect(r.asks).toEqual([
      { monthId: "mo1", userId: "u-dan" },
      { monthId: "mo1", userId: "u-ben" },
    ]);
    expect(m.setCoverage).not.toHaveBeenCalled();
    expect(m.claim).not.toHaveBeenCalled();
  });

  it("item 5: one changed and one not placed: the reply says what changed, and only the other was left alone", async () => {
    const r = await words({ refs: ["Dan", "Zed"] });
    expect(r.outcome).toBe("month-coverage-done");
    expect(r.replyText).toBe(
      "✅ Dan Daly covers the whole of November: 5 games.\nI couldn't tell which regular on the month's list Zed is, so I didn't change anything for Zed.",
    );
    expect(r.replyText).not.toContain("I changed nothing");
  });

  describe("item 4: 'which player?' is not asked twice about the same questions, but is about new ones", () => {
    const at = (min: number) => new Date(NOW.getTime() + min * 60_000);
    const ask = (userId: string, min: number): HqLogRow => ({ waMessageId: `mt:q-${userId}-${min}`, fromMatchTime: true, senderUserId: null, text: "q", askRef: coverageAskRef("mo1", userId), createdAt: at(min) });
    const whichLine = (min: number): HqLogRow => ({ waMessageId: `${COVERAGE_WHICH_LINE_PREFIX}${min}`, fromMatchTime: true, senderUserId: null, text: "Which player", askRef: null, createdAt: at(min) });
    const which = (log: HqLogRow[], quoted = false) =>
      askWhichCoveragePlayer({ orgId: "o", lang: "en", userIds: ["u-dan", "u-ben"], log, now: at(5), quoted });

    it("asked since the newest question: not again", async () => {
      expect(await which([ask("u-dan", 0), ask("u-ben", 0), whichLine(1)])).toBeNull();
    });
    it("questions asked after the last which-line: asked", async () => {
      expect((await which([whichLine(0), ask("u-dan", 1), ask("u-ben", 1)]))?.outcome).toBe("month-coverage-which");
    });
    it("a reply quoting MatchTime's reply: always answered", async () => {
      expect((await which([ask("u-dan", 0), ask("u-ben", 0), whichLine(1)], true))?.outcome).toBe("month-coverage-which");
    });
  });
});
