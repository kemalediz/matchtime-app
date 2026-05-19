/**
 * Dry-run the Phase 2 onboarding flow WITHOUT touching WhatsApp.
 *
 * Drives the real server code (handleOnboardingTurn → LLM extraction
 * → DB writes → org/sport/activity/match creation) against a
 * synthetic groupId, printing the exact reply the bot would post at
 * each step. Lets you watch the whole conversation and inspect the
 * created org before piloting on a real group.
 *
 *   node --env-file=.env --import tsx scripts/sim-onboarding.ts
 *   node --env-file=.env --import tsx scripts/sim-onboarding.ts --wipe   # tear down the test org after
 *
 * The synthetic group id is unique per run so repeat runs don't
 * collide. At the end it prints the org slug — wipe it with:
 *   node --env-file=.env --import tsx scripts/wipe-org.ts <slug> --apply
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { handleOnboardingTurn } from "../src/lib/onboarding-conversation.ts";

const WIPE = process.argv.includes("--wipe");

// A scripted "Amir's Thursday group" conversation. Edit freely to
// probe edge cases (vague answers, "everything except payments",
// one-off matches, corrections mid-flow, etc.).
const SCRIPT: string[] = [
  "@MatchTime setup",
  "we're the Thursday Ballers",
  "7 a side",
  "thursdays",
  "8:30pm",
  "PowerLeague Shoreditch",
  "every week",
  "just Man of the Match and player ratings please",
];

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);

  const groupId = `sim-onboard-${Date.now().toString(36)}@g.us`;
  console.log(`Synthetic group: ${groupId}\n${"=".repeat(60)}`);

  let session = await db.onboardingSession.create({
    data: { whatsappGroupId: groupId, stage: "collecting" },
  });

  let waSeq = 0;
  for (const body of SCRIPT) {
    const waMessageId = `sim-${groupId}-${waSeq++}`;
    console.log(`\n🧑  ${body}`);
    const res = await handleOnboardingTurn({
      session: session as any,
      messages: [{ waMessageId, authorName: "Tester", body }],
    });
    if (res.reply) {
      console.log(`🤖  ${res.reply.replace(/\n/g, "\n    ")}`);
    } else {
      console.log(`🤖  (silent)`);
    }
    // Reload the session so the next turn sees the advanced stage +
    // collected fields, exactly like consecutive /analyze batches.
    const fresh = await db.onboardingSession.findFirst({
      where: { whatsappGroupId: groupId },
      orderBy: { createdAt: "desc" },
    });
    if (!fresh) break;
    session = fresh;
    if (res.completed) {
      console.log(`\n${"=".repeat(60)}\n✅ onboarding completed`);
      break;
    }
  }

  // Inspect what got created.
  const org = await db.organisation.findFirst({
    where: { whatsappGroupId: groupId },
    include: {
      sports: true,
      activities: { include: { matches: true } },
    },
  });
  if (org) {
    console.log(`\nCreated org: "${org.name}" (slug=${org.slug})`);
    console.log(
      `  features: att=${org.featureAttendance} bench=${org.featureBench} teams=${org.featureTeamBalancing} ` +
        `mom=${org.featureMomVoting} rate=${org.featurePlayerRating} rem=${org.featureReminders} ` +
        `stats=${org.featureStatsQa} pay=${org.paymentTrackingEnabled} botEnabled=${org.whatsappBotEnabled}`,
    );
    for (const s of org.sports)
      console.log(`  sport: ${s.name} (${s.playersPerTeam}-a-side, preset=${s.preset})`);
    for (const a of org.activities) {
      console.log(
        `  activity: ${a.name} — day=${a.dayOfWeek} time=${a.time} venue="${a.venue}" active=${a.isActive}`,
      );
      for (const mt of a.matches)
        console.log(`    match: ${mt.date.toISOString()} maxPlayers=${mt.maxPlayers} status=${mt.status}`);
    }

    if (WIPE) {
      // Best-effort teardown so repeat runs stay clean. Mirrors
      // wipe-org's cascade order at a minimal level for a fresh org
      // that has no attendances yet.
      await db.onboardingSession.deleteMany({ where: { whatsappGroupId: groupId } });
      for (const a of org.activities) {
        await db.match.deleteMany({ where: { activityId: a.id } });
      }
      await db.activity.deleteMany({ where: { orgId: org.id } });
      await db.sport.deleteMany({ where: { orgId: org.id } });
      await db.membership.deleteMany({ where: { orgId: org.id } });
      await db.organisation.delete({ where: { id: org.id } });
      console.log(`\n🧹 wiped test org ${org.slug}`);
    } else {
      console.log(
        `\nTo remove the test org:\n  node --env-file=.env --import tsx scripts/wipe-org.ts ${org.slug} --apply`,
      );
    }
  } else {
    console.log(`\n(no org created — conversation didn't reach completion)`);
    await db.onboardingSession.deleteMany({ where: { whatsappGroupId: groupId } });
  }

  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
