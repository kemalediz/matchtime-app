/** Manual team regeneration for tonight's match (bot batch lost on restart). */
import { generateTeamsForMatch } from "../src/lib/team-generation.ts";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const MATCH_ID = "cmohvq0n5000004lf6bm8udzj";

async function main() {
  const result = await generateTeamsForMatch(MATCH_ID, {});
  if (!result.ok) {
    console.error("FAILED:", result.reason);
    process.exit(1);
  }
  console.log(result.groupPost);

  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as never);
  const match = await db.match.findUnique({
    where: { id: MATCH_ID },
    include: { activity: { include: { org: true } } },
  });
  if (!match) return;
  const job = await db.botJob.create({
    data: { orgId: match.activity.org.id, kind: "group", text: result.groupPost },
  });
  console.log("---");
  console.log("Queued BotJob", job.id);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => process.exit(0));
