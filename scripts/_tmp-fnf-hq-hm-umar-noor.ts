// One-off (2026-11-24): Kemal asked to tell HM in FNF HQ, tagging him, that adding "Umar Noor" now works (#631). Dry run unless --apply.
import { db } from "../src/lib/db.ts";

const ORG = "cmv9nmp81000006l2iau88fig";
const HM = "447376548222";
const KEY = `hq-explain:${ORG}:hm-umar-noor-2026-11-24`;
const TEXT = [
  `@${HM} thanks for flagging Umar Noor yesterday. That was my mistake: when you added "Umar Noor" on the Players page, I took him for the Umar already in the club, so nobody new was added. That is fixed now, so adding "Umar Noor" creates him as a new player.`,
  ``,
  `One thing to tidy: your "Umar N in" put the existing Umar on the bench for Fri 27 Nov. Once Umar Noor is added, swap them over on the match page, or tag me and I'll do it.`,
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
