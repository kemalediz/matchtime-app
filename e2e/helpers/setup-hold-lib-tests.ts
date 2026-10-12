/**
 * GO-LIVE SLICE S3 (PR #235 review fixes 1, 3, 5 and 8): the held approval
 * against the REAL embedded Postgres, under tsx (the lib imports the
 * Prisma 7 generated client, which Playwright's transpiler cannot load).
 * Invoked by e2e/api/setup-hold-approval.spec.ts via execFile; exits
 * non-zero with a readable message on any failure.
 *
 * What only the lib and a real database can show, with the clock in hand:
 *   - approve at 23:30, suspend at 00:10: nothing is handed to the Pi at
 *     09:00 (the waiting setup DM is cancelled by the suspension);
 *   - a setup DM the Pi has ALREADY claimed is left alone by the cancel;
 *   - a held club cannot be rejected or approved again through
 *     `decideClub`, and suspending it leaves it silent;
 *   - a reading CLOSED while its model call is in flight applies nothing
 *     and does not overwrite the closed row;
 *   - a reading that is writing its result when the cap arrives wins, and
 *     the cap then closes nothing.
 *
 * No model is called: the reading is given a stub.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { assertSafeTestDbUrl, E2E, E2E_DB_URL, REPO_ROOT } from "./env";

const rolling = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "src/lib/setup-learning/__fixtures__/rolling.json"), "utf8"),
) as { history: unknown[] };

const ROLLING_ANSWER = {
  regular_game: true,
  squad: {
    answer: "rolling",
    confidence: "high",
    evidence: ["Same lot as last week, let me know if you can't do Tuesday", "Usual crew this week too, only message if you're dropping out"],
  },
  open_places: { answer: "unclear", confidence: "low", evidence: [] },
  drop_out_deadline: { day: "none", time: "none", confidence: "low", evidence: [] },
  list_published: { day: "none", time: "none", confidence: "low", evidence: [] },
  payments: { answer: "no_sign", confidence: "low", evidence: [] },
  monthly_list: { answer: "no_sign", prepay_for_month: false, pay_as_you_go_fill_ins: false, credit_for_missed_games: false, confidence: "low", evidence: [] },
  weekly_game: { day: "none", time: "none", venue: "", players_per_side: 0, confidence: "low", evidence: [] },
};

async function main() {
  const url = process.env.MT_E2E_DATABASE_URL ?? E2E_DB_URL;
  assertSafeTestDbUrl(url);
  process.env.DATABASE_URL = url;
  process.env.NEXTAUTH_URL = "https://matchtime.ai";
  process.env.SELF_JOIN_APPROVER_PHONES = E2E.APPROVER_PHONE;

  const { decideClub, loadSilentGroupIds } = await import("@/lib/club-approval");
  const { runSetupAfterApproval, sendSetupDm, closeReadingForGood, cancelSetupDm, setupAskRefId } = await import("@/lib/club-setup-dm");
  const { claimDuePlatformJobs, recordPlatformJobOutcome } = await import("@/lib/platform-jobs");
  const { goLiveClub, helloPreviewForClub } = await import("@/lib/club-setup");
  const { learnClubSetup } = await import("@/lib/setup-learning/run");
  const { messageHoursSendAfter } = await import("@/lib/message-hours");
  const { db } = await import("@/lib/db");

  let n = 0;
  const ok = (label: string) => {
    n++;
    console.log(`  ✓ ${label}`);
  };

  const P = "e2e-s3-lib";
  async function pendingClub(i: number, opts: { history?: boolean } = {}) {
    const orgId = `${P}-org-${i}`;
    const groupId = `1203639300000000${String(i).padStart(2, "0")}@g.us`;
    const phone = `4477009006${String(i).padStart(2, "0")}`;
    const userId = `${P}-u-${i}`;
    await db.user.create({ data: { id: userId, name: "Lib Organiser", email: `${userId}@e2e-test.invalid`, phoneNumber: `+${phone}` } });
    await db.$executeRawUnsafe(
      `INSERT INTO "Organisation" (id,name,slug,"inviteCode","approvalStatus",language,"createdAt","updatedAt")
       VALUES ($1,$2,$1,$3,'pending','en',now(),now())`,
      orgId,
      `Lib Held ${i}`,
      `${orgId}-invite`,
    );
    await db.clubConnect.create({
      data: {
        id: `${P}-cc-${i}`,
        orgId,
        userId,
        phone,
        code: `H${String(i).padStart(3, "0")}`,
        status: "group_linked",
        expiresAt: new Date(Date.now() + 3600_000),
        groupId,
        groupSubject: `Lib held group ${i}`,
        memberCount: 1,
        participants: [{ phone, pushname: "Lib" }],
        linkedAt: new Date(),
        ...(opts.history ? { capturedHistory: rolling.history as object } : {}),
      },
    });
    return { orgId, groupId, phone, userId };
  }
  const setupJob = (orgId: string) =>
    db.platformJob.findFirst({ where: { purpose: "setup-ask", refId: setupAskRefId(orgId) }, select: { id: true, status: true, sendAfter: true, failReason: true } });
  const club = (orgId: string) =>
    db.organisation.findUnique({ where: { id: orgId }, select: { approvalStatus: true, whatsappBotEnabled: true, rollingSquadEnabled: true, setupAskedAt: true } });

  // 23:30 London on a summer night, 00:10 the next day, and the morning after.
  const AT_2330 = new Date("2026-07-14T22:30:00Z");
  const AT_0010 = new Date("2026-07-14T23:10:00Z");
  const AT_0905 = new Date("2026-07-15T08:05:00Z");

  try {
    // ── 1. Approve at 23:30, suspend at 00:10: nothing is sent at 09:00 ──
    {
      const c = await pendingClub(1);
      const approved = await decideClub(c.orgId, "approve", "lib-owner", { now: AT_2330, hold: true });
      assert.ok(approved.ok && approved.held, "the approval held the club");
      await runSetupAfterApproval(c.orgId, { now: AT_2330, learningEnabled: false });
      const queued = await setupJob(c.orgId);
      assert.equal(queued?.status, "queued");
      assert.deepEqual(queued?.sendAfter, messageHoursSendAfter(AT_2330), "held for 09:00 London");

      const suspended = await decideClub(c.orgId, "suspend", "lib-owner", { now: AT_0010, confirmName: "Lib Held 1" });
      assert.ok(suspended.ok, "suspended");
      const after = await setupJob(c.orgId);
      assert.equal(after?.status, "failed");
      assert.equal(after?.failReason, "cancelled: suspended");

      const handed = await claimDuePlatformJobs({ now: AT_0905, limit: 50 });
      assert.ok(!handed.some((j) => j.id === queued!.id), "the cancelled DM is not handed to the Pi at 09:05");
      assert.ok(!handed.some((j) => j.kind === "dm" && j.phone === c.phone), "nothing at all goes to that organiser");
      assert.deepEqual(await club(c.orgId).then((o) => [o?.approvalStatus, o?.whatsappBotEnabled]), ["suspended", false]);
      assert.ok((await loadSilentGroupIds()).includes(c.groupId), "a suspended held club's group is silent");
      ok("approve at 23:30, suspend at 00:10: the waiting setup DM is cancelled and nothing is sent at 09:00");
    }

    // ── 2. The Pi had already claimed it: left alone, and the caller is told ──
    {
      const c = await pendingClub(2);
      await decideClub(c.orgId, "approve", "lib-owner", { now: AT_2330, hold: true });
      await runSetupAfterApproval(c.orgId, { now: AT_2330, learningEnabled: false });
      const handed = await claimDuePlatformJobs({ now: AT_0905, limit: 50 });
      const job = await setupJob(c.orgId);
      assert.ok(handed.some((j) => j.id === job!.id), "the Pi was handed the DM at 09:05");
      assert.equal(job?.status, "claimed");
      // Two jobs since slice S7: the setup DM and the admin group command
      // behind it. The Pi claimed both in that poll, and both are marked.
      assert.deepEqual(await cancelSetupDm(c.orgId, "suspended", AT_0905), {
        cancelled: 0,
        alreadyClaimed: 1,
        followUps: { cancelled: 0, alreadyClaimed: 1 },
      });
      const marked = await setupJob(c.orgId);
      assert.equal(marked?.status, "claimed", "a claimed job keeps its status: it may be on its way");
      assert.equal(marked?.failReason, "cancelled: suspended", "and is marked as cancelled");
      ok("a setup DM the Pi has already claimed keeps its status, is marked, and the cancel says so");

      // THE PACING GAP: the Pi's one-DM-a-minute pacing held it back, so it
      // RELEASES the job. A cancelled job must not go back in the queue.
      assert.deepEqual(await recordPlatformJobOutcome(job!.id, { outcome: "release" }, AT_0905), { updated: true });
      const released = await setupJob(c.orgId);
      assert.equal(released?.status, "failed", "released after a cancel: failed, not queued");
      const later = await claimDuePlatformJobs({ now: new Date(AT_0905.getTime() + 60_000), limit: 50 });
      assert.ok(!later.some((j) => j.id === job!.id), "and never handed to the Pi again");
      ok("a cancelled job the Pi then releases for pacing is failed, not re-queued, and is never sent");
    }

    // ── 2b. A job that was NOT cancelled is released exactly as before ───
    {
      const c = await pendingClub(30);
      await decideClub(c.orgId, "approve", "lib-owner", { now: AT_2330, hold: true });
      await runSetupAfterApproval(c.orgId, { now: AT_2330, learningEnabled: false });
      await claimDuePlatformJobs({ now: AT_0905, limit: 50 });
      const job = await setupJob(c.orgId);
      assert.equal(job?.status, "claimed");
      await recordPlatformJobOutcome(job!.id, { outcome: "release" }, AT_0905);
      assert.equal((await setupJob(c.orgId))?.status, "queued", "a plain release goes back to queued");
      const again = await claimDuePlatformJobs({ now: new Date(AT_0905.getTime() + 60_000), limit: 50 });
      assert.ok(again.some((j) => j.id === job!.id), "and is handed out on the next poll");
      ok("a release of a job nobody cancelled is unchanged: back to queued, sent on a later poll");
    }

    // ── 2c. Approve at 23:30, GO LIVE at 23:40: nothing is sent at 09:00 ──
    {
      const c = await pendingClub(31);
      const AT_2340 = new Date("2026-07-14T22:40:00Z");
      await decideClub(c.orgId, "approve", "lib-owner", { now: AT_2330, hold: true });
      await runSetupAfterApproval(c.orgId, { now: AT_2330, learningEnabled: false });
      const queued = await setupJob(c.orgId);
      assert.equal(queued?.status, "queued");
      assert.deepEqual(queued?.sendAfter, messageHoursSendAfter(AT_2330), "held for 09:00 London");
      // The organiser presses Go live on the settings page (the action calls goLiveClub).
      const live = await goLiveClub(c.orgId, c.userId, AT_2340, { learningEnabled: false, billingEnabled: false });
      assert.equal(live.outcome, "went-live");
      const after = await setupJob(c.orgId);
      assert.equal(after?.status, "failed");
      assert.equal(after?.failReason, "cancelled: went-live");
      const handed = await claimDuePlatformJobs({ now: AT_0905, limit: 50 });
      assert.ok(!handed.some((j) => j.kind === "dm" && j.phone === c.phone), "no 'reply GO' DM reaches a club that is already live");
      // A refused go-live cancels nothing: the club is still waiting for its DM.
      const d = await pendingClub(32);
      await decideClub(d.orgId, "approve", "lib-owner", { now: AT_2330, hold: true });
      await runSetupAfterApproval(d.orgId, { now: AT_2330, learningEnabled: false });
      await db.organisation.update({ where: { id: d.orgId }, data: { setupRemovedAt: AT_2330 } });
      const refused = await goLiveClub(d.orgId, d.userId, AT_2340, { learningEnabled: false, billingEnabled: false });
      assert.equal(refused.outcome, "removed-from-group");
      assert.equal((await setupJob(d.orgId))?.status, "queued", "a go-live that was refused cancels nothing");
      ok("approve at 23:30, Go live at 23:40: the waiting setup DM is cancelled and nothing is sent at 09:00");
    }

    // ── 3. The cancel and the claim racing for one queued job: exactly one wins ──
    for (let i = 3; i <= 6; i++) {
      const c = await pendingClub(i);
      await decideClub(c.orgId, "approve", "lib-owner", { now: AT_2330, hold: true });
      await runSetupAfterApproval(c.orgId, { now: AT_2330, learningEnabled: false });
      const [cancel, handed] = await Promise.all([cancelSetupDm(c.orgId, "removed", AT_0905), claimDuePlatformJobs({ now: AT_0905, limit: 50 })]);
      // Two jobs since slice S7 (the setup DM and its admin group
      // command), each raced on its own: for EACH, exactly one of the
      // cancel and the claim won.
      const both = await db.platformJob.findMany({
        where: { refId: { in: [setupAskRefId(c.orgId), `${c.orgId}:setup-admin-code`] } },
        select: { id: true, status: true, failReason: true },
      });
      assert.equal(both.length, 2);
      let cancelled = 0;
      for (const job of both) {
        const sent = handed.some((j) => j.id === job.id);
        if (sent) {
          assert.equal(job.status, "claimed", "the claim won this job: it keeps its status");
        } else {
          assert.equal(job.status, "failed", "the cancel won this job: the Pi was not handed it");
          cancelled++;
        }
      }
      assert.equal(cancel.cancelled + cancel.followUps.cancelled, cancelled, "the cancel reports exactly the jobs it took back");
      assert.equal(
        cancel.cancelled + cancel.alreadyClaimed + cancel.followUps.cancelled + cancel.followUps.alreadyClaimed,
        2,
        "and accounts for both",
      );
    }
    ok("the cancel racing the Pi's claim (4 rounds): never both, never neither");

    // ── 4. A held club cannot be rejected or approved again ───────────────
    {
      const c = await pendingClub(7);
      await decideClub(c.orgId, "approve", "lib-owner", { now: AT_2330, hold: true });
      for (const d of ["reject", "approve"] as const) {
        const r = await decideClub(c.orgId, d, "lib-owner", { now: AT_0010, hold: true });
        assert.ok(!r.ok && r.reason === "not-pending", `${d} of a held club is refused`);
      }
      assert.deepEqual(await club(c.orgId).then((o) => [o?.approvalStatus, o?.whatsappBotEnabled]), ["approved", false]);
      assert.equal(await db.platformJob.count({ where: { kind: "leave-group", groupId: c.groupId } }), 0, "nothing leaves the group");
      assert.equal(await db.botJob.count({ where: { orgId: c.orgId } }), 0);
      ok("reject and a second approve of a held club are refused through decideClub; nothing changes");
    }

    // ── 5. Closed while the model call is in flight: nothing applied, the row stands ──
    {
      const c = await pendingClub(8, { history: true });
      const now = new Date();
      await decideClub(c.orgId, "approve", "lib-owner", { now, hold: true });
      let closedMidCall = false;
      const out = await learnClubSetup(c.orgId, {
        now,
        model: {
          name: "closed-mid-call",
          complete: async () => {
            // The 2-hour cap arrives while the model is still answering.
            closedMidCall = await closeReadingForGood(c.orgId, "timed-out", now);
            return {
              text: JSON.stringify(ROLLING_ANSWER),
              stopReason: "end_turn",
              usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
              costUsd: 0.001,
              ms: 1,
            };
          },
        },
      });
      assert.equal(closedMidCall, true, "the close found the reading unfinished and closed it");
      assert.deepEqual(out, { kind: "skipped", reason: "closed" });
      assert.equal((await club(c.orgId))?.rollingSquadEnabled, false, "the late result applied NOTHING");
      const row = await db.clubSetupLearning.findUnique({ where: { orgId: c.orgId }, select: { status: true, reason: true, applied: true, detected: true } });
      assert.deepEqual(row, { status: "skipped", reason: "timed-out", applied: null, detected: null }, "the closed row was not overwritten");
      const dm = await sendSetupDm(c.orgId, now, { learningEnabled: true });
      assert.equal(dm.kind, "sent");
      const text = (await db.platformJob.findFirst({ where: { purpose: "setup-ask", refId: setupAskRefId(c.orgId) }, select: { text: true } }))?.text ?? "";
      assert.match(text, /I couldn't read your group's recent messages, so MatchTime is on its standard setup\./);
      ok("a reading closed in flight applies nothing, leaves the closed row, and the DM says it could not be read");
    }

    // ── 6. A reading that finishes first wins: the cap then closes nothing ──
    {
      const c = await pendingClub(9, { history: true });
      const now = new Date();
      await decideClub(c.orgId, "approve", "lib-owner", { now, hold: true });
      const reading = learnClubSetup(c.orgId, {
        now,
        model: {
          name: "ok",
          complete: async () => ({
            text: JSON.stringify(ROLLING_ANSWER),
            stopReason: "end_turn",
            usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
            costUsd: 0.001,
            ms: 1,
          }),
        },
      });
      const out = await reading;
      assert.equal(out.kind, "done");
      assert.equal(await closeReadingForGood(c.orgId, "timed-out", now), false, "a finished reading is not closed");
      const row = await db.clubSetupLearning.findUnique({ where: { orgId: c.orgId }, select: { status: true } });
      assert.equal(row?.status, "applied");
      assert.equal((await club(c.orgId))?.rollingSquadEnabled, true);
      ok("a reading that finished is left exactly as it was by the cap's close");
    }

    // ── 7. The reading and the close at the same moment, 8 rounds: never half of each ──
    for (let i = 10; i <= 17; i++) {
      const c = await pendingClub(i, { history: true });
      const now = new Date();
      await decideClub(c.orgId, "approve", "lib-owner", { now, hold: true });
      const model = {
        name: "ok",
        complete: async () => ({
          text: JSON.stringify(ROLLING_ANSWER),
          stopReason: "end_turn",
          usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
          costUsd: 0.001,
          ms: 1,
        }),
      };
      // The first close makes the row exist ("running" is taken by the
      // reading's claim); the racing close arrives while it writes.
      const [out] = await Promise.all([
        learnClubSetup(c.orgId, { now, model }),
        new Promise((r) => setTimeout(r, i % 4)).then(() => closeReadingForGood(c.orgId, "timed-out", now)),
      ]);
      const row = await db.clubSetupLearning.findUnique({ where: { orgId: c.orgId }, select: { status: true, reason: true } });
      const switched = (await club(c.orgId))?.rollingSquadEnabled;
      if (row?.status === "applied") {
        assert.equal(switched, true, "recorded as applied, so it was applied");
        assert.equal(out.kind, "done");
      } else {
        assert.deepEqual(row, { status: "skipped", reason: "timed-out" });
        assert.equal(switched, false, "closed, so NOTHING was applied");
        assert.notEqual(out.kind, "done");
      }
    }
    ok("the reading racing the close (8 rounds): the club is switched if and only if the row says applied");

    // ── 8. LOCK ORDER: go-live racing a reading that is applying, 24 rounds ──
    //   Both take the club's row, then the reading row. No deadlock, and
    //   the result is always one of two whole outcomes: the reading applied
    //   BEFORE the hello was built (the hello describes a rolling squad), or
    //   it applied nothing (the hello describes weekly sign-up).
    {
      let appliedFirst = 0;
      let closedFirst = 0;
      for (let i = 40; i < 64; i++) {
        const c = await pendingClub(i, { history: true });
        const now = new Date();
        await decideClub(c.orgId, "approve", "lib-owner", { now, hold: true });
        const model = {
          name: "ok",
          complete: async () => {
            await new Promise((r) => setTimeout(r, i % 3));
            return {
              text: JSON.stringify(ROLLING_ANSWER),
              stopReason: "end_turn",
              usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
              costUsd: 0.001,
              ms: 1,
            };
          },
        };
        // `learningEnabled: false` so go-live does not wait for the reading
        // (the owner's "Go live now", or a GO after the two hours).
        const [reading, live] = await Promise.all([
          learnClubSetup(c.orgId, { now, model }),
          new Promise((r) => setTimeout(r, (i * 7) % 12)).then(() =>
            goLiveClub(c.orgId, c.userId, now, { learningEnabled: false, billingEnabled: false, organiserUserId: c.userId }),
          ),
        ]);
        assert.equal(live.outcome, "went-live", `round ${i}: went live (no deadlock, no error)`);
        const row = await db.clubSetupLearning.findUnique({ where: { orgId: c.orgId }, select: { status: true, reason: true } });
        const org = await db.organisation.findUnique({ where: { id: c.orgId }, select: { rollingSquadEnabled: true, whatsappBotEnabled: true } });
        assert.ok(row && ["applied", "nothing", "skipped", "failed"].includes(row.status), `round ${i}: live implies the reading is final (${row?.status})`);
        assert.equal(org?.whatsappBotEnabled, true);
        const hello = (await db.botJob.findFirst({ where: { orgId: c.orgId, kind: "group" }, orderBy: { createdAt: "asc" }, select: { text: true } }))?.text ?? "";
        if (live.outcome === "went-live") assert.equal(hello, live.hello);
        // The hello queued is the hello the stored settings produce.
        assert.equal(hello, await helloPreviewForClub(c.orgId, { organiserUserId: c.userId }), `round ${i}: the hello matches the settings stored`);
        if (row.status === "applied") {
          appliedFirst++;
          assert.equal(org?.rollingSquadEnabled, true, `round ${i}: recorded as applied, so it is applied`);
          assert.equal(reading.kind, "done");
        } else {
          closedFirst++;
          assert.deepEqual(row, { status: "skipped", reason: "went-live" });
          assert.equal(org?.rollingSquadEnabled, false, `round ${i}: closed by go-live, so NOTHING was applied`);
          assert.notEqual(reading.kind, "done");
        }
      }
      console.log(`    (the reading applied first in ${appliedFirst} round(s), go-live closed it first in ${closedFirst})`);
      ok("go-live racing a reading that is applying (24 rounds): no deadlock, never half of each, and the hello matches the stored settings");
    }

    console.log(`OK: ${n} setup-hold checks`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
