/**
 * SPENT, AND NO LONGER RUNNABLE. This script reads or writes
 * `User.seedRating` / `User.matchRating`, and both columns were DROPPED
 * on 2026-09-19 (slice 7 of
 * MDs/club-scoped-ratings-design-2026-09-18.md). It will throw.
 *
 * Kept as a record of what was done, not as something to re-run or copy.
 * The seed and the Elo are per club now: `Membership.seedRating`, and
 * `src/lib/membership-elo.ts` for the Elo, which needs the match's org.
 */
/**
 * Recalibrate Sutton seed ratings per Kemal's feedback + regenerate
 * tonight's teams + queue a BotJob with the updated lineup. One-off
 * fix because seeds were stale on the first live match.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { generateTeamsForMatch } from "../src/lib/team-generation.ts";

const GROUP_ID = "447525334985-1607872139@g.us";

// First-name (or first-token) → new seedRating (1-10)
const SEEDS: Record<string, number> = {
  Wasim: 9,
  Sait: 8,
  Kemal: 8,
  Idris: 7,
  Ibrahim: 6,
  Ehtisham: 6,
  Mustafa: 6,
  Najib: 6,
  Aydın: 6,
  Habib: 6,
  Ersin: 6,
  Elvin: 5,
  Elnur: 5,
  Mauricio: 5,
};

function firstName(full: string | null): string {
  if (!full) return "";
  return full.trim().split(/\s+/)[0];
}

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);

  // 1. Find the current match.
  const match = await db.match.findFirst({
    where: { status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] } },
    include: {
      attendances: {
        include: { user: { select: { id: true, name: true, seedRating: true } } },
      },
      activity: { select: { orgId: true, name: true } },
    },
    orderBy: { date: "asc" },
  });
  if (!match) throw new Error("no upcoming match");
  console.log(`Match: ${match.activity.name} (${match.id})  — status ${match.status}`);

  // 2. Update seeds for every player on the roster whose first name is
  //    in SEEDS. Report misses so we can add them if needed.
  const updated: string[] = [];
  const skipped: string[] = [];
  for (const a of match.attendances) {
    const fn = firstName(a.user.name);
    const desired = SEEDS[fn];
    if (typeof desired !== "number") {
      skipped.push(`${a.user.name} (first="${fn}", no SEEDS key)`);
      continue;
    }
    if (a.user.seedRating === desired) {
      console.log(`  ${a.user.name}: already ${desired}`);
      continue;
    }
    await db.user.update({
      where: { id: a.user.id },
      data: { seedRating: desired },
    });
    updated.push(`${a.user.name}: ${a.user.seedRating ?? "—"} → ${desired}`);
  }

  console.log(`\nUpdated ${updated.length} seed ratings:`);
  for (const line of updated) console.log(`  ${line}`);
  if (skipped.length) {
    console.log(`\n⚠️  Skipped (no SEEDS key — check names):`);
    for (const line of skipped) console.log(`  ${line}`);
  }

  // 3. Regenerate teams via the shared helper. This honours the
  //    Activity's balancing strategy + position composition.
  console.log(`\nRegenerating teams...`);
  const result = await generateTeamsForMatch(match.id);
  if (!result.ok) {
    console.error(`FAILED: ${result.reason}`);
    process.exit(1);
  }
  console.log(`\n--- Group post ---\n${result.groupPost}\n`);

  // 4. Queue a BotJob so the bot posts in the group on its next poll.
  const org = await db.organisation.findFirst({ where: { whatsappGroupId: GROUP_ID } });
  if (!org) throw new Error("org not found");
  const job = await db.botJob.create({
    data: { orgId: org.id, kind: "group", phone: null, text: result.groupPost },
  });
  console.log(`Queued BotJob ${job.id} — bot posts within ~5 min.`);

  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
