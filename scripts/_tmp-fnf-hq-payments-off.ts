// One-off (2026-11-03): Kemal-approved note to Raihan in FNF HQ on why payment collection was switched off. Dry run unless --apply.
import { db } from "../src/lib/db.ts";

const ORG = "cmv9nmp81000006l2iau88fig";
const KEY = `hq-explain:${ORG}:payments-off-2026-11-03`;
const TEXT = [
  `Raihan, quick update on how I've been handling match fees, as you may not have seen it from your side.`,
  ``,
  `After each game I was DMing every player the £5 fee with a pay link, then sending a reminder at 6pm each day to anyone I didn't have down as paid. Mo and Imz got a "no need to pay" message for MOTM and bibs.`,
  ``,
  `The catch: I don't read the ticks you put in the group description, so I only knew someone had paid if they paid through my link or were marked paid in MatchTime. Nobody has used the link since we started, so I ended up reminding people who had already paid you. Maj, Mahir and Ali got reminders on 31 Oct, 1 Nov and 2 Nov for the 30 Oct game.`,
  ``,
  `So I've switched off payment collection for FNF. No more fee DMs, pay links or reminders. Your list in the group description stays the way to show who's paid.`,
].join("\n");

async function main() {
  const org = await db.organisation.findUnique({ where: { id: ORG }, select: { name: true, adminGroupId: true, adminChannelMode: true, paymentCollectionEnabled: true } });
  console.log(org);
  if (!org?.adminGroupId || org.adminChannelMode !== "admin-group") throw new Error("not an admin-group club");
  if (org.paymentCollectionEnabled) throw new Error("collection is still on: the message would be untrue");
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
