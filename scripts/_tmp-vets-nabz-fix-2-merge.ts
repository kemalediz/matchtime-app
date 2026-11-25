/**
 * One-off (2026-11-03, approved by Kemal): fold "Nabz" (phoneless, created
 * by a script) into "smiler" (+447983882605, the real one) at the Vets,
 * then make his 9 Nov place the November REGULAR's place.
 *
 *   1. the merge tool (`applyUserMerge`, src/lib/user-merge.ts). On 9 Nov
 *      both rows are CONFIRMED, so the planner keeps the target's row (the
 *      PAYG one smiler took by DM) and deletes the source's; the regular's
 *      SquadMonthMember (slot 13, paid claimed) moves to smiler.
 *   2. the monthly week's own bookkeeping on that kept row, so it is the
 *      regular's and not a PAYG place:
 *        `takeMonthlySlot`  a regular takes his own slot (13), with its
 *                           AttendanceEvent;
 *        `syncMonthlyWeek`  a regular's row carries paymentMethod "monthly"
 *                           (every per-match payment path skips it).
 *      Both are what the attendance write path runs after a change on a
 *      monthly club (`afterMonthlyAttendanceChange`); neither posts or DMs.
 *
 * The dry run also shows what the scheduler will do next on 9 Nov: the week
 * list it would post (and whether it differs from the one the group saw
 * last), the offers `ensureOpenPlaceOffers` would open and the PAYG pool
 * they would go to.
 *
 *   npx tsx --env-file=.env scripts/_tmp-vets-nabz-fix-2-merge.ts          # dry run
 *   npx tsx --env-file=.env scripts/_tmp-vets-nabz-fix-2-merge.ts --apply
 */
import { db } from "../src/lib/db.ts";
import { applyUserMerge, dryRunUserMerge } from "../src/lib/user-merge.ts";
import { summarisePlan } from "../src/lib/user-merge-plan.ts";
import { loadMonthlyWeek, loadPaygPool, syncMonthlyWeek, takeMonthlySlot, weekListKeyPrefix, type MonthlyWeek } from "../src/lib/monthly-week.ts";
import { buildWeekList, decideSlotFor, planOpenPlaceOffers, weekListHash } from "../src/lib/monthly-week-rules.ts";
import { buildWeekListPost } from "../src/lib/monthly-week-copy.ts";
import { loadPlayerNames } from "../src/lib/player-display-name.ts";

const S = "cmw0llrw90000wv9k0ta8k8io"; // Nabz (source)
const T = "cmvzuu1h0000408i73gv6fkb1"; // smiler (target)
const NOV9 = "cmvzw1o9a000208l6pb9xe31n";
const NEW_NAME = "Nabz"; // step 3 renames the target; the list is shown with it
const APPLY = process.argv.includes("--apply");

async function render(week: MonthlyWeek, nameOverride: Map<string, string>) {
  const list = buildWeekList({ members: week.members, rows: week.rows, maxPlayers: week.maxPlayers });
  const ids = [
    ...list.slots.map((x) => x.userId).filter((u): u is string => u !== null),
    ...list.paidCantPlay.map((n) => n.userId),
    ...list.cantPlay.map((n) => n.userId),
    ...list.reserves.map((n) => n.userId),
  ];
  const known = await loadPlayerNames(week.orgId, ids, week.language);
  const named = <X extends { userId: string | null; name: string }>(x: X): X =>
    x.userId && nameOverride.has(x.userId) ? { ...x, name: nameOverride.get(x.userId)! } : x.userId && known.get(x.userId)?.name ? { ...x, name: known.get(x.userId)!.name! } : x;
  const shown = { ...list, slots: list.slots.map(named), paidCantPlay: list.paidCantPlay.map(named), cantPlay: list.cantPlay.map(named), reserves: list.reserves.map(named) };
  const text = buildWeekListPost({ list: shown, matchDate: week.matchDate, title: week.activityName, paygPricePence: week.paygPricePence, organiserPicks: week.pickMode === "organiser", lang: week.language });
  return { list, text, hash: weekListHash(text) };
}

async function nov9Rows(label: string) {
  const rows = await db.attendance.findMany({
    where: { matchId: NOV9, userId: { in: [S, T] } },
    select: { id: true, userId: true, status: true, position: true, paymentMethod: true, paidAt: true },
  });
  console.log(`\n${label} 9 Nov rows for him: ${JSON.stringify(rows)}`);
  const count = await db.attendance.count({ where: { matchId: NOV9, status: "CONFIRMED" } });
  console.log(`  CONFIRMED on 9 Nov: ${count}`);
}

