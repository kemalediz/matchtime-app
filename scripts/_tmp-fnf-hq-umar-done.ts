// One-off (2026-11-24): Kemal asked to tell FNF HQ the Umar swap for Fri 27 Nov is done (tagging HM). Dry run unless --apply.
import { db } from "../src/lib/db.ts";

const ORG = "cmv9nmp81000006l2iau88fig";
const HM = "447376548222";
const KEY = `hq-explain:${ORG}:hm-umar-done-2026-11-24`;
const TEXT = [
  `@${HM} all sorted for Fri 27 Nov: Umar is off the list and Umar Noor is on the bench (the squad is full at 18). Sorry for the hassle, and for my "not sure who" replies just now. That was my mistake, and I'm fixing it so names like these work first time.`,
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
    return (await tx.botJob.create({ data: { orgId: ORG, kind: "admin-group", text: TEXT, mentions: [HM] } })).id;
  });
  console.log(jobId ? `queued BotJob ${jobId}` : "already sent, nothing queued");
}
main().finally(() => db.$disconnect());
