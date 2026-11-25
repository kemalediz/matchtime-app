// One-off (2026-11-04): DM Kemal the MatchTime intro for Andrew to share with his Tuesday group, so he can copy and paste it. Dry run unless --apply.
import { db } from "../src/lib/db.ts";

const ORG = "cmnnwhdx30000zfr85q18lyy9"; // Sutton Football Club, Kemal's own club
const PHONE = "447525334985"; // Kemal
const KEY = `kemal-draft:andrew-intro-noname-2026-11-04`;
const TEXT = [
  `👋 *MatchTime: an assistant for your football group's WhatsApp*`,
  ``,
  `MatchTime joins your WhatsApp group and takes the weekly admin off the organiser's hands. Players keep chatting the way they already do. It reads the IN and OUT messages, keeps the list up to date, moves people up from the bench when someone drops out, and reminds people before the deadline. It stays quiet in the group and only answers when someone tags it.`,
  ``,
  `What it does:`,
  ``,
  `📋 *Squad list:* who's in, who's out and who's on the bench, for weekly games or a monthly list.`,
  `⏰ *Reminders:* it chases numbers before the deadline, so the organiser doesn't have to.`,
  `💷 *Payments (optional):* it can track who's paid and send each player a link to pay.`,
  `⚖️ *Fair teams:* it makes balanced teams from the squad before kickoff, so no more sorting sides at the pitch.`,
  `⭐ *Ratings:* players rate each other after the game, which keeps the teams fair every week.`,
  `🏆 *Man of the Match:* voted by the players and announced in the group.`,
  `📊 *Player profiles:* a page for each player with their games, ratings and MoM awards.`,
  `🤝 *Short of players:* nearby clubs and a pool of local players can be offered your empty places.`,
  ``,
  `Nobody needs to download an app or learn anything new. It's been running in local groups since April.`,
  ``,
  `🌐 You can see more on the website: matchtime.ai`,
  ``,
  `If the group likes it, it can be set up in about 10 minutes, and it can be removed from the group at any time.`,
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
