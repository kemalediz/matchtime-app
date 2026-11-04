/**
 * WHAT THE HQ READERS ARE SHOWN, IN A STABLE ORDER (2026-11-04).
 *
 * Two findings of the FNF sandbox replay (branch sandbox/club-scenarios):
 *
 *   1. `loadHqSquadReaderContext` numbered the club's members p1, p2, ...
 *      in whatever order Postgres returned the membership rows (no
 *      `orderBy`), so the same club could be shown "p3: Rafi" on one
 *      message and "p3: Mo" on the next. Now oldest membership first, id
 *      to break a tie: the order the other member readers (the monthly
 *      reader, the month newcomers and seed readers) already use.
 *
 *   2. An HQ message and MatchTime's reply to it are written with the SAME
 *      `now` (`admin-group.ts` records the message, the reply is recorded
 *      further down the same request), and `hqLogSince` read them back by
 *      `createdAt` alone, so the "recent messages" could list the reply
 *      before the message it answers. At one instant a member's message
 *      comes first: MatchTime only ever speaks to what it has already read.
 *
 * The fake db below honours `orderBy` the way Postgres does (false before
 * true, a tie left in the physical order it was given), and returns rows
 * in a physical order chosen to expose a reader that leaves order to the
 * database. No model, no network.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type OrderBy = Record<string, "asc" | "desc"> | Array<Record<string, "asc" | "desc">>;

/** Prisma's `orderBy` over plain rows: Postgres order, a stable sort. */
function ordered<T extends Row>(rows: T[], orderBy: OrderBy | undefined): T[] {
  const keys = orderBy === undefined ? [] : Array.isArray(orderBy) ? orderBy : [orderBy];
  const val = (r: Row, k: string) => {
    const v = r[k];
    return v instanceof Date ? v.getTime() : typeof v === "boolean" ? Number(v) : v;
  };
  return [...rows].sort((a, b) => {
    for (const o of keys) {
      const [k, dir] = Object.entries(o)[0];
      const x = val(a, k) as number | string;
      const y = val(b, k) as number | string;
      if (x < y) return dir === "asc" ? -1 : 1;
      if (x > y) return dir === "asc" ? 1 : -1;
    }
    return 0;
  });
}

const store = vi.hoisted(() => ({ memberships: [] as Row[], log: [] as Row[] }));

const dbMock = vi.hoisted(() => ({
  membership: { findMany: vi.fn() },
  userAlias: { findMany: vi.fn(async () => []) },
  attendance: { findMany: vi.fn(async () => []) },
  teamAssignment: { findMany: vi.fn(async () => []) },
  adminTeamProposal: { findUnique: vi.fn(async () => null) },
  adminGroupMessage: { findMany: vi.fn() },
  user: { findMany: vi.fn(async () => []) },
}));
vi.mock("../db", () => ({ db: dbMock }));
vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("../group-chat-history", () => ({
  rosterLabels: vi.fn(async (ids: Array<string | null>) => new Map(ids.filter(Boolean).map((id) => [id as string, `name-of-${id}`]))),
}));

import { loadHqRecentMessages, loadHqSquadReaderContext } from "../hq-squad-reader";
import { groupLogSince, hqLogSince, hqQuestionsSince } from "../admin-group-log";

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.membership.findMany.mockImplementation(async (args: { orderBy?: OrderBy }) => ordered(store.memberships, args.orderBy));
  dbMock.adminGroupMessage.findMany.mockImplementation(async (args: { orderBy?: OrderBy }) => ordered(store.log, args.orderBy));
});

describe("the HQ squad reader's members", () => {
  const T = (d: number) => new Date(Date.UTC(2026, 8, d));
  const rafi = { id: "m-3", createdAt: T(3), role: "PLAYER", user: { id: "u-rafi", name: "Rafi" } };
  const feroz = { id: "m-1", createdAt: T(1), role: "OWNER", user: { id: "u-feroz", name: "Feroz" } };
  const mo = { id: "m-2", createdAt: T(2), role: "PLAYER", user: { id: "u-mo", name: "Mo" } };
  // Imported in one statement: the same instant, so the id decides.
  const akram = { id: "m-5", createdAt: T(4), role: "PLAYER", user: { id: "u-akram", name: "Akram" } };
  const imz = { id: "m-4", createdAt: T(4), role: "PLAYER", user: { id: "u-imz", name: "Imz" } };

  const refsFor = async (physical: Row[]) => {
    store.memberships = physical;
    const ctx = await loadHqSquadReaderContext({ orgId: "club", match: null, lang: "en" });
    return ctx.members.map((m) => `${m.ref}:${m.name}`);
  };

  it("are numbered the same whatever order the database returns the rows in", async () => {
    const a = await refsFor([rafi, feroz, akram, mo, imz]);
    const b = await refsFor([imz, mo, akram, feroz, rafi]);
    expect(a).toEqual(b);
  });

  it("oldest membership first, the id breaking a tie (as the other member readers)", async () => {
    expect(await refsFor([rafi, akram, imz, mo, feroz])).toEqual(["p1:Feroz", "p2:Mo", "p3:Rafi", "p4:Imz", "p5:Akram"]);
    expect(dbMock.membership.findMany.mock.calls[0][0].orderBy).toEqual([{ createdAt: "asc" }, { id: "asc" }]);
  });
});

describe("the HQ log, read back", () => {
  const AT = new Date("2026-11-18T11:05:00.000Z");
  const question = { id: "c2", waMessageId: "wa-fnf-32", fromMatchTime: false, senderUserId: "u-raihan", text: "@Match Time how many have we got for Friday?", askRef: null, waStanzaId: null, createdAt: AT };
  // MatchTime's reply, written with the same `now` as the message it answers.
  const answer = { id: "c1", waMessageId: "mt:list:wa-fnf-32:1", fromMatchTime: true, senderUserId: null, text: "We're 12/18 for Fri 20:30", askRef: "list:wa-fnf-32", waStanzaId: null, createdAt: AT };
  const earlier = { id: "c0", waMessageId: "wa-fnf-31", fromMatchTime: false, senderUserId: "u-hamzah", text: "lads", askRef: null, waStanzaId: null, createdAt: new Date(AT.getTime() - 60_000) };

  it("puts a message before MatchTime's reply to it when both carry one timestamp", async () => {
    store.log = [answer, earlier, question];
    const rows = await hqLogSince("club", new Date(AT.getTime() - 3_600_000));
    expect(rows.map((r) => r.waMessageId)).toEqual(["wa-fnf-31", "wa-fnf-32", "mt:list:wa-fnf-32:1"]);
  });

  it("so the squad reader's recent messages read message, then reply", async () => {
    store.log = [answer, earlier, question];
    const history = await loadHqRecentMessages("club", "wa-fnf-99", new Date(AT.getTime() + 60_000));
    expect(history.map((h) => h.author)).toEqual(["name-of-u-hamzah", "name-of-u-raihan", "MatchTime"]);
  });

  it("orders by time, then a member's message before MatchTime's, then id, on every reader", async () => {
    store.log = [];
    await hqLogSince("club", AT);
    await groupLogSince("club", AT);
    await hqQuestionsSince("club", "pool:", AT);
    for (const call of dbMock.adminGroupMessage.findMany.mock.calls) {
      expect(call[0].orderBy).toEqual([{ createdAt: "asc" }, { fromMatchTime: "asc" }, { id: "asc" }]);
    }
  });
});
