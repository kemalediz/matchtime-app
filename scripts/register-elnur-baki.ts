/** Manually register Elnur + Baki for next Tuesday. Both said IN
 *  but the analyzer dropped them — Elnur's message hadn't flushed
 *  yet, Baki's @lid pushname "ba" hit the multi-first-name ambiguity
 *  with Başar. Also lay down a "ba" → Baki UserAlias to fix the
 *  resolver going forward. */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { registerAttendance } from "../src/lib/attendance.ts";

const MATCH_ID = "cmorvjoqw000004i8gur1etny";
const ORG_ID = "cmnnwhdx30000zfr85q18lyy9";
const ELNUR_ID = "cmo4wno5x000pmvr8uhrx8hfi";
const BAKI_ID = "cmo4wnnkt0005mvr8vrxko4ck";

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as never);

  const r1 = await registerAttendance(ELNUR_ID, MATCH_ID);
  console.log("Elnur:", r1.status, "slot=", r1.slot);
  const r2 = await registerAttendance(BAKI_ID, MATCH_ID);
  console.log("Baki:", r2.status, "slot=", r2.slot);

  await db.userAlias.upsert({
    where: { orgId_alias: { orgId: ORG_ID, alias: "ba" } },
    create: { orgId: ORG_ID, userId: BAKI_ID, alias: "ba", source: "manual" },
    update: { userId: BAKI_ID },
  });
  console.log("UserAlias 'ba' → Baki saved");

  const ats = await db.attendance.findMany({
    where: { matchId: MATCH_ID, status: { in: ["CONFIRMED", "BENCH"] } },
    include: { user: { select: { name: true } } },
    orderBy: { position: "asc" },
  });
  console.log("---squad---");
  for (const a of ats) {
    console.log(`  ${a.position}. ${(a.user.name ?? "?").padEnd(22)} ${a.status}`);
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => process.exit(0));
