// One-off (2026-10-23): Kemal-approved explanation in FNF HQ. Dry run unless --apply.
import { db } from "../src/lib/db.ts";

const ORG = "cmv9nmp81000006l2iau88fig";
const KEY = `hq-explain:${ORG}:fixes-2026-10-24`;
const TEXT = [
  `🛠️ Three fixes are live now:`,
  ``,
  `1. *Aliases work everywhere.* A short name set in the admin portal, like *AH* for Abdul-Hafeez, now works in lists, IN, OUT and swaps.`,
  `2. *Names that are also ordinary words work.* *Glazers out* now takes Glazers off.`,
  `3. *After a cancelled week*, anyone who said OUT for it is not carried into the next week's squad. I list them here, one per line, and you can put anyone back by saying their name and *IN*. This starts from the next squad I carry over.`,
  ``,
  `Please send *AH out* one more time to check it. Then *AH IN* puts him back.`,
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
    return (await tx.botJob.create({ data: { orgId: ORG, kind: "admin-group", text: TEXT } })).id;
  });
  console.log(jobId ? `queued BotJob ${jobId}` : "already sent, nothing queued");
}
main().finally(() => db.$disconnect());
