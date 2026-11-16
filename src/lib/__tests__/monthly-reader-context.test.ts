/**
 * THE MONTHLY READER'S CONTEXT, from the club's months (2026-11-16): the
 * games played are marked "(played)" against the clock given, the games
 * still to play are listed with their dates, and what each REGULAR covers
 * comes from his row (a pay-as-you-go or bench row is not a regular, so its
 * player covers the games left). The database and the month loader are
 * faked: this is what `loadMonthlyReaderContext` makes of them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  membership: { findMany: vi.fn() },
  userAlias: { findMany: vi.fn() },
}));
vi.mock("../db", () => ({ db: dbMock }));
const months = vi.hoisted(() => ({ value: [] as unknown[] }));
vi.mock("../month-signup", async (orig) => {
  const real = await orig<typeof import("../month-signup")>();
  return { isRegularMember: real.isRegularMember, loadLiveMonths: async () => months.value, renderSignupList: () => ({ text: "📋 List for November", hash: "h" }) };
});
vi.mock("../monthly-week", () => ({ loadMonthlyWeek: async () => null, renderWeekList: async () => ({ text: "" }) }));
vi.mock("../player-display-name", () => ({ loadSeenAs: async () => new Map(), resolvePlayerName: (p: { name: string | null }) => p.name }));
vi.mock("../month-seed-hq", () => ({ comingMonth: async () => null }));

import { loadMonthlyReaderContext } from "../monthly-reader";
import { buildMonthlyReaderUserTurn } from "../monthly-reader-prompt";

// Mondays of November 2026, 20:00 London (GMT).
const NOV = [2, 9, 16, 23, 30].map((d) => new Date(Date.UTC(2026, 10, d, 20, 0)));
const member = (userId: string, kind: "regular" | "payg", over: Record<string, unknown> = {}) => ({
  userId,
  name: userId,
  kind,
  slot: null,
  waiting: false,
  out: false,
  paid: "none",
  paygMatchIds: [],
  gamesCovered: kind === "regular" ? 5 : 0,
  ...over,
});

beforeEach(() => {
  dbMock.membership.findMany.mockResolvedValue(
    ["davide", "lee", "pat", "bea", "will"].map((id) => ({ role: id === "davide" ? "OWNER" : "PLAYER", user: { id, name: id } })),
  );
  dbMock.userAlias.findMany.mockResolvedValue([]);
  months.value = [
    {
      id: "m-nov",
      monthNumber: 11,
      open: false,
      startedMidMonth: false,
      kickoffs: NOV,
      firstKickoff: NOV[0],
      members: [
        member("davide", "regular"),
        member("lee", "regular", { gamesCovered: 3 }),
        member("pat", "payg"),
        member("bea", "payg", { waiting: true }),
      ],
    },
  ];
});

const turnFor = async (userId: string, now: Date) => {
  const ctx = await loadMonthlyReaderContext({ orgId: "org", matchId: null, now });
  return { ctx, turn: buildMonthlyReaderUserTurn({ body: "x", sender: { userId, name: userId, organiser: false }, history: [], reply: null, now }, ctx) };
};

describe("loadMonthlyReaderContext", () => {
  it("marks the games played against the clock it is given, and lists the games still to play", async () => {
    const { ctx } = await turnFor("will", new Date(Date.UTC(2026, 10, 12, 12)));
    expect(ctx.months[0]).toContain(
      "November 2026 (month 11): under way. 5 games: Mon 2 Nov (played), Mon 9 Nov (played), Mon 16 Nov, Mon 23 Nov, Mon 30 Nov; 3 still to play: Mon 16 Nov, Mon 23 Nov, Mon 30 Nov.",
    );
  });

  it("under the month's list, the games each REGULAR covers, by ref (an organiser's line about him counts against them)", async () => {
    const { ctx } = await turnFor("will", new Date(Date.UTC(2026, 10, 12, 12)));
    // davide p1, lee p2 are regulars; pat (PAYG) and bea (bench) are not.
    expect(ctx.months[0]).toContain("  Games each regular on it covers: davide (p1) 5, lee (p2) 3.");
  });

  it("a game at the very moment of kick-off is played: it is not one a joiner covers", async () => {
    const { ctx } = await turnFor("will", NOV[2]);
    expect(ctx.months[0]).toContain("Mon 16 Nov (played)");
    expect(ctx.months[0]).toContain("2 still to play: Mon 23 Nov, Mon 30 Nov.");
  });

  it("only a REGULAR row is on the list: a pay-as-you-go or bench player covers the games left", async () => {
    const now = new Date(Date.UTC(2026, 10, 12, 12));
    expect((await turnFor("pat", now)).turn).toContain("THE SENDER COVERS in November 2026: 3 games, Mon 16 Nov, Mon 23 Nov, Mon 30 Nov (not a regular on its list yet");
    expect((await turnFor("bea", now)).turn).toContain("THE SENDER COVERS in November 2026: 3 games, Mon 16 Nov, Mon 23 Nov, Mon 30 Nov (not a regular on its list yet");
    expect((await turnFor("davide", now)).turn).toContain(
      "THE SENDER COVERS in November 2026: 5 games, Mon 2 Nov (played), Mon 9 Nov (played), Mon 16 Nov, Mon 23 Nov, Mon 30 Nov (a regular on its list).",
    );
    expect((await turnFor("lee", now)).turn).toContain("THE SENDER COVERS in November 2026: 3 games, Mon 16 Nov, Mon 23 Nov, Mon 30 Nov (a regular on its list).");
  });
});
