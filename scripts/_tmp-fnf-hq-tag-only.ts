// One-off (2026-10-31, sent 08:00 UK): Kemal-approved explanation in FNF HQ of the tag-only rule. Dry run unless --apply.
import { db } from "../src/lib/db.ts";

const ORG = "cmv9nmp81000006l2iau88fig";
const KEY = `hq-explain:${ORG}:tag-only-2026-10-31`;
const TEXT = [
  `👋 A quick change to how I work in this group.`,
  ``,
  `From now on I stay quiet here unless you *tag me*: type @ and pick *Match Time* from the list, so it shows highlighted. Typing my name by hand, or replying to my message without the tag, does not count.`,
  ``,
  `So whenever you want me to do something here, tag me, even when you are answering my own question. For example:`,
  `• @Match Time yes (to approve teams or a list)`,
  `• @Match Time Bibs won 5-4`,
  `• @Match Time Mo was man of the match`,
  `• @Match Time swap Rafi and Yorel`,
  `• @Match Time make the teams`,
  `• @Match Time send the poster`,
  ``,
  `Anything without a tag is your own chat, and I will leave it alone. My usual posts here (teams ready, deadlines) carry on as normal.`,
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
    return (await tx.botJob.create({ data: { orgId: ORG, kind: "admin-group", text: TEXT, sendAfter: new Date("2026-10-31T08:00:00Z") } })).id;
  });
  console.log(jobId ? `queued BotJob ${jobId}` : "already sent, nothing queued");
}
main().finally(() => db.$disconnect());
