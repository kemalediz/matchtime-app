/**
 * registerAttendance promote-from-bench semantics (Kemal 2026-05-19):
 *  - squad short + bench player's OWN "IN" (promoteFromBench) → CONFIRMED
 *  - same but third-party (no promoteFromBench) → stays BENCH
 *  - forceBench always wins (no accidental promotion)
 *  - squad full → bench player's IN stays BENCH (no overfill)
 * Non-destructive (synthetic org, wiped).
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { registerAttendance } from "../src/lib/attendance.ts";

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
} as any);
let pass = true;
const chk = (ok: boolean, m: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${m}`); if (!ok) pass = false; };

async function main() {
  const tag = Date.now().toString(36);
  const org = await db.organisation.create({
    data: { name: `BP ${tag}`, slug: `bp-${tag}`, whatsappGroupId: `bp-${tag}@g.us`, whatsappBotEnabled: true },
  });
  const sport = await db.sport.create({ data: { orgId: org.id, name: "F7", preset: "football-7aside", playersPerTeam: 7, positions: ["GK"], teamLabels: ["Red", "Yellow"], mvpLabel: "MoM", balancingStrategy: "rating-only" } });
  const act = await db.activity.create({ data: { orgId: org.id, sportId: sport.id, name: "T", dayOfWeek: 2, time: "21:00", venue: "V", isActive: true } });
  const future = new Date(Date.now() + 6 * 3600 * 1000);
  // maxPlayers 3 for a tiny squad.
  const match = await db.match.create({ data: { activityId: act.id, date: future, maxPlayers: 3, attendanceDeadline: future, status: "UPCOMING" } });

  const mk = async (n: string, status: "CONFIRMED" | "BENCH", pos: number) => {
    const u = await db.user.create({ data: { name: n, email: `bp-${n}-${tag}@matchtime.local` } });
    await db.attendance.create({ data: { matchId: match.id, userId: u.id, status, position: pos } });
    return u.id;
  };
  const c1 = await mk("C1", "CONFIRMED", 1);
  const c2 = await mk("C2", "CONFIRMED", 2);   // squad 2/3 → one free slot
  const enayem = await mk("Enayem", "BENCH", 3);
  const burak = await mk("Burak", "BENCH", 4);
  void c1; void c2;

  // Third-party registerFor for Burak (NO promoteFromBench) → stays BENCH.
  await registerAttendance(burak, match.id, {});
  let bA = await db.attendance.findUnique({ where: { matchId_userId: { matchId: match.id, userId: burak } } });
  chk(bA?.status === "BENCH", `3rd-party register for a bencher does NOT promote (Burak ${bA?.status})`);

  // Enayem's OWN IN (promoteFromBench) with a free slot → CONFIRMED.
  const r = await registerAttendance(enayem, match.id, { promoteFromBench: true });
  chk(r.status === "CONFIRMED", `bench player's own IN with room → CONFIRMED (got ${r.status})`);
  const eA = await db.attendance.findUnique({ where: { matchId_userId: { matchId: match.id, userId: enayem } } });
  chk(eA?.status === "CONFIRMED", `Enayem promoted from bench (got ${eA?.status})`);
  bA = await db.attendance.findUnique({ where: { matchId_userId: { matchId: match.id, userId: burak } } });
  chk(bA?.status === "BENCH", `Burak still BENCH — not auto-promoted by Baki-style nudge (got ${bA?.status})`);

  // Squad now 3/3 (full). Burak's OWN IN → must stay BENCH (no overfill).
  const r2 = await registerAttendance(burak, match.id, { promoteFromBench: true });
  chk(r2.status === "BENCH", `own IN when squad FULL stays BENCH, no overfill (got ${r2.status})`);

  // forceBench beats promoteFromBench.
  const c3 = await mk("C3spare", "BENCH", 5);
  await db.match.update({ where: { id: match.id }, data: { maxPlayers: 10 } }); // make room
  const r3 = await registerAttendance(c3, match.id, { promoteFromBench: true, forceBench: true });
  chk(r3.status === "BENCH", `forceBench overrides promoteFromBench (got ${r3.status})`);

  // teardown
  await db.attendance.deleteMany({ where: { matchId: match.id } });
  await db.botJob.deleteMany({ where: { orgId: org.id } });
  await db.match.deleteMany({ where: { activityId: act.id } });
  await db.activity.deleteMany({ where: { orgId: org.id } });
  await db.sport.deleteMany({ where: { orgId: org.id } });
  for (const id of [c1, c2, enayem, burak, c3]) await db.user.delete({ where: { id } }).catch(() => {});
  await db.organisation.delete({ where: { id: org.id } });

  console.log(`\n${pass ? "ALL PASS" : "FAILURES"}`);
  await db.$disconnect();
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
