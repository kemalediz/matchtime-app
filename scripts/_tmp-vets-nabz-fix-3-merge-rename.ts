/**
 * One-off (2026-11-03, approved by Kemal): the APPLY for steps 2 and 3.
 * Dry run of the merge + the 9 Nov simulation: _tmp-vets-nabz-fix-2-merge.ts.
 *
 * One transaction, so the group's list never shows a half-done state:
 *   - the merge exactly as `applyUserMerge` does it (both users locked,
 *     snapshot, plan, refuse on any blocker, `applyMergePlan`);
 *   - the rename as `updatePlayerName` does it (club-owned record only):
 *     User.name "smiler" -> "Nabz";
 *   - "smiler" kept as an alias at the Vets as `addPlayerAlias` does it
 *     (aliases are stored lowercased + diacritic-stripped, so one row
 *     covers "smiler" and "Smiler").
 * Then the monthly week's own bookkeeping on 9 Nov (`takeMonthlySlot`,
 * `syncMonthlyWeek`). Nothing here posts or DMs.
 *
 *   npx tsx --env-file=.env scripts/_tmp-vets-nabz-fix-3-merge-rename.ts          # dry run
 *   npx tsx --env-file=.env scripts/_tmp-vets-nabz-fix-3-merge-rename.ts --apply
 */
import { db } from "../src/lib/db.ts";
import { applyMergePlan, loadMergeSnapshot } from "../src/lib/user-merge.ts";
import { aliasNorm, planUserMerge, summarisePlan } from "../src/lib/user-merge-plan.ts";
import { isClubOwnedUser } from "../src/lib/player-account-guard.ts";
import { syncMonthlyWeek, takeMonthlySlot } from "../src/lib/monthly-week.ts";

const S = "cmw0llrw90000wv9k0ta8k8io"; // Nabz (source)
const T = "cmvzuu1h0000408i73gv6fkb1"; // smiler (target)
const ORG = "cmvzlm8km000707iihou1ut9h";
const NOV9 = "cmvzw1o9a000208l6pb9xe31n";
const NEW_NAME = "Nabz";
const OLD_ALIAS = aliasNorm("smiler");
const APPLY = process.argv.includes("--apply");

async function main() {
  const memberships = await db.membership.findMany({ where: { userId: T }, select: { orgId: true, leftAt: true } });
  const owned = await isClubOwnedUser(T, ORG);
  const aliasHolder = await db.userAlias.findUnique({ where: { orgId_alias: { orgId: ORG, alias: OLD_ALIAS } }, select: { userId: true } });
  console.log(`target clubs: ${JSON.stringify(memberships)}; club-owned (rename allowed): ${owned}; alias "${OLD_ALIAS}" held by: ${aliasHolder?.userId ?? "nobody"}`);
  if (memberships.some((m) => m.orgId !== ORG)) throw new Error("target is a member of another club: report before renaming");
  if (!owned) throw new Error("updatePlayerName would refuse: not a club-owned record");
  if (aliasHolder && aliasHolder.userId !== T) throw new Error("alias taken by someone else");
  if (!APPLY) return console.log("DRY RUN: nothing written.");

  const plan = await db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id IN (${S}, ${T}) FOR UPDATE`;
      const snapshot = await loadMergeSnapshot(tx, S, T);
      const p = planUserMerge(snapshot, { now: new Date() });
      if (p.blockers.length > 0) throw new Error(`merge blocked: ${p.blockers.join("; ")}`);
      if (!p.noop) await applyMergePlan(tx, p, { actorKind: "script" });
      await tx.user.update({ where: { id: T }, data: { name: NEW_NAME } });
      if (!aliasHolder) await tx.userAlias.create({ data: { orgId: ORG, userId: T, alias: OLD_ALIAS, source: "manual" } });
      return p;
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
  console.log(`MERGE + RENAME committed: noop=${plan.noop} ${JSON.stringify(summarisePlan(plan))}`);
  console.log("takeMonthlySlot:", JSON.stringify(await takeMonthlySlot(NOV9, T)));
  console.log("syncMonthlyWeek:", JSON.stringify(await syncMonthlyWeek(NOV9)));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
