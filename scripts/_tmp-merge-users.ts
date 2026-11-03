/**
 * One-off: fold one User into another (2026-11-03). The rules are in
 * src/lib/user-merge-plan.ts; the reads and writes in src/lib/user-merge.ts.
 *
 *   # Dry run (default): one READ ONLY transaction, prints every row it
 *   # would move, every conflict and how it is resolved. Writes nothing.
 *   npx tsx --env-file=.env scripts/_tmp-merge-users.ts --source <userId> --target <userId>
 *
 *   # Apply: one transaction, both users locked. Needs migration
 *   # 20261103120000_user_merge_detail applied first.
 *   npx tsx --env-file=.env scripts/_tmp-merge-users.ts --source <id> --target <id> --apply
 *
 * Idempotent: a second --apply over a merged pair is a no-op.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { applyUserMerge, dryRunUserMerge } from "../src/lib/user-merge.ts";
import { summarisePlan, type MergePlan, type MergeSnapshot } from "../src/lib/user-merge-plan.ts";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

const fmt = (v: unknown) => JSON.stringify(v, (_k, x) => (x instanceof Date ? x.toISOString() : x));

function printPlan(plan: MergePlan, snap: MergeSnapshot | null) {
  if (snap) {
    const u = (x: MergeSnapshot["source"]) =>
      `${x.id} name=${fmt(x.name)} phone=${x.phoneNumber ?? "none"} email=${x.email} active=${x.isActive}`;
    console.log(`SOURCE ${u(snap.source)}`);
    console.log(`TARGET ${u(snap.target)}`);
    const orgs = (id: string) =>
      snap.memberships.filter((m) => m.userId === id).map((m) => `${m.orgId}(${m.role}${m.leftAt ? ",left" : ""},seed=${m.seedRating},elo=${m.matchRating})`);
    console.log(`  source memberships: ${orgs(snap.source.id).join(" ") || "none"}`);
    console.log(`  target memberships: ${orgs(snap.target.id).join(" ") || "none"}`);
  }
  if (plan.blockers.length > 0) {
    console.log("\nBLOCKED, nothing would be written:");
    for (const b of plan.blockers) console.log(`  - ${b}`);
    return;
  }
  if (plan.noop) {
    console.log("\nNO-OP: already merged, nothing left to move.");
    return;
  }
  console.log(`\nOPS (${plan.ops.length}), in execution order:`);
  for (const o of plan.ops) {
    if (o.kind === "delete") console.log(`  DELETE ${o.table} ${o.id}: ${o.why}`);
    else if (o.kind === "update") console.log(`  UPDATE ${o.table} ${o.id} set ${fmt(o.set)}: ${o.why}`);
    else if (o.kind === "create") console.log(`  CREATE ${o.table} ${fmt(o.data)}: ${o.why}`);
    else console.log(`  APPEND attendanceEvent ${fmt(o.transition)}: ${o.why}`);
  }
  console.log(`\nCONFLICTS (${plan.conflicts.length}):`);
  for (const c of plan.conflicts) console.log(`  ${c.table} ${c.rowId}: ${c.rule}`);
  console.log(`\nALIAS added: ${plan.alias ?? "none"}`);
  console.log(`TOMBSTONES (UserMerge rows): ${plan.tombstoneOrgIds.map((o) => o || '""').join(", ") || "none"}`);
  console.log(`SUMMARY ${fmt(summarisePlan(plan))}`);
}

async function main() {
  const source = arg("--source");
  const target = arg("--target");
  const apply = process.argv.includes("--apply");
  if (!source || !target) {
    console.error("usage: --source <userId> --target <userId> [--apply]");
    process.exit(2);
  }
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as never);
  try {
    if (!apply) {
      console.log(`DRY RUN (read only): merge ${source} into ${target}\n`);
      const { plan, snapshot } = await dryRunUserMerge(db, source, target);
      printPlan(plan, snapshot);
      return;
    }
    console.log(`APPLY: merge ${source} into ${target}\n`);
    const res = await applyUserMerge(db, source, target, { actorKind: "script" });
    printPlan(res.plan, null);
    console.log(res.ok ? (res.noop ? "\nDone: no-op." : "\nDone: committed.") : "\nRefused: nothing written.");
    if (!res.ok) process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
