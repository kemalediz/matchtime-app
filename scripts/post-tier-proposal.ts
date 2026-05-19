/**
 * One-off: queue the Regulars/Subs tier-proposal message to the
 * Sutton FC group. Posted by the bot so it lands as MatchTime
 * (so the proposal reads as the bot's idea rather than the admin's).
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const TEXT = `Listening to the discussion on adding new players vs keeping spots for regulars 👀

Here's a thought that might work for both: a *Regulars + Subs* model.

🟢 *Regulars* — play every week. When you say IN, your slot is guaranteed.

🟡 *Subs* — newer recruits / casuals. They can say IN too, but only fill any remaining slots if Regulars don't fill the squad by the deadline. Otherwise they're on standby for drop-outs.

How it'd land:
• If you've been playing weekly, you're a *Regular* by default — nothing changes for you.
• New recruits start as *Subs*. Admins can promote them after a few weeks of consistent show-ups.
• Anyone who said *"maybe"* in this week's check-in becomes a *Sub* automatically.
• If a Regular drops on match day, the first Sub gets the call.

This way we can also add the new players who joined us last night to the group as *Subs* — they'd be eligible for future weeks without taking spots away from regulars.

Net: regulars keep priority, we can grow the pool without anyone losing their spot.

Worth a try? Open to thoughts before we wire it up 🙏`;

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as never);
  const org = await db.organisation.findFirst({
    where: { slug: { contains: "sutton" } },
    select: { id: true, name: true, whatsappBotEnabled: true, whatsappGroupId: true },
  });
  if (!org || !org.whatsappBotEnabled || !org.whatsappGroupId) {
    console.error("Sutton org not found / bot disabled");
    return;
  }
  const job = await db.botJob.create({
    data: { orgId: org.id, kind: "group", text: TEXT },
  });
  console.log(`Queued BotJob ${job.id} for ${org.name}.`);
  console.log("Bot will post on next ~30s poll.");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => process.exit(0));
