/**
 * `goLiveClub` (src/lib/club-setup.ts, go-live slice S4) against the REAL
 * embedded Postgres, under tsx (the lib imports the Prisma 7 generated
 * client, which Playwright's transpiler cannot load). Invoked by
 * e2e/api/setup-go-live.spec.ts via execFile; exits non-zero with a
 * readable message on any failure.
 *
 * What only a real database can show: the one transaction commits every
 * part or none, two GOs at the same instant give ONE hello, the stale
 * queue is gone, fixtures that kicked off before go-live are quiet, the
 * CHECK constraint accepts the write, and every refusal changes nothing.
 */
import assert from "node:assert/strict";
import { assertSafeTestDbUrl, E2E_DB_URL } from "./env";

const P = "e2e-golive-";

async function main() {
  const url = process.env.MT_E2E_DATABASE_URL ?? E2E_DB_URL;
  assertSafeTestDbUrl(url);
  process.env.DATABASE_URL = url;

  const { db } = await import("@/lib/db");
  const { goLiveClub, helloPreviewForClub, liveByUser, liveByOwner } = await import("@/lib/club-setup");
  const { paymentsLiveKey } = await import("@/lib/payments-live-announce");

  let n = 0;
  const ok = (label: string) => {
    n++;
    console.log(`  ok ${n}: ${label}`);
  };
  const NOW = new Date();
  const HOUR = 3_600_000;
  const ago = (ms: number) => new Date(NOW.getTime() - ms);
  const ahead = (ms: number) => new Date(NOW.getTime() + ms);

  let phoneSeq = 0;
  async function club(
    key: string,
    over: Record<string, unknown> = {},
    opts: { connect?: boolean; approvedAgoMs?: number } = {},
  ) {
    const id = `${P}${key}`;
    const phone = `4477009018${String(++phoneSeq).padStart(2, "0")}`;
    await db.user.create({
      data: { id: `${id}-u`, name: "Greta Golive", email: `${id}@e2e-test.invalid`, phoneNumber: `+${phone}`, onboarded: true },
    });
    await db.organisation.create({
      data: {
        id,
        name: `Golive ${key}`,
        slug: id,
        inviteCode: `${id}-invite`,
        approvalStatus: "approved",
        approvedAt: ago(opts.approvedAgoMs ?? 3 * HOUR),
        whatsappGroupId: `1203639000001${String(phoneSeq).padStart(2, "0")}@g.us`,
        whatsappBotEnabled: false,
        setupStage: "setting-up",
        ...over,
      } as never,
    });
    await db.membership.create({ data: { userId: `${id}-u`, orgId: id, role: "OWNER" } });
    if (opts.connect !== false) {
      await db.clubConnect.create({
        data: {
          id: `${id}-cc`,
          orgId: id,
          userId: `${id}-u`,
          phone,
          code: "7GL2",
          status: "closed",
          expiresAt: ahead(HOUR),
          groupId: `1203639000001${String(phoneSeq).padStart(2, "0")}@g.us`,
          groupSubject: `Golive ${key} 5s`,
          linkedAt: ago(4 * HOUR),
          capturedHistory: [{ author: "A", text: "same lot as last week" }],
        },
      });
    }
    return id;
  }
  const org = (id: string) =>
    db.organisation.findUnique({
      where: { id },
      select: { setupStage: true, whatsappBotEnabled: true, liveAt: true, liveBy: true, approvalStatus: true } as never,
    }) as Promise<{ setupStage: string; whatsappBotEnabled: boolean; liveAt: Date | null; liveBy: string | null; approvalStatus: string } | null>;
  const jobs = (orgId: string) => db.botJob.findMany({ where: { orgId }, orderBy: { createdAt: "asc" } });

  const cleanup = async () => {
    await db.sentNotification.deleteMany({ where: { key: { contains: P } } });
    await db.botJob.deleteMany({ where: { orgId: { startsWith: P } } });
    await db.organisation.deleteMany({ where: { id: { startsWith: P } } });
    await db.user.deleteMany({ where: { id: { startsWith: P } } });
  };

  try {
    // A crashed earlier run must not fail this one.
    await cleanup();
    // ── 1. The whole go-live, in one transaction ──────────────────────
    const a = await club("full", { paymentCollectionEnabled: true, stripeConnectAccountId: "acct_golive", stripeChargesEnabled: true });
    await db.sport.create({
      data: { id: `${a}-sport`, orgId: a, name: "Football 5-a-side", playersPerTeam: 5, positions: ["GK"], teamLabels: ["Red", "Yellow"] } as never,
    });
    await db.activity.create({
      data: { id: `${a}-act`, orgId: a, sportId: `${a}-sport`, name: "Weekly game", dayOfWeek: 2, time: "21:00", venue: "Pitch", isActive: true } as never,
    });
    const match = (id: string, date: Date, status: string) =>
      db.match.create({ data: { id: `${a}-${id}`, activityId: `${a}-act`, date, maxPlayers: 10, status, attendanceDeadline: date } as never });
    await match("past-open", ago(5 * HOUR), "UPCOMING");
    await match("past-done", ago(30 * HOUR), "COMPLETED");
    await match("future", ahead(48 * HOUR), "UPCOMING");
    // The queue a setting-up club builds up: website actions and the
    // undelivered help replies.
    await db.botJob.createMany({
      data: [
        { orgId: a, kind: "group", text: "STALE: Pat is in (from the website)" },
        { orgId: a, kind: "dm", phone: "447700901899", text: "STALE: help answer" },
        { orgId: a, kind: "dm", phone: "447700901899", text: "STALE: a reminder for later", sendAfter: ahead(24 * HOUR) },
        { orgId: a, kind: "group", text: "ALREADY SENT (kept)", sentAt: ago(HOUR) },
      ],
    });
    await db.clubSetupLearning.create({ data: { orgId: a, status: "deferred", reason: "model-error" } });

    const preview = await helloPreviewForClub(a);
    const out = await goLiveClub(a, liveByUser(`${a}-u`), NOW);
    assert.equal(out.outcome, "went-live");
    if (out.outcome !== "went-live") throw new Error("unreachable");
    assert.equal(out.club, "Golive full");
    assert.equal(out.group, "Golive full 5s");
    assert.equal(out.hello, preview, "the preview is the hello that goes out");
    assert.equal(out.purgedJobs, 3);
    const row = await org(a);
    assert.equal(row?.setupStage, "live");
    assert.equal(row?.whatsappBotEnabled, true);
    assert.equal(row?.liveAt?.getTime(), NOW.getTime());
    assert.equal(row?.liveBy, `${a}-u`);
    ok("stage live, bot on, liveAt and liveBy stamped, in one write the CHECK constraint accepts");

    const after = await jobs(a);
    assert.deepEqual(
      after.filter((j) => !j.sentAt).map((j) => ({ kind: j.kind, text: j.text })),
      [{ kind: "group", text: preview }],
      "the only unsent job is the hello",
    );
    assert.equal(after.filter((j) => j.text.startsWith("STALE")).length, 0);
    assert.equal(after.filter((j) => j.text.startsWith("ALREADY SENT")).length, 1);
    assert.match(preview, /Greta/);
    ok("every unsent job queued while setting up is DELETED (future-dated too); a sent one is history; the hello is queued");

    assert.ok(await db.sentNotification.findUnique({ where: { key: `org-${a}:bot-intro` } }));
    ok("the scheduler's older intro is claimed, so it never follows the hello");

    assert.deepEqual(await db.clubSetupLearning.findUnique({ where: { orgId: a }, select: { status: true, reason: true } }), {
      status: "skipped",
      reason: "went-live",
    });
    ok("the unfinished setup reading is closed in the same transaction");

    const ms = await db.match.findMany({ where: { activityId: `${a}-act` }, select: { id: true, status: true, postMatchEndFlow: true }, orderBy: { date: "asc" } });
    assert.deepEqual(ms, [
      { id: `${a}-past-done`, status: "COMPLETED", postMatchEndFlow: false },
      { id: `${a}-past-open`, status: "COMPLETED", postMatchEndFlow: false },
      { id: `${a}-future`, status: "UPCOMING", postMatchEndFlow: true },
    ]);
    assert.equal(out.quietedMatches, 2);
    for (const id of ["past-open", "past-done"]) {
      assert.ok(await db.sentNotification.findUnique({ where: { key: `${a}-${id}:ask-score` } }), `${id}: ask-score claimed`);
    }
    assert.equal(await db.sentNotification.findUnique({ where: { key: `${a}-future:ask-score` } }), null);
    ok("fixtures that kicked off before go-live are completed and quiet (no post-match flow, no score ask); the next game is untouched");

    assert.ok(await db.sentNotification.findUnique({ where: { key: paymentsLiveKey(a, "acct_golive") } }));
    ok("payments switched on while setting up: the hello says so, and the late announcement is marked done");

    // ── 2. Said again: already live, nothing more ─────────────────────
    const again = await goLiveClub(a, liveByUser(`${a}-u`), new Date(NOW.getTime() + 60_000));
    assert.equal(again.outcome, "already-live");
    if (again.outcome !== "already-live") throw new Error("unreachable");
    assert.equal(again.liveBy, `${a}-u`);
    assert.equal(again.liveAt?.getTime(), NOW.getTime());
    assert.equal((await jobs(a)).filter((j) => !j.sentAt).length, 1);
    assert.equal((await org(a))?.liveBy, `${a}-u`);
    ok("a second GO is already-live, with who and when, and queues no second hello");

    // ── 3. The race: two GOs at the same instant ──────────────────────
    for (let round = 1; round <= 3; round++) {
      const r = await club(`race${round}`);
      const [x, y] = await Promise.all([
        goLiveClub(r, liveByUser("u-second-admin"), NOW),
        goLiveClub(r, liveByUser(`${r}-u`), NOW),
      ]);
      const kinds = [x.outcome, y.outcome].sort();
      assert.deepEqual(kinds, ["already-live", "went-live"], `round ${round}`);
      const hellos = (await jobs(r)).filter((j) => j.kind === "group");
      assert.equal(hellos.length, 1, `round ${round}: one hello`);
      const winner = x.outcome === "went-live" ? "u-second-admin" : `${r}-u`;
      assert.equal((await org(r))?.liveBy, winner);
      const loser = x.outcome === "already-live" ? x : y;
      if (loser.outcome === "already-live") assert.equal(loser.liveBy, winner);
    }
    ok("two concurrent GOs: one goes live, the other is told already-live by the winner, and there is ONE hello (3 rounds)");

    // ── 4. Still reading (owner decision 4) ───────────────────────────
    const reading = await club("reading", {}, { approvedAgoMs: 10 * 60_000 });
    await db.clubSetupLearning.create({ data: { orgId: reading, status: "running" } });
    assert.equal((await goLiveClub(reading, "u", NOW, { learningEnabled: true })).outcome, "still-reading");
    assert.equal((await org(reading))?.setupStage, "setting-up");
    assert.equal((await jobs(reading)).length, 0);
    ok("an unfinished reading under two hours old refuses GO: nothing changes");

    const noRow = await club("norow", {}, { approvedAgoMs: 5 * 60_000 });
    assert.equal((await goLiveClub(noRow, "u", NOW, { learningEnabled: true })).outcome, "still-reading");
    ok("no reading row yet, one expected (a connect request), under two hours: still reading");

    assert.equal((await goLiveClub(reading, "u", NOW, { learningEnabled: false })).outcome, "went-live");
    assert.deepEqual(await db.clubSetupLearning.findUnique({ where: { orgId: reading }, select: { status: true, reason: true } }), {
      status: "skipped",
      reason: "went-live",
    });
    ok("with the reading switched off the same club goes live, and the row is closed");

    const old = await club("old", {}, { approvedAgoMs: 2 * HOUR + 60_000 });
    await db.clubSetupLearning.create({ data: { orgId: old, status: "running" } });
    assert.equal((await goLiveClub(old, "u", NOW, { learningEnabled: true })).outcome, "went-live");
    ok("past two hours an unfinished reading no longer blocks");

    const unexpected = await club("unexpected", {}, { approvedAgoMs: 5 * 60_000, connect: false });
    const unexpectedOut = await goLiveClub(unexpected, "u", NOW, { learningEnabled: true });
    assert.equal(unexpectedOut.outcome, "went-live");
    if (unexpectedOut.outcome === "went-live") assert.equal(unexpectedOut.group, "Golive unexpected");
    ok("no row and none expected (no connect request): not blocked; the group is named by the club");

    const done = await club("done", {}, { approvedAgoMs: 5 * 60_000 });
    await db.clubSetupLearning.create({ data: { orgId: done, status: "applied" } });
    assert.equal((await goLiveClub(done, "u", NOW, { learningEnabled: true })).outcome, "went-live");
    assert.equal((await db.clubSetupLearning.findUnique({ where: { orgId: done }, select: { status: true } }))?.status, "applied");
    ok("a finished reading does not block, and is left as it was");

    // ── 5. Removed from the group ─────────────────────────────────────
    const removed = await club("removed", { setupRemovedAt: ago(HOUR) });
    assert.equal((await goLiveClub(removed, "u", NOW)).outcome, "removed-from-group");
    assert.equal((await org(removed))?.setupStage, "setting-up");
    assert.equal((await jobs(removed)).length, 0);
    ok("removed from its group: refused, nothing changes");
    // The MatchTime owner's door (slice S5) skips ONE check, the reading.
    assert.equal(
      (await goLiveClub(removed, liveByOwner("kemal"), NOW, { learningEnabled: true, skipReadingCheck: true })).outcome,
      "removed-from-group",
    );
    assert.equal((await org(removed))?.setupStage, "setting-up");
    assert.equal((await jobs(removed)).length, 0);
    ok("skipReadingCheck does not get a removed club live: still refused, nothing changes");

    const ownerDoor = await club("ownerdoor", {}, { approvedAgoMs: 10 * 60_000 });
    await db.clubSetupLearning.create({ data: { orgId: ownerDoor, status: "running" } });
    assert.equal((await goLiveClub(ownerDoor, "u", NOW, { learningEnabled: true })).outcome, "still-reading");
    const viaOwner = await goLiveClub(ownerDoor, liveByOwner("kemal"), NOW, { learningEnabled: true, skipReadingCheck: true });
    assert.equal(viaOwner.outcome, "went-live");
    assert.equal((await org(ownerDoor))?.liveBy, "owner:kemal");
    assert.equal((await jobs(ownerDoor)).length, 1);
    assert.deepEqual(await db.clubSetupLearning.findUnique({ where: { orgId: ownerDoor }, select: { status: true, reason: true } }), {
      status: "skipped",
      reason: "went-live",
    });
    ok("skipReadingCheck takes a club with an unfinished reading live, once, and closes the reading for good");

    // ── 6. Not setting up ─────────────────────────────────────────────
    const neverHeld = await club("neverheld", { setupStage: "live", whatsappBotEnabled: true });
    assert.equal((await goLiveClub(neverHeld, "u", NOW)).outcome, "not-setting-up");
    assert.equal((await org(neverHeld))?.liveAt, null);
    const pending = await club("pending", { approvalStatus: "pending", approvedAt: null });
    assert.equal((await goLiveClub(pending, "u", NOW)).outcome, "not-setting-up");
    assert.equal((await org(pending))?.whatsappBotEnabled, false);
    assert.equal((await goLiveClub(`${P}nobody`, "u", NOW)).outcome, "not-setting-up");
    assert.equal((await jobs(neverHeld)).length + (await jobs(pending)).length, 0);
    ok("a club that was never held (the Sutton FC shape), one not approved, and one that does not exist: not-setting-up, untouched");

    // ── 7. The owner's door ───────────────────────────────────────────
    const owned = await club("owner");
    assert.equal((await goLiveClub(owned, liveByOwner("u-kemal"), NOW)).outcome, "went-live");
    assert.equal((await org(owned))?.liveBy, "owner:u-kemal");
    ok("liveBy records the platform owner's door as owner:<id>");

    // ── 8. Payments the hello does not cover are announced after it ────
    const monthly = await club("monthly", {
      squadMode: "monthly",
      paymentCollectionEnabled: true,
      stripeConnectAccountId: "acct_monthly",
      stripeChargesEnabled: true,
    });
    const mOut = await goLiveClub(monthly, "u", NOW);
    assert.equal(mOut.outcome, "went-live");
    const mJobs = (await jobs(monthly)).filter((j) => j.kind === "group");
    assert.equal(mJobs.length, 2);
    if (mOut.outcome === "went-live") assert.equal(mJobs[0].text, mOut.hello);
    assert.ok(mJobs[1].createdAt.getTime() > mJobs[0].createdAt.getTime(), "the announcement follows the hello");
    assert.ok(await db.sentNotification.findUnique({ where: { key: paymentsLiveKey(monthly, "acct_monthly") } }));
    ok("a monthly club's hello has no fees line, so the payments announcement is queued once, after the hello");

    // ── 9. Paused for the club fee (PR #234 review, fix 2) ─────────────
    // A hello queued for a paused club is never delivered (due-posts
    // refuses the club) and is marked sent on resume, with the intro key
    // already spent. So going live waits.
    async function pause(orgId: string, reason: string) {
      await db.clubBilling.create({
        data: { orgId, trialStartedAt: ago(70 * 24 * HOUR), trialEndsAt: ago(9 * 24 * HOUR), pausedAt: ago(HOUR), pausedReason: reason } as never,
      });
      await db.organisation.update({ where: { id: orgId }, data: { billingStatus: "paused" } as never });
    }
    const paused = await club("paused");
    await pause(paused, "no-card");
    const pausedOut = await goLiveClub(paused, "u", NOW, { billingEnabled: true });
    assert.equal(pausedOut.outcome, "billing-paused");
    assert.equal((await org(paused))?.setupStage, "setting-up");
    assert.equal((await org(paused))?.whatsappBotEnabled, false);
    assert.equal((await jobs(paused)).length, 0);
    assert.equal(await db.sentNotification.findUnique({ where: { key: `org-${paused}:bot-intro` } }), null);
    ok("a club paused for the club fee is refused (billing-paused): no hello queued to be lost, the intro key unspent");
    assert.equal(
      (await goLiveClub(paused, liveByOwner("kemal"), NOW, { billingEnabled: true, learningEnabled: true, skipReadingCheck: true })).outcome,
      "billing-paused",
    );
    assert.equal((await org(paused))?.setupStage, "setting-up");
    assert.equal((await jobs(paused)).length, 0);
    ok("skipReadingCheck does not get a paused club live either: billing-paused, nothing changes");

    const pausedRemoved = await club("pausedrm");
    await pause(pausedRemoved, "removed");
    assert.equal((await goLiveClub(pausedRemoved, "u", NOW, { billingEnabled: true })).outcome, "removed-from-group");
    assert.equal((await jobs(pausedRemoved)).length, 0);
    ok("paused BECAUSE MatchTime was removed from the group: the removed-from-group refusal");

    assert.equal((await goLiveClub(paused, "u", NOW, { billingEnabled: false })).outcome, "went-live");
    ok("with BILLING_ENABLED off nobody counts as paused, as everywhere else: the same club goes live");

    // ── 10. The seeds skip a club that is setting up (fix 4) ────────────
    const { seedDueRollingSquads } = await import("@/lib/rolling-squad");
    const { seedDueMonthlySquads } = await import("@/lib/monthly-week");
    const yesterday = ago(30 * HOUR);
    const soon = ahead(3 * HOUR);
    async function fixture(orgId: string, playerIds: string[]) {
      await db.sport.create({
        data: { id: `${orgId}-sport`, orgId, name: "Football 5-a-side", playersPerTeam: 5, positions: ["GK"], teamLabels: ["Red", "Yellow"] } as never,
      });
      await db.activity.create({
        data: { id: `${orgId}-act`, orgId, sportId: `${orgId}-sport`, name: "Weekly game", dayOfWeek: 2, time: "21:00", venue: "Pitch", isActive: true } as never,
      });
      await db.match.create({ data: { id: `${orgId}-last`, activityId: `${orgId}-act`, date: yesterday, maxPlayers: 10, status: "COMPLETED", attendanceDeadline: yesterday } as never });
      await db.match.create({ data: { id: `${orgId}-next`, activityId: `${orgId}-act`, date: soon, maxPlayers: 10, status: "UPCOMING", attendanceDeadline: soon } as never });
      for (const [i, userId] of playerIds.entries()) {
        await db.attendance.create({ data: { matchId: `${orgId}-last`, userId, status: "CONFIRMED", position: i + 1 } });
      }
    }
    const seededOn = (orgId: string) => db.attendance.count({ where: { matchId: `${orgId}-next` } });

    const rollHeld = await club("rollheld", { rollingSquadEnabled: true });
    const rollLive = await club("rolllive", { rollingSquadEnabled: true, setupStage: "live", whatsappBotEnabled: true });
    await fixture(rollHeld, [`${rollHeld}-u`]);
    await fixture(rollLive, [`${rollLive}-u`]);
    await seedDueRollingSquads(NOW);
    assert.equal(await seededOn(rollLive), 1, "the control club, live, is seeded as ever");
    assert.equal(await seededOn(rollHeld), 0, "the setting-up club is not seeded");
    assert.equal(await db.sentNotification.count({ where: { matchId: `${rollHeld}-next` } }), 0);
    assert.equal((await jobs(rollHeld)).length, 0);
    ok("rolling squad: a setting-up club is not seeded and no key is claimed for it; an identical live club is seeded as before");
    assert.equal((await goLiveClub(rollHeld, "u", NOW)).outcome, "went-live");
    await seedDueRollingSquads(NOW);
    assert.equal(await seededOn(rollHeld), 1);
    ok("and it is seeded on the first run after it goes live");

    const monthStart = new Date(Date.UTC(soon.getUTCFullYear(), soon.getUTCMonth(), 1));
    async function runningMonth(orgId: string) {
      await db.squadMonth.create({
        data: {
          id: `${orgId}-month`,
          orgId,
          activityId: `${orgId}-act`,
          monthStart,
          status: "running",
          gamesScheduled: 4,
          startedMidMonthAt: ago(2 * HOUR),
          members: { create: [{ userId: `${orgId}-u`, kind: "regular", slot: 1, gamesCovered: 4 }] },
        } as never,
      });
    }
    const monHeld = await club("monheld", { squadMode: "monthly" });
    const monLive = await club("monlive", { squadMode: "monthly", setupStage: "live", whatsappBotEnabled: true });
    for (const id of [monHeld, monLive]) {
      await fixture(id, []);
      await db.match.delete({ where: { id: `${id}-last` } });
      await runningMonth(id);
    }
    await seedDueMonthlySquads(NOW);
    assert.equal(await seededOn(monLive), 1, "the control club, live, has its regular put on the next game");
    assert.equal(await seededOn(monHeld), 0, "the setting-up club's regular is not");
    assert.equal((await db.match.findUnique({ where: { id: `${monHeld}-next` }, select: { rollingSeededAt: true } }))?.rollingSeededAt, null);
    assert.equal((await jobs(monHeld)).length, 0);
    // The organiser starting a month on the website asks for this one club by id.
    await seedDueMonthlySquads(NOW, monHeld);
    assert.equal(await seededOn(monHeld), 0);
    ok("monthly squad: a setting-up club is not seeded (nor by the website's own call), its once-mark is not spent, no DM is queued; a live one is as before");
    assert.equal((await goLiveClub(monHeld, "u", NOW)).outcome, "went-live");
    await seedDueMonthlySquads(NOW, monHeld);
    assert.equal(await seededOn(monHeld), 1);
    ok("and it is seeded once it is live");

    console.log(`OK: ${n} go-live checks against Postgres`);
  } finally {
    await cleanup().catch((err) => console.error("cleanup failed:", err));
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
