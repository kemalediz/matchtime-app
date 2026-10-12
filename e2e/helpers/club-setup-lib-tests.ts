/**
 * `closeUnfinishedSetupLearning` (src/lib/club-setup.ts) against the REAL
 * embedded Postgres, under tsx (the lib imports the Prisma 7 generated
 * client, which Playwright's transpiler cannot load). Invoked by
 * e2e/api/setup-hold-silence.spec.ts via execFile; exits non-zero with a
 * readable message on any failure.
 *
 * The unit test proves the outcomes on a mock. What only a real database
 * can show: the one raw statement parses and runs, it runs INSIDE a
 * transaction without aborting it (a caught unique violation would), an
 * unfinished row becomes final, a final row is untouched, a club with no
 * row gets a final one, and the stored chat is deleted.
 */
import assert from "node:assert/strict";
import { assertSafeTestDbUrl, E2E_DB_URL } from "./env";

const P = "e2e-closelib-";

async function main() {
  const url = process.env.MT_E2E_DATABASE_URL ?? E2E_DB_URL;
  assertSafeTestDbUrl(url);
  process.env.DATABASE_URL = url;

  const { db } = await import("@/lib/db");
  const { closeUnfinishedSetupLearning } = await import("@/lib/club-setup");

  let n = 0;
  const ok = (label: string) => {
    n++;
    console.log(`  ok ${n}: ${label}`);
  };
  const NOW = new Date();

  async function club(key: string, learning: { status: string; reason?: string } | null) {
    const id = `${P}${key}`;
    await db.user.create({ data: { id: `${id}-u`, name: "Cleo Closer", email: `${id}@e2e-test.invalid`, onboarded: true } });
    await db.organisation.create({ data: { id, name: `Close ${key}`, slug: id, inviteCode: `${id}-invite` } });
    await db.clubConnect.create({
      data: {
        id: `${id}-cc`,
        orgId: id,
        userId: `${id}-u`,
        phone: "447700900990",
        code: "7CL2",
        status: "closed",
        expiresAt: new Date(NOW.getTime() + 3_600_000),
        capturedHistory: [{ author: "A", text: "same lot as last week" }],
      },
    });
    if (learning) await db.clubSetupLearning.create({ data: { orgId: id, ...learning } });
    return id;
  }
  const row = (orgId: string) =>
    db.clubSetupLearning.findUnique({ where: { orgId }, select: { status: true, reason: true, attempts: true } });
  const chat = async (orgId: string) =>
    (await db.clubConnect.findFirst({ where: { orgId }, select: { capturedHistory: true } }))?.capturedHistory ?? null;

  try {
    // 1. A deferred reading: closed, inside a transaction that then commits more work.
    const deferred = await club("deferred", { status: "deferred", reason: "model-error" });
    const out1 = await db.$transaction(async (tx) => {
      const r = await closeUnfinishedSetupLearning(deferred, tx, NOW);
      // The transaction is still usable after the call.
      await tx.organisation.update({ where: { id: deferred }, data: { name: "Close deferred (live)" } });
      return r;
    });
    assert.equal(out1, "closed");
    assert.deepEqual(await row(deferred), { status: "skipped", reason: "went-live", attempts: 1 });
    assert.equal(await chat(deferred), null);
    assert.equal((await db.organisation.findUnique({ where: { id: deferred }, select: { name: true } }))?.name, "Close deferred (live)");
    ok("a deferred reading is closed (skipped, went-live), its chat deleted, and the transaction carries on");

    // 2. A running reading.
    const running = await club("running", { status: "running" });
    assert.equal(await db.$transaction((tx) => closeUnfinishedSetupLearning(running, tx, NOW)), "closed");
    assert.deepEqual(await row(running), { status: "skipped", reason: "went-live", attempts: 1 });
    ok("a running reading is closed");

    // 3. No row at all: a final one is created.
    const none = await club("none", null);
    assert.equal(await db.$transaction((tx) => closeUnfinishedSetupLearning(none, tx, NOW)), "created-closed");
    assert.deepEqual(await row(none), { status: "skipped", reason: "went-live", attempts: 1 });
    assert.equal(await chat(none), null);
    ok("a club with no reading gets a final row, so the sweep's 'not read yet' can never match it");

    // 4. A final row is untouched, and the transaction is NOT aborted by the conflict.
    const applied = await club("applied", { status: "applied" });
    const out4 = await db.$transaction(async (tx) => {
      const r = await closeUnfinishedSetupLearning(applied, tx, NOW);
      await tx.organisation.update({ where: { id: applied }, data: { name: "Close applied (live)" } });
      return r;
    });
    assert.equal(out4, "already-final");
    assert.deepEqual(await row(applied), { status: "applied", reason: null, attempts: 1 });
    assert.notEqual(await chat(applied), null);
    assert.equal((await db.organisation.findUnique({ where: { id: applied }, select: { name: true } }))?.name, "Close applied (live)");
    ok("an already final reading is left as it is, and the conflict does not abort the transaction");

    // 5. Twice is once.
    assert.equal(await db.$transaction((tx) => closeUnfinishedSetupLearning(deferred, tx, NOW)), "already-final");
    ok("calling it again changes nothing");

    console.log(`OK: ${n} club-setup checks against Postgres`);
  } finally {
    await db.organisation.deleteMany({ where: { id: { startsWith: P } } });
    await db.user.deleteMany({ where: { id: { startsWith: P } } });
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
