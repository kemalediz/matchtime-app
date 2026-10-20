/**
 * `lib/role-change.ts` and the merge path against the REAL embedded
 * Postgres, under tsx (the libs import the Prisma 7 generated client,
 * which Playwright's transpiler cannot load). Invoked by
 * e2e/api/role-change.spec.ts via execFile; exits non-zero with a
 * readable message on any failure.
 *
 * What a real database shows that the mocked unit suite cannot:
 *   - an OWNER asked to become ADMIN or PLAYER stays OWNER and no
 *     RoleChange row is written;
 *   - a player made ADMIN is ADMIN and exactly one RoleChange row says
 *     who, whose, from, to, where and when;
 *   - a merge whose dropped row held the higher role raises the kept row
 *     and logs it; a merge can never lower an OWNER;
 *   - only the OWNER can hand ownership on: an ADMIN, a PLAYER and a
 *     superadmin with no membership are refused with nothing written;
 *     the owner's hand-over leaves exactly one OWNER, the old one ADMIN,
 *     and two RoleChange rows.
 *
 * Requires the fixture world to be seeded (the spec reseeds first) and
 * MT_E2E_DATABASE_URL to point at the embedded test DB.
 */
import assert from "node:assert/strict";
import { assertSafeTestDbUrl, E2E_DB_URL } from "./env";
import { ORG_ID, U } from "./constants";

