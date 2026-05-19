/**
 * Squad-full announcement fires on the confirm that completes the
 * squad, lists the players, is idempotent, and re-arms after a
 * confirmed drop. Non-destructive (synthetic org).
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { registerAttendance, cancelAttendance } from "../src/lib/attendance.ts";

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
} as any);
let pass = true;
const chk = (ok: boolean, m: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${m}`); if (!ok) pass = false; };

async function main() {
  const tag = Date.now().toString(36);
  const org = await db.organisation.create({ data: { name: `SA ${tag}`, slug: `sa-${tag}`, whatsappGroupId: `sa-${tag}@g.us`, whatsappBotEnabled: true } });
  const sport = await db.sport.create({ data: { orgId: org.id, name: "F", preset: "football-7aside", playersPerTeam: 1, positions: ["GK"], teamLabels: ["Red", "Yellow"], mvpLabel: "MoM", balancingStrategy: "rating-only" } });
  const act = await db.activity.create({ data: { orgId: org.id, sportId: sport.id, name: "T", dayOfWeek: 2, time: "21:00", venue: "V", isActive: true } });
  const future = new Date(Date.now() + 6 * 3600 * 1000);
  const match = await db.match.create({ data: { activityId: act.id, date: future, maxPlayers: 2, attendanceDeadline: future, status: "UPCOMING" } });
  const mk = async (n: string) => (await db.user.create({ data: { name: n, email: `sa-${n}-${tag}@matchtime.local` } })).id;
  const u1 = await mk("Alice"); const u2 = await mk("Bob"); const u3 = await mk("Cara");

  const sqJobs = async () =>
    db.botJob.findMany({ where: { orgId: org.id, kind: "group", text: { contains: "Squad complete" } } });

  await registerAttendance(u1, match.id, {}); // 1/2 — not full
  chk((await sqJobs()).length === 0, "no announce at 1/2");

  await registerAttendance(u2, match.id, {}); // 2/2 — FULL
  let jobs = await sqJobs();
  chk(jobs.length === 1, `announce fires exactly once at 2/2 (got ${jobs.length})`);
  chk(/Alice/.test(jobs[0]?.text ?? "") && /Bob/.test(jobs[0]?.text ?? ""), "announcement lists the players");
  chk(/2\/2/.test(jobs[0]?.text ?? ""), "announcement shows N/N");

  // Idempotent: re-registering an already-confirmed player doesn't re-announce.
  await registerAttendance(u1, match.id, {});
  chk((await sqJobs()).length === 1, "no duplicate announce on idempotent re-IN");

  // Confirmed drop re-arms; next refill announces again.
  await cancelAttendance(u2, match.id);          // 1/2
  await registerAttendance(u3, match.id, {});    // 2/2 again
  jobs = await sqJobs();
  chk(jobs.length === 2, `re-fill after a confirmed drop announces again (got ${jobs.length})`);
  chk(/Cara/.test(jobs[1]?.text ?? ""), "re-fill announcement lists the new line-up (Cara)");

  // teardown
  await db.benchSlotOffer.deleteMany({ where: { matchId: match.id } });
  await db.attendance.deleteMany({ where: { matchId: match.id } });
  await db.botJob.deleteMany({ where: { orgId: org.id } });
  await db.sentNotification.deleteMany({ where: { key: { startsWith: `${match.id}:` } } });
  await db.match.deleteMany({ where: { activityId: act.id } });
  await db.activity.deleteMany({ where: { orgId: org.id } });
  await db.sport.deleteMany({ where: { orgId: org.id } });
  for (const id of [u1, u2, u3]) await db.user.delete({ where: { id } }).catch(() => {});
  await db.organisation.delete({ where: { id: org.id } });

  console.log(`\n${pass ? "ALL PASS" : "FAILURES"}`);
  await db.$disconnect();
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
