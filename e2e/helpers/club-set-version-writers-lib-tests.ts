/**
 * THE CLUB SET VERSION, DRIVEN BY THE PRODUCTION WRITERS (PR #250 review).
 *
 * e2e/api/club-set-version.spec.ts shows the stamp reads the right
 * columns, mostly by writing them with SQL. This shows the other half:
 * that the REAL writers, the single functions every door goes through,
 * write those columns, so the stamp moves when the product does the thing:
 *
 *   decideClub (approve, hold on)   the owner's approval, by the page or
 *                                   by DM: the club becomes setting up
 *   handleSetupRemoval / ReAdd      MatchTime removed from the group of a
 *                                   setting-up club, and added back
 *   goLiveClub                      GO, the Go live button, Go live now
 *   setBillingState                 the free period ends, the grace week
 *                                   ends (PAUSED), a card is added (resumed)
 *   decideClub (approve, hold off)  the old flow: served at approval
 *   decideClub (suspend)            the owner turns a club off
 *
 * Against the real embedded Postgres, under tsx (the libs import the
 * Prisma client, which Playwright's transpiler cannot load). Invoked by
 * the spec via execFile; exits non-zero with a readable message on any
 * failure. No model is called: the setup reading is switched off.
 */
import assert from "node:assert/strict";
import { assertSafeTestDbUrl, E2E, E2E_DB_URL } from "./env";

const P = "e2e-csvw";

