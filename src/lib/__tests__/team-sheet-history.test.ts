/**
 * The team sheets MatchTime posts in HQ, kept so an earlier one can be
 * brought back (2026-10-30, FNF HQ). Found by the quoted post's WhatsApp id
 * (stamped on the Pi's ack), else by MatchTime's own words in the Pi's copy
 * of its own post. Never by an organiser's words.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { id: string; orgId: string; matchId: string; slots: unknown; text: string; waStanzaId: string | null; createdAt: Date };
const rows = vi.hoisted(() => ({ list: [] as Row[] }));
const dbMock = vi.hoisted(() => ({
  adminTeamSheet: {
    create: vi.fn(async ({ data }: { data: Omit<Row, "id" | "waStanzaId"> & { waStanzaId?: string | null } }) => {
      const r = { id: `s${rows.list.length + 1}`, waStanzaId: null, ...data } as Row;
      rows.list.push(r);
      return r;
    }),
    deleteMany: vi.fn(async () => ({ count: 0 })),
    findMany: vi.fn(async ({ where }: { where: { orgId?: string; matchId?: string; createdAt?: { gte?: Date; lte?: Date }; waStanzaId?: null } }) =>
      rows.list
        .filter((r) => (where.orgId ? r.orgId === where.orgId : true))
        .filter((r) => (where.matchId ? r.matchId === where.matchId : true))
        .filter((r) => (where.createdAt?.gte ? r.createdAt >= where.createdAt.gte : true))
        .filter((r) => (where.createdAt?.lte ? r.createdAt <= where.createdAt.lte : true))
        .filter((r) => (where.waStanzaId === null ? r.waStanzaId === null : true))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    ),
    updateMany: vi.fn(async ({ where, data }: { where: { id: { in: string[] } }; data: { waStanzaId: string } }) => {
      let count = 0;
      for (const r of rows.list) {
        if (!where.id.in.includes(r.id)) continue;
        r.waStanzaId = data.waStanzaId;
        count++;
      }
      return { count };
    }),
  },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));

import { earlierSheetLike, quotedTeamSheet, recordTeamSheet, stampTeamSheets } from "../team-sheet-history";

const TUE = new Date("2026-10-27T18:09:00Z");
const THU = new Date("2026-10-29T17:30:00Z");
const TUE_TEXT = "📝 *Proposed teams*: 21:00 at Goals\n\n*Red*:\n1. Ali\n\n*Yellow*:\n1. Tom";
const THU_TEXT = "📝 *Proposed teams*: 21:00 at Goals\n\n*Red*:\n1. Tom\n\n*Yellow*:\n1. Ali";
const tueSlots = [{ userId: "u-ali", team: "RED" }, { userId: "u-tom", team: "YELLOW" }] as const;
const thuSlots = [{ userId: "u-tom", team: "RED" }, { userId: "u-ali", team: "YELLOW" }] as const;

beforeEach(async () => {
  vi.clearAllMocks();
  rows.list = [];
  await recordTeamSheet({ orgId: "org", matchId: "m1", slots: [...tueSlots], text: TUE_TEXT, now: TUE });
  await recordTeamSheet({ orgId: "org", matchId: "m1", slots: [...thuSlots], text: THU_TEXT, now: THU });
});

describe("recordTeamSheet", () => {
  it("keeps the sheet and prunes sheets older than 14 days", () => {
    expect(rows.list.map((r) => r.text)).toEqual([TUE_TEXT, THU_TEXT]);
    expect(dbMock.adminTeamSheet.deleteMany).toHaveBeenCalledWith({ where: { orgId: "org", createdAt: { lt: new Date(THU.getTime() - 14 * 24 * 60 * 60 * 1000) } } });
  });
  it("never throws (before the migration)", async () => {
    dbMock.adminTeamSheet.create.mockRejectedValueOnce(new Error("relation does not exist"));
    await expect(recordTeamSheet({ orgId: "org", matchId: "m1", slots: [], text: "x", now: THU })).resolves.toBeUndefined();
  });
});

describe("stampTeamSheets: the Pi's ack gives the post's id to the sheet in it", () => {
  it("a sheet whose words are in the sent post, within two minutes", async () => {
    const n = await stampTeamSheets({ orgId: "org", sentText: `To keep the sides even, I also moved Bo.\n\n${TUE_TEXT}`, at: new Date(TUE.getTime() + 1000), waStanzaId: "3EB0TUE" });
    expect(n).toBe(1);
    expect(rows.list[0].waStanzaId).toBe("3EB0TUE");
    expect(rows.list[1].waStanzaId).toBeNull();
  });
  it("another post stamps nothing", async () => {
    expect(await stampTeamSheets({ orgId: "org", sentText: "Teams are final.", at: TUE, waStanzaId: "3EB0X" })).toBe(0);
  });
});

describe("quotedTeamSheet", () => {
  it("by the quoted post's id", async () => {
    await stampTeamSheets({ orgId: "org", sentText: TUE_TEXT, at: TUE, waStanzaId: "3EB0TUE" });
    const s = await quotedTeamSheet("org", { messageId: "3EB0TUE", text: null, fromMatchTime: true });
    expect(s).toMatchObject({ matchId: "m1", slots: tueSlots, createdAt: TUE });
  });
  it("by MatchTime's own words in the Pi's copy of its post, when the id is unknown", async () => {
    const s = await quotedTeamSheet("org", { messageId: "3EB0NOPE", text: TUE_TEXT, fromMatchTime: true });
    expect(s?.createdAt).toEqual(TUE);
  });
  it("never for a member's message, nor for words that are no sheet", async () => {
    expect(await quotedTeamSheet("org", { messageId: null, text: TUE_TEXT, fromMatchTime: false })).toBeNull();
    expect(await quotedTeamSheet("org", { messageId: null, text: "Teams are final.", fromMatchTime: true })).toBeNull();
    expect(await quotedTeamSheet("org", null)).toBeNull();
  });
});

describe("earlierSheetLike: a pasted sheet that is one MatchTime posted before", () => {
  it("the latest stored sheet with the same players on the same sides", async () => {
    expect((await earlierSheetLike("m1", [{ userId: "u-tom", team: "YELLOW" }, { userId: "u-ali", team: "RED" }]))?.createdAt).toEqual(TUE);
    expect(await earlierSheetLike("m1", [{ userId: "u-tom", team: "YELLOW" }])).toBeNull();
  });
});
