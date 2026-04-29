/**
 * One-off: trigger a roster check-in survey for an org.
 *
 *   # Test mode — only DM Kemal so we can verify classification works
 *   node --env-file=.env --import tsx scripts/start-roster-survey.ts sutton-fc --test-only-me
 *
 *   # Real mode — DM every active member with a phone number
 *   node --env-file=.env --import tsx scripts/start-roster-survey.ts sutton-fc --apply
 *
 * Defaults to dry-run (lists who WOULD be DM'd, queues no jobs).
 *
 * Skips:
 *   - Members with no phone on file (we can't DM them).
 *   - Soft-removed memberships (leftAt != null).
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const SENT_BY_EMAIL = "kemal.ediz@cressoft.io";
const TEST_PHONE_E164 = "+447525334985"; // Kemal's number for --test-only-me

async function main() {
  const args = process.argv.slice(2);
  const slug = args.find((a) => !a.startsWith("--"));
  const testOnlyMe = args.includes("--test-only-me");
  const apply = args.includes("--apply");
  if (!slug) {
    console.error("Usage: start-roster-survey.ts <orgSlug> [--test-only-me] [--apply]");
    process.exit(1);
  }

  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as never);

  const org = await db.organisation.findFirst({
    where: { slug },
    select: { id: true, name: true },
  });
  if (!org) {
    console.error(`No org with slug "${slug}"`);
    process.exit(1);
  }

  const sender = await db.user.findUnique({ where: { email: SENT_BY_EMAIL } });
  if (!sender) {
    console.error(`Sender ${SENT_BY_EMAIL} not found`);
    process.exit(1);
  }

  const members = await db.membership.findMany({
    where: {
      orgId: org.id,
      leftAt: null,
    },
    include: {
      user: {
        select: { id: true, name: true, phoneNumber: true },
      },
    },
  });

  const eligible = members.filter((m) => {
    if (!m.user.phoneNumber) return false;
    if (testOnlyMe) return m.user.phoneNumber === TEST_PHONE_E164;
    return true;
  });

  console.log(`Org: ${org.name}`);
  console.log(`Mode: ${testOnlyMe ? "TEST (Kemal only)" : "REAL (all eligible members)"}`);
  console.log(`Eligible: ${eligible.length} member(s) with phone numbers.\n`);

  if (eligible.length === 0) {
    console.log("Nobody to DM. Aborting.");
    return;
  }

  for (const m of eligible) {
    console.log(`  - ${m.user.name?.padEnd(28) ?? "?"}  ${m.user.phoneNumber}`);
  }

  if (!apply) {
    console.log("\nDry run. Pass --apply to actually queue DMs.");
    return;
  }

  // Create the survey row.
  const survey = await db.rosterSurvey.create({
    data: {
      orgId: org.id,
      sentByUserId: sender.id,
    },
  });
  console.log(`\nCreated RosterSurvey ${survey.id}`);

  // Queue a DM per member. Save the BotJob id on the RosterSurveyDM
  // so we can later trace which DM was which.
  let queued = 0;
  for (const m of eligible) {
    const phone = m.user.phoneNumber!.replace(/^\+/, "");
    const firstName = m.user.name?.split(/\s+/)[0] ?? "mate";
    const text = [
      `Hey ${firstName} 👋`,
      ``,
      `This is *Match Time*, the bot that coordinates your *${org.name}* WhatsApp group (the Tuesday football one).`,
      ``,
      `Quick check-in — attendance's been thin lately, so we're asking everyone if they're still up for Tuesday football going forward.`,
      ``,
      `Just reply here with a word or two:`,
      `• "yes" / "I'm in" — keep me on the roster`,
      `• "maybe" / "depends" — only when I confirm`,
      `• "not for now" / "out" — step me back`,
      ``,
      `Whatever you pick stays between you and the group admin. No drama 🙏`,
    ].join("\n");

    const job = await db.botJob.create({
      data: { orgId: org.id, kind: "dm", phone, text },
    });
    await db.rosterSurveyDM.create({
      data: {
        surveyId: survey.id,
        userId: m.user.id,
        botJobId: job.id,
      },
    });
    queued += 1;
    console.log(`  queued: ${m.user.name} (${m.user.phoneNumber})`);
  }
  console.log(`\nQueued ${queued} DM(s). Bot will deliver on next 30s poll.`);
  console.log(`Admin dashboard at /admin/roster-survey/${survey.id} (TBD).`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => process.exit(0));
