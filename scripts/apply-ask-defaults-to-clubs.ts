/**
 * Move existing clubs on the old partner-ask cut-off (4 hours) to the new
 * default (2 hours). Kemal's ruling of 2026-10-29 changed the defaults;
 * whether the clubs already live follow it is HIS decision, so this is a
 * separate, explicit step.
 *
 *   npx tsx scripts/apply-ask-defaults-to-clubs.ts            # DRY RUN (default)
 *   npx tsx scripts/apply-ask-defaults-to-clubs.ts --apply    # do it
 *
 * WHAT IT DOES (with --apply only):
 *   UPDATE "Organisation" SET "partnerAskCutoffHours" = 2
 *    WHERE "partnerAskCutoffHours" = 4
 *   A club that chose any other cut-off (1, 3, 6, ...) is left alone.
 *
 * WHAT IT DOES NOT DO: touch `partnerAskTime`. A club with NULL there
 * already follows the code's default (08:00 since 2026-10-29) the moment
 * the code deploys, and a club that set its own time keeps it. The dry run
 * still lists every club's time, so who moves from 16:00 to 08:00 on deploy
 * is visible.
 *
 * Prints every club's values before and after, so "what changed" is a
 * list, not a promise.
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { PARTNER_ASK_CUTOFF_DEFAULT_HOURS, PARTNER_ASK_TIME_DEFAULT } from "../src/lib/club-partnership-rules.ts";

const APPLY = process.argv.includes("--apply");
const OLD_CUTOFF = 4;
const NEW_CUTOFF = PARTNER_ASK_CUTOFF_DEFAULT_HOURS;

type Row = { id: string; name: string; when: string; time: string | null; cutoff: number };

async function main() {
  if (NEW_CUTOFF === OLD_CUTOFF) throw new Error("The default is still 4: nothing to move.");
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);

  const list = async (): Promise<Row[]> =>
    db.$queryRawUnsafe(
      `SELECT id, name, "partnerAskWhen" AS when, "partnerAskTime" AS time, "partnerAskCutoffHours" AS cutoff
         FROM "Organisation" ORDER BY name`,
    ) as Promise<Row[]>;
  const show = (label: string, rows: Row[]) => {
    console.log(`\n${label}`);
    for (const r of rows) {
      const time = r.time ?? `NULL (reads ${PARTNER_ASK_TIME_DEFAULT})`;
      console.log(`  ${r.name.padEnd(32)} when=${r.when.padEnd(10)} time=${time.padEnd(20)} cutoff=${r.cutoff}h  ${r.id}`);
    }
  };

  const before = await list();
  show("BEFORE", before);
  const targets = before.filter((r) => r.cutoff === OLD_CUTOFF);
  console.log(`\n${targets.length} club(s) on ${OLD_CUTOFF}h would move to ${NEW_CUTOFF}h:`);
  for (const r of targets) console.log(`  ${r.name} (${r.id})`);

  if (!APPLY) {
    console.log("\nDRY RUN: nothing written. Re-run with --apply to update.");
    await db.$disconnect();
    return;
  }

  const n = await db.$executeRawUnsafe(
    `UPDATE "Organisation" SET "partnerAskCutoffHours" = $1 WHERE "partnerAskCutoffHours" = $2`,
    NEW_CUTOFF,
    OLD_CUTOFF,
  );
  console.log(`\nUPDATED ${n} row(s).`);
  show("AFTER", await list());
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
