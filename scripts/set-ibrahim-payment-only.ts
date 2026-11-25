import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const APPLY = process.argv.includes("--apply");

async function main() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);

  // Ibrahim, +44 7385 849848 (from the DM screenshot).
  const users = await db.user.findMany({
    where: { OR: [{ phoneNumber: "+447385849848" }, { name: { contains: "Ibrahim", mode: "insensitive" } }] },
    select: { id: true, name: true, phoneNumber: true },
  });
  console.log("Candidates:", JSON.stringify(users, null, 2));

  const ibr = users.find((u: any) => u.phoneNumber === "+447385849848");
  if (!ibr) { console.log("No user with that exact number — resolve manually."); await db.$disconnect(); return; }
  console.log(`Target: ${ibr.name} ${ibr.phoneNumber} (${ibr.id})`);

  const mems = await db.membership.findMany({ where: { userId: ibr.id, leftAt: null } });
  console.log(`Active memberships: ${mems.length}`);

  if (!APPLY) { console.log("(dry-run — pass --apply to set all sub flags false + queue correction DM)"); await db.$disconnect(); return; }

  const upd = await db.membership.updateMany({
    where: { userId: ibr.id, leftAt: null },
    data: {
      subMatchInviteDm: false, subBenchOfferDm: false, subTentativeDm: false,
      subRatingDm: false, subReminderDm: false, subPrefsUpdatedAt: new Date(),
    },
  });
  console.log(`Set payment-only on ${upd.count} membership(s).`);

  const phone = ibr.phoneNumber.replace(/^\+/, "");
  const mem = mems[0];
  const text =
    "Sorry — earlier I only switched off rating messages. I've now stopped everything except payment, " +
    "which is what you asked for. You'll only hear from me about match fees. Text \"start messages\" anytime to turn the rest back on.";
  const job = await db.botJob.create({ data: { orgId: mem.orgId, kind: "dm", phone, text } });
  console.log(`Queued correction DM (BotJob ${job.id}) — sends on next bot cycle.`);

  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
