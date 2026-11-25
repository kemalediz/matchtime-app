/**
 * Seed an ISOLATED payment-test fixture. Touches nothing else:
 *   • Org "MatchTime Test (payments)" — paymentCollection ON, all methods
 *     ON, collector = Kemal. whatsappBotEnabled stays OFF until we wire a
 *     throwaway WhatsApp group (so the scheduler never runs for it early).
 *   • Activity "Test 5-a-side" + a COMPLETED match that ended ~2h ago,
 *     fee NOT set (so the chat fee-capture / fee-ask path is exercisable).
 *   • Confirmed attendances: Kemal (real number) + "Test Player Two" on a
 *     UK reserved-fictitious number (07700 900xxx — never a real person).
 *
 * Idempotent: re-running updates in place. Teardown: scripts/teardown-pay-test.ts
 */
import { db } from "@/lib/db";

const SLUG = "mt-test-payments";
const KEMAL_ID = "cmn5vhtp2000004ifh4dqbsym";
const SPORT_5ASIDE = "cmo50pj330002brr814fvdftn";

async function main() {
  // 1. Org
  const org = await db.organisation.upsert({
    where: { slug: SLUG },
    update: {
      paymentCollectionEnabled: true,
      payMethodPayByBank: true,
      payMethodCard: true,
      payMethodDirect: true,
      paymentHolderId: KEMAL_ID,
      whatsappBotEnabled: false,
    },
    create: {
      name: "MatchTime Test (payments)",
      slug: SLUG,
      paymentCollectionEnabled: true,
      payMethodPayByBank: true,
      payMethodCard: true,
      payMethodDirect: true,
      paymentHolderId: KEMAL_ID,
      whatsappBotEnabled: false,
    },
  });

  // 2. Kemal as OWNER member
  await db.membership.upsert({
    where: { userId_orgId: { userId: KEMAL_ID, orgId: org.id } },
    update: { role: "OWNER", leftAt: null },
    create: { userId: KEMAL_ID, orgId: org.id, role: "OWNER" },
  });

  // 3. Second test player (reserved-fictitious number)
  const p2 = await db.user.upsert({
    where: { phoneNumber: "+447700900123" },
    update: { name: "Test Player Two" },
    create: { name: "Test Player Two", phoneNumber: "+447700900123", email: "test-player-two@mt-test.invalid" },
  });
  await db.membership.upsert({
    where: { userId_orgId: { userId: p2.id, orgId: org.id } },
    update: { role: "PLAYER", leftAt: null },
    create: { userId: p2.id, orgId: org.id, role: "PLAYER" },
  });

  // 4. Activity
  let activity = await db.activity.findFirst({ where: { orgId: org.id, name: "Test 5-a-side" } });
  if (!activity) {
    activity = await db.activity.create({
      data: {
        orgId: org.id,
        sportId: SPORT_5ASIDE,
        name: "Test 5-a-side",
        dayOfWeek: 3,
        time: "20:00",
        venue: "Test Pitch",
        matchDurationMins: 60,
      },
    });
  }

  // 5. A match that ended ~2h ago, fee NOT set
  const now = new Date();
  const date = new Date(now.getTime() - 3 * 60 * 60 * 1000); // kicked off 3h ago, 60min → ended 2h ago
  let match = await db.match.findFirst({
    where: { activityId: activity.id, isHistorical: false },
    orderBy: { date: "desc" },
  });
  if (!match) {
    match = await db.match.create({
      data: {
        activityId: activity.id,
        date,
        maxPlayers: 10,
        status: "COMPLETED",
        attendanceDeadline: new Date(date.getTime() - 60 * 60 * 1000),
        postMatchEndFlow: true,
        feePerPlayer: null,
        feePendingConfirm: null,
        paymentLinksReleasedAt: null,
      },
    });
  } else {
    // Reset payment state so the test can re-run cleanly.
    match = await db.match.update({
      where: { id: match.id },
      data: {
        date,
        status: "COMPLETED",
        feePerPlayer: null,
        feePendingConfirm: null,
        feeSetByUserId: null,
        feeSetAt: null,
        paymentLinksReleasedAt: null,
      },
    });
  }

  // 6. Confirmed attendances (reset payment fields)
  for (const [i, uid] of [KEMAL_ID, p2.id].entries()) {
    await db.attendance.upsert({
      where: { matchId_userId: { matchId: match.id, userId: uid } },
      update: {
        status: "CONFIRMED",
        position: i + 1,
        paidAt: null,
        paymentMethod: null,
        paymentAmount: null,
        paymentQuantity: 1,
        stripeSessionId: null,
        directPendingAt: null,
        directConfirmedByUserId: null,
      },
      create: { matchId: match.id, userId: uid, status: "CONFIRMED", position: i + 1 },
    });
  }

  console.log("✅ Seeded payment-test fixture");
  console.log("   orgId      :", org.id, `(slug ${SLUG})`);
  console.log("   matchId    :", match.id);
  console.log("   activityId :", activity.id);
  console.log("   collector  : Kemal", KEMAL_ID);
  console.log("   player2    :", p2.id, "+447700900123");
  console.log("");
  console.log("   Pay page   : https://matchtime.ai/pay/" + match.id);
  console.log("   Collect    : https://matchtime.ai/collect/" + match.id);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