async function main() {
  const { plan, snapshot } = await dryRunUserMerge(db, S, T);
  console.log(`MERGE DRY RUN: blockers ${JSON.stringify(plan.blockers)}`);
  for (const o of plan.ops) console.log(`  ${o.kind.toUpperCase()} ${"table" in o ? o.table : "attendanceEvent"} ${"id" in o ? o.id : ""} ${"set" in o ? JSON.stringify(o.set) : ""} ${"data" in o ? JSON.stringify(o.data) : ""} ${"transition" in o ? JSON.stringify(o.transition) : ""} : ${o.why}`);
  console.log(`  SUMMARY ${JSON.stringify(summarisePlan(plan))}`);
  console.log(`  source seed ${snapshot.memberships.find((m) => m.userId === S)?.seedRating}, target seed ${snapshot.memberships.find((m) => m.userId === T)?.seedRating}`);
  if (plan.blockers.length) throw new Error("merge blocked");
  await nov9Rows("BEFORE");

  // ── What 9 Nov looks like after the merge + bookkeeping (simulated) ──
  const week = await loadMonthlyWeek(NOV9);
  if (!week) throw new Error("no monthly week for 9 Nov");
  const prefix = weekListKeyPrefix(NOV9);
  const last = await db.sentNotification.findFirst({ where: { matchId: NOV9, key: { startsWith: prefix } }, orderBy: { createdAt: "desc" }, select: { key: true, kind: true, createdAt: true } });
  const lastHash = last ? last.key.slice(prefix.length).split(":")[0] : null;
  const now = await render(week, new Map());
  console.log(`\nlast list the group saw: ${last?.key} (${last?.kind}) at ${last?.createdAt.toISOString()}`);
  console.log(`list as it stands now (hash ${now.hash}, open ${now.list.open}):\n${now.text}`);

  const simMembers = week.members.map((m) => (m.userId === S ? { ...m, userId: T, name: NEW_NAME } : m));
  let simRows = week.rows.filter((r) => r.userId !== S);
  const slot = decideSlotFor({ members: simMembers, rows: simRows, maxPlayers: week.maxPlayers, userId: T });
  simRows = simRows.map((r) => (r.userId === T ? { ...r, position: slot?.slot ?? r.position } : r));
  const sim: MonthlyWeek = { ...week, members: simMembers, rows: simRows };
  const after = await render(sim, new Map([[T, NEW_NAME]]));
  console.log(`\ntakeMonthlySlot would give him slot ${JSON.stringify(slot)}`);
  console.log(`list after the repair (hash ${after.hash}, open ${after.list.open}; same as last seen: ${after.hash === lastHash}):\n${after.text}`);
  const offers = await db.benchSlotOffer.findMany({ where: { matchId: NOV9, resolvedAt: null }, select: { id: true, replacingUserId: true } });
  const planned = planOpenPlaceOffers({ members: simMembers, rows: simRows, maxPlayers: week.maxPlayers, openOffers: offers.map((o) => o.replacingUserId) });
  const pool = await loadPaygPool({ orgId: week.orgId, members: simMembers, rows: simRows });
  const bench = simRows.filter((r) => r.status === "BENCH").length;
  console.log(`\nopen offers now ${offers.length}; ensureOpenPlaceOffers would plan ${planned.length} (${JSON.stringify(planned)}), but opens one ONLY with a bench (${bench}) or a PAYG pool (${pool.length}: ${JSON.stringify(pool.map((p) => p.name))})`);
  console.log(`=> offers opened: ${bench > 0 || pool.length > 0 ? planned.length : 0}; payg-pool DMs/group line: ${pool.length > 0 ? "YES" : "none"}`);
  if (!APPLY) return console.log("\nDRY RUN: nothing written.");
  if (pool.length > 0 || bench > 0) throw new Error("an open-place offer would go out: STOP");

  const res = await applyUserMerge(db, S, T, { actorKind: "script" });
  console.log(`\nMERGE: ok=${res.ok} noop=${"noop" in res ? res.noop : "-"} ${JSON.stringify(summarisePlan(res.plan))}`);
  if (!res.ok) throw new Error("merge refused");
  await nov9Rows("AFTER MERGE");
  console.log("takeMonthlySlot:", JSON.stringify(await takeMonthlySlot(NOV9, T)));
  console.log("syncMonthlyWeek:", JSON.stringify(await syncMonthlyWeek(NOV9)));
  await nov9Rows("AFTER BOOKKEEPING");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
