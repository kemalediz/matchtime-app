/**
 * EVERY WAY INTO A CLUB CARRIES THE SEED (Kemal, 2026-11-03).
 *
 * The rule runs in one place, the Prisma client (`db.ts`), on every
 * membership create. These tests pin that:
 *
 *   1. the payload rewrites (`carriedSeedHook`) for each shape a join
 *      path writes: unchecked ids, `connect`, `createMany` rows, a new
 *      club's owner nested in `organisation.create`, an upsert's create;
 *   2. `db.ts` wires the hook to every one of those operations;
 *   3. a scan of `src/`: every file that creates a membership is one of
 *      the known join paths, and it writes through `db` or a transaction
 *      opened on `db`, never through a client of its own, so none can go
 *      round the hook. A new join path fails here until it is listed.
 *
 * No DB, no model.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { carriedSeedHook } from "@/lib/carried-seed";

const SRC = path.resolve(__dirname, "../..");

describe("carriedSeedHook", () => {
  const read = vi.fn(async (userId: string, orgId: string | null) =>
    userId === "rated" ? { seed: 8, fromOrgIds: ["sutton"].filter((o) => o !== orgId) } : null,
  );
  const hook = carriedSeedHook(read);

  it("membership.create with ids: filled, asking about the club being joined", async () => {
    expect(await hook.create({ userId: "rated", orgId: "vets", role: "PLAYER" })).toEqual({
      userId: "rated",
      orgId: "vets",
      role: "PLAYER",
      seedRating: 8,
    });
    expect(read).toHaveBeenLastCalledWith("rated", "vets");
  });

  it("membership.create with connect: filled", async () => {
    const out = await hook.create({ user: { connect: { id: "rated" } }, org: { connect: { id: "vets" } } });
    expect(out).toMatchObject({ seedRating: 8 });
    expect(read).toHaveBeenLastCalledWith("rated", "vets");
  });

  it("an upsert's create branch with a typed seed: kept", async () => {
    expect(await hook.create({ userId: "rated", orgId: "vets", seedRating: 4 })).toEqual({
      userId: "rated",
      orgId: "vets",
      seedRating: 4,
    });
  });

  it("a player with no rating anywhere else: unchanged", async () => {
    expect(await hook.create({ userId: "new", orgId: "vets" })).toEqual({ userId: "new", orgId: "vets" });
  });

  it("createMany: each row on its own", async () => {
    expect(
      await hook.createMany([
        { userId: "rated", orgId: "vets" },
        { userId: "new", orgId: "vets" },
      ]),
    ).toEqual([
      { userId: "rated", orgId: "vets", seedRating: 8 },
      { userId: "new", orgId: "vets" },
    ]);
  });

  it("a new club's owner, nested in organisation.create: every rated club counts", async () => {
    const out = await hook.organisationCreate({ name: "New FC", memberships: { create: { userId: "rated", role: "OWNER" } } });
    expect(out).toEqual({ name: "New FC", memberships: { create: { userId: "rated", role: "OWNER", seedRating: 8 } } });
    expect(read).toHaveBeenLastCalledWith("rated", null);
    expect(await hook.organisationCreate({ name: "No members" })).toEqual({ name: "No members" });
  });
});

describe("db.ts wires the hook to every membership create", () => {
  const src = readFileSync(path.join(SRC, "lib/db.ts"), "utf8");
  const ext = src.slice(src.indexOf('name: "carried-seed-on-join"'));

  it("create, upsert (create branch only), createMany, createManyAndReturn, organisation.create", () => {
    expect(ext).toMatch(/membership:\s*{[\s\S]*async create\(\{ args, query \}\) {\s*args\.data = await hook\.create\(args\.data\)/);
    expect(ext).toMatch(/async upsert\(\{ args, query \}\) {\s*args\.create = await hook\.create\(args\.create\);\s*return query/);
    expect(ext).toMatch(/async createMany\(\{ args, query \}\) {\s*args\.data = await hook\.createMany\(args\.data\)/);
    expect(ext).toMatch(/async createManyAndReturn\(\{ args, query \}\) {\s*args\.data = await hook\.createMany\(args\.data\)/);
    expect(ext).toMatch(/organisation:\s*{\s*async create\(\{ args, query \}\) {\s*args\.data = await hook\.organisationCreate\(args\.data\)/);
    // The upsert's update branch is never rewritten: an existing row keeps its seed.
    expect(ext).not.toMatch(/args\.update\s*=/);
  });

  it("the exported db is the extended client", () => {
    expect(src).toMatch(/function createPrismaClient\(\)[\s\S]*return extendClient\(base\);/);
    expect(src).toMatch(/return withCarriedSeed\(withPhoneNormalisation\(base\), base\);/);
  });
});

/** Every file in src that creates a membership, and the way in it is. */
const JOIN_PATHS: Record<string, string> = {
  "app/actions/players.ts": "admin add, link by phone or name, friend and invite joins",
  "app/actions/onboarding.ts": "web onboarding: the owner and the imported squad",
  "app/actions/org.ts": "create a club (owner) and join one by invite code",
  "app/api/whatsapp/attendance/route.ts": "a sender auto-enrolled from the group",
  "app/api/whatsapp/group-join/route.ts": "added to the WhatsApp group",
  "lib/participant-sync.ts": "WhatsApp participant import",
  "lib/partner-guest.ts": "partner-club and pool guests",
  "lib/resolve-sender.ts": "an unknown sender added provisionally",
  "lib/squad-from-list.ts": "a pasted squad list",
  "lib/self-join-club.ts": "self-join: a new club's owner",
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) return f === "__tests__" || f === "generated" ? [] : files(p);
    return /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
}

const CREATES = /\.membership\.(create|upsert|createMany|createManyAndReturn)\(|memberships:\s*{\s*create:/;

describe("every join path writes through the hooked client", () => {
  const found = files(SRC)
    .filter((f) => CREATES.test(readFileSync(f, "utf8")))
    .map((f) => path.relative(SRC, f))
    .sort();

  it("the files that create memberships are exactly the known join paths", () => {
    expect(found).toEqual(Object.keys(JOIN_PATHS).sort());
  });

  it.each(Object.keys(JOIN_PATHS))("%s uses db (or a transaction on db), never its own client", (rel) => {
    const src = readFileSync(path.join(SRC, rel), "utf8");
    expect(src).toMatch(/import\s*{[^}]*\bdb\b[^}]*}\s*from\s*["'](@\/lib\/db|\.\/db|\.\.\/db)["']/);
    expect(src).not.toMatch(/new PrismaClient\(/);
    for (const m of src.matchAll(/(\w+)\.membership\.(create|upsert|createMany|createManyAndReturn)\(/g)) {
      expect(["db", "tx"]).toContain(m[1]);
    }
  });

  it("no client other than db.ts's exists in src", () => {
    const owners = files(SRC).filter((f) => /new PrismaClient\(/.test(readFileSync(f, "utf8")));
    expect(owners.map((f) => path.relative(SRC, f))).toEqual(["lib/db.ts"]);
  });
});
