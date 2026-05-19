/** Cancel the 6 rate-match BotJobs queued moments ago (only if not yet sent). */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const JOB_IDS = [
  "cmolcd60s0000c5r80f50gp0c", // Efat
  "cmolcd6270001c5r8im0jp0tm", // Faris
  "cmolcd63g0002c5r868gexb1b", // Shaz
  "cmolcd6570003c5r8neq1b2tp", // Elnur Mammadov
  "cmolcd67t0004c5r837s0epyp", // Enayem
  "cmolcd68z0005c5r87ykhmzk5", // Abid Kazmi
];

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as never);

  for (const id of JOB_IDS) {
    const job = await db.botJob.findUnique({ where: { id } });
    if (!job) {
      console.log(`  ✘ ${id} — not found`);
      continue;
    }
    if (job.sentAt) {
      console.log(`  ⚠ ${id} — already sent at ${job.sentAt.toISOString()}, can't recall`);
      continue;
    }
    await db.botJob.delete({ where: { id } });
    console.log(`  ✓ ${id} — cancelled (was unsent)`);
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => process.exit(0));
