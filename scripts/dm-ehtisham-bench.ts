/**
 * One-off (Kemal, 2026-05-18): Ehtisham has an open bench prompt
 * (replacing Elnur) and the group 🎟 tag was already posted, but he
 * hasn't been DM'd. Send a personal DM telling him there's a question
 * for him IN THE GROUP and he's expected to answer it. Also write the
 * scheduler's bench-prompt-dm SentNotification key so the new
 * auto-DM path doesn't fire a second DM for the same PBC.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const APPLY = process.argv.includes("--apply");

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);

  const m = await db.match.findFirst({
    where: { status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] } },
    orderBy: { date: "asc" },
    include: { activity: { select: { name: true, orgId: true } } },
  });
  if (!m) { console.error("no match"); process.exit(1); }

  const pbc = await db.pendingBenchConfirmation.findFirst({
    where: { matchId: m.id, resolvedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (!pbc) { console.error("no open PBC"); process.exit(1); }

  const u = await db.user.findUnique({
    where: { id: pbc.userId },
    select: { id: true, name: true, phoneNumber: true },
  });
  if (!u?.phoneNumber) { console.error("bencher has no phone"); process.exit(1); }

  const first = (u.name ?? "there").split(" ")[0];
  const phoneNoPlus = u.phoneNumber.replace(/^\+/, "");
  const dmKey = `${m.id}:bench-prompt-dm:${pbc.userId}`;

  const text =
    `👋 Hi ${first} — quick one: a bench slot just opened for ${m.activity.name} tonight ` +
    `and I've tagged you in the group with the question.\n\n` +
    `Please pop into the group and let me know — 👍 if you can play, 👎 if you can't — ` +
    `so I can lock the squad in. (You can also just reply *YES* or *NO* to this message and I'll sort it.) 🙏`;

  console.log(`Bencher: ${u.name} (${u.phoneNumber})`);
  console.log(`PBC expires: ${pbc.expiresAt.toISOString()}`);
  console.log(`dmKey: ${dmKey}`);
  console.log(`\nDM text:\n${text}\n`);

  const already = await db.sentNotification.findUnique({ where: { key: dmKey } });
  if (already) {
    console.log("dmKey already in SentNotification — a DM path already fired. Aborting to avoid a duplicate.");
    await db.$disconnect();
    return;
  }

  if (!APPLY) {
    console.log("(dry-run — pass --apply to queue the DM + suppress the scheduler dupe)");
    await db.$disconnect();
    return;
  }

  await db.botJob.create({
    data: { orgId: m.activity.orgId, kind: "dm", phone: phoneNoPlus, text },
  });
  await db.sentNotification.create({
    data: { key: dmKey, kind: "bench-prompt-dm", matchId: m.id, targetUser: pbc.userId },
  });
  console.log("Queued DM BotJob + wrote dmKey SentNotification (scheduler won't double-send).");
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
