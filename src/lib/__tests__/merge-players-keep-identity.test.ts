/**
 * `keepIdentity` on mergePlayersCore (2026-10-18, #312 reconciled with #314).
 *
 * The cross-club phone link merges club A's placeholder INTO an existing
 * account that belongs to another club. `User.name` and `User.image` are
 * global, so the default backfill ("fill what the keeper is missing from
 * the dropped row") would let club A's admin name another club's player
 * everywhere. #314 refuses exactly that in `mergePlayers`. With
 * `keepIdentity: true` the keeper's User row is never patched; without it
 * the old backfill still runs for every other caller.
 */
import { describe, expect, it } from "vitest";
import { mergePlayersCore } from "../merge-players-core";

type Row = Record<string, unknown>;

/** A tx where every model answers "nothing here", except `user`. */
function makeTx(keep: Row, drop: Row) {
  const userUpdates: Array<{ where: { id: string }; data: Row }> = [];
  const empty = new Proxy(
    {},
    {
      get: (_t, method: string) => async () => {
        if (method === "findMany") return [];
        if (method === "findUnique" || method === "findFirst") return null;
        if (method === "count") return 0;
        if (method === "updateMany" || method === "deleteMany" || method === "createMany") return { count: 0 };
        return {};
      },
    },
  );
  const user = {
    findUnique: async ({ where }: { where: { id: string } }) =>
      where.id === keep.id ? { ...keep } : where.id === drop.id ? { ...drop } : null,
    update: async (args: { where: { id: string }; data: Row }) => {
      userUpdates.push(args);
      return {};
    },
    delete: async () => ({}),
  };
  const tx = new Proxy({} as Row, {
    get: (_t, model: string) => {
      if (model === "user") return user;
      if (model === "$executeRaw" || model === "$queryRaw") return async () => [];
      return empty;
    },
  });
  return { tx, userUpdates };
}

const keep = { id: "keep", name: null, image: null, phoneNumber: "+447404111243", email: "wa-1@placeholder.matchtime", password: null, emailVerified: null, onboarded: false };
const drop = { id: "drop", name: "Habib", image: "https://x/y.png", phoneNumber: "+447700900123", email: "manual-x@placeholder.matchtime", password: null, emailVerified: null, onboarded: false };

describe("mergePlayersCore keepIdentity", () => {
  it("by default fills the keeper's empty name and image from the dropped row", async () => {
    const { tx, userUpdates } = makeTx(keep, drop);
    await mergePlayersCore(tx, "keep", "drop", { saveAliasInOrgIds: [] });
    const patch = userUpdates.find((u) => u.where.id === "keep");
    expect(patch?.data).toMatchObject({ name: "Habib", image: "https://x/y.png" });
  });

  it("with keepIdentity the keeper's User row is never patched", async () => {
    const { tx, userUpdates } = makeTx(keep, drop);
    await mergePlayersCore(tx, "keep", "drop", { saveAliasInOrgIds: [], keepIdentity: true });
    expect(userUpdates.filter((u) => u.where.id === "keep")).toEqual([]);
    // The dropped row's unique fields are still freed.
    expect(userUpdates.find((u) => u.where.id === "drop")?.data).toMatchObject({ phoneNumber: null });
  });
});
