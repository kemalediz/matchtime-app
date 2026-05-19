/**
 * One-off: queue the WhatsApp briefing message about today's MatchTime
 * changes to the Sutton FC group via the bot. Uses a BotJob so the
 * Pi picks it up on its next 30-second poll and posts it as the
 * MatchTime account.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const TEXT = `👋 Quick MatchTime update — a few things shipped today:

1️⃣ *Your rating finally moves* 📈
The number on your dashboard used to just show your starting "seed" rating forever. Now it blends your seed with the peer ratings teammates give you after each match — the more matches you play, the more it reflects what others think of your game.

To check yours:
👉 Open https://matchtime.ai
👉 Sign in (or tap any rating link I've sent you)
👉 You'll land on your dashboard
👉 The "Rating" tile shows your number plus how many people have rated you so far ("3 peer ratings", "blended (5 peer + seed)", or "seed · waiting for peer ratings")

2️⃣ *Sign-up now works for everyone*
Until this morning only Google sign-in was working — if you didn't have a Google account, you couldn't get in. Now both options work properly: tap *Sign in with Google*, OR enter your phone and we'll WhatsApp you a 6-digit code (arrives in seconds). Either way, if I already track you as a player you'll land straight on your dashboard with your stats.

3️⃣ *"Amir paid for 4 players"* 💳
If a member of the group covers fees for guests they brought, just tell me — e.g. *"@Match Time, Amir paid for 4 players"* or *"@Match Time, Sait paid for Faris and Adam"*. I'll credit those payments so the unpaid chase stops nagging the wrong people. (Only admins — *Kemal* and *Elvin* — can do this, keeps things tidy.)

4️⃣ *Better team-locked posts*
The 5pm match-day post now shows the Red vs Yellow lineup directly, so you can quickly see which side you're on.

If anything looks off, just shout 🙏`;

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as never);

  const org = await db.organisation.findFirst({
    where: { slug: { contains: "sutton" } },
    select: { id: true, name: true, whatsappGroupId: true, whatsappBotEnabled: true },
  });
  if (!org) {
    console.error("Sutton org not found");
    return;
  }
  if (!org.whatsappBotEnabled || !org.whatsappGroupId) {
    console.error("Bot not enabled for org or whatsappGroupId missing.");
    return;
  }
  console.log(`Queueing briefing for ${org.name} (group ${org.whatsappGroupId})`);
  const job = await db.botJob.create({
    data: {
      orgId: org.id,
      kind: "group",
      text: TEXT,
    },
  });
  console.log(`Queued BotJob ${job.id}. Bot will post on next 30s poll.`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => process.exit(0));
