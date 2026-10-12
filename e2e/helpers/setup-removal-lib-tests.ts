/**
 * MATCHTIME REMOVED FROM THE GROUP OF A CLUB THAT IS STILL SETTING UP, AND
 * ADDED BACK (go-live removal slice, 2026-10-12; src/lib/club-setup-removal.ts)
 * against the REAL embedded Postgres, under tsx (the lib imports the Prisma
 * 7 generated client, which Playwright's transpiler cannot load). Invoked
 * by e2e/api/setup-go-live.spec.ts via execFile; exits non-zero with a
 * readable message on any failure.
 *
 * Every club here is put into "setting up" by the REAL approval
 * (`decideClub` with the hold on), and its setup DM by the real
 * `runSetupAfterApproval`, so the three states the DM can be in at the
 * removal are the real ones: never sent, queued for 09:00, already sent
 * (and claimed by the Pi). The clock is passed in.
 *
 * The line that matters most: while a club is removed NO door takes it
 * live, so no free period starts for a group MatchTime is not in.
 *
 * No model is called (the reading is off here) and nothing reaches Stripe.
 */
import assert from "node:assert/strict";
import { assertSafeTestDbUrl, E2E, E2E_DB_URL } from "./env";

const P = "e2e-rm-lib";

async function main() {
  const url = process.env.MT_E2E_DATABASE_URL ?? E2E_DB_URL;
  assertSafeTestDbUrl(url);
  process.env.DATABASE_URL = url;
  process.env.NEXTAUTH_URL = "https://matchtime.ai";
  process.env.SELF_JOIN_APPROVER_PHONES = E2E.APPROVER_PHONE;
  process.env.BILLING_ENABLED = "1";

  const { db } = await import("@/lib/db");
  const { decideClub } = await import("@/lib/club-approval");
  const { runSetupAfterApproval, sendSetupDm, setupAskRefId } = await import("@/lib/club-setup-dm");
  const { claimDuePlatformJobs } = await import("@/lib/platform-jobs");
  const { goLiveClub, liveByOwner, liveByUser } = await import("@/lib/club-setup");
  const { handleSetupRemoval, handleSetupReAdd, setupRemovedRefId } = await import("@/lib/club-setup-removal");
  const { messageHoursSendAfter } = await import("@/lib/message-hours");

  let n = 0;
  const ok = (label: string) => {
    n++;
    console.log(`  ok ${n}: ${label}`);
  };

  const history = Array.from({ length: 30 }, (_, i) => ({ author: `Player ${i % 6}`, text: `same lot as last week ${i}` }));

  /** A club approved through the real approval, with the hold on. */
  async function heldClub(i: number, approvedAt: Date) {
    const orgId = `${P}-org-${i}`;
    const groupId = `1203639400000000${String(i).padStart(2, "0")}@g.us`;
    const phone = `4477009028${String(i).padStart(2, "0")}`;
    const userId = `${P}-u-${i}`;
    await db.user.create({ data: { id: userId, name: "Remy Removed", email: `${userId}@e2e-test.invalid`, phoneNumber: `+${phone}` } });
    await db.$executeRawUnsafe(
      `INSERT INTO "Organisation" (id,name,slug,"inviteCode","approvalStatus",language,"createdAt","updatedAt")
       VALUES ($1,$2,$1,$3,'pending','en',now(),now())`,
      orgId,
      `Removed Club ${i}`,
      `${orgId}-invite`,
    );
    await db.membership.create({ data: { userId, orgId, role: "OWNER" } });
    await db.clubConnect.create({
      data: {
        id: `${P}-cc-${i}`,
        orgId,
        userId,
        phone,
        code: `R${String(i).padStart(3, "0")}`,
        status: "group_linked",
        expiresAt: new Date(Date.now() + 3600_000),
        groupId,
        groupSubject: `Removed group ${i}`,
        memberCount: 1,
        participants: [{ phone, pushname: "Remy" }],
        linkedAt: new Date(approvedAt.getTime() - 3600_000),
        capturedHistory: history as object,
        capturedDescription: "Tuesdays 8pm",
      },
    });
    const approved = await decideClub(orgId, "approve", "lib-owner", { now: approvedAt, hold: true });
    assert.ok(approved.ok && approved.held, `club ${i}: the approval held the club`);
    return { orgId, groupId, phone, userId };
  }
  type Club = Awaited<ReturnType<typeof heldClub>>;

  const row = (c: Club) =>
    db.organisation.findUnique({
      where: { id: c.orgId },
      select: { approvalStatus: true, setupStage: true, whatsappBotEnabled: true, setupRemovedAt: true, setupAskedAt: true, liveAt: true, billingStatus: true } as never,
    }) as unknown as Promise<{
      approvalStatus: string;
      setupStage: string;
      whatsappBotEnabled: boolean;
      setupRemovedAt: Date | null;
      setupAskedAt: Date | null;
      liveAt: Date | null;
      billingStatus: string;
    }>;
  const setupJobs = (c: Club) =>
    db.platformJob.findMany({ where: { purpose: "setup-ask", refId: setupAskRefId(c.orgId) }, orderBy: { createdAt: "asc" }, select: { id: true, status: true, sendAfter: true, failReason: true } });
  const removalJobs = (c: Club) =>
    db.platformJob.findMany({ where: { purpose: "setup-removed", refId: setupRemovedRefId(c.orgId) }, orderBy: { createdAt: "asc" }, select: { id: true, status: true, sendAfter: true, failReason: true, text: true, phone: true } });
  const alerts = (c: Club) => db.opsAlert.count({ where: { orgId: c.orgId, kind: "club-setup", dedupeKey: { startsWith: "setup-removed:" } } });
  const chat = (c: Club) =>
    db.clubConnect.findFirst({ where: { orgId: c.orgId }, select: { capturedHistory: true, capturedDescription: true, status: true, botRemovedAt: true } });
  const billingRows = (c: Club) => db.clubBilling.count({ where: { orgId: c.orgId } });
  const stillHeld = async (c: Club, label: string) => {
    const r = await row(c);
    assert.deepEqual([r.approvalStatus, r.setupStage, r.whatsappBotEnabled, r.liveAt], ["approved", "setting-up", false, null], label);
    assert.equal(await db.botJob.count({ where: { orgId: c.orgId } }), 0, `${label}: nothing for the group`);
    assert.equal(await billingRows(c), 0, `${label}: no free period`);
    assert.equal(r.billingStatus, "exempt", label);
  };

  const cleanup = async () => {
    await db.platformJob.deleteMany({ where: { OR: [{ refId: { startsWith: P } }, { phone: { startsWith: "4477009028" } }] } });
    await db.opsAlert.deleteMany({ where: { orgId: { startsWith: P } } });
    await db.billingEvent.deleteMany({ where: { orgId: { startsWith: P } } });
    await db.sentNotification.deleteMany({ where: { key: { contains: P } } });
    await db.botJob.deleteMany({ where: { orgId: { startsWith: P } } });
    await db.organisation.deleteMany({ where: { id: { startsWith: P } } });
    await db.user.deleteMany({ where: { id: { startsWith: P } } });
  };

  // Midday London, 23:30 London, 00:10 and 00:20 the next day, and 09:05.
  const NOON = new Date("2026-07-14T11:00:00Z");
  const AT_2330 = new Date("2026-07-14T22:30:00Z");
  const AT_0010 = new Date("2026-07-14T23:10:00Z");
  const AT_0020 = new Date("2026-07-14T23:20:00Z");
  const AT_0905 = new Date("2026-07-15T08:05:00Z");
  const STRANGER = "447700902899";

  try {
    await cleanup();
    await db.user.create({ data: { id: `${P}-stranger`, name: "Sam Stranger", email: `${P}-stranger@e2e-test.invalid`, phoneNumber: `+${STRANGER}` } });

    // ── A. The setup DM had NEVER been sent ───────────────────────────
    {
      const c = await heldClub(1, new Date(NOON.getTime() - 60_000));
      assert.ok((await chat(c))?.capturedHistory, "the chat is kept for the reading until the removal");

      const r = await handleSetupRemoval(c.groupId, { now: NOON });
      assert.deepEqual(r, { kind: "removed", orgId: c.orgId, setupDm: "none-waiting", organiserDm: "queued" });
      assert.equal((await row(c)).setupRemovedAt?.getTime(), NOON.getTime());
      await stillHeld(c, "A removed");
      ok("removed: the removal is stamped; the club stays approved and setting up; nothing for the group, no billing");

      const dm = await removalJobs(c);
      assert.equal(dm.length, 1);
      assert.equal(dm[0].status, "queued");
      assert.equal(dm[0].sendAfter, null, "daytime: sent at once");
      assert.equal(dm[0].phone, c.phone);
      assert.equal(
        dm[0].text,
        `I was removed from "Removed group 1" before Removed Club 1 went live, so nothing has started there. ` +
          `Add me back to the group, then reply *GO* here or press *Go live* on your settings page:\nhttps://matchtime.ai/admin/settings`,
      );
      assert.equal(await alerts(c), 1);
      ok("the organiser gets ONE DM on the platform channel, and the platform owner one event");

      const kept = await chat(c);
      assert.deepEqual([kept?.capturedHistory, kept?.capturedDescription], [null, null]);
      assert.deepEqual([kept?.status, kept?.botRemovedAt], ["closed", null], "the approved club's connect request is not reopened");
      ok("the chat and the description captured at the add are deleted together; the club does not go back to draft");

      assert.deepEqual(await handleSetupRemoval(c.groupId, { now: new Date(NOON.getTime() + 5000) }), { kind: "already-removed", orgId: c.orgId });
      assert.equal((await removalJobs(c)).length, 1);
      assert.equal(await alerts(c), 1);
      assert.equal((await row(c)).setupRemovedAt?.getTime(), NOON.getTime());
      ok("the same removal reported again: nothing more is stamped, said or recorded");

      assert.deepEqual((await sendSetupDm(c.orgId, NOON, { learningEnabled: false })).kind, "not-due");
      assert.equal((await setupJobs(c)).length, 0);
      ok("while removed the setup DM ('I'm in your group, reply GO') is not due");

      // Every door.
      const later = new Date(NOON.getTime() + 3 * 3600_000);
      assert.equal((await goLiveClub(c.orgId, liveByUser(c.userId), later)).outcome, "removed-from-group");
      assert.equal((await goLiveClub(c.orgId, liveByOwner("the-matchtime-owner"), later)).outcome, "removed-from-group");
      await stillHeld(c, "A after two refused go-lives");
      ok("GO by the organiser AND the platform owner's Go live now are both refused: no hello, bot off, NO FREE PERIOD started");

      // Added back, but not so as to count.
      assert.deepEqual(await handleSetupReAdd({ groupId: c.groupId, addedByPhone: STRANGER, now: later }), { kind: "not-a-member", orgId: c.orgId });
      assert.deepEqual(await handleSetupReAdd({ groupId: c.groupId, now: later }), { kind: "not-a-member", orgId: c.orgId });
      assert.deepEqual(await handleSetupReAdd({ groupId: "120363940000000099@g.us", addedByPhone: c.phone, now: later }), { kind: "not-removed" });
      assert.ok((await row(c)).setupRemovedAt, "still removed");
      assert.equal((await goLiveClub(c.orgId, liveByUser(c.userId), later)).outcome, "removed-from-group");
      ok("added back by a stranger, by nobody named, or to a different group: still removed, GO still refused");

      // Added back by a member, to the same group.
      assert.deepEqual(await handleSetupReAdd({ groupId: c.groupId, addedByPhone: `+${c.phone}`, now: later }), { kind: "cleared", orgId: c.orgId });
      assert.equal((await row(c)).setupRemovedAt, null);
      await stillHeld(c, "A re-added");
      assert.deepEqual(await handleSetupReAdd({ groupId: c.groupId, addedByPhone: c.phone, now: later }), { kind: "not-removed" });
      ok("added back by a member of the club to the same group: the removal is cleared, nothing is posted, a second add does nothing");

      // The setup DM that never went is due again, once.
      assert.equal((await sendSetupDm(c.orgId, later, { learningEnabled: false })).kind, "sent");
      assert.equal((await sendSetupDm(c.orgId, later, { learningEnabled: false })).kind, "not-due");
      assert.equal((await setupJobs(c)).length, 1);
      ok("never sent: after the re-add the setup DM goes, once");

      // And GO works, starting the free period at THAT go-live.
      const goAt = new Date(later.getTime() + 3600_000);
      const live = await goLiveClub(c.orgId, liveByUser(c.userId), goAt);
      assert.equal(live.outcome, "went-live");
      if (live.outcome !== "went-live") throw new Error("unreachable");
      assert.equal(live.freePeriodStarted, true);
      assert.match(live.freePeriodNote ?? "", /^Your first two months are free\.\n\n💷 \*Club fee tip:\* /);
      const billing = await db.clubBilling.findUnique({ where: { orgId: c.orgId }, select: { trialStartedAt: true } });
      assert.equal(billing?.trialStartedAt.getTime(), goAt.getTime());
      assert.equal((await row(c)).billingStatus, "trial");
      ok("GO then goes live; the free period starts at that go-live, and the result carries the free period sentence and the club fee tip");
    }

    // ── B. The setup DM was QUEUED for 09:00 ──────────────────────────
    {
      const c = await heldClub(2, AT_2330);
      await runSetupAfterApproval(c.orgId, { now: AT_2330, learningEnabled: false });
      const queued = await setupJobs(c);
      assert.deepEqual([queued.length, queued[0]?.status], [1, "queued"]);
      assert.deepEqual(queued[0].sendAfter, messageHoursSendAfter(AT_2330));
      assert.ok((await row(c)).setupAskedAt, "asked");

      const r = await handleSetupRemoval(c.groupId, { now: AT_0010 });
      assert.deepEqual(r, { kind: "removed", orgId: c.orgId, setupDm: "cancelled-will-resend", organiserDm: "queued" });
      const cancelled = await setupJobs(c);
      assert.deepEqual([cancelled[0].status, cancelled[0].failReason], ["failed", "cancelled: removed"]);
      assert.equal((await row(c)).setupAskedAt, null, "never asked again: it was told nothing");
      const removal = await removalJobs(c);
      assert.deepEqual(removal[0].sendAfter, messageHoursSendAfter(AT_0010), "the removal DM waits for 09:00 London");
      ok("queued for 09:00: the removal cancels the setup DM, and the removal DM itself waits for the daytime");

      assert.deepEqual(await handleSetupReAdd({ groupId: c.groupId, addedByPhone: c.phone, now: AT_0020 }), { kind: "cleared", orgId: c.orgId });
      const removalAfter = await removalJobs(c);
      assert.deepEqual([removalAfter[0].status, removalAfter[0].failReason], ["failed", "cancelled: re-added"]);
      // The sweep's next run: a fresh setup DM, again held for 09:00.
      assert.equal((await sendSetupDm(c.orgId, new Date(AT_0020.getTime() + 60_000), { learningEnabled: false })).kind, "sent");
      const handed = await claimDuePlatformJobs({ now: AT_0905, limit: 50 });
      const mine = handed.filter((j) => j.kind === "dm" && j.phone === c.phone);
      // Go-live slice S7: a setup DM is followed by its admin group command,
      // so the fresh pair is what arrives: ONE setup DM and ONE command,
      // and nothing of the cancelled pair.
      assert.deepEqual(
        mine.map((j) => (j as { purpose?: string }).purpose),
        ["setup-ask", "setup-admin-code"],
        "exactly one setup DM, then its admin group command, reach the organiser in the morning",
      );
      assert.notEqual(mine[0].id, queued[0].id, "the fresh one, not the cancelled one");
      const commands = await db.platformJob.findMany({
        where: { purpose: "setup-admin-code", refId: `${c.orgId}:setup-admin-code` },
        orderBy: { createdAt: "asc" },
        select: { id: true, status: true, failReason: true },
      });
      assert.deepEqual(commands.map((j) => [j.status, j.failReason]), [["failed", "cancelled: removed"], ["claimed", null]], "the first command was cancelled with its setup DM");
      ok("added back in the night: 'I was removed' is taken back, and at 09:00 the organiser gets ONE setup DM (the fresh one), not two and not none");
    }

    // ── C. The setup DM had ALREADY BEEN SENT ─────────────────────────
    {
      const c = await heldClub(3, new Date(NOON.getTime() - 60_000));
      await runSetupAfterApproval(c.orgId, { now: NOON, learningEnabled: false });
      const [job] = await setupJobs(c);
      await db.platformJob.update({ where: { id: job.id }, data: { status: "sent", sentAt: NOON } });
      const askedAt = (await row(c)).setupAskedAt;
      assert.ok(askedAt);

      const at = new Date(NOON.getTime() + 3600_000);
      assert.deepEqual(await handleSetupRemoval(c.groupId, { now: at }), { kind: "removed", orgId: c.orgId, setupDm: "none-waiting", organiserDm: "queued" });
      assert.equal((await setupJobs(c))[0].status, "sent");
      assert.equal((await row(c)).setupAskedAt?.getTime(), askedAt!.getTime(), "the stamp is kept");
      assert.deepEqual(await handleSetupReAdd({ groupId: c.groupId, addedByPhone: c.phone, now: new Date(at.getTime() + 60_000) }), { kind: "cleared", orgId: c.orgId });
      assert.equal((await sendSetupDm(c.orgId, new Date(at.getTime() + 120_000), { learningEnabled: false })).kind, "not-due");
      assert.equal((await setupJobs(c)).length, 1);
      ok("already sent: left alone, its stamp kept, and after the re-add it is NOT sent a second time");
      assert.equal((await goLiveClub(c.orgId, liveByUser(c.userId), new Date(at.getTime() + 180_000))).outcome, "went-live");
      ok("and its GO works once MatchTime is back");
    }

    // ── D. The Pi had already CLAIMED the setup DM ─────────────────────
    {
      const c = await heldClub(4, new Date(NOON.getTime() - 60_000));
      await runSetupAfterApproval(c.orgId, { now: NOON, learningEnabled: false });
      const [job] = await setupJobs(c);
      await db.platformJob.update({ where: { id: job.id }, data: { status: "claimed", claimedAt: NOON } });
      const r = await handleSetupRemoval(c.groupId, { now: new Date(NOON.getTime() + 1000) });
      assert.deepEqual(r, { kind: "removed", orgId: c.orgId, setupDm: "left-with-the-pi", organiserDm: "queued" });
      assert.ok((await row(c)).setupAskedAt, "it may be on its way: the stamp is kept, so it is never sent twice");
      ok("claimed by the Pi at that instant: left alone (it may be on its way), never queued a second time");
    }

    // ── E. Clubs that are NOT setting up are never touched ─────────────
    {
      const live = await heldClub(5, new Date(NOON.getTime() - 60_000));
      assert.equal((await goLiveClub(live.orgId, liveByUser(live.userId), NOON)).outcome, "went-live");
      const before = JSON.stringify(await row(live));
      assert.deepEqual(await handleSetupRemoval(live.groupId, { now: NOON }), { kind: "not-setting-up" });
      assert.deepEqual(await handleSetupReAdd({ groupId: live.groupId, addedByPhone: live.phone, now: NOON }), { kind: "not-removed" });
      assert.equal(JSON.stringify(await row(live)), before);
      assert.equal((await removalJobs(live)).length, 0);
      assert.deepEqual(await handleSetupRemoval("120363940000000098@g.us", { now: NOON }), { kind: "not-setting-up" });
      // A club that is setting up and was NOT removed: a re-add changes nothing.
      const held = await heldClub(6, new Date(NOON.getTime() - 60_000));
      assert.deepEqual(await handleSetupReAdd({ groupId: held.groupId, addedByPhone: held.phone, now: NOON }), { kind: "not-removed" });
      ok("a live club, an unknown group, and a setting-up club that was never removed: nothing is written or said");
    }

    // ── F. Found back in its own group by the reconnect sweep ──────────
    {
      const c = await heldClub(7, new Date(NOON.getTime() - 60_000));
      // Not removed: a sweep report is nothing.
      assert.deepEqual(await handleSetupReAdd({ groupId: c.groupId, discovered: true, now: NOON }), { kind: "not-removed" });
      await handleSetupRemoval(c.groupId, { now: NOON });
      // Some other group the sweep found: nothing to do with this club.
      assert.deepEqual(await handleSetupReAdd({ groupId: "120363940000000097@g.us", discovered: true, now: NOON }), { kind: "not-removed" });
      assert.ok((await row(c)).setupRemovedAt, "still removed");
      // Its own group: MatchTime is demonstrably back, no adder needed.
      assert.deepEqual(await handleSetupReAdd({ groupId: c.groupId, discovered: true, now: NOON }), { kind: "cleared", orgId: c.orgId });
      assert.equal((await row(c)).setupRemovedAt, null);
      await stillHeld(c, "F swept");
      assert.equal((await goLiveClub(c.orgId, liveByUser(c.userId), new Date(NOON.getTime() + 60_000))).outcome, "went-live");
      ok("the reconnect sweep finding MatchTime in the removed club's own group clears the removal (no adder); any other group does not");
    }

    console.log(`OK: ${n} setup-removal checks against Postgres`);
  } finally {
    await cleanup().catch((err) => console.error("cleanup failed:", err));
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
