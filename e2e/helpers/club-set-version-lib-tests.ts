/**
 * WHAT THE CLUB SET VERSION COSTS (src/lib/club-set-version.ts), measured
 * against the real embedded Postgres under tsx. It runs on every scheduler
 * tick of the Pi, for ever, so the number matters.
 *
 * Invoked by e2e/api/club-set-version.spec.ts via execFile; exits non-zero
 * with a readable message on any failure. Prints the measurement.
 *
 * It measures with the club table as the e2e world has it, and again with
 * 300 clubs that each have a group (far more than MatchTime serves), so
 * the answer is known before the table is that size.
 */
import assert from "node:assert/strict";
import { assertSafeTestDbUrl, E2E_DB_URL } from "./env";

const P = "e2e-csvlib-";

async function main() {
  const url = process.env.MT_E2E_DATABASE_URL ?? E2E_DB_URL;
  assertSafeTestDbUrl(url);
  process.env.DATABASE_URL = url;

  const { db } = await import("@/lib/db");
  const { loadClubSetVersion } = await import("@/lib/club-set-version");

  const cleanup = () => db.organisation.deleteMany({ where: { id: { startsWith: P } } });

  async function measure(label: string, rounds = 300) {
    await loadClubSetVersion(); // warm the connection
    const times: number[] = [];
    let first = "";
    for (let i = 0; i < rounds; i++) {
      const t0 = process.hrtime.bigint();
      const v = await loadClubSetVersion();
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
      if (i === 0) first = v;
      else assert.equal(v, first, "the stamp does not move while nothing changes");
    }
    times.sort((a, b) => a - b);
    const clubs = await db.organisation.count({ where: { OR: [{ whatsappGroupId: { not: null } }, { adminGroupId: { not: null } }] } });
    const median = times[Math.floor(times.length / 2)];
    const p95 = times[Math.floor(times.length * 0.95)];
    console.log(
      `  ${label}: ${clubs} club(s) with a group; ${rounds} reads; median ${median.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, worst ${times.at(-1)!.toFixed(2)} ms`,
    );
    return { median, p95, first };
  }

  try {
    await cleanup();
    const small = await measure("as seeded");

    // The plan Postgres uses for it.
    const plan = (await db.$queryRawUnsafe(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
       SELECT "id","whatsappGroupId","adminGroupId","whatsappBotEnabled","billingStatus","approvalStatus","setupStage","setupRemovedAt"
       FROM "Organisation" WHERE "whatsappGroupId" IS NOT NULL OR "adminGroupId" IS NOT NULL ORDER BY "id" ASC`,
    )) as Array<Record<string, string>>;
    console.log("  plan (as seeded):");
    for (const row of plan) console.log(`    ${Object.values(row)[0]}`);

    await db.organisation.createMany({
      data: Array.from({ length: 300 }, (_, i) => ({
        id: `${P}${String(i).padStart(3, "0")}`,
        name: `Cost club ${i}`,
        slug: `${P}${i}`,
        inviteCode: `${P}${i}-invite`,
        whatsappGroupId: `1203639100${String(i).padStart(8, "0")}@g.us`,
      })),
    });
    const big = await measure("with 300 more clubs");
    assert.notEqual(big.first, small.first, "300 new clubs with groups change the stamp");
    // A generous ceiling: a regression to something slow fails here, noise does not.
    assert.ok(small.median < 25, `the stamp should cost a few milliseconds, not ${small.median.toFixed(1)} ms`);
    assert.ok(big.median < 50, `even with 300 clubs: ${big.median.toFixed(1)} ms`);
    console.log("OK: club set version cost measured");
  } finally {
    await cleanup().catch((err) => console.error("cleanup failed:", err));
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
