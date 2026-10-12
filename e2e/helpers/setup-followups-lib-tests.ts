/**
 * GO-LIVE SLICES S6 AND S7: what follows the setup DM, against the REAL
 * embedded Postgres, under tsx (the lib imports the Prisma 7 generated
 * client, which Playwright's transpiler cannot load). Invoked by
 * e2e/api/setup-followups.spec.ts via execFile; exits non-zero with a
 * readable message on any failure.
 *
 * What only the lib and a real database can show, with the clock in hand:
 *   - THE REMINDER, exactly once per club under concurrent runs; taken
 *     back when the club goes live or is suspended overnight; never left
 *     queued for a club that went live at the same instant;
 *   - THE OWNER'S NOTE, exactly once per club under concurrent runs;
 *   - THE ADMIN GROUP COMMAND: one per club under concurrent runs, sent
 *     after the setup DM, carrying the code that is stored, valid 7 days;
 *     the whole link path for a club that is SETTING UP, with not a word
 *     in the players' group; and the admin group after go-live.
 *
 * No model is called anywhere.
 */
import assert from "node:assert/strict";
import { assertSafeTestDbUrl, E2E, E2E_DB_URL } from "./env";

async function main() {
  const url = process.env.MT_E2E_DATABASE_URL ?? E2E_DB_URL;
  assertSafeTestDbUrl(url);
  process.env.DATABASE_URL = url;
  process.env.NEXTAUTH_URL = "https://matchtime.ai";
  process.env.SELF_JOIN_APPROVER_PHONES = E2E.APPROVER_PHONE;

  const { decideClub, loadSilentGroupIds } = await import("@/lib/club-approval");
  const { runSetupAfterApproval, sendSetupDm, cancelSetupDm, setupAskRefId } = await import("@/lib/club-setup-dm");
  const { sendSetupReminder, runSetupReminderSweep } = await import("@/lib/club-setup-reminder");
  const { noteStuckClub, runSetupStuckSweep } = await import("@/lib/club-setup-stuck");
  const { claimDuePlatformJobs, recordPlatformJobOutcome } = await import("@/lib/platform-jobs");
  const { goLiveClub } = await import("@/lib/club-setup");
  const { createAdminGroupLinkCode, linkAdminGroup, loadAdminGroups } = await import("@/lib/admin-group-link");
  const { handleAdminGroupLinkCommand } = await import("@/lib/admin-group-link-command");
  const { handleAdminGroupMessage } = await import("@/lib/admin-group");
  const { detectAdminGroupCandidate } = await import("@/lib/admin-group-link");
  const { messageHoursSendAfter } = await import("@/lib/message-hours");
  const { ownerQuietHoursSendAfter } = await import("@/lib/owner-dm");
  const { db } = await import("@/lib/db");

  let n = 0;
  const ok = (label: string) => {
    n++;
    console.log(`  ✓ ${label}`);
  };

  const HOUR = 60 * 60 * 1000;
  const P = "e2e-s6-lib";
  let seq = 0;
  async function pendingClub(opts: { lang?: string } = {}) {
    const i = ++seq;
    const orgId = `${P}-org-${i}`;
    const groupId = `1203639400000${String(i).padStart(5, "0")}@g.us`;
    const phone = `44770091${String(i).padStart(4, "0")}`;
    const userId = `${P}-u-${i}`;
    await db.user.create({ data: { id: userId, name: "Lib Organiser", email: `${userId}@e2e-test.invalid`, phoneNumber: `+${phone}` } });
    await db.$executeRawUnsafe(
      `INSERT INTO "Organisation" (id,name,slug,"inviteCode","approvalStatus",language,"createdAt","updatedAt")
       VALUES ($1,$2,$1,$3,'pending',$4,now(),now())`,
      orgId,
      `Lib Follow ${i}`,
      `${orgId}-invite`,
      opts.lang ?? "en",
    );
    await db.membership.create({ data: { id: `${userId}-mem`, userId, orgId, role: "OWNER" } });
    await db.clubConnect.create({
      data: {
        id: `${P}-cc-${i}`,
        orgId,
        userId,
        phone,
        code: `F${String(i).padStart(3, "0")}`,
        status: "group_linked",
        expiresAt: new Date(Date.now() + 3600_000),
        groupId,
        groupSubject: `Lib follow group ${i}`,
        memberCount: 1,
        participants: [{ phone, pushname: "Lib" }],
        linkedAt: new Date(),
      },
    });
    return { orgId, groupId, phone, userId, name: `Lib Follow ${i}`, hq: `1203639499000${String(i).padStart(5, "0")}@g.us` };
  }
  /** Approved and held at `at`, its setup DM (and command) queued, then marked as SENT by the Pi. */
  async function heldAndAsked(at: Date, opts: { lang?: string; sent?: boolean } = {}) {
    const c = await pendingClub(opts);
    const approved = await decideClub(c.orgId, "approve", "lib-owner", { now: at, hold: true });
    assert.ok(approved.ok && approved.held, "the approval held the club");
    await runSetupAfterApproval(c.orgId, { now: at, learningEnabled: false });
    if (opts.sent !== false) {
      await db.platformJob.updateMany({
        where: { refId: { in: [setupAskRefId(c.orgId), `${c.orgId}:setup-admin-code`] } },
        data: { status: "sent", sentAt: at },
      });
    }
    return c;
  }
  const jobsOf = (orgId: string, purpose: string) =>
    db.platformJob.findMany({
      where: { purpose, refId: { startsWith: `${orgId}:` } },
      orderBy: { createdAt: "asc" },
      select: { id: true, status: true, sendAfter: true, failReason: true, text: true, phone: true, createdAt: true, refId: true },
    });
  const reminders = (orgId: string) => jobsOf(orgId, "setup-reminder");
  /** Empty the queue of what earlier checks left, so "what the Pi is
   *  handed" below is about this check's jobs (a poll reads the 50 oldest). */
  const drainQueue = () => db.platformJob.updateMany({ where: { status: "queued" }, data: { status: "sent", sentAt: new Date() } });

  // 12:00 London on a summer day; and the clocks that follow from it.
  const T0 = new Date("2026-07-14T11:00:00Z");
  const T24 = new Date(T0.getTime() + 24 * HOUR);
  const T72 = new Date(T0.getTime() + 72 * HOUR);

  try {
    // ── 1. THE REMINDER: eight runs at the same moment, six rounds: exactly one ──
    for (let round = 0; round < 6; round++) {
      const c = await heldAndAsked(T0);
      const outcomes = await Promise.all(Array.from({ length: 8 }, () => sendSetupReminder(c.orgId, T24)));
      assert.equal(outcomes.filter((o) => o.kind === "sent").length, 1, `round ${round}: exactly one run sent it (${outcomes.map((o) => o.kind).join(",")})`);
      assert.ok(outcomes.every((o) => o.kind === "sent" || o.kind === "already"), "the others found it claimed");
      const jobs = await reminders(c.orgId);
      assert.equal(jobs.length, 1, "one reminder job");
      assert.equal(jobs[0].status, "queued");
      assert.equal(jobs[0].sendAfter, null, "12:00 London: it goes at once");
      assert.equal(jobs[0].phone, c.phone);
      assert.match(
        jobs[0].text ?? "",
        new RegExp(
          `^Just checking: ${c.name} is approved, but I'm still quiet in "Lib follow group \\d+"\\. Reply \\*GO\\* when you're ready and I'll introduce myself, or check the settings first: https://matchtime\\.ai/\\S+\\nI won't remind you again\\.$`,
        ),
      );
      assert.equal(await db.sentNotification.count({ where: { key: { startsWith: `org-${c.orgId}:setup-reminder:` } } }), 1);
      // And never again: a sweep a month later.
      await runSetupReminderSweep(new Date(T24.getTime() + 30 * 24 * HOUR));
      assert.equal((await reminders(c.orgId)).length, 1, "a month later: still one, and no automatic go-live");
      const org = await db.organisation.findUnique({ where: { id: c.orgId }, select: { whatsappBotEnabled: true, liveAt: true } });
      assert.deepEqual(org, { whatsappBotEnabled: false, liveAt: null });
    }
    ok("the reminder under eight concurrent runs (6 rounds): exactly one job, one claim, never a second, no automatic go-live");

    // ── 2. Not a minute early ────────────────────────────────────────────
    {
      const c = await heldAndAsked(T0);
      assert.deepEqual(await sendSetupReminder(c.orgId, new Date(T24.getTime() - 60_000)), { kind: "not-due" });
      assert.equal((await reminders(c.orgId)).length, 0);
      assert.deepEqual(await sendSetupReminder(c.orgId, T24), { kind: "sent", sendAfter: null });
      ok("the reminder is not due at 23 hours 59 minutes, and is at 24 hours");
    }

    // ── 3. Queued at 23:05 for 09:00; the club goes live at midnight: cancelled ──
    {
      const ASKED = new Date("2026-07-14T21:50:00Z"); // 22:50 London
      const AT_2305 = new Date("2026-07-15T22:05:00Z");
      const MIDNIGHT = new Date("2026-07-15T23:00:00Z");
      const AT_0905 = new Date("2026-07-16T08:05:00Z");
      await drainQueue();
      const c = await heldAndAsked(ASKED);
      const r = await sendSetupReminder(c.orgId, AT_2305);
      assert.deepEqual(r, { kind: "sent", sendAfter: messageHoursSendAfter(AT_2305) });
      assert.deepEqual((await reminders(c.orgId))[0].sendAfter, new Date("2026-07-16T08:00:00Z"), "held for 09:00 London");
      const live = await goLiveClub(c.orgId, c.userId, MIDNIGHT, { learningEnabled: false, billingEnabled: false });
      assert.equal(live.outcome, "went-live");
      const after = (await reminders(c.orgId))[0];
      assert.equal(after.status, "failed");
      assert.equal(after.failReason, "cancelled: went-live");
      const handed = await claimDuePlatformJobs({ now: AT_0905, limit: 50 });
      assert.ok(!handed.some((j) => j.id === after.id), "the reminder is not handed to the Pi at 09:05");
      assert.ok(!handed.some((j) => j.kind === "dm" && j.phone === c.phone && /Just checking/.test(j.text)), "no 'reply GO' reaches a live club");
      ok("a reminder queued at 23:05 for 09:00 is cancelled when the club goes live at midnight");

      // The same, suspended overnight.
      const d = await heldAndAsked(ASKED);
      await sendSetupReminder(d.orgId, AT_2305);
      const suspended = await decideClub(d.orgId, "suspend", "lib-owner", { now: MIDNIGHT, confirmName: d.name });
      assert.ok(suspended.ok, "suspended");
      const gone = (await reminders(d.orgId))[0];
      assert.equal(gone.status, "failed");
      assert.equal(gone.failReason, "cancelled: suspended");
      ok("and when the club is suspended overnight");

      // The Pi had already claimed it: marked, and a release does not re-queue it.
      const e = await heldAndAsked(ASKED);
      await sendSetupReminder(e.orgId, AT_2305);
      await claimDuePlatformJobs({ now: AT_0905, limit: 50 });
      const claimed = (await reminders(e.orgId))[0];
      assert.equal(claimed.status, "claimed");
      assert.deepEqual(await cancelSetupDm(e.orgId, "went-live", AT_0905), {
        cancelled: 0,
        alreadyClaimed: 0,
        followUps: { cancelled: 0, alreadyClaimed: 1 },
      });
      const marked = (await reminders(e.orgId))[0];
      assert.equal(marked.status, "claimed", "a claimed reminder keeps its status: it may be on its way");
      assert.equal(marked.failReason, "cancelled: went-live", "and is marked");
      await recordPlatformJobOutcome(marked.id, { outcome: "release" }, AT_0905);
      assert.equal((await reminders(e.orgId))[0].status, "failed", "released after a cancel: failed, not queued");
      ok("a reminder the Pi has already claimed keeps its status, is marked, and is not re-queued when released");
    }

    // ── 4. The reminder racing a go-live at the same instant, 12 rounds ──
    {
      let reminded = 0;
      let liveFirst = 0;
      for (let i = 0; i < 12; i++) {
        const c = await heldAndAsked(T0);
        const [rem, live] = await Promise.all([
          new Promise((r) => setTimeout(r, i % 5)).then(() => sendSetupReminder(c.orgId, T24)),
          new Promise((r) => setTimeout(r, (i * 3) % 7)).then(() =>
            goLiveClub(c.orgId, c.userId, T24, { learningEnabled: false, billingEnabled: false }),
          ),
        ]);
        assert.equal(live.outcome, "went-live", `round ${i}: went live`);
        const jobs = await reminders(c.orgId);
        if (rem.kind === "sent") {
          reminded++;
          assert.equal(jobs.length, 1);
          assert.equal(jobs[0].status, "failed", `round ${i}: queued just before the go-live, so the go-live cancelled it`);
          assert.equal(jobs[0].failReason, "cancelled: went-live");
        } else {
          liveFirst++;
          assert.equal(rem.kind, "not-due", `round ${i}: the go-live committed first, so the reminder was not due`);
          assert.equal(jobs.length, 0);
        }
        assert.equal(
          await db.platformJob.count({ where: { purpose: "setup-reminder", refId: `${c.orgId}:setup-reminder`, status: { in: ["queued", "claimed"] } } }),
          0,
          `round ${i}: no live club is left with a reminder waiting to go`,
        );
      }
      console.log(`    (the reminder was queued first in ${reminded} round(s), the go-live committed first in ${liveFirst})`);
      ok("the reminder racing a go-live (12 rounds): a live club is never left with a reminder waiting to go");
    }

    // ── 5. Each "not sent" condition ─────────────────────────────────────
    {
      // Removed from the group: not due, NOT settled; added back: sent.
      const c = await heldAndAsked(T0);
      await db.organisation.update({ where: { id: c.orgId }, data: { setupRemovedAt: new Date(T0.getTime() + HOUR) } });
      assert.deepEqual(await sendSetupReminder(c.orgId, T24), { kind: "not-due" });
      assert.deepEqual(await runSetupReminderSweep(T24).then(() => reminders(c.orgId)), []);
      assert.equal(await db.sentNotification.count({ where: { key: { startsWith: `org-${c.orgId}:setup-reminder:` } } }), 0);
      await db.organisation.update({ where: { id: c.orgId }, data: { setupRemovedAt: null } });
      assert.equal((await sendSetupReminder(c.orgId, T24)).kind, "sent");

      // The setup DM never went: cancelled or failed, or no job at all.
      const failed = await heldAndAsked(T0, { sent: false });
      await db.platformJob.updateMany({ where: { refId: setupAskRefId(failed.orgId) }, data: { status: "failed", failReason: "send threw" } });
      assert.deepEqual(await sendSetupReminder(failed.orgId, T24), { kind: "never", reason: "setup-dm-not-sent" });
      const none = await heldAndAsked(T0, { sent: false });
      await db.platformJob.deleteMany({ where: { refId: setupAskRefId(none.orgId) } });
      assert.deepEqual(await sendSetupReminder(none.orgId, T24), { kind: "never", reason: "setup-dm-not-sent" });
      for (const x of [failed, none]) {
        assert.equal((await reminders(x.orgId)).length, 0);
        assert.deepEqual(await sendSetupReminder(x.orgId, new Date(T24.getTime() + HOUR)), { kind: "already" }, "settled: not looked at again");
      }

      // Still queued (the Pi has been down): not before the message it reminds of.
      const waiting = await heldAndAsked(T0, { sent: false });
      assert.deepEqual(await sendSetupReminder(waiting.orgId, T24), { kind: "waiting-for-setup-dm" });
      assert.equal((await reminders(waiting.orgId)).length, 0);
      await db.platformJob.updateMany({ where: { refId: setupAskRefId(waiting.orgId) }, data: { status: "sent" } });
      assert.equal((await sendSetupReminder(waiting.orgId, new Date(T24.getTime() + HOUR))).kind, "sent");

      // Went live, or suspended: not due.
      const live = await heldAndAsked(T0);
      await goLiveClub(live.orgId, live.userId, new Date(T0.getTime() + HOUR), { learningEnabled: false, billingEnabled: false });
      assert.deepEqual(await sendSetupReminder(live.orgId, T24), { kind: "not-due" });
      const off = await heldAndAsked(T0);
      await decideClub(off.orgId, "suspend", "lib-owner", { now: new Date(T0.getTime() + HOUR), confirmName: off.name });
      assert.deepEqual(await sendSetupReminder(off.orgId, T24), { kind: "not-due" });
      for (const x of [live, off]) assert.equal((await reminders(x.orgId)).length, 0);
      ok("no reminder for a club that went live, was suspended, was removed from, or whose setup DM never went; one that is still to go is waited for");
    }

    // ── 6. Turkish ───────────────────────────────────────────────────────
    {
      const c = await heldAndAsked(T0, { lang: "tr" });
      await sendSetupReminder(c.orgId, T24);
      const text = (await reminders(c.orgId))[0].text ?? "";
      assert.match(text, /^Küçük bir hatırlatma: Lib Follow \d+ onaylandı, ama "Lib follow group \d+" grubunda hâlâ sessizim\. Hazır olduğunuzda \*BAŞLA\* yazın/);
      assert.match(text, /\nBir daha hatırlatmayacağım\.$/);
      ok("a Turkish club is reminded in Turkish, and asked for BAŞLA");
    }

    // ── 7. THE OWNER'S NOTE: eight runs at once, six rounds: exactly one ──
    for (let round = 0; round < 6; round++) {
      const c = await heldAndAsked(T0);
      const outcomes = await Promise.all(Array.from({ length: 8 }, () => noteStuckClub(c.orgId, T72)));
      assert.equal(outcomes.filter((o) => o.kind === "noted").length, 1, `round ${round}: exactly one run noted it (${outcomes.map((o) => o.kind).join(",")})`);
      const jobs = await jobsOf(c.orgId, "owner-setup-stuck");
      assert.equal(jobs.length, 1, "one owner DM");
      assert.equal(jobs[0].phone, E2E.APPROVER_PHONE);
      assert.equal(jobs[0].refId, `${c.orgId}:setup-stuck`);
      assert.equal(
        jobs[0].text,
        `${c.name} has been approved for 3 days and its organiser has not gone live. MatchTime is still silent in its group. You can take it live from the clubs page: https://matchtime.ai/admin/clubs`,
      );
      assert.deepEqual(jobs[0].sendAfter, ownerQuietHoursSendAfter(T72), "12:00 London: not quiet hours");
      assert.equal(await db.opsAlert.count({ where: { orgId: c.orgId, dedupeKey: "setup-stuck-72h" } }), 1, "one ops event");
      await runSetupStuckSweep(new Date(T72.getTime() + 30 * 24 * HOUR));
      assert.equal((await jobsOf(c.orgId, "owner-setup-stuck")).length, 1, "a month later: still one");
    }
    ok("the owner's note under eight concurrent runs (6 rounds): exactly one DM and one ops event, never a second");

    // ── 8. The owner's note: not early, quiet hours, removed, suspended ──
    {
      const c = await heldAndAsked(T0);
      assert.deepEqual(await noteStuckClub(c.orgId, new Date(T72.getTime() - 60_000)), { kind: "not-due" });
      assert.equal((await jobsOf(c.orgId, "owner-setup-stuck")).length, 0);

      const NIGHT = new Date("2026-07-14T22:30:00Z"); // 23:30 London
      const q = await heldAndAsked(NIGHT);
      await noteStuckClub(q.orgId, new Date(NIGHT.getTime() + 72 * HOUR));
      assert.deepEqual((await jobsOf(q.orgId, "owner-setup-stuck"))[0].sendAfter, new Date("2026-07-18T08:00:00Z"), "held until 09:00 London");

      const r = await heldAndAsked(T0);
      await db.organisation.update({ where: { id: r.orgId }, data: { setupRemovedAt: new Date(T0.getTime() + HOUR) } });
      assert.deepEqual(await noteStuckClub(r.orgId, T72), { kind: "removed" });
      await runSetupStuckSweep(T72);
      assert.equal((await jobsOf(r.orgId, "owner-setup-stuck")).length, 0, "removed: the owner is not messaged");
      const events = await db.opsAlert.findMany({ where: { orgId: r.orgId, kind: "club-setup" }, select: { dedupeKey: true, detail: true } });
      assert.equal(events.length, 1, "one ops event, however many sweeps");
      assert.equal(events[0].dedupeKey, "setup-stuck-72h-removed");
      assert.match(events[0].detail, /was removed from its group/);

      const s = await heldAndAsked(T0);
      await decideClub(s.orgId, "suspend", "lib-owner", { now: new Date(T0.getTime() + HOUR), confirmName: s.name });
      assert.deepEqual(await noteStuckClub(s.orgId, T72), { kind: "not-due" });
      assert.equal((await jobsOf(s.orgId, "owner-setup-stuck")).length, 0);
      assert.equal(await db.opsAlert.count({ where: { orgId: s.orgId, dedupeKey: { startsWith: "setup-stuck" } } }), 0);
      ok("the owner's note: not before 72 hours, held in his quiet hours, an ops event only for a removed club, nothing for a suspended one");
    }

    // ── 9. THE ADMIN GROUP COMMAND: eight runs at once: one setup DM, one command ──
    for (let round = 0; round < 4; round++) {
      const c = await pendingClub();
      await decideClub(c.orgId, "approve", "lib-owner", { now: T0, hold: true });
      const outcomes = await Promise.all(Array.from({ length: 8 }, () => sendSetupDm(c.orgId, T0, { learningEnabled: false })));
      assert.equal(outcomes.filter((o) => o.kind === "sent").length, 1, `round ${round}: exactly one run sent the setup DM`);
      const asks = await jobsOf(c.orgId, "setup-ask");
      const codes = await jobsOf(c.orgId, "setup-admin-code");
      assert.equal(asks.length, 1);
      assert.equal(codes.length, 1, "one admin group command");
      const org = await db.organisation.findUnique({ where: { id: c.orgId }, select: { adminGroupLinkCode: true, adminGroupLinkCodeExpiresAt: true } });
      assert.match(org?.adminGroupLinkCode ?? "", /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
      assert.equal(codes[0].text, `Match Time admin group ${org!.adminGroupLinkCode}`, "the code that was sent is the code that is stored");
      assert.deepEqual(org!.adminGroupLinkCodeExpiresAt, new Date(T0.getTime() + 7 * 24 * HOUR), "valid 7 days");
      assert.equal(codes[0].createdAt.getTime() - asks[0].createdAt.getTime(), 1, "ordered right after the setup DM");
      assert.deepEqual(codes[0].sendAfter, asks[0].sendAfter, "the same due time");
    }
    ok("the admin group command under eight concurrent runs (4 rounds): one per club, carrying the stored code, valid 7 days");

    // ── 10. The Pi is handed the setup DM before its command ─────────────
    {
      await drainQueue();
      const c = await pendingClub();
      await decideClub(c.orgId, "approve", "lib-owner", { now: T0, hold: true });
      await sendSetupDm(c.orgId, T0, { learningEnabled: false });
      const handed = (await claimDuePlatformJobs({ now: new Date(), limit: 50 })).filter((j) => j.kind === "dm" && j.phone === c.phone);
      assert.deepEqual(handed.map((j) => (j.kind === "dm" ? j.purpose : "")), ["setup-ask", "setup-admin-code"]);
      // Paced: the Pi sends the first and RELEASES the second; the next poll hands the command out.
      await recordPlatformJobOutcome(handed[0].id, { outcome: "sent", waMessageId: "wa-1" });
      await recordPlatformJobOutcome(handed[1].id, { outcome: "release" });
      const next = (await claimDuePlatformJobs({ now: new Date(), limit: 50 })).filter((j) => j.kind === "dm" && j.phone === c.phone);
      assert.deepEqual(next.map((j) => j.id), [handed[1].id]);
      ok("the Pi is handed the setup DM first and its admin group command second, and a paced release keeps that order");
    }

    // ── 11. THE WHOLE LINK PATH for a club that is SETTING UP ────────────
    {
      const c = await heldAndAsked(T0);
      const command = (await jobsOf(c.orgId, "setup-admin-code"))[0].text ?? "";
      const quiet = async (label: string) => {
        assert.equal(await db.botJob.count({ where: { orgId: c.orgId } }), 0, `${label}: nothing is queued for the club's own channel`);
        assert.ok((await loadSilentGroupIds()).includes(c.groupId), `${label}: the players' group is still silent`);
        const org = await db.organisation.findUnique({ where: { id: c.orgId }, select: { whatsappBotEnabled: true } });
        assert.equal(org?.whatsappBotEnabled, false, `${label}: the bot is still off`);
      };

      // (1) Adding MatchTime to the organisers' own group: a silent candidate.
      assert.equal(await detectAdminGroupCandidate({ addedByPhone: c.phone, participants: [{ phone: c.phone }], now: T0 }), true);

      // (2a) The command forwarded into the PLAYERS' group by mistake: no post there, a DM instead.
      const mistake = await handleAdminGroupLinkCommand({ groupId: c.groupId, text: command, senderPhone: c.phone, messageId: `${c.orgId}-m1`, now: T0 });
      assert.deepEqual(mistake, { outcome: "ignored", replyText: null, reason: "club-setting-up" });
      const told = await db.platformJob.findMany({ where: { purpose: "setup-reply", phone: c.phone }, select: { text: true, refId: true, sendAfter: true } });
      assert.equal(told.length, 1);
      assert.equal(told[0].text, "That is your players' group, so it can't be the admin group. Add me to a separate group for the admins and send the message there.");
      assert.equal(told[0].sendAfter, null);
      // The Pi forwards the same message again: still one DM.
      await handleAdminGroupLinkCommand({ groupId: c.groupId, text: command, senderPhone: c.phone, messageId: `${c.orgId}-m1`, now: T0 });
      assert.equal(await db.platformJob.count({ where: { purpose: "setup-reply", phone: c.phone } }), 1);
      // The code was not spent by the mistake.
      assert.ok((await db.organisation.findUnique({ where: { id: c.orgId }, select: { adminGroupLinkCode: true } }))?.adminGroupLinkCode);
      await quiet("the command in the players' group");

      // (2b) The command in the SEPARATE group, six days later: linked, confirmed THERE.
      const day6 = new Date(T0.getTime() + 6 * 24 * HOUR);
      const linked = await handleAdminGroupLinkCommand({ groupId: c.hq, text: command, senderPhone: c.phone, groupSubject: "Lib HQ", messageId: `${c.orgId}-m2`, now: day6 });
      assert.deepEqual(linked, {
        outcome: "linked",
        replyText: `✅ Linked as the admin group for *${c.name}*.`,
        adminGroup: { groupId: c.hq, orgId: c.orgId },
      });
      const org = await db.organisation.findUnique({
        where: { id: c.orgId },
        select: { adminGroupId: true, adminChannelMode: true, adminGroupLinkCode: true, approvalStatus: true, liveAt: true },
      });
      assert.deepEqual(org, { adminGroupId: c.hq, adminChannelMode: "admin-group", adminGroupLinkCode: null, approvalStatus: "approved", liveAt: null });
      await quiet("the link from a separate group");
      // What the Pi is told: the HQ group is an admin group, not silent; the players' group is silent.
      assert.ok((await loadAdminGroups()).some((a) => a.groupId === c.hq && a.orgId === c.orgId));
      assert.ok(!(await loadSilentGroupIds()).includes(c.hq));

      // Before go-live a message in the admin group is read by nobody and answered by nobody.
      const chat = await handleAdminGroupMessage({ groupId: c.hq, messageId: `${c.orgId}-m3`, text: "When do we start?", senderPhone: c.phone, now: day6 });
      assert.deepEqual(chat, { handled: false, ignored: "no-open-pick", orgId: c.orgId, replyText: null });
      await quiet("a message in the admin group before go-live");

      // (3) After go-live the club still routes admin messages to that group.
      const live = await goLiveClub(c.orgId, c.userId, new Date(day6.getTime() + HOUR), { learningEnabled: false, billingEnabled: false });
      assert.equal(live.outcome, "went-live");
      const after = await db.organisation.findUnique({ where: { id: c.orgId }, select: { adminGroupId: true, adminChannelMode: true, whatsappBotEnabled: true } });
      assert.deepEqual(after, { adminGroupId: c.hq, adminChannelMode: "admin-group", whatsappBotEnabled: true });
      const posts = await db.botJob.findMany({ where: { orgId: c.orgId }, select: { kind: true } });
      assert.deepEqual(posts.map((p) => p.kind), ["group"], "go-live queued the hello for the players' group and nothing else");
      ok("a setting-up club links its admin group from a separate group with the DM's command; the same command in the players' group posts nothing there and is answered by DM; the link survives go-live");

      // An eighth day: the code has expired.
      const d = await heldAndAsked(T0);
      const late = (await jobsOf(d.orgId, "setup-admin-code"))[0].text ?? "";
      const expired = await linkAdminGroup({ groupId: d.hq, text: late, senderPhone: d.phone, now: new Date(T0.getTime() + 7 * 24 * HOUR + 60_000) });
      assert.equal(expired.outcome, "bad-code");
      ok("the DM's code stops working after 7 days");
    }

    // ── 12. A club that already has an admin group: no block, no command ──
    {
      const c = await pendingClub();
      await db.organisation.update({ where: { id: c.orgId }, data: { adminGroupId: c.hq, adminChannelMode: "admin-group" } });
      await decideClub(c.orgId, "approve", "lib-owner", { now: T0, hold: true });
      await sendSetupDm(c.orgId, T0, { learningEnabled: false });
      const asks = await jobsOf(c.orgId, "setup-ask");
      assert.equal(asks.length, 1);
      assert.ok(!(asks[0].text ?? "").includes("Admin group (optional)"));
      assert.equal((await jobsOf(c.orgId, "setup-admin-code")).length, 0);
      assert.equal((await db.organisation.findUnique({ where: { id: c.orgId }, select: { adminGroupLinkCode: true } }))?.adminGroupLinkCode, null);
      ok("a club that already has an admin group gets neither the block nor the second message, and no code is minted");
    }

    // ── 13. The command is cancelled WITH the setup DM ───────────────────
    {
      const NIGHT = new Date("2026-07-14T22:30:00Z"); // 23:30 London
      const c = await heldAndAsked(NIGHT, { sent: false });
      const suspended = await decideClub(c.orgId, "suspend", "lib-owner", { now: new Date(NIGHT.getTime() + 40 * 60_000), confirmName: c.name });
      assert.ok(suspended.ok);
      for (const purpose of ["setup-ask", "setup-admin-code"]) {
        const j = (await jobsOf(c.orgId, purpose))[0];
        assert.equal(j.status, "failed", `${purpose} is cancelled`);
        assert.equal(j.failReason, "cancelled: suspended");
      }
      ok("the admin group command queued for 09:00 is cancelled together with the setup DM");
    }

    // ── 14. FLAG OFF: an approval that does not hold the club ────────────
    {
      const c = await pendingClub();
      const approved = await decideClub(c.orgId, "approve", "lib-owner", { now: T0, hold: false });
      assert.ok(approved.ok && !approved.held, "today's approval: not held");
      await runSetupAfterApproval(c.orgId, { now: T0, learningEnabled: false });
      const far = new Date(T0.getTime() + 100 * HOUR);
      await runSetupReminderSweep(far);
      await runSetupStuckSweep(far);
      assert.deepEqual(await sendSetupReminder(c.orgId, far), { kind: "not-due" });
      assert.deepEqual(await noteStuckClub(c.orgId, far), { kind: "not-due" });
      for (const purpose of ["setup-ask", "setup-admin-code", "setup-reminder", "owner-setup-stuck"]) {
        assert.equal((await jobsOf(c.orgId, purpose)).length, 0, `no ${purpose} job for a club that was never held`);
      }
      assert.equal(await db.opsAlert.count({ where: { orgId: c.orgId, dedupeKey: { startsWith: "setup-stuck" } } }), 0);
      const org = await db.organisation.findUnique({ where: { id: c.orgId }, select: { adminGroupLinkCode: true } });
      assert.equal(org?.adminGroupLinkCode, null, "no code is minted for it");
      // The Settings "Link admin group" button: 48 hours, as today.
      const now = new Date();
      const button = await createAdminGroupLinkCode(c.orgId, now);
      assert.deepEqual(button.expiresAt, new Date(now.getTime() + 48 * HOUR));
      const stored = await db.organisation.findUnique({ where: { id: c.orgId }, select: { adminGroupLinkCodeExpiresAt: true } });
      assert.deepEqual(stored?.adminGroupLinkCodeExpiresAt, button.expiresAt);
      ok("with the hold off: no reminder, no owner's note, no admin group command, and the Settings button's code still lasts 48 hours");
    }

    // (Removal and re-add go through the real bot-removed and bot-added
    //  routes: e2e/api/setup-followups.spec.ts, section D.)

    // ── 16. THE 48-HOUR AUTO-LEAVE AND THE CODE'S 7 DAYS AGREE ────────────
    {
      const { queueUnsolicitedAutoLeaves } = await import("@/lib/group-add");
      const { recordAdminGroupCandidate, adminGroupLinkCodeForSettings } = await import("@/lib/admin-group-link");
      const leaveOf = (groupId: string) => db.platformJob.count({ where: { kind: "leave-group", groupId } });
      // Nothing else in the test database may be due for a leave here.
      await db.unsolicitedGroup.updateMany({ where: { leftAt: null }, data: { leftAt: new Date() } });

      // (a) The setup DM's 7-day code; the organiser adds MatchTime to the organisers' group.
      const c = await heldAndAsked(T0);
      const command = (await jobsOf(c.orgId, "setup-admin-code"))[0].text ?? "";
      await recordAdminGroupCandidate({ groupId: c.hq, subject: "Lib HQ", memberCount: 2, addedByPhone: c.phone, now: T0 });
      for (const hours of [49, 72, 6 * 24]) {
        assert.deepEqual(await queueUnsolicitedAutoLeaves(new Date(T0.getTime() + hours * HOUR)), { queued: 0, markedLeft: 0 }, `${hours} hours after the add: not left`);
      }
      assert.equal(await leaveOf(c.hq), 0);
      // Day three: the command is forwarded there, and it links.
      const linked = await handleAdminGroupLinkCommand({ groupId: c.hq, text: command, senderPhone: c.phone, messageId: `${c.orgId}-al1`, now: new Date(T0.getTime() + 72 * HOUR) });
      assert.equal(linked.outcome, "linked");
      assert.deepEqual(await queueUnsolicitedAutoLeaves(new Date(T0.getTime() + 30 * 24 * HOUR)), { queued: 0, markedLeft: 0 }, "a linked admin group is never left by the sweep");

      // (b) The same, but the command never comes: left when the code expires.
      const d = await heldAndAsked(T0);
      await recordAdminGroupCandidate({ groupId: d.hq, subject: "Lib HQ 2", memberCount: 2, addedByPhone: d.phone, now: T0 });
      assert.deepEqual(await queueUnsolicitedAutoLeaves(new Date(T0.getTime() + 7 * 24 * HOUR - 60_000)), { queued: 0, markedLeft: 0 });
      assert.deepEqual(await queueUnsolicitedAutoLeaves(new Date(T0.getTime() + 7 * 24 * HOUR + 60_000)), { queued: 1, markedLeft: 0 });
      assert.equal(await leaveOf(d.hq), 1);
      await db.unsolicitedGroup.updateMany({ where: { groupId: d.hq }, data: { leftAt: new Date() } });
      ok("a candidate admin group is not left while its adder's club has an open code: day three links; with no command it is left when the 7-day code expires");

      // (c) THE SETTINGS BUTTON, as today: a 48-hour code, then the add. Left 48 hours after the add.
      const e = await pendingClub();
      await decideClub(e.orgId, "approve", "lib-owner", { now: T0, hold: false });
      const pressed = new Date(T0.getTime() + HOUR);
      const button = await adminGroupLinkCodeForSettings(e.orgId, { now: pressed });
      assert.deepEqual(button.expiresAt, new Date(pressed.getTime() + 48 * HOUR));
      const added = new Date(pressed.getTime() + 10 * 60_000);
      await recordAdminGroupCandidate({ groupId: e.hq, subject: "Lib HQ 3", memberCount: 2, addedByPhone: e.phone, now: added });
      assert.deepEqual(await queueUnsolicitedAutoLeaves(new Date(added.getTime() + 48 * HOUR - 60_000)), { queued: 0, markedLeft: 0 }, "not before 48 hours, as today");
      assert.deepEqual(await queueUnsolicitedAutoLeaves(new Date(added.getTime() + 48 * HOUR)), { queued: 1, markedLeft: 0 }, "at 48 hours after the add, as today");
      assert.equal(await leaveOf(e.hq), 1);
      await db.unsolicitedGroup.updateMany({ where: { groupId: e.hq }, data: { leftAt: new Date() } });

      // A stranger's group, and a candidate whose club has no code: 48 hours.
      const f = await pendingClub();
      await decideClub(f.orgId, "approve", "lib-owner", { now: T0, hold: false });
      await recordAdminGroupCandidate({ groupId: f.hq, subject: "Lib HQ 4", memberCount: 2, addedByPhone: f.phone, now: T0 });
      await db.unsolicitedGroup.create({ data: { groupId: "120363949900099999@g.us", subject: "Strangers", addedByPhone: "447700900977", addedAt: T0 } });
      assert.deepEqual(await queueUnsolicitedAutoLeaves(new Date(T0.getTime() + 48 * HOUR)), { queued: 2, markedLeft: 0 });
      ok("the Settings button's 48-hour code, a candidate with no code and a stranger's group are all left 48 hours after the add, exactly as before");

      // ── 17. THE SETTINGS BUTTON SHOWS THE DM'S CODE ────────────────────
      const g = await heldAndAsked(T0);
      const dmCode = (await db.organisation.findUnique({ where: { id: g.orgId }, select: { adminGroupLinkCode: true } }))!.adminGroupLinkCode!;
      const day2 = new Date(T0.getTime() + 48 * HOUR);
      const shown = await adminGroupLinkCodeForSettings(g.orgId, { now: day2 });
      assert.deepEqual(shown, { code: dmCode, expiresAt: new Date(T0.getTime() + 7 * 24 * HOUR), reused: true }, "the same code, with its real expiry");
      // The command in the organiser's DM still works after the button was pressed.
      const dmCommand = (await jobsOf(g.orgId, "setup-admin-code"))[0].text ?? "";
      const still = await linkAdminGroup({ groupId: g.hq, text: dmCommand, senderPhone: g.phone, now: day2 });
      assert.equal(still.outcome, "linked", "pressing Link admin group did not kill the DM's command");
      // "New code" replaces it, on purpose: the old command then gets the 'not valid' reply.
      const h = await heldAndAsked(T0);
      const oldCommand = (await jobsOf(h.orgId, "setup-admin-code"))[0].text ?? "";
      const fresh = await adminGroupLinkCodeForSettings(h.orgId, { now: day2, fresh: true });
      assert.equal(fresh.reused, false);
      assert.deepEqual(fresh.expiresAt, new Date(day2.getTime() + 48 * HOUR));
      assert.equal((await linkAdminGroup({ groupId: h.hq, text: oldCommand, senderPhone: h.phone, now: day2 })).outcome, "bad-code");
      assert.equal((await linkAdminGroup({ groupId: h.hq, text: `Match Time admin group ${fresh.code}`, senderPhone: h.phone, now: day2 })).outcome, "linked");
      ok("the Settings button shows the code MatchTime sent by DM (the DM's command keeps working); only 'New code' replaces it");
    }

    console.log(`OK: ${n} setup follow-up checks`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
