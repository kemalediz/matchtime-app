/**
 * Bench redesign end-to-end (non-destructive — synthetic org, wiped).
 * Asserts: a drop opens ONE offer to the whole bench; the FIRST
 * claimer wins (promoted + announce); a second claimer is told it's
 * gone but STAYS on the bench; a decline is a no-op; nobody is ever
 * dropped for silence; offer auto-closes at kickoff.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { cancelAttendance } from "../src/lib/attendance.ts";
import { resolveBenchConfirmation } from "../src/lib/bench-confirmation.ts";
import { sweepExpiredBenchConfirmations } from "../src/lib/bot-scheduler.ts";

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
} as any);

let pass = true;
const chk = (ok: boolean, m: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${m}`);
  if (!ok) pass = false;
};

async function main() {
  const tag = Date.now().toString(36);
  const org = await db.organisation.create({
    data: {
      name: `BenchTest ${tag}`,
      slug: `benchtest-${tag}`,
      whatsappGroupId: `bench-${tag}@g.us`,
      whatsappBotEnabled: true,
      sports: {
        create: {
          name: "Football 7-a-side", preset: "football-7aside",
          playersPerTeam: 7, positions: ["GK", "DEF", "MID", "FWD"],
          teamLabels: ["Red", "Yellow"], mvpLabel: "Man of the Match",
          balancingStrategy: "position-aware",
        },
      },
    },
    include: { sports: true },
  });
  const act = await db.activity.create({
    data: { orgId: org.id, sportId: org.sports[0].id, name: "T", dayOfWeek: 2, time: "21:00", venue: "V", isActive: true },
  });
  const future = new Date(Date.now() + 6 * 60 * 60 * 1000);
  const match = await db.match.create({
    data: { activityId: act.id, date: future, maxPlayers: 14, attendanceDeadline: future, status: "TEAMS_PUBLISHED" },
  });

  const mkUser = async (name: string, status: "CONFIRMED" | "BENCH", pos: number) => {
    const u = await db.user.create({
      data: { name, email: `bt-${name}-${tag}@matchtime.local`, phoneNumber: `+44700${tag.slice(-4)}${pos}` },
    });
    await db.attendance.create({ data: { matchId: match.id, userId: u.id, status, position: pos } });
    return u;
  };
  const dropper = await mkUser("Dropper", "CONFIRMED", 1);
  await db.teamAssignment.create({ data: { matchId: match.id, userId: dropper.id, team: "RED" } });
  const a = await mkUser("BenchA", "BENCH", 2);
  const b = await mkUser("BenchB", "BENCH", 3);
  const c = await mkUser("BenchC", "BENCH", 4);

  // 1. Confirmed player drops → exactly ONE open offer, NOBODY dropped.
  await cancelAttendance(dropper.id, match.id);
  let offers = await db.benchSlotOffer.findMany({ where: { matchId: match.id, resolvedAt: null } });
  chk(offers.length === 1, `drop opens exactly 1 offer (got ${offers.length})`);
  chk(offers[0].replacingUserId === dropper.id, "offer carries the dropped player's id");
  let benchCount = await db.attendance.count({ where: { matchId: match.id, status: "BENCH" } });
  chk(benchCount === 3, `all 3 benchers still BENCH after the drop (got ${benchCount})`);

  // 2. Second drop with no new bench → still fine (no offer if dup id).
  const dup = await resolveBenchConfirmation({ matchId: match.id, userId: a.id, decision: false });
  chk(dup.kind === "declined", `BenchA declines → no-op "declined" (got ${dup.kind})`);
  benchCount = await db.attendance.count({ where: { matchId: match.id, status: "BENCH" } });
  chk(benchCount === 3, `decline drops NOBODY — still 3 on bench (got ${benchCount})`);

  // 3. BenchB claims → promoted, TA transferred, offer resolved.
  const claim = await resolveBenchConfirmation({ matchId: match.id, userId: b.id, decision: true });
  chk(claim.kind === "confirmed", `BenchB claim → confirmed (got ${claim.kind})`);
  const bAtt = await db.attendance.findUnique({ where: { matchId_userId: { matchId: match.id, userId: b.id } } });
  chk(bAtt?.status === "CONFIRMED", `BenchB is now CONFIRMED (got ${bAtt?.status})`);
  const bTA = await db.teamAssignment.findUnique({ where: { matchId_userId: { matchId: match.id, userId: b.id } } });
  chk(bTA?.team === "RED", `BenchB inherited Dropper's RED team slot (got ${bTA?.team})`);
  offers = await db.benchSlotOffer.findMany({ where: { matchId: match.id, resolvedAt: null } });
  chk(offers.length === 0, `offer resolved after claim (open offers ${offers.length})`);

  // 4. BenchC tries to claim the now-gone slot → ignored, STILL on bench.
  const late = await resolveBenchConfirmation({ matchId: match.id, userId: c.id, decision: true });
  chk(late.kind === "ignored", `late claim → ignored (got ${late.kind})`);
  const cAtt = await db.attendance.findUnique({ where: { matchId_userId: { matchId: match.id, userId: c.id } } });
  chk(cAtt?.status === "BENCH", `BenchC still BENCH after missing it (got ${cAtt?.status})`);
  const aAtt = await db.attendance.findUnique({ where: { matchId_userId: { matchId: match.id, userId: a.id } } });
  chk(aAtt?.status === "BENCH", `BenchA (declined earlier) still BENCH — never dropped (got ${aAtt?.status})`);

  // 5. New drop opens a fresh offer; sweep at kickoff closes it w/o dropping anyone.
  const dropper2 = await db.user.findUnique({ where: { id: a.id } }); // reuse: confirm A then drop
  await db.attendance.update({ where: { matchId_userId: { matchId: match.id, userId: a.id } }, data: { status: "CONFIRMED" } });
  await cancelAttendance(a.id, match.id);
  offers = await db.benchSlotOffer.findMany({ where: { matchId: match.id, resolvedAt: null } });
  chk(offers.length === 1, `new drop opens a fresh offer (got ${offers.length})`);
  await db.match.update({ where: { id: match.id }, data: { date: new Date(Date.now() - 1000) } });
  await sweepExpiredBenchConfirmations(org.id);
  offers = await db.benchSlotOffer.findMany({ where: { matchId: match.id, resolvedAt: null } });
  chk(offers.length === 0, `kickoff sweep closes the open offer (got ${offers.length})`);
  const cStill = await db.attendance.findUnique({ where: { matchId_userId: { matchId: match.id, userId: c.id } } });
  chk(cStill?.status === "BENCH", `sweep dropped NOBODY — BenchC still BENCH (got ${cStill?.status})`);
  void dropper2;

  // teardown
  await db.benchSlotOffer.deleteMany({ where: { matchId: match.id } });
  await db.teamAssignment.deleteMany({ where: { matchId: match.id } });
  await db.attendance.deleteMany({ where: { matchId: match.id } });
  await db.botJob.deleteMany({ where: { orgId: org.id } });
  await db.match.deleteMany({ where: { activityId: act.id } });
  await db.activity.deleteMany({ where: { orgId: org.id } });
  await db.sport.deleteMany({ where: { orgId: org.id } });
  for (const u of [dropper, a, b, c]) await db.user.delete({ where: { id: u.id } }).catch(() => {});
  await db.organisation.delete({ where: { id: org.id } });

  console.log(`\n${pass ? "ALL PASS" : "FAILURES"}`);
  await db.$disconnect();
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
