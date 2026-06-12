/**
 * Server-lib semantics tests that must run under tsx (they import
 * src libs which pull in the Prisma 7 generated client — unloadable in
 * Playwright's transpiler). Invoked by e2e/api/resolve-and-pricing.spec.ts
 * via execFile; exits non-zero with a readable diff on any failure.
 *
 * Requires the fixture world to be seeded (the spec reseeds first) and
 * MT_E2E_DATABASE_URL to point at the embedded test DB.
 */
import assert from "node:assert/strict";
import { assertSafeTestDbUrl, E2E_DB_URL } from "./env";
import { U, ORG_ID } from "./constants";

async function main() {
  const url = process.env.MT_E2E_DATABASE_URL ?? E2E_DB_URL;
  assertSafeTestDbUrl(url);
  // The libs read DATABASE_URL via src/lib/db — pin it to the test DB
  // BEFORE the first import.
  process.env.DATABASE_URL = url;

  const { findExistingOrgMember } = await import("@/lib/resolve-player");
  const { normaliseName, parseReservesFromBody, resolveOrProvisionSquadName } = await import(
    "@/lib/squad-from-list"
  );
  const { db } = await import("@/lib/db");

  let n = 0;
  const ok = (label: string) => {
    n++;
    console.log(`  ✓ ${label}`);
  };

  // ── findExistingOrgMember — shared add-player dedup helper ─────────
  {
    const hit = await findExistingOrgMember(ORG_ID, {
      name: "Completely Different",
      phone: "07700 900003",
    });
    assert.equal(hit?.userId, U.player, "phone match wins even when the name differs");
    ok("findExistingOrgMember: phone match wins");
  }
  {
    const hit = await findExistingOrgMember(ORG_ID, { name: "Patso" });
    assert.equal(hit?.userId, U.player, "alias hit resolves to the aliased player");
    ok("findExistingOrgMember: alias hit");
  }
  {
    const hit = await findExistingOrgMember(ORG_ID, { name: "pat player" });
    assert.equal(hit?.userId, U.player, "unique exact name (case-insensitive) reuses");
    ok("findExistingOrgMember: unique exact name");
  }
  {
    const hit = await findExistingOrgMember(ORG_ID, { name: "Riley" });
    assert.equal(hit?.userId, U.rater, "unique first-token fuzzy reuses");
    ok("findExistingOrgMember: unique fuzzy first-token");
  }
  {
    const hit = await findExistingOrgMember(ORG_ID, { name: "Omar" });
    assert.equal(hit, null, "ambiguous (two Omars) → null, caller creates fresh");
    ok("findExistingOrgMember: ambiguous → null");
  }
  {
    const hit = await findExistingOrgMember(ORG_ID, { name: "Nobody Atall" });
    assert.equal(hit, null, "unknown name → null");
    ok("findExistingOrgMember: unknown → null");
  }

  // ── squad-from-list helpers ────────────────────────────────────────
  assert.equal(normaliseName("~ Kemal​  EDIZ "), "kemal ediz");
  assert.equal(normaliseName("Çağlar"), "caglar");
  ok("normaliseName: zero-width junk, tildes, accents, case");

  assert.deepEqual(
    parseReservesFromBody("Squad:\n1. Alpha\n2. Bravo\n\nReserves:\n1. Charlie\n2) Delta\n"),
    ["Charlie", "Delta"],
  );
  assert.deepEqual(parseReservesFromBody("no reserves here"), []);
  ok("parseReservesFromBody: numbered reserves block");

  {
    const before = await db.user.count();
    const hit = await resolveOrProvisionSquadName(ORG_ID, "Pat Player");
    assert.equal(hit?.userId, U.player);
    assert.equal(hit?.provisional, false);
    assert.equal(await db.user.count(), before, "existing member reused — no ghost minted");
    ok("resolveOrProvisionSquadName: existing member reused");
  }
  {
    const hit = await resolveOrProvisionSquadName(ORG_ID, "Brandnew Bloke");
    assert.ok(hit, "unknown name provisions a member");
    assert.equal(hit!.provisional, true);
    const mem = await db.membership.findUnique({
      where: { userId_orgId: { userId: hit!.userId, orgId: ORG_ID } },
    });
    assert.ok(mem?.provisionallyAddedAt, "membership is marked provisional");
    ok("resolveOrProvisionSquadName: unknown name provisions a NEW provisional member");
  }

  console.log(`OK ${n} lib assertions`);
  process.exit(0);
}

main().catch((err) => {
  console.error("LIB-TESTS FAILED:", err);
  process.exit(1);
});
