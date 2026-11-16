/**
 * The roster @-mentions are named from (`loadMentionRoster`, 2026-11-16).
 *
 * The Vets, 16 Nov 2026: a player added to the group at 18:05 had a User
 * row with his phone and no name. Two minutes later an organiser tagged
 * him by LID, with his phone beside the tag, and MatchTime asked the group
 * who he was: the roster held only members with a name. Database mocked;
 * the end-to-end case is `e2e/sim/mention-new-joiner.spec.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const aliasFindMany = vi.fn();
const updateMany = vi.fn();
const findUnique = vi.fn();
vi.mock("@/lib/db", () => ({
  db: {
    membership: { findMany: (...a: unknown[]) => findMany(...a) },
    userAlias: { findMany: (...a: unknown[]) => aliasFindMany(...a) },
    user: { updateMany: (...a: unknown[]) => updateMany(...a), findUnique: (...a: unknown[]) => findUnique(...a) },
  },
}));

import { loadMentionRoster } from "@/lib/mention-roster";

const LID = "128539798032620@lid";
const ORGANISER = { user: { id: "u-org", name: "Olly", phoneNumber: "+447700900001" } };
const NEWBIE = { user: { id: "u-new", name: null, phoneNumber: "+447700900555" } };
const UNKNOWN = { user: { id: "u-quiet", name: null, phoneNumber: "+447700900556" } };
const tagOfNewbie = {
  authorPhone: "447700900001",
  authorName: "Olly",
  body: "@Match Time @128539798032620 is IN",
  mentions: [LID],
  mentionNames: [{ jid: LID, name: "Nico", phone: "447700900555" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([ORGANISER, NEWBIE, UNKNOWN]);
  aliasFindMany.mockResolvedValue([]);
  updateMany.mockResolvedValue({ count: 1 });
});

describe("loadMentionRoster", () => {
  it("puts a nameless member the batch can name on the roster, and names his row only while it has no name", async () => {
    const { roster } = await loadMentionRoster("org-1", [tagOfNewbie]);
    expect(roster).toEqual([
      { userId: "u-org", name: "Olly", phone: "+447700900001" },
      { userId: "u-new", name: "Nico", phone: "+447700900555" },
    ]);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith({ where: { id: "u-new", name: null }, data: { name: "Nico" } });
  });

  it("a name somebody wrote in the meantime wins: the row is re-read, not overwritten", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue({ name: "Nicholas" });
    const { roster } = await loadMentionRoster("org-1", [tagOfNewbie]);
    expect(roster.find((m) => m.userId === "u-new")?.name).toBe("Nicholas");
  });

  it("a failed write still names the mention from the batch, and is logged, never thrown", async () => {
    updateMany.mockRejectedValue(new Error("connection reset"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { roster } = await loadMentionRoster("org-1", [tagOfNewbie]);
    expect(roster.find((m) => m.userId === "u-new")?.name).toBe("Nico");
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("writes nothing when the batch names no nameless member", async () => {
    const { roster } = await loadMentionRoster("org-1", [{ body: "@447700900001 in", mentions: ["447700900001@c.us"] }]);
    expect(roster.map((m) => m.userId)).toEqual(["u-org"]);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("returns the club's aliases with the roster", async () => {
    aliasFindMany.mockResolvedValue([{ alias: "Ols", userId: "u-org" }]);
    const { aliases } = await loadMentionRoster("org-1", []);
    expect(aliases).toEqual([{ alias: "Ols", userId: "u-org" }]);
  });
});
