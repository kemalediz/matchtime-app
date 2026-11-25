// One-off (2026-10-31): Kemal-approved announcement of the friend link in the players' groups of Sutton FC and FNF. Dry run unless --apply.
import { db } from "../src/lib/db.ts";

const ORGS = ["cmnnwhdx30000zfr85q18lyy9", "cmv9nmp81000006l2iau88fig"];
const TEXT = [
  `👋 A quick change to bringing a friend.`,
  ``,
  `When you say a friend is coming ("my mate Ali is in", "+1"), I'll react ✉️ and send you a personal link for them by DM. Forward it to your friend.`,
  ``,
  `Your friend opens it, fills in a few details and sends the WhatsApp code it gives them. That books them straight into the game (or onto the bench if we're full), and I'll post here when they're in.`,
  ``,
  `The link works until kick-off. If they can't make it after all, they can tell me by WhatsApp and the place opens up again.`,
  ``,
  `Nothing else changes: say IN or OUT for yourself as usual.`,
].join("\n");

async function main() {
  for (const orgId of ORGS) {
    const org = await db.organisation.findUnique({ where: { id: orgId }, select: { name: true, whatsappGroupId: true, whatsappBotEnabled: true } });
    console.log(org);
    if (!org?.whatsappGroupId || !org.whatsappBotEnabled) { console.log("skip: no live group"); continue; }
    if (!process.argv.includes("--apply")) { console.log("dry run"); continue; }
    const key = `announce:${orgId}:friend-link-2026-10-31`;
    const jobId = await db.$transaction(async (tx) => {
      const { count } = await tx.sentNotification.createMany({ data: [{ key, kind: "group-message" }], skipDuplicates: true });
      if (count !== 1) return null;
      return (await tx.botJob.create({ data: { orgId, kind: "group", text: TEXT } })).id;
    });
    console.log(jobId ? `queued BotJob ${jobId}` : "already sent, nothing queued");
  }
  console.log(`\n${TEXT}`);
}
main().finally(() => db.$disconnect());
