// One-off (2026-11-03): Kemal-approved question in the Vets players' group: which team Nabz (smiler) played on, 2 Nov. Dry run unless --apply.
import { db } from "../src/lib/db.ts";

const ORG = "cmvzlm8km000707iihou1ut9h";
const NABZ = "447983882605";
const KEY = `group-ask:${ORG}:nabz-team-2026-11-02`;
const TEXT = [
  `Quick one about last Monday's game (2 Nov). Smiler and Nabz are the same person, so I had him down on both teams 😄`,
  ``,
  `@${NABZ} were you on *Bibs* or *No bibs*? Anyone who remembers, just reply here.`,
].join("\n");

async function main() {
  const org = await db.organisation.findUnique({ where: { id: ORG }, select: { name: true, whatsappGroupId: true, whatsappBotEnabled: true } });
  console.log(org);
  if (!org?.whatsappGroupId || !org.whatsappBotEnabled) throw new Error("club has no live group");
  console.log(`\n${TEXT}\n`);
  if (!process.argv.includes("--apply")) return console.log("dry run");
  const jobId = await db.$transaction(async (tx) => {
    const { count } = await tx.sentNotification.createMany({ data: [{ key: KEY, kind: "group-message" }], skipDuplicates: true });
    if (count !== 1) return null;
    return (await tx.botJob.create({ data: { orgId: ORG, kind: "group", text: TEXT, mentions: [NABZ] } })).id;
  });
  console.log(jobId ? `queued BotJob ${jobId}` : "already sent, nothing queued");
}
main().finally(() => db.$disconnect());
