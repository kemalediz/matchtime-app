/**
 * THE MAIN MERGE PATH KEEPS STORED MAN OF THE MATCH WINS (review of #608,
 * round 3). `mergePlayersCore` (the admin "merge players" action, the
 * phone-collision merges, the cross-club link, the placeholder auto-link)
 * deletes the dropped user at the end, so a stored result still naming him
 * would credit nobody. It rewrites the ids in "MoMAnnouncement".result,
 * combining the two when both appear (`mom-result-merge.ts`).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/attendance-events", () => ({ recordAttendanceEvent: vi.fn() }));
vi.mock("../attendance-events", () => ({ recordAttendanceEvent: vi.fn() }));

import { mergePlayersCore } from "../merge-players-core";

const KEEP = "user-keep";
const DROP = "user-drop";

function fakeTx(rows: Array<{ matchId: string; result: unknown }>) {
  const updates: Array<{ matchId: string; result: unknown }> = [];
  const none = vi.fn().mockResolvedValue([]);
  const nothing = vi.fn().mockResolvedValue(null);
  const noop = vi.fn().mockResolvedValue({ count: 0 });
  const relation = () => ({
    findMany: none,
    findUnique: nothing,
    findFirst: nothing,
    create: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
    updateMany: noop,
    delete: vi.fn().mockResolvedValue({}),
    deleteMany: noop,
    upsert: vi.fn().mockResolvedValue({}),
    count: vi.fn().mockResolvedValue(0),
  });
  const special: Record<string, unknown> = {
    user: {
      ...relation(),
      findUnique: vi.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve({ id: where.id, name: where.id === KEEP ? "Najib" : "Uncle Najib", email: `${where.id}@example.com`, phoneNumber: null }),
      ),
    },
    $queryRawUnsafe: vi.fn(async (sql: string) => (sql.includes("to_regclass") ? [{ t: "MoMAnnouncement" }] : rows)),
    moMAnnouncement: {
      update: vi.fn(async ({ where, data }: { where: { matchId: string }; data: { result: unknown } }) => {
        updates.push({ matchId: where.matchId, result: data.result });
        return {};
      }),
    },
  };
  const cache = new Map<string, unknown>();
  const tx = new Proxy({}, { get: (_t, k: string) => special[k] ?? cache.get(k) ?? (cache.set(k, relation()), cache.get(k)) });
  return { tx, updates };
}

describe("mergePlayersCore and stored Man of the Match results", () => {
  it("the dropped player's stored win moves to the kept player", async () => {
    const { tx, updates } = fakeTx([{ matchId: "m1", result: { v: 1, kind: "vote", tally: [{ userId: DROP, name: "Uncle Najib", votes: 3 }], winners: [DROP] } }]);
    await mergePlayersCore(tx, KEEP, DROP, { saveAliasInOrgIds: [] });
    expect(updates).toEqual([{ matchId: "m1", result: { v: 1, kind: "vote", tally: [{ userId: KEEP, name: "Uncle Najib", votes: 3 }], winners: [KEEP] } }]);
  });

  // Round 4 of the review: the earlier version of this test re-derived the
  // winner from the summed tally and so pinned the bug (Mo won it 3 to 2 and
  // 2; the two Najib records summed to 4 then took his win).
  it("both in one stored result: one tally entry, votes summed; the announced winner stays the winner", async () => {
    const { tx, updates } = fakeTx([
      {
        matchId: "m2",
        result: { v: 1, kind: "vote", tally: [{ userId: "u-x", name: "Mo", votes: 3 }, { userId: KEEP, name: "Najib", votes: 2 }, { userId: DROP, name: "Uncle Najib", votes: 2 }], winners: ["u-x"] },
      },
    ]);
    await mergePlayersCore(tx, KEEP, DROP, { saveAliasInOrgIds: [] });
    expect(updates).toEqual([
      { matchId: "m2", result: { v: 1, kind: "vote", tally: [{ userId: KEEP, name: "Najib", votes: 4 }, { userId: "u-x", name: "Mo", votes: 3 }], winners: ["u-x"], merged: true } },
    ]);
  });
});
