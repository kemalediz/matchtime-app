/**
 * Live proof vs prod:
 *  A) MoM+rating-only org → /analyze short-circuits (no LLM):
 *     ignored = "no-message-driven-features".
 *  B) attendance org, teams generated, A & B both CONFIRMED →
 *     "swap A with B" swaps their teams, NOBODY dropped.
 * Self-wiping synthetic orgs.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const API = process.env.MATCHTIME_API_URL || "https://matchtime.ai";
const KEY = process.env.WHATSAPP_API_KEY!;
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
let pass = true;
const chk = (ok: boolean, m: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${m}`); if (!ok) pass = false; };
const post = (b: unknown) =>
  fetch(`${API}/api/whatsapp/analyze`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": KEY }, body: JSON.stringify(b) }).then((r) => r.json());
const msg = (gid: string, body: string) => ({ groupId: gid, history: [], messages: [{ waMessageId: `t-${gid}-${Math.random().toString(36).slice(2)}`, body, authorPhone: "", authorName: "Tester", timestamp: new Date().toISOString() }] });

async function mkOrg(tag: string, feats: Record<string, boolean>) {
  return db.organisation.create({
    data: {
      name: `SW ${tag}`, slug: `sw-${tag}`, whatsappGroupId: `sw-${tag}@g.us`, whatsappBotEnabled: true,
      featureAttendance: !!feats.attendance, featureBench: !!feats.bench, featureTeamBalancing: !!feats.teamBalancing,
      featureMomVoting: !!feats.momVoting, featurePlayerRating: !!feats.playerRating, featureReminders: !!feats.reminders,
      featureStatsQa: !!feats.statsQa,
      sports: { create: { name: "F7", preset: "football-7aside", playersPerTeam: 7, positions: ["GK"], teamLabels: ["Red", "Yellow"], mvpLabel: "MoM", balancingStrategy: "rating-only" } },
    }, include: { sports: true },
  });
}
async function wipe(orgId: string, gid: string) {
  const acts = await db.activity.findMany({ where: { orgId }, select: { id: true } });
  for (const a of acts) { await db.benchSlotOffer.deleteMany({ where: { match: { activityId: a.id } } }); await db.teamAssignment.deleteMany({ where: { match: { activityId: a.id } } }); await db.attendance.deleteMany({ where: { match: { activityId: a.id } } }); await db.match.deleteMany({ where: { activityId: a.id } }); }
  await db.activity.deleteMany({ where: { orgId } });
  await db.sport.deleteMany({ where: { orgId } });
  await db.botJob.deleteMany({ where: { orgId } });
  await db.analyzedMessage.deleteMany({ where: { orgId } });
  await db.onboardingSession.deleteMany({ where: { whatsappGroupId: gid } });
  await db.organisation.delete({ where: { id: orgId } });
}

async function main() {
  // A) MoM-only → skip
  const tA = Date.now().toString(36) + "a";
  const oA = await mkOrg(tA, { momVoting: true, playerRating: true });
  const rA = await post(msg(oA.whatsappGroupId!, "hello team, anyone around?"));
  chk(rA.ignored === "no-message-driven-features", `MoM-only org: analyzer skipped (ignored=${rA.ignored})`);
  await wipe(oA.id, oA.whatsappGroupId!);

  // B) attendance org, teams generated, A & B confirmed → swap not drop
  const tB = Date.now().toString(36) + "b";
  const oB = await mkOrg(tB, { attendance: true, teamBalancing: true });
  const act = await db.activity.create({ data: { orgId: oB.id, sportId: oB.sports[0].id, name: "T", dayOfWeek: 2, time: "21:00", venue: "V", isActive: true } });
  const match = await db.match.create({ data: { activityId: act.id, date: new Date(Date.now() + 6 * 3600e3), maxPlayers: 14, attendanceDeadline: new Date(Date.now() + 6 * 3600e3), status: "TEAMS_GENERATED" } });
  const mkU = async (n: string, team: "RED" | "YELLOW", pos: number) => {
    const u = await db.user.create({ data: { name: n, email: `sw-${n}-${tB}@matchtime.local`, phoneNumber: `+44799${tB.slice(-5)}${pos}` } });
    await db.attendance.create({ data: { matchId: match.id, userId: u.id, status: "CONFIRMED", position: pos } });
    await db.teamAssignment.create({ data: { matchId: match.id, userId: u.id, team } });
    return u;
  };
  const alice = await mkU("Alice", "RED", 1);
  const bob = await mkU("Bob", "YELLOW", 2);
  await mkU("Cara", "RED", 3); await mkU("Dan", "YELLOW", 4);

  await post(msg(oB.whatsappGroupId!, "@MatchTime swap Alice with Bob please, then post the teams again"));
  await new Promise((r) => setTimeout(r, 1500));

  const aAtt = await db.attendance.findUnique({ where: { matchId_userId: { matchId: match.id, userId: alice.id } } });
  const bAtt = await db.attendance.findUnique({ where: { matchId_userId: { matchId: match.id, userId: bob.id } } });
  chk(aAtt?.status === "CONFIRMED" && bAtt?.status === "CONFIRMED", `nobody dropped (Alice=${aAtt?.status}, Bob=${bAtt?.status})`);
  const aTA = await db.teamAssignment.findUnique({ where: { matchId_userId: { matchId: match.id, userId: alice.id } } });
  const bTA = await db.teamAssignment.findUnique({ where: { matchId_userId: { matchId: match.id, userId: bob.id } } });
  chk(aTA?.team === "YELLOW" && bTA?.team === "RED", `teams swapped (Alice ${aTA?.team}, Bob ${bTA?.team})`);
  const drops = await db.attendance.count({ where: { matchId: match.id, status: "DROPPED" } });
  chk(drops === 0, `zero DROPPED rows (got ${drops})`);
  const offers = await db.benchSlotOffer.count({ where: { matchId: match.id } });
  chk(offers === 0, `no bench offer opened (got ${offers})`);

  await wipe(oB.id, oB.whatsappGroupId!);
  console.log(`\n${pass ? "ALL PASS" : "FAILURES"}`);
  await db.$disconnect();
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
