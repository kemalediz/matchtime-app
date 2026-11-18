/**
 * THE USER MERGE BEFORE THE MIGRATION (review of #608, round 4). The merge
 * snapshot reads every JSON column naming the source, and since #608 that
 * includes "MoMAnnouncement".result. Deployed before the migration that
 * table does not exist, and inside the merge's transaction a failed
 * statement aborts the whole merge. So the snapshot looks the table up first
 * (`momAnnouncementTableExists`, shared with `merge-players-core.ts`) and
 * reads it only when it is there.
 */
import { describe, expect, it, vi } from "vitest";
import { loadMergeSnapshot } from "../user-merge";

const S = "src_user_000000000000000001";
const T = "tgt_user_000000000000000002";

function fakeTx(table: boolean) {
  const raw: string[] = [];
  const relation = () => ({ findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null), count: vi.fn().mockResolvedValue(0) });
  const special: Record<string, unknown> = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        name: where.id === S ? "Uncle Najib" : "Najib",
        email: `${where.id}@placeholder.matchtime`,
        phoneNumber: null,
        isActive: true,
        isSuperadmin: false,
        onboarded: false,
        password: null,
        emailVerified: null,
        _count: { accounts: 0, sessions: 0 },
      })),
    },
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      raw.push(sql);
      if (sql.includes("to_regclass")) return [{ t: table ? "MoMAnnouncement" : null }];
      if (sql.includes('"MoMAnnouncement"') && !table) throw new Error('relation "MoMAnnouncement" does not exist');
      return [];
    }),
  };
  const cache = new Map<string, unknown>();
  const tx = new Proxy({}, { get: (_t, k: string) => special[k] ?? cache.get(k) ?? (cache.set(k, relation()), cache.get(k)) });
  return { tx, raw };
}

describe("loadMergeSnapshot and the MoMAnnouncement table", () => {
  it("before the migration: the table is looked up and never queried, so the merge is not aborted", async () => {
    const { tx, raw } = fakeTx(false);
    await expect(loadMergeSnapshot(tx as never, S, T)).resolves.toBeTruthy();
    expect(raw.some((q) => q.includes("to_regclass"))).toBe(true);
    expect(raw.some((q) => q.includes('FROM "MoMAnnouncement"'))).toBe(false);
  });

  it("after it: the stored results naming the source are read", async () => {
    const { tx, raw } = fakeTx(true);
    await loadMergeSnapshot(tx as never, S, T);
    expect(raw.some((q) => q.includes('FROM "MoMAnnouncement"'))).toBe(true);
  });
});
