/**
 * One-off: queue the "how the bench works now" announcement as a
 * MatchTime group message for Sutton. Posts on the bot's next cycle.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const APPLY = process.argv.includes("--apply");

const TEXT = `📋 *Quick update from me on how the bench works*

I've changed how spots get filled when someone drops out — the old way was clunky, this is much better:

❌ *Old:* I asked benchers one-by-one with a 2-hour timer. Miss the window (even if you were asleep 🥱) and you got bumped down. Scrapped.

✅ *New:* when a spot opens, *everyone on the bench gets told at once*. First to reply *IN* (or 👍) takes it. That's it.

⏱️ *No timers, no pressure* — reply whenever you see it.
🛏️ *You're never taken off the bench* for being slow or not replying — you stay on standby until you say otherwise.
🌙 *No more middle-of-the-night messages* about a spot.
⚡ On the bench and we're short? Just say *IN* — you're straight into the squad, no waiting to be asked.

Fair, fast, first-come. Cheers all 🙌`;

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);
  const org = await db.organisation.findFirst({
    where: { slug: { contains: "sutton", mode: "insensitive" } },
    select: { id: true, name: true, whatsappBotEnabled: true },
  });
  if (!org) { console.error("Sutton org not found"); process.exit(1); }
  console.log(`Org: ${org.name} (botEnabled=${org.whatsappBotEnabled})`);
  console.log("---\n" + TEXT + "\n---");
  if (!APPLY) {
    console.log("(dry-run — pass --apply to queue)");
    await db.$disconnect();
    return;
  }
  const job = await db.botJob.create({
    data: { orgId: org.id, kind: "group", text: TEXT },
  });
  console.log(`Queued BotJob ${job.id} — posts to the group on the next bot cycle (≤5 min).`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
