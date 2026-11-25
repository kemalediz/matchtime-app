// One-off (2026-11-02): DM Kemal his draft message for Amir (Sutton Lads) so he can copy and paste it. Dry run unless --apply.
import { db } from "../src/lib/db.ts";

const ORG = "cmnnwhdx30000zfr85q18lyy9"; // Sutton Football Club, Kemal's own club
const PHONE = "447525334985"; // Kemal
const KEY = `kemal-draft:amir-intro-2026-11-02`;
const TEXT = [
  `Hi Amir, Kemal here.`,
  ``,
  `I know MatchTime got it wrong with the Lads back in June, remaking your teams and asking about the next week when nobody had asked. Sorry again for that. It was fixed the same day, but you'd already moved on, and fair enough.`,
  ``,
  `A lot has changed since. It now stays quiet in the group: it only answers when someone tags it, and only picks up In and Out messages without a tag. It never remakes teams unless asked.`,
  ``,
  `I know you're not short of players, so the bits I think the Lads would actually enjoy are these:`,
  ``,
  `*More games:* your players can join the local player pool and get offered spare places in other local games, on nights the Lads aren't playing. It's entirely optional for each player.`,
  `*Partner clubs:* if a nearby club is short, your lads can help out and get an extra game, and you can borrow from them on the odd week you're short.`,
  `*Fair teams:* balanced sides made from the squad before the match, based on how everyone actually plays, so fewer one-sided games and no time lost sorting teams.`,
  `*Man of the Match and ratings:* voted by the players after the game. You liked these before, and they're better now.`,
  `*Player profiles:* each player gets a page showing their games, ratings and MoM awards over the season.`,
  ``,
  `It's free for the first 3 months. After that it's up to £4.99 a month for the whole group, not per player, and only for the weeks you play. If it's not for you, just remove it again.`,
  ``,
  `Happy to set it up with you so it works the way the Lads like it. Fancy giving it another go?`,
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
