// One-off (2026-11-02): DM Kemal the Vets welcome draft so he can copy and paste it. Dry run unless --apply.
import { db } from "../src/lib/db.ts";

const ORG = "cmnnwhdx30000zfr85q18lyy9"; // Sutton Football Club, Kemal's own club
const PHONE = "447525334985"; // Kemal
const KEY = `kemal-draft:vets-hello-2026-11-02`;
const TEXT = [
  `👋 Hi everyone, I'm *MatchTime*. Davide has set me up to help run the Monday games. Here's what I do, right here in WhatsApp:`,
  ``,
  `📋 *Monthly squad:* regulars sign up and pay for the whole month, and are in every game of it. Can't make one? Say *Out*.`,
  `✅ *Not a regular?* When a place is open, say *In* to take it. You pay for that game only.`,
  `👥 *Bringing a friend:* say a friend is coming and I'll DM you a link to send them.`,
  `⏰ *Remind me:* tag me and say when, in your own words (for example *"@Match Time remind me Thursday"*), and I'll DM you then.`,
  ``,
  `⭐ *Ratings:* the morning after each game I DM everyone who played a private link to rate the others out of 10. Your scores stay private and you can't rate yourself. I combine them into a form rating for each player, updated every week.`,
  `⚖️ *Fair teams:* I use those ratings to pick two balanced sides, so the games stay close. The more people rate, the fairer the teams.`,
  `🏆 *Man of the Match:* after the final whistle I post a quick vote in the group. Tap who you thought was the standout player and I'll announce the winner. Wins add up over the season.`,
  `📊 *Your profile:* everyone gets their own page with their games, ratings and MoM awards. Ask me any stats question too, for example *@Match Time my stats*.`,
  `🤝 *More games:* if you fancy playing on other nights, you can join the local MatchTime player pool and get offered spare places in nearby games. It's up to you: matchtime.ai/play`,
  ``,
  `Davide will post the month's list as usual.`,
  ``,
  `I stay quiet during the banter and only reply to In, Out or a tag. Anything else, tag me: *@Match Time help*`,
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
