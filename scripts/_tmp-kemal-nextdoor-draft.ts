// One-off (2026-11-02): DM Kemal his draft Nextdoor post for the player pool so he can copy and paste it. Dry run unless --apply.
import { db } from "../src/lib/db.ts";

const ORG = "cmnnwhdx30000zfr85q18lyy9"; // Sutton Football Club, Kemal's own club
const PHONE = "447525334985"; // Kemal
const KEY = `kemal-draft:nextdoor-pool-2026-11-02`;
const TEXT = [
  `Fancy a game of football in Sutton? 5 and 7-a-side players wanted`,
  ``,
  `Hi neighbours,`,
  ``,
  `I organise a weekly 7-a-side game in Sutton, and a few local groups near us play 5 and 7-a-side during the week. Most weeks someone drops out and a group ends up a player or two short.`,
  ``,
  `So we've set up a simple local player list. You say where you are, which days and times suit you, and what you like to play. When a local game near you is short of a player, you get a WhatsApp message offering you the place, and you decide whether to take it. No commitment, no membership, no weekly sign-up.`,
  ``,
  `- Free to join. You only pay the normal match fee for the games you choose to play.`,
  `- At most two messages a week, and you can stop them at any time.`,
  `- All levels welcome, 18 and over.`,
  `- We only ask for the first part of your postcode (like SM1 or SW19), never your full address.`,
  ``,
  `Sign up here, it takes about a minute: https://matchtime.ai/play`,
  ``,
  `We're actually a few short for this Tuesday, so if you fancy a game tomorrow evening, now's a good time to join.`,
  ``,
  `Kemal`,
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
