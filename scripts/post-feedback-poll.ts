/**
 * One-off: post a MatchTime feedback round to Sutton's WhatsApp group.
 *
 * Four messages, in order:
 *   1. Intro text — sets expectations, gives social permission to be honest.
 *   2. Sentiment poll (single-select, 5 options).
 *   3. Feature-utility poll (multi-select, 7 options).
 *   4. Follow-up text — invites qualitative feedback in chat or DM.
 *
 * They all queue at once via BotJob; the bot's next /due-posts cycle
 * (~5 min) emits them sequentially. WhatsApp's send latency naturally
 * spaces them ~1-2s apart, which reads as a deliberate sequence in chat.
 *
 * Run with --apply to actually queue. Default is dry-run (prints what
 * would be queued).
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const APPLY = process.argv.includes("--apply");

const INTRO = `📣 *Quick check-in*

Would love your honest take on MatchTime (me, the bot). Two polls below, takes 10 seconds — please vote even if you're indifferent, that's useful signal too 🙏`;

const SENTIMENT_QUESTION = "Honest take — how are you finding MatchTime so far?";
const SENTIMENT_OPTIONS = [
  "🙌 Really useful, glad we have it",
  "👍 Helpful, no complaints",
  "🤷 Don't really notice it",
  "😅 Bit confusing sometimes",
  "👎 Prefer the old manual way",
];

const FEATURE_QUESTION = "Which bit of MatchTime do you actually find useful? (pick any/all)";
const FEATURE_OPTIONS = [
  "🎯 Auto-tracks who's IN / OUT",
  "📋 Squad updates + roster posts",
  "🪑 Bench fill on match day",
  "⚖️ Team generation (Red vs Yellow)",
  "🏆 MoM voting + announcement",
  "📊 Stats questions (history, top attenders)",
  "🤷 None really — could do without it",
];

const FOLLOWUP = `If anything's bugging you — wrong reactions, too many messages, replies that miss the mark — drop it here or DM me directly. No filter, I'd rather hear it 🙏 — Kemal`;

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);

  const org = await db.organisation.findFirst({
    where: { slug: { contains: "sutton", mode: "insensitive" } },
    select: { id: true, name: true, whatsappBotEnabled: true },
  });
  if (!org) { console.error("Sutton org not found"); process.exit(1); }
  if (!org.whatsappBotEnabled) {
    console.error(`Bot is NOT enabled for ${org.name}. Aborting.`);
    process.exit(1);
  }
  console.log(`Org: ${org.name} (${org.id})`);

  // Build the four BotJob payloads. Ordering is by createdAt (asc) so
  // we just insert them in sequence — Prisma createMany doesn't return
  // ids, so use individual creates for clarity + insertion order.
  const jobs = [
    { kind: "group" as const, text: INTRO },
    {
      kind: "group-poll" as const,
      text: SENTIMENT_QUESTION,
      pollQuestion: SENTIMENT_QUESTION,
      pollOptions: SENTIMENT_OPTIONS,
      pollMulti: false,
    },
    {
      kind: "group-poll" as const,
      text: FEATURE_QUESTION,
      pollQuestion: FEATURE_QUESTION,
      pollOptions: FEATURE_OPTIONS,
      pollMulti: true,
    },
    { kind: "group" as const, text: FOLLOWUP },
  ];

  console.log(`\nWill queue ${jobs.length} BotJobs:`);
  for (const [i, j] of jobs.entries()) {
    console.log(`\n  [${i + 1}] kind=${j.kind}`);
    if (j.kind === "group") {
      console.log(`      text: ${j.text.replace(/\n/g, " ⏎ ").slice(0, 200)}`);
    } else {
      console.log(`      question: ${j.pollQuestion}`);
      console.log(`      multi: ${j.pollMulti}`);
      for (const opt of j.pollOptions) console.log(`        • ${opt}`);
    }
  }

  if (!APPLY) {
    console.log(`\n(dry-run — re-run with --apply to actually queue)`);
    await db.$disconnect();
    return;
  }

  for (const j of jobs) {
    const row = await db.botJob.create({
      data: {
        orgId: org.id,
        kind: j.kind,
        text: j.text,
        pollQuestion: j.kind === "group-poll" ? j.pollQuestion : null,
        pollOptions: j.kind === "group-poll" ? j.pollOptions : [],
        pollMulti: j.kind === "group-poll" ? j.pollMulti : false,
      },
    });
    console.log(`Queued BotJob ${row.id} (${row.kind})`);
    // Small delay between creates so createdAt is strictly increasing
    // — guarantees dispatch order on the bot side.
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log(`\nDone. Bot will pick these up on its next /due-posts tick (≤5 min).`);
  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
