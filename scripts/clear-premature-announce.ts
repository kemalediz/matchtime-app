import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

/** The 21 Jul match was announced prematurely (rollover-guard bug, fixed in
 *  c65559b). That consumed its announce-match key, which would stop it from
 *  ever being announced properly. Delete the key so it announces correctly
 *  once tonight's match completes. Safe now the fix is deployed: the gate
 *  suppresses the 21 Jul match while tonight's is still live. */
const MATCH_ID = "cmrjvyy6b000p04jip1ges3y6";
const KEY = `${MATCH_ID}:announce-match`;
const APPLY = process.argv.includes("--apply");

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);

  const row = await db.sentNotification.findUnique({ where: { key: KEY } });
  if (!row) { console.log("No such key — already cleared?"); await db.$disconnect(); return; }
  console.log(`Found: key=${row.key} kind=${row.kind} createdAt=${row.createdAt.toISOString()}`);

  if (!APPLY) { console.log("(dry-run — pass --apply to delete)"); await db.$disconnect(); return; }

  await db.sentNotification.delete({ where: { key: KEY } });
  console.log("Deleted. The 21 Jul match will announce properly once tonight's match completes.");
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
