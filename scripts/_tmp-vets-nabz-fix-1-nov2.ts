/**
 * One-off (2026-11-03, approved by Kemal): Vets, Mon 2 Nov. "Nabz" (the
 * phoneless duplicate of smiler) was recorded on No bibs while smiler was
 * on Bibs; they are one person, who played on Bibs. Take Nabz off the
 * match and put the Elo right, through the app's own paths:
 *
 *   1. attendance: the writes of `removePlayerFromMatch`
 *      (src/app/actions/players.ts): delete the row + an AttendanceEvent
 *      with toStatus null (append-only log; nothing mutated).
 *   2. team sheet: the write of `removeFromTeam` (src/app/actions/teams.ts).
 *   3. Elo: the score-correction path (`setMatchScore` + `reconcileMatchElo`,
 *      src/lib/match-elo.ts, what the dashboard's updateMatchScore calls).
 *      A reconcile only re-runs when the score differs from what the
 *      ratings carry, so the score is corrected 3-4 -> 3-3 (takes back the
 *      stored deltas, incl. Nabz's +19; a draw between equal sides adds 0)
 *      and straight back 3-3 -> 3-4 (applies the result to the corrected
 *      6 v 6 sheet). Neither function posts or DMs anything.
 *
 *   npx tsx --env-file=.env scripts/_tmp-vets-nabz-fix-1-nov2.ts          # dry run
 *   npx tsx --env-file=.env scripts/_tmp-vets-nabz-fix-1-nov2.ts --apply
 */
import { db } from "../src/lib/db.ts";
import { recordAttendanceEvent } from "../src/lib/attendance-events.ts";
import { computeEloDeltas } from "../src/lib/elo.ts";
import { parseEloApplied, reconcileMatchElo, setMatchScore } from "../src/lib/match-elo.ts";

const MATCH = "cmw0llsje0004wv9kazlsvdls";
const ORG = "cmvzlm8km000707iihou1ut9h";
const NABZ = "cmw0llrw90000wv9k0ta8k8io";
const APPLY = process.argv.includes("--apply");

async function show(label: string) {
  const m = await db.match.findUniqueOrThrow({
    where: { id: MATCH },
    select: {
      redScore: true,
      yellowScore: true,
      status: true,
      eloApplied: true,
      teamAssignments: { select: { userId: true, team: true, user: { select: { name: true } } } },
      attendances: { select: { userId: true, status: true } },
    },
  });
  const ids = m.teamAssignments.map((t) => t.userId).concat(NABZ);
  const mem = await db.membership.findMany({ where: { orgId: ORG, userId: { in: ids } }, select: { userId: true, matchRating: true } });
  const r = new Map(mem.map((x) => [x.userId, x.matchRating]));
  const rec = parseEloApplied(m.eloApplied);
  console.log(`\n== ${label}: ${m.status} Bibs(RED) ${m.redScore} - No bibs(YELLOW) ${m.yellowScore}; attendance rows ${m.attendances.length}`);
  for (const team of ["RED", "YELLOW"] as const) {
    const rows = m.teamAssignments.filter((t) => t.team === team);
    console.log(`  ${team === "RED" ? "Bibs" : "No bibs"} (${rows.length}): ${rows.map((t) => `${t.user.name}=${r.get(t.userId)}`).join(", ")}`);
  }
  console.log(`  Nabz rating ${r.get(NABZ)}; on sheet: ${m.teamAssignments.some((t) => t.userId === NABZ)}; attendance: ${m.attendances.some((a) => a.userId === NABZ)}`);
  console.log(`  eloApplied target ${JSON.stringify(rec?.target)} applied ${rec?.applied?.red}-${rec?.applied?.yellow}, ${rec?.applied?.deltas?.length} deltas, names Nabz: ${!!rec?.applied?.deltas?.some((d) => d.userId === NABZ)}`);
  return { m, r, rec };
}

async function main() {
  const { m, r, rec } = await show("BEFORE");
  if (m.redScore !== 3 || m.yellowScore !== 4) throw new Error("score is not 3-4, stop");
  const att = await db.attendance.findUnique({ where: { matchId_userId: { matchId: MATCH, userId: NABZ } }, select: { status: true, position: true } });
  const ta = m.teamAssignments.find((t) => t.userId === NABZ);
  const guest = await db.membership.findUnique({ where: { userId_orgId: { userId: NABZ, orgId: ORG } }, select: { guestFromOrgId: true, guestMatchId: true } });
  console.log(`\nPLAN`);
  console.log(`  delete Attendance (Nabz) ${att ? `${att.status} pos ${att.position}` : "none"} + AttendanceEvent ${att?.status} -> null (admin-squad-edit, script)`);
  console.log(`  delete TeamAssignment (Nabz) ${ta?.team ?? "none"}`);
  console.log(`  Nabz partner guest? ${!!(guest?.guestFromOrgId || guest?.guestMatchId)} (removePlayerFromMatch only tells partner guests; skipped, none)`);

  // What the corrected Elo will be: take back the stored deltas, re-run 3-4 on the corrected sheet.
  const base = new Map(r);
  for (const d of rec?.applied?.deltas ?? []) if (base.has(d.userId)) base.set(d.userId, base.get(d.userId)! - d.delta);
  const sheet = m.teamAssignments.filter((t) => t.userId !== NABZ);
  const deltas = computeEloDeltas(sheet.map((t) => ({ userId: t.userId, team: t.team as "RED" | "YELLOW", matchRating: base.get(t.userId)! })), 3, 4);
  console.log(`  Elo after (6 v 6 = ${sheet.filter((t) => t.team === "RED").length} v ${sheet.filter((t) => t.team === "YELLOW").length}):`);
  for (const d of deltas) {
    const name = sheet.find((t) => t.userId === d.userId)!.user.name;
    console.log(`    ${name}: now ${r.get(d.userId)} -> ${d.after} (${d.delta > 0 ? "+" : ""}${d.delta})`);
  }
  console.log(`    Nabz: now ${r.get(NABZ)} -> ${base.get(NABZ)}`);
  if (!APPLY) return console.log("\nDRY RUN: nothing written.");

  // 1. removePlayerFromMatch's writes.
  if (att) {
    await db.$transaction(async (tx) => {
      await tx.attendance.deleteMany({ where: { matchId: MATCH, userId: NABZ } });
      await recordAttendanceEvent(
        tx,
        { matchId: MATCH, userId: NABZ, orgId: ORG, fromStatus: att.status, toStatus: null, fromPosition: att.position, toPosition: null },
        {
          cause: "admin-squad-edit",
          actorKind: "script",
          sourceRef: "script:_tmp-vets-nabz-fix-1-nov2 (admin:removePlayerFromMatch)",
          note: "attendance row deleted outright: Nabz is smiler (same person), who played on Bibs; approved by Kemal 2026-11-03",
        },
      );
    });
  }
  // 2. removeFromTeam's write.
  await db.teamAssignment.deleteMany({ where: { matchId: MATCH, userId: NABZ } });

  // 3. Score correction there and back, so the reconcile re-runs on the corrected sheet.
  await setMatchScore({ matchId: MATCH, red: 3, yellow: 3, expectPrevious: { red: 3, yellow: 4 } });
  console.log("reconcile 3-3:", JSON.stringify(await reconcileMatchElo({ matchId: MATCH })));
  await setMatchScore({ matchId: MATCH, red: 3, yellow: 4, expectPrevious: { red: 3, yellow: 3 } });
  console.log("reconcile 3-4:", JSON.stringify(await reconcileMatchElo({ matchId: MATCH })));
  await show("AFTER");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
