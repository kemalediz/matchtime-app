/**
 * Mark a club as already told to set its players' seed ratings, so the
 * automatic nudge (src/lib/seed-nudge-rules.ts) never sends it one. For a
 * club an organiser or the manager has told by hand.
 *
 *   npx tsx scripts/mark-seed-nudged.ts <orgId or slug>
 *
 * Writes the club-wide claim `org-<orgId>:seed-nudge` (SentNotification,
 * kind "seed-nudge"). Idempotent: a second run changes nothing. To undo,
 * delete that one row.
 *
 * FNF needs no run: its queued one-off admin message (BotJob `hqseed…`)
 * contains "rough rating from 1 to 10", which the nudge already treats as
 * sent. Running this for FNF as well is harmless.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const arg = process.argv[2];
  if (!arg) throw new Error("usage: npx tsx scripts/mark-seed-nudged.ts <orgId or slug>");
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);
  try {
    const org = await db.organisation.findFirst({
      where: { OR: [{ id: arg }, { slug: arg }] },
      select: { id: true, name: true },
    });
    if (!org) throw new Error(`no club with id or slug "${arg}"`);
    const key = `org-${org.id}:seed-nudge`;
    const row = await db.sentNotification.upsert({
      where: { key },
      create: { key, kind: "seed-nudge" },
      update: {},
      select: { createdAt: true },
    });
    console.log(`${org.name} (${org.id}): marked as nudged (${key}, since ${row.createdAt.toISOString()})`);
  } finally {
    await db.$disconnect();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