async function main() {
  const url = process.env.MT_E2E_DATABASE_URL ?? E2E_DB_URL;
  assertSafeTestDbUrl(url);
  process.env.DATABASE_URL = url;
  process.env.NEXTAUTH_URL = "https://matchtime.ai";
  process.env.SELF_JOIN_APPROVER_PHONES = E2E.APPROVER_PHONE;
  process.env.BILLING_ENABLED = "1";
  delete process.env.SETUP_LEARNING_ENABLED;

  const { db } = await import("@/lib/db");
  const { decideClub } = await import("@/lib/club-approval");
  const { goLiveClub, liveByUser } = await import("@/lib/club-setup");
  const { handleSetupRemoval, handleSetupReAdd } = await import("@/lib/club-setup-removal");
  const { setBillingState } = await import("@/lib/club-billing");
  const { loadClubSetVersion } = await import("@/lib/club-set-version");

  let n = 0;
  const ok = (label: string) => {
    n++;
    console.log(`  ok ${n}: ${label}`);
  };
  const NOW = new Date();

  async function pendingClub(i: number) {
    const orgId = `${P}-org-${i}`;
    const groupId = `1203639500000000${String(i).padStart(2, "0")}@g.us`;
    const phone = `4477009038${String(i).padStart(2, "0")}`;
    const userId = `${P}-u-${i}`;
    await db.user.create({ data: { id: userId, name: "Wes Writer", email: `${userId}@e2e-test.invalid`, phoneNumber: `+${phone}` } });
    await db.$executeRawUnsafe(
      `INSERT INTO "Organisation" (id,name,slug,"inviteCode","approvalStatus",language,"createdAt","updatedAt")
       VALUES ($1,$2,$1,$3,'pending','en',now(),now())`,
      orgId,
      `Writer Club ${i}`,
      `${orgId}-invite`,
    );
    await db.membership.create({ data: { userId, orgId, role: "OWNER" } });
    await db.clubConnect.create({
      data: {
        id: `${P}-cc-${i}`,
        orgId,
        userId,
        phone,
        code: `W${String(i).padStart(3, "0")}`,
        status: "group_linked",
        expiresAt: new Date(Date.now() + 3600_000),
        groupId,
        groupSubject: `Writer group ${i}`,
        memberCount: 1,
        participants: [{ phone, pushname: "Wes" }],
        linkedAt: new Date(NOW.getTime() - 3600_000),
      },
    });
    return { orgId, groupId, userId, name: `Writer Club ${i}` };
  }
  const row = (orgId: string) =>
    db.organisation.findUnique({
      where: { id: orgId },
      select: { approvalStatus: true, setupStage: true, whatsappBotEnabled: true, billingStatus: true, setupRemovedAt: true, whatsappGroupId: true } as never,
    }) as unknown as Promise<{
      approvalStatus: string;
      setupStage: string;
      whatsappBotEnabled: boolean;
      billingStatus: string;
      setupRemovedAt: Date | null;
      whatsappGroupId: string | null;
    }>;

  const cleanup = async () => {
    await db.platformJob.deleteMany({ where: { OR: [{ refId: { startsWith: P } }, { phone: { startsWith: "4477009038" } }] } });
    await db.opsAlert.deleteMany({ where: { orgId: { startsWith: P } } });
    await db.billingEvent.deleteMany({ where: { orgId: { startsWith: P } } });
    await db.sentNotification.deleteMany({ where: { key: { contains: P } } });
    await db.botJob.deleteMany({ where: { orgId: { startsWith: P } } });
    await db.organisation.deleteMany({ where: { id: { startsWith: P } } });
    await db.user.deleteMany({ where: { id: { startsWith: P } } });
  };

  let stamp = "";
  /** The stamp moved from the last one; returns nothing, remembers it. */
  const moved = async (label: string) => {
    const now = await loadClubSetVersion();
    assert.notEqual(now, stamp, `${label}: the stamp must change`);
    assert.equal(await loadClubSetVersion(), now, `${label}: stable afterwards`);
    stamp = now;
  };

  try {
    await cleanup();
    const a = await pendingClub(1);
    const b = await pendingClub(2);
    stamp = await loadClubSetVersion();
    // Two clubs waiting for approval with no group of their own yet are not in it.
    assert.equal((await row(a.orgId)).whatsappGroupId, null);

    // ── The owner approves, with the hold on ──────────────────────────
    const approved = await decideClub(a.orgId, "approve", "lib-owner", { now: NOW, hold: true });
    assert.ok(approved.ok && approved.held, "the approval held the club");
    assert.deepEqual([(await row(a.orgId)).approvalStatus, (await row(a.orgId)).setupStage, (await row(a.orgId)).whatsappBotEnabled], ["approved", "setting-up", false]);
    await moved("approved and setting up");
    const settingUp = stamp;
    ok("decideClub (approve, hold on): the club becomes setting up, and the stamp changes");

    // ── Removed from its group, and added back ────────────────────────
    assert.equal((await handleSetupRemoval(a.groupId, { now: NOW })).kind, "removed");
    assert.ok((await row(a.orgId)).setupRemovedAt);
    await moved("removed");
    assert.equal((await handleSetupReAdd({ groupId: a.groupId, discovered: true, now: NOW })).kind, "cleared");
    assert.equal((await row(a.orgId)).setupRemovedAt, null);
    await moved("re-added");
    assert.equal(stamp, settingUp, "back to exactly the stamp before the removal");
    ok("handleSetupRemoval and handleSetupReAdd: the stamp changes at each, and returns to what it was");

    // ── GO ────────────────────────────────────────────────────────────
    const live = await goLiveClub(a.orgId, liveByUser(a.userId), new Date(NOW.getTime() + 60_000), { learningEnabled: false, billingEnabled: true });
    assert.equal(live.outcome, "went-live");
    assert.deepEqual([(await row(a.orgId)).setupStage, (await row(a.orgId)).whatsappBotEnabled], ["live", true]);
    await moved("went live");
    ok("goLiveClub: live and served, and the stamp changes");

    // ── The club fee: the free period ends, the grace week ends, a card ──
    assert.equal((await row(a.orgId)).billingStatus, "trial", "its free period started at go-live");
    const later = new Date(NOW.getTime() + 70 * 24 * 3600_000);
    assert.ok((await setBillingState(a.orgId, { type: "trial-ended" }, later)).ok);
    assert.equal((await row(a.orgId)).billingStatus, "grace");
    await moved("free period over");
    assert.ok((await setBillingState(a.orgId, { type: "grace-ended" }, new Date(later.getTime() + 8 * 24 * 3600_000))).ok);
    assert.equal((await row(a.orgId)).billingStatus, "paused");
    await moved("paused for the club fee");
    const paused = stamp;
    assert.ok((await setBillingState(a.orgId, { type: "card-added" }, new Date(later.getTime() + 9 * 24 * 3600_000))).ok);
    assert.notEqual((await row(a.orgId)).billingStatus, "paused");
    await moved("resumed");
    assert.notEqual(stamp, paused);
    ok("setBillingState: the pause (grace-ended) and the resume (card-added) each change the stamp");

    // ── An approval under the old flow ────────────────────────────────
    const old = await decideClub(b.orgId, "approve", "lib-owner", { now: NOW, hold: false });
    assert.ok(old.ok && !old.held, "the old flow: not held");
    assert.deepEqual([(await row(b.orgId)).approvalStatus, (await row(b.orgId)).setupStage, (await row(b.orgId)).whatsappBotEnabled], ["approved", "live", true]);
    await moved("old-flow approval");
    ok("decideClub (approve, hold off): served at once, and the stamp changes");

    // ── The owner turns a club off ────────────────────────────────────
    const suspended = await decideClub(b.orgId, "suspend", "lib-owner", { now: new Date(NOW.getTime() + 120_000), confirmName: b.name });
    assert.ok(suspended.ok, `the suspension went through: ${JSON.stringify(suspended)}`);
    assert.deepEqual([(await row(b.orgId)).approvalStatus, (await row(b.orgId)).whatsappBotEnabled], ["suspended", false]);
    await moved("suspended");
    ok("decideClub (suspend): no longer served, and the stamp changes");

    console.log(`OK: ${n} club-set-version checks through the production writers`);
  } finally {
    await cleanup().catch((err) => console.error("cleanup failed:", err));
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
