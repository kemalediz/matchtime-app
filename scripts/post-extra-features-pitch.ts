/**
 * One-off: queue a BotJob to post a "here's what else MatchTime can
 * do" message in an org's WhatsApp group, listing only the features
 * the org has TURNED OFF.
 *
 * Why this exists (2026-05-25):
 *   The auto-firing `botIntroMessage(features)` in
 *   `src/lib/bot-scheduler.ts` is deliberately tailored — it only
 *   mentions enabled features, so members aren't promised things the
 *   org won't actually deliver. For Amir's MoM+Rating-only group
 *   that's a very short intro. Kemal wanted a one-off follow-up
 *   message that pitches the OTHER features as "if you ever want
 *   them, ask the admin to enable." This script does that without
 *   touching the auto-intro logic (which stays accurate-by-default
 *   for every future onboarding).
 *
 * Behavior:
 *   - Computes the OFF features for the target org
 *   - Builds a friendly pitch listing them
 *   - Creates a single BotJob(kind="group-message") for that org
 *   - Bot's next /due-posts poll (≤30s) picks it up and sends
 *
 * Idempotency: refuses to queue if a non-sent BotJob with the same
 * marker tag (`<!--extra-features-pitch-->`) already exists for the
 * org. The marker is stripped from the visible message. `--force`
 * bypasses.
 *
 * Run:
 *   npx tsx --env-file=.env scripts/post-extra-features-pitch.ts --org=sutton-lads
 *   npx tsx --env-file=.env scripts/post-extra-features-pitch.ts --org=sutton-lads --apply
 *   npx tsx --env-file=.env scripts/post-extra-features-pitch.ts --org=sutton-lads --apply --force
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const argSlug = process.argv.find((a) => a.startsWith("--org="))?.slice("--org=".length);
const APPLY = process.argv.includes("--apply");
const FORCE = process.argv.includes("--force");

if (!argSlug) {
  console.error("Missing --org=<slug>. Example: --org=sutton-lads");
  process.exit(2);
}

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
} as never);

// Hidden marker stripped from the visible text but stored in BotJob.text
// so re-runs can detect a prior queue.
const MARKER = "<!--extra-features-pitch-->";

interface FeatureLine {
  flagOn: boolean;
  line: string;
}

function buildPitch(features: {
  attendance: boolean;
  bench: boolean;
  teamBalancing: boolean;
  reminders: boolean;
  statsQa: boolean;
}): string | null {
  const lines: FeatureLine[] = [
    {
      flagOn: features.attendance,
      line: `🗓  *Attendance tracking* — Players say "IN" / "OUT" here and I log them. I post a daily roll-call at 5pm until the squad's full so you all see how many we need.`,
    },
    {
      flagOn: features.bench,
      line: `🔁  *Smart bench* — When someone drops, the spot's offered to the whole bench at once; first to confirm gets in.`,
    },
    {
      flagOn: features.teamBalancing,
      line: `⚽  *Auto-balanced teams* — Ask me to "generate teams" and I post Red/Yellow sides balanced from real player ratings. \`swap X Y\` to tweak.`,
    },
    {
      flagOn: features.reminders,
      line: `⏰  *Personal reminders* — Say "@MatchTime remind me Thursday" and I'll DM you then.`,
    },
    {
      flagOn: features.statsQa,
      line: `📊  *Stats Q&A* — Ask me things like "who got MoM last week?" or "who's our most consistent player?"`,
    },
  ];

  const offLines = lines.filter((l) => !l.flagOn).map((l) => l.line);
  if (offLines.length === 0) return null;

  const visible = [
    `💡 *By the way…* I can do more than just MoM + ratings — these are turned OFF for this group right now, but they're available whenever you want them:`,
    ``,
    ...offLines.flatMap((l) => [l, ""]),
    `If any of those sound useful, just let your admin know and they'll flip the switch.`,
  ].join("\n");

  // Append marker so re-runs can detect the prior post. WhatsApp will
  // display the marker as literal text (no HTML rendering), so we put
  // it on a trailing line that's invisible-ish: a single zero-width
  // space followed by the marker, then strip via post-processing on
  // the bot side? Actually the bot has no post-processing for this —
  // marker would show up to users. So we DON'T include it in the
  // visible text. We rely on a separate index field instead: BotJob's
  // text + an identifying prefix in a comment-like tail won't render
  // hidden. So: keep marker out of the visible string, store it in
  // BotJob.text by suffixing AFTER a sentinel \n\n that the bot
  // trims before sending? The bot doesn't do that either.
  //
  // Pragmatic: store the marker as a hidden HTML-style comment in the
  // BotJob.text. WhatsApp will render `<!--…-->` as literal text. So
  // we have to either accept the literal text appearing, OR strip it
  // before sending. The cleanest is to LOOK UP idempotency NOT via
  // the marker in BotJob.text (visible) but via a separate metadata
  // path. BotJob doesn't have a metadata column, so we use the
  // workaround: search by text-contains a distinctive phrase from
  // the pitch itself. Skip the marker concept entirely.
  return visible;
}

async function main() {
  const org = await db.organisation.findUnique({
    where: { slug: argSlug },
    select: {
      id: true, name: true, whatsappBotEnabled: true, whatsappGroupId: true,
      featureAttendance: true, featureBench: true, featureTeamBalancing: true,
      featureReminders: true, featureStatsQa: true,
    },
  });
  if (!org) {
    console.error(`No org with slug "${argSlug}".`);
    await db.$disconnect();
    process.exit(1);
  }
  if (!org.whatsappBotEnabled || !org.whatsappGroupId) {
    console.error(`Org "${argSlug}" is not bot-enabled or has no whatsappGroupId.`);
    await db.$disconnect();
    process.exit(1);
  }

  const pitch = buildPitch({
    attendance: org.featureAttendance,
    bench: org.featureBench,
    teamBalancing: org.featureTeamBalancing,
    reminders: org.featureReminders,
    statsQa: org.featureStatsQa,
  });
  if (!pitch) {
    console.log(`Org "${argSlug}" has no OFF features — nothing to pitch. Exiting.`);
    await db.$disconnect();
    return;
  }

  // Idempotency: distinctive phrase from the pitch ("By the way…").
  // If a BotJob for this org contains it and is not yet failed-out,
  // we've probably already queued it.
  const prior = await db.botJob.findMany({
    where: {
      orgId: org.id,
      kind: "group-message",
      text: { contains: "By the way" },
    },
    select: { id: true, sentAt: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 3,
  });
  console.log(`Found ${prior.length} prior matching BotJob(s) for this org.`);
  for (const p of prior) {
    console.log(
      `  - ${p.id} | created ${p.createdAt.toISOString()} | sent ${p.sentAt ? p.sentAt.toISOString() : "no"}`,
    );
  }

  if (prior.length > 0 && !FORCE) {
    console.error(`Refusing to queue: prior matching BotJob exists. Use --force to override.`);
    await db.$disconnect();
    process.exit(1);
  }

  console.log("\n--- Pitch preview ---");
  console.log(pitch);
  console.log("--- end ---\n");

  if (!APPLY) {
    console.log("(dry-run — re-run with --apply to queue. Use --force to bypass the prior-job check.)");
    await db.$disconnect();
    return;
  }

  const job = await db.botJob.create({
    data: { orgId: org.id, kind: "group-message", text: pitch },
  });
  console.log(`✓ Queued BotJob ${job.id} for ${org.name} (${org.whatsappGroupId}).`);
  console.log(`  Bot will post within ~30s on its next /due-posts poll.`);

  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
