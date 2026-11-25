// One-off (2026-11-01): DM Kemal his draft intro message for Davide (Vets MNF) so he can copy and paste it. Dry run unless --apply.
import { db } from "../src/lib/db.ts";

const ORG = "cmnnwhdx30000zfr85q18lyy9"; // Sutton Football Club, Kemal's own club
const PHONE = "447525334985"; // Kemal
const KEY = `kemal-draft:davide-intro-2026-11-01`;
const TEXT = [
  `Hi Davide, Kemal here.`,
  ``,
  `We had a quick chat after a Monday game about a month ago about MatchTime, the WhatsApp assistant I've been building. Sorry it went quiet, I picked up an injury and things got delayed. I'd still love you to try it with the Vets.`,
  ``,
  `In short, it takes the monthly list off your hands. It reads the list the way you already write it, tracks who's paid and the credits for missed games, reminds people before your deadline, and fills empty slots from the bench and PAYG players. It stays quiet in the group and only answers when tagged.`,
  ``,
  `Since we spoke I've added a lot more:`,
  ``,
  `*Fair teams:* it makes balanced teams from the squad before the match, so no more time spent sorting sides at the pitch, and fewer one-sided games.`,
  `*Ratings:* players rate each other after the game, which keeps the teams fairer every week.`,
  `*Man of the Match:* voted by the players and announced in the group.`,
  `*Player profiles:* a proper page for each player to track their games, ratings and MoM awards.`,
  `*Partner clubs:* when you're short, nearby clubs can lend you players.`,
  `*Local player pool:* a pool of local players who can be offered your empty slots.`,
  ``,
  `The players don't need to learn anything new.`,
  ``,
  `It's free for the first 3 months. After that it's up to £4.99 a month for the whole group, not per player, and only for the weeks you play. If it's not for you, just remove it from the group.`,
  ``,
  `I'll do the setup with you. It takes about 10 minutes, and we could start with the November list ready for Monday. Shall I send you the link?`,
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
