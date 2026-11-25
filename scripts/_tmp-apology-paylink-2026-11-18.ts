import { db } from "../src/lib/db";
const MATCH = "cmtbrqkro0002009k6zyrwdmg";
async function main() {
  const apply = process.argv.includes("--apply");
  const m = await db.match.findUniqueOrThrow({ where: { id: MATCH }, select: { activity: { select: { orgId: true } } } });
  const rows = await db.attendance.findMany({
    where: { matchId: MATCH, paidAt: { lt: new Date("2026-11-18T09:00:00Z") } },
    include: { user: { select: { name: true, phoneNumber: true } } },
  });
  for (const a of rows) {
    const first = (a.user.name ?? "").trim().split(/\s+/)[0] || "there";
    const text = `Sorry ${first}, please ignore this morning's payment message for Tuesday 17 Nov. You're already marked as paid, so there's nothing to do. Thanks!`;
    console.log(a.user.name, "|", text);
    if (apply && a.user.phoneNumber) {
      await db.botJob.create({ data: { orgId: m.activity.orgId, kind: "dm", phone: a.user.phoneNumber.replace(/^\+/, ""), text } });
    }
  }
  console.log(apply ? `queued ${rows.length}` : `dry run, ${rows.length} would be queued`);
}
main().finally(() => db.$disconnect());
