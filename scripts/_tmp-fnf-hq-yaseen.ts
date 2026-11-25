// One-off (2026-11-03): Kemal-approved ask in FNF HQ, tagging Raihan, for Yaseen's number. Dry run unless --apply.
import { db } from "../src/lib/db.ts";

const ORG = "cmv9nmp81000006l2iau88fig";
const RAIHAN = "447961809174";
const KEY = `hq-ask:${ORG}:yaseen-number-2026-11-03`;
const TEXT = [
  `@${RAIHAN} quick one. A few players weren't getting my rating links after games because I didn't have their phone numbers. Najib and Habib are sorted now: they were already in MatchTime from Sutton, so I've linked them up. Yaseen is the only one left. Could you post his number here, or add it to his name on the Players page? Then he'll get his rating links too.`,
].join("\n");

async function main() {
  const org = await db.organisation.findUnique({ where: { id: ORG }, select: { name: true, adminGroupId: true, adminChannelMode: true } });
  console.log(org);
  if (!org?.adminGroupId || org.adminChannelMode !== "admin-group") throw new Error("not an admin-group club");
  console.log(`\n${TEXT}\n`);
  if (!process.argv.includes("--apply")) return console.log("dry run");
  const jobId = await db.$transaction(async (tx) => {
    const { count } = await tx.sentNotification.createMany({ data: [{ key: KEY, kind: "group-message" }], skipDuplicates: true });
    if (count !== 1) return null;
    return (await tx.botJob.create({ data: { orgId: ORG, kind: "admin-group", text: TEXT, mentions: [RAIHAN] } })).id;
  });
  console.log(jobId ? `queued BotJob ${jobId}` : "already sent, nothing queued");
}
main().finally(() => db.$disconnect());
