/** Diagnose: why is only Idris's reply showing? */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const SURVEY_ID = process.argv[2] ?? "cmol71h6l0000ulr8418mo4fh";

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as never);

  const survey = await db.rosterSurvey.findUnique({
    where: { id: SURVEY_ID },
    include: {
      dms: {
        include: { user: { select: { id: true, name: true, phoneNumber: true } } },
      },
      responses: { include: { user: { select: { name: true } } } },
    },
  });
  if (!survey) {
    console.error("Survey not found:", SURVEY_ID);
    process.exit(1);
  }

  console.log(`Survey ${survey.id} status=${survey.status}`);
  console.log(`Sent ${survey.dms.length} DMs, recorded ${survey.responses.length} responses.`);
  console.log("");

  // DM delivery state — RosterSurveyDM.sentAt + failedReason
  const delivered = survey.dms.filter((d) => d.sentAt !== null);
  const failed = survey.dms.filter((d) => d.failedReason);
  console.log(`DM delivery: ${delivered.length} sent, ${failed.length} errored.`);
  if (failed.length > 0) {
    for (const f of failed.slice(0, 5)) {
      console.log(`  err: ${f.user.name} → ${f.failedReason}`);
    }
  }
  console.log("");

  console.log("Responses on this survey:");
  for (const r of survey.responses) {
    console.log(
      `  ${r.classifiedAt.toISOString()}  ${r.user.name?.padEnd(22) ?? "?"}  ${r.response.padEnd(8)}  raw=${JSON.stringify((r.rawReply ?? "").slice(0, 70))}`,
    );
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => process.exit(0));
