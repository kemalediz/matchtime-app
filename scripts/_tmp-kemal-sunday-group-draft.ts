// One-off (2026-11-16): DM Kemal the Sunday "Football Group" intro draft so he can copy and paste it. Dry run unless --apply.
import { db } from "../src/lib/db.ts";

const ORG = "cmnnwhdx30000zfr85q18lyy9"; // Sutton Football Club, Kemal's own club
const PHONE = "447525334985"; // Kemal
const KEY = `kemal-draft:sunday-group-intro-2026-11-16`;
const TEXT = [
  `Hi all 👋 Quick one, and @Ugur only if you're happy with it.`,
  ``,
  `Looking back at the last few weeks:`,
  `🔢 "6 more… 5 more… 3 more" every week, with Ugur tagging people one by one`,
  `🤔 "How many are we now? Including Mirhan?" (that one was me 😅)`,
  `📱 Drop-outs the night before, accidental poll votes, and new lads who can't see the poll`,
  `❌ Two Sundays called off (1st and 15th Nov) because we couldn't get to 14 before the pitch deadline`,
  ``,
  `I use a WhatsApp helper called MatchTime for my Monday and Tuesday games, and it helps with exactly this:`,
  ``,
  `📋 *One live list:* just say IN or OUT in the chat and it keeps track of who's in, how many places are left and who's on the bench`,
  `🔄 *Drop-outs:* someone pulls out, the next person on the bench moves up and gets told`,
  `⏰ *Reminders:* it nudges the group while places are still open, so nobody has to post the countdown`,
  `🤝 *Still short?* It can offer the empty places to players from nearby clubs and a local player pool`,
  ``,
  `And the fun bit:`,
  ``,
  `⭐ *Ratings:* after each game everyone privately rates the others out of 10, and it builds a form rating for each player`,
  `⚖️ *Fair teams:* it uses those ratings to pick two balanced sides`,
  `🏆 *Man of the Match:* a quick vote in the group after each game, and the wins add up over the season`,
  `📊 *Your own page:* games, ratings and MoM awards for every player. Tag it with "@Match Time my stats" to see yours`,
  ``,
  `Nothing to download, everyone keeps chatting as normal, and it stays quiet unless someone says IN, OUT or tags it.`,
  ``,
  `🌐 matchtime.ai`,
  ``,
  `Ugur, if you fancy trying it, I can set it up in about 10 minutes, and it can be removed any time 👍`,
].join("\n");

async function main() {
  console.log(TEXT);
  if (!process.argv.includes("--apply")) return console.log("\ndry run");
  const jobId = await db.$transaction(async (tx) => {
    const { count } = await tx.sentNotification.createMany({ data: [{ key: KEY, kind: "dm" }], skipDuplicates: true });
    if (count !== 1) return null;
    return (await tx.botJob.create({ data: { orgId: ORG, kind: "dm", phone: PHONE, text: TEXT } })).id;
  });
  console.log(jobId ? `queued BotJob ${jobId}` : "already sent, nothing queued");
}
main().finally(() => db.$disconnect());
