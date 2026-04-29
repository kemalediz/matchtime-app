/**
 * One-off: queue the WhatsApp briefing message that warns the
 * Sutton FC group about the upcoming roster check-in DMs. Posted
 * BEFORE the actual survey is triggered so people aren't surprised
 * by an unsolicited bot DM.
 *
 * The actual survey infrastructure is being built separately —
 * this is just the heads-up post.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const TEXT = `Hey lads 👋

Attendance's been a bit thin lately, so we're doing a quick roster check-in to see who's still up for Tuesday football going forward.

*What happens next:*

1️⃣ In a few hours you'll get a DM from *Match Time* (the bot that runs this group). It'll just ask if you want to keep playing.

2️⃣ Reply in the DM with a quick word — *"I'm in"*, *"maybe"*, *"not for now"*, or whatever fits. Takes 5 seconds. Whatever you pick stays between you and the admins.

3️⃣ Every day MatchTime will post a count update here (in / maybe / out / pending) — *no names in the group*. Only the admins can see who said what, on the matchtime.ai dashboard.

4️⃣ Anyone who picks *"not for now"* will be taken off from the group at the end of the week. If you change your mind later, just message *Kemal* or *Elvin* and they'll add you back in.

5️⃣ If you don't reply at all, no big deal — at the end of the week the admins will have a look and decide on a case-by-case basis.

No drama, no judgment whichever way you go — we just want to know who's keen so we can keep the matches running smoothly 🙏

Cheers 👊`;

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as never);

  const org = await db.organisation.findFirst({
    where: { slug: { contains: "sutton" } },
    select: { id: true, name: true, whatsappGroupId: true, whatsappBotEnabled: true },
  });
  if (!org || !org.whatsappBotEnabled || !org.whatsappGroupId) {
    console.error("Sutton org not found or bot not enabled");
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