async function main() {
  const url = process.env.MT_E2E_DATABASE_URL ?? E2E_DB_URL;
  assertSafeTestDbUrl(url);
  process.env.DATABASE_URL = url;

  const { changeMemberRole, transferOwnership } = await import("@/lib/role-change");
  const { mergePlayersCore } = await import("@/lib/merge-players-core");
  const { db } = await import("@/lib/db");

  let n = 0;
  const ok = (label: string) => {
    n++;
    console.log(`  ✓ ${label}`);
  };
  const roleOf = async (userId: string) =>
    (await db.membership.findUnique({ where: { userId_orgId: { userId, orgId: ORG_ID } }, select: { role: true } }))
      ?.role;
  const logFor = (userId: string) => db.roleChange.findMany({ where: { orgId: ORG_ID, userId } });

  const P = "e2e-rolechg";
  try {
    await db.roleChange.deleteMany({ where: { orgId: ORG_ID } });

    // ── The owner is never changed ──
    assert.equal(await roleOf(U.admin), "OWNER", "fixture: Alex Admin owns the club");
    for (const to of ["ADMIN", "PLAYER"] as const) {
      const res = await changeMemberRole(db, {
        orgId: ORG_ID,
        userId: U.admin,
        to,
        actorUserId: U.rater,
        source: "admin-players-page",
      });
      assert.deepEqual(res, { ok: false, reason: "owner-locked" });
      assert.equal(await roleOf(U.admin), "OWNER", `owner still OWNER after a request for ${to}`);
    }
    assert.equal((await logFor(U.admin)).length, 0, "a refused request logs nothing");
    ok("an OWNER asked to become ADMIN or PLAYER stays OWNER, nothing logged");

    // ── Nobody becomes OWNER through a role edit ──
    {
      const res = await changeMemberRole(db, {
        orgId: ORG_ID,
        userId: U.player,
        to: "OWNER",
        actorUserId: U.admin,
        source: "admin-players-page",
      });
      assert.deepEqual(res, { ok: false, reason: "owner-grant" });
      assert.equal(await roleOf(U.player), "PLAYER");
      assert.equal((await logFor(U.player)).length, 0);
    }
    ok("a role edit cannot make anybody OWNER");

    // ── A real change is written and logged ──
    {
      const before = Date.now();
      const res = await changeMemberRole(db, {
        orgId: ORG_ID,
        userId: U.player,
        to: "ADMIN",
        actorUserId: U.admin,
        source: "admin-players-page",
      });
      assert.deepEqual(res, { ok: true, changed: true });
      assert.equal(await roleOf(U.player), "ADMIN");
      const rows = await logFor(U.player);
      assert.equal(rows.length, 1);
      const r = rows[0];
      assert.equal(r.actorUserId, U.admin);
      assert.equal(r.fromRole, "PLAYER");
      assert.equal(r.toRole, "ADMIN");
      assert.equal(r.source, "admin-players-page");
      assert.ok(r.createdAt.getTime() >= before - 5_000, "createdAt is now");

      const again = await changeMemberRole(db, {
        orgId: ORG_ID,
        userId: U.player,
        to: "ADMIN",
        actorUserId: U.admin,
        source: "admin-players-page",
      });
      assert.deepEqual(again, { ok: true, changed: false });
      assert.equal((await logFor(U.player)).length, 1, "a no-op logs nothing");
    }
    ok("a player made ADMIN is ADMIN, one RoleChange row (who, whose, from, to, where, when)");

    // ── Merges keep the higher role and log a raise ──
    {
      const keep = `${P}-keep`;
      const drop = `${P}-drop`;
      await db.user.createMany({ data: [{ id: keep, name: "Rolechg Keep", email: "rolechg-keep@e2e-test.invalid" }, { id: drop, name: "Rolechg Drop", email: "rolechg-drop@e2e-test.invalid" }] });
      await db.membership.createMany({
        data: [
          { userId: keep, orgId: ORG_ID, role: "PLAYER" },
          { userId: drop, orgId: ORG_ID, role: "ADMIN" },
        ],
      });
      await db.$transaction((tx) => mergePlayersCore(tx, keep, drop, { saveAliasInOrgIds: [], actorUserId: U.admin }), {
        timeout: 60_000,
      });
      assert.equal(await roleOf(keep), "ADMIN");
      const rows = await logFor(keep);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].fromRole, "PLAYER");
      assert.equal(rows[0].toRole, "ADMIN");
      assert.equal(rows[0].source, "merge");
      assert.equal(rows[0].actorUserId, U.admin);
    }
    ok("a merge raising the kept row to the dropped row's ADMIN logs it");

    {
      const keep = `${P}-okeep`;
      const drop = `${P}-odrop`;
      await db.user.createMany({ data: [{ id: keep, name: "Rolechg OKeep", email: "rolechg-okeep@e2e-test.invalid" }, { id: drop, name: "Rolechg ODrop", email: "rolechg-odrop@e2e-test.invalid" }] });
      await db.organisation.create({
        data: {
          id: `${P}-org`,
          name: "Rolechg Club",
          slug: `${P}-org`,
          memberships: {
            create: [
              { userId: keep, role: "OWNER" },
              { userId: drop, role: "PLAYER" },
            ],
          },
        },
      });
      await db.$transaction((tx) => mergePlayersCore(tx, keep, drop, { saveAliasInOrgIds: [] }), { timeout: 60_000 });
      const m = await db.membership.findUnique({ where: { userId_orgId: { userId: keep, orgId: `${P}-org` } } });
      assert.equal(m?.role, "OWNER", "a merge never lowers an OWNER");
      assert.equal(await db.roleChange.count({ where: { orgId: `${P}-org` } }), 0);
    }
    ok("a merge never lowers an OWNER, nothing logged");

    // ── Only the owner hands ownership on ──
    {
      const SUPER = `${P}-super`;
      await db.user.create({ data: { id: SUPER, name: "Rolechg Super", email: "rolechg-super@e2e-test.invalid", isSuperadmin: true } });
      await db.membership.updateMany({ where: { orgId: ORG_ID, userId: U.rater }, data: { role: "ADMIN" } });
      await db.roleChange.deleteMany({ where: { orgId: ORG_ID } });
      for (const actor of [U.rater /* ADMIN */, U.collector /* PLAYER */, SUPER /* no membership */]) {
        const res = await transferOwnership(db, { orgId: ORG_ID, actorUserId: actor, targetUserId: U.player });
        assert.deepEqual(res, { ok: false, reason: "not-owner" }, `actor ${actor}`);
      }
      // A non-owner admin cannot change the owner's role either.
      const viaEdit = await changeMemberRole(db, {
        orgId: ORG_ID,
        userId: U.admin,
        to: "PLAYER",
        actorUserId: U.rater,
        source: "admin-players-page",
      });
      assert.deepEqual(viaEdit, { ok: false, reason: "owner-locked" });
      assert.equal(await roleOf(U.admin), "OWNER");
      assert.equal(await db.roleChange.count({ where: { orgId: ORG_ID } }), 0);
      ok("an ADMIN, a PLAYER and a superadmin cannot hand ownership on or change the owner; nothing logged");

      const res = await transferOwnership(db, { orgId: ORG_ID, actorUserId: U.admin, targetUserId: U.rater });
      assert.deepEqual(res, { ok: true });
      assert.equal(await roleOf(U.rater), "OWNER");
      assert.equal(await roleOf(U.admin), "ADMIN");
      assert.equal(await db.membership.count({ where: { orgId: ORG_ID, role: "OWNER" } }), 1, "one owner");
      const rows = await db.roleChange.findMany({ where: { orgId: ORG_ID }, orderBy: { userId: "asc" } });
      assert.deepEqual(
        rows.map((r) => [r.userId, r.fromRole, r.toRole, r.actorUserId, r.source]),
        [
          [U.admin, "OWNER", "ADMIN", U.admin, "ownership-transfer"],
          [U.rater, "ADMIN", "OWNER", U.admin, "ownership-transfer"],
        ],
      );
      // The old owner is now an ADMIN and cannot take it back.
      const back = await transferOwnership(db, { orgId: ORG_ID, actorUserId: U.admin, targetUserId: U.admin });
      assert.deepEqual(back, { ok: false, reason: "not-owner" });
      ok("the owner hands ownership on: one OWNER, old owner ADMIN, two RoleChange rows");
    }

    console.log(`OK: ${n} role-change checks against Postgres`);
  } finally {
    await db.roleChange.deleteMany({ where: { OR: [{ orgId: ORG_ID }, { orgId: `${P}-org` }] } });
    await db.membership.updateMany({
      where: { orgId: ORG_ID, userId: { in: [U.player, U.rater, U.collector] } },
      data: { role: "PLAYER" },
    });
    await db.membership.updateMany({ where: { orgId: ORG_ID, userId: U.admin }, data: { role: "OWNER" } });
    await db.organisation.deleteMany({ where: { id: `${P}-org` } });
    await db.user.deleteMany({ where: { id: { startsWith: P } } });
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
