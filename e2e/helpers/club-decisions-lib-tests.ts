/**
 * SELF-JOIN SLICE 7: `decideClub` against the REAL embedded Postgres, under
 * tsx (the lib imports the Prisma 7 generated client, which Playwright's
 * transpiler cannot load). Invoked by e2e/api/self-join-decisions.spec.ts
 * via execFile; exits non-zero with a readable message on any failure.
 *
 * What only a real database can show:
 *   - a DM and a button press racing: exactly one decision wins, and only
 *     the winner's side effects exist;
 *   - the CHECK constraint refuses the bot ON for a club that is not approved;
 *   - the seeded approved club (Sutton FC's shape: approved by default,
 *     `approvedAt` NULL) cannot be rejected, turned off or left, even with
 *     its name typed.
 *
 * Requires the fixture world to be seeded (the spec reseeds first) and
 * MT_E2E_DATABASE_URL to point at the embedded test DB.
 */
import assert from "node:assert/strict";
import { assertSafeTestDbUrl, E2E, E2E_DB_URL } from "./env";
import { ORG_ID } from "./constants";

async function main() {
  const url = process.env.MT_E2E_DATABASE_URL ?? E2E_DB_URL;
  assertSafeTestDbUrl(url);
  process.env.DATABASE_URL = url;
  process.env.NEXTAUTH_URL = "https://matchtime.ai";
  process.env.SELF_JOIN_APPROVER_PHONES = E2E.APPROVER_PHONE;

  const { decideClub, leaveUnsolicitedGroup, loadSilentGroupIds } = await import("@/lib/club-approval");
  const { db } = await import("@/lib/db");

  let n = 0;
  const ok = (label: string) => {
    n++;
    console.log(`  ✓ ${label}`);
  };

  const P = "e2e-sj7-lib";
  const organiser = `${P}-u`;
  const phone = "447700900881";
  await db.user.create({
    data: { id: organiser, name: "Lib Organiser", email: `${organiser}@e2e-test.invalid`, phoneNumber: `+${phone}` },
  });

  async function pendingClub(i: number): Promise<{ orgId: string; groupId: string }> {
    const orgId = `${P}-org-${i}`;
    const groupId = `12036370000000${String(i).padStart(4, "0")}@g.us`;
    await db.$executeRawUnsafe(
      `INSERT INTO "Organisation" (id,name,slug,"inviteCode","approvalStatus",language,"createdAt","updatedAt")
       VALUES ($1,$2,$1,$3,'pending','en',now(),now())`,
      orgId,
      `Lib Club ${i}`,
      `${orgId}-invite`,
    );
    await db.clubConnect.create({
      data: {
        id: `${P}-cc-${i}`,
        orgId,
        userId: organiser,
        phone,
        code: `L${String(i).padStart(3, "0")}`.slice(0, 4),
        status: "group_linked",
        expiresAt: new Date(Date.now() + 3600_000),
        groupId,
        groupSubject: `Lib group ${i}`,
        memberCount: 1,
        participants: [{ phone, pushname: "Lib" }],
        linkedAt: new Date(),
      },
    });
    return { orgId, groupId };
  }

  try {
    // ── 1. A DM and a button press at the same moment: one wins ───────
    for (let i = 1; i <= 4; i++) {
      const { orgId, groupId } = await pendingClub(i);
      const [a, b] = await Promise.all([
        decideClub(orgId, "approve", `whatsapp:${E2E.APPROVER_PHONE}`),
        decideClub(orgId, "reject", "web-user"),
      ]);
      const winners = [a, b].filter((r) => r.ok);
      assert.equal(winners.length, 1, `exactly one decision wins (race ${i}): ${JSON.stringify([a, b])}`);
      const loser = [a, b].find((r) => !r.ok);
      assert.equal(loser && !loser.ok && loser.reason, "not-pending", "the loser is told it was already decided");
      const org = await db.organisation.findUniqueOrThrow({
        where: { id: orgId },
        select: { approvalStatus: true, whatsappBotEnabled: true, whatsappGroupId: true },
      });
      const hellos = await db.botJob.count({ where: { orgId, kind: "group" } });
      const leaves = await db.platformJob.count({ where: { kind: "leave-group", groupId } });
      if (org.approvalStatus === "approved") {
        assert.deepEqual(org, { approvalStatus: "approved", whatsappBotEnabled: true, whatsappGroupId: groupId });
        assert.equal(hellos, 1, "approved: one hello");
        assert.equal(leaves, 0, "approved: no leave");
      } else {
        assert.deepEqual(org, { approvalStatus: "rejected", whatsappBotEnabled: false, whatsappGroupId: null });
        assert.equal(hellos, 0, "rejected: no hello");
        assert.equal(leaves, 1, "rejected: one leave");
      }
    }
    ok("approve and reject racing on one club: exactly one wins, and only its side effects exist");

    // ── 2. The CHECK constraint ─────────────────────────────────────────
    {
      const { orgId } = await pendingClub(9);
      await assert.rejects(
        db.$executeRawUnsafe(`UPDATE "Organisation" SET "whatsappBotEnabled" = true WHERE id = $1`, orgId),
        /Organisation_bot_requires_approval/,
      );
    }
    ok("the database refuses the bot ON for a pending club");

    // ── 3. Sutton FC's shape cannot be rejected, turned off or left ─────
    const sutton = await db.organisation.findUniqueOrThrow({
      where: { id: ORG_ID },
      select: { name: true, approvalStatus: true, approvedAt: true, whatsappBotEnabled: true, whatsappGroupId: true },
    });
    assert.equal(sutton.approvalStatus, "approved");
    assert.equal(sutton.approvedAt, null);
    const s1 = await decideClub(ORG_ID, "suspend", "web-user", { confirmName: sutton.name });
    assert.equal(!s1.ok && s1.reason, "not-self-join", "Turn off refused even with the name typed");
    const s2 = await decideClub(ORG_ID, "reject", "web-user");
    assert.equal(!s2.ok && s2.reason, "not-pending", "Reject refused");
    const s3 = await decideClub(ORG_ID, "approve", "web-user");
    assert.equal(!s3.ok && s3.reason, "not-pending", "Approve refused");
    await db.unsolicitedGroup.create({
      data: { id: `${P}-stale`, groupId: E2E.GROUP_ID, addedAt: new Date(Date.now() - 72 * 3600_000) },
    });
    const s4 = await leaveUnsolicitedGroup(`${P}-stale`);
    assert.deepEqual(s4, { ok: false, reason: "approved-club-group" }, "Leave refused for its group");
    const after = await db.organisation.findUniqueOrThrow({
      where: { id: ORG_ID },
      select: { name: true, approvalStatus: true, approvedAt: true, whatsappBotEnabled: true, whatsappGroupId: true },
    });
    assert.deepEqual(after, sutton, "the seeded approved club is byte-identical");
    assert.equal(await db.platformJob.count({ where: { kind: "leave-group", groupId: E2E.GROUP_ID } }), 0);
    ok("the seeded approved club (Sutton FC's shape) cannot be rejected, turned off or left, even with its name typed");

    // ── 4. Turning off a live self-join club ───────────────────────────
    {
      const { orgId, groupId } = await pendingClub(10);
      const a = await decideClub(orgId, "approve", "web-user");
      assert.ok(a.ok, "approved");
      const wrong = await decideClub(orgId, "suspend", "web-user", { confirmName: "Lib Club" });
      assert.equal(!wrong.ok && wrong.reason, "confirm-mismatch");
      const off = await decideClub(orgId, "suspend", "web-user", { confirmName: "lib club 10" });
      assert.ok(off.ok, `turned off: ${JSON.stringify(off)}`);
      const org = await db.organisation.findUniqueOrThrow({
        where: { id: orgId },
        select: { approvalStatus: true, whatsappBotEnabled: true, whatsappGroupId: true },
      });
      assert.deepEqual(org, { approvalStatus: "suspended", whatsappBotEnabled: false, whatsappGroupId: groupId });
      assert.equal(await db.platformJob.count({ where: { kind: "leave-group", groupId, status: "queued" } }), 1);
      assert.ok((await loadSilentGroupIds()).includes(groupId), "its group is silent now");
      const again = await decideClub(orgId, "suspend", "web-user", { confirmName: "lib club 10" });
      assert.equal(!again.ok && again.reason, "not-approved", "a second Turn off does nothing");
    }
    ok("Turn off: needs the name, bot off in the same write, leave queued, group silent, idempotent");
  } finally {
    await db.platformJob.deleteMany({ where: { OR: [{ refId: { startsWith: P } }, { groupId: { startsWith: "12036370000000" } }] } });
    await db.botJob.deleteMany({ where: { orgId: { startsWith: P } } });
    await db.unsolicitedGroup.deleteMany({ where: { id: { startsWith: P } } });
    await db.membership.deleteMany({ where: { orgId: { startsWith: P } } });
    await db.clubConnect.deleteMany({ where: { id: { startsWith: P } } });
    await db.organisation.deleteMany({ where: { id: { startsWith: P } } });
    await db.user.deleteMany({ where: { id: organiser } });
    await db.$disconnect();
  }

  console.log(`OK: ${n} club-decision checks against Postgres`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
