// One-off (2026-10-31): Kemal-approved apology in FNF HQ about Imti and Clarence dropping off after the cancelled 23 Oct week. Dry run unless --apply.
import { db } from "../src/lib/db.ts";

const ORG = "cmv9nmp81000006l2iau88fig";
const KEY = `hq-explain:${ORG}:imti-clarence-2026-10-31`;
const TEXT = [
  `Sorry lads, that one was my mistake, not yours or Imti's.`,
  ``,
  `Imti and Clarence were added to the 23 Oct list, but that game was cancelled. When I built the 30 Oct list I copied the last game that was actually played (16 Oct) and skipped the cancelled one, so both dropped off. Nothing to pay for Imti last week, as you said.`,
  ``,
  `I'm being fixed so a cancelled week's list always carries over. This Friday's list is full (18), so tell me what you'd like: tag me with "@Match Time put Imti and Clarence on the bench", or say who they replace.`,
].join("\n");

async function main() {
  const org = await db.organisation.findUnique({ where: { id: ORG }, select: { name: true, adminGroupId: true, adminChannelMode: true } });
  console.log(org);
  if (!org?.adminGroupId || org.adminChannelMode !== "admin-group") throw new Error("not an admin-group club");
  if (!process.argv.includes("--apply")) return console.log("dry run");
  const jobId = await db.$transaction(async (tx) => {
    const { count } = await tx.sentNotification.createMany({ data: [{ key: KEY, kind: "group-message" }], skipDuplicates: true });
    if (count !== 1) return null;
    return (await tx.botJob.create({ data: { orgId: ORG, kind: "admin-group", text: TEXT } })).id;
  });
  console.log(jobId ? `queued BotJob ${jobId}` : "already sent, nothing queued");
}
main().finally(() => db.$disconnect());
