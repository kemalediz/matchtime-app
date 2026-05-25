/**
 * One-shot data migration: every User.phoneNumber → canonical E.164,
 * with duplicate User rows merged via mergePlayersCore.
 *
 * Why this script exists (2026-05-25):
 *   Same human had multiple User rows with different phone formats
 *   ("+447943789944" vs "07943 789944"), which silently routed
 *   sender-resolution to the wrong row → cancelAttendance no-op'd →
 *   bot looked broken (see Omar incident, MDs/learnings.md). The
 *   Prisma extension in src/lib/db.ts prevents new violations; this
 *   script cleans existing data + installs a DB CHECK constraint so
 *   raw-SQL writes also can't reintroduce the problem.
 *
 * Run:
 *   # Show the plan, no writes:
 *   npx tsx --env-file=.env scripts/normalise-phones-migration.ts
 *
 *   # Execute the merges + canonicalise phones:
 *   npx tsx --env-file=.env scripts/normalise-phones-migration.ts --apply
 *
 *   # After --apply succeeds with 0 violations, install the CHECK:
 *   npx tsx --env-file=.env scripts/normalise-phones-migration.ts --install-constraint
 *
 * Idempotent: re-running with --apply over an already-clean DB is a
 * no-op (no dup clusters found, all phones already canonical).
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { normalisePhone } from "../src/lib/phone.ts";
import { mergePlayersCore } from "../src/lib/merge-players-core.ts";

const APPLY = process.argv.includes("--apply");
const INSTALL_CONSTRAINT = process.argv.includes("--install-constraint");

// NOTE: bypassing the auto-norm extension in src/lib/db.ts ON PURPOSE
// here — the migration WANTS to write canonical values directly without
// going through it again. We also need raw SQL access for the CHECK
// constraint installation.
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
} as never);

interface Dup {
  normalised: string;
  users: Array<{
    id: string;
    name: string | null;
    phoneNumber: string;
    createdAt: Date;
    attendanceCount: number;
  }>;
}

async function scan(): Promise<{
  dups: Dup[];
  rewrites: Array<{ id: string; name: string | null; from: string; to: string }>;
  unnormaliseable: Array<{ id: string; name: string | null; phoneNumber: string }>;
}> {
  const users = await db.user.findMany({
    where: { phoneNumber: { not: null } },
    select: { id: true, name: true, phoneNumber: true, createdAt: true },
  });

  // Group by normalised. Track attendance counts to pick smart keepers.
  const grouped = new Map<string, Dup["users"]>();
  const unnormaliseable: Array<{ id: string; name: string | null; phoneNumber: string }> = [];

  for (const u of users) {
    const n = normalisePhone(u.phoneNumber!);
    if (n === null) {
      unnormaliseable.push({ id: u.id, name: u.name, phoneNumber: u.phoneNumber! });
      continue;
    }
    const attendanceCount = await db.attendance.count({ where: { userId: u.id } });
    const entry = { id: u.id, name: u.name, phoneNumber: u.phoneNumber!, createdAt: u.createdAt, attendanceCount };
    if (!grouped.has(n)) grouped.set(n, []);
    grouped.get(n)!.push(entry);
  }

  const dups: Dup[] = [];
  const rewrites: Array<{ id: string; name: string | null; from: string; to: string }> = [];
  for (const [normalised, group] of grouped) {
    if (group.length > 1) {
      dups.push({ normalised, users: group });
    } else {
      const only = group[0];
      if (only.phoneNumber !== normalised) {
        rewrites.push({ id: only.id, name: only.name, from: only.phoneNumber, to: normalised });
      }
    }
  }
  return { dups, rewrites, unnormaliseable };
}

function pickKeeper(group: Dup["users"]): { keep: Dup["users"][0]; drops: Dup["users"] } {
  // Priority: most attendance → oldest createdAt → lexicographic id.
  const sorted = [...group].sort((a, b) => {
    if (a.attendanceCount !== b.attendanceCount) return b.attendanceCount - a.attendanceCount;
    if (a.createdAt.getTime() !== b.createdAt.getTime()) return a.createdAt.getTime() - b.createdAt.getTime();
    return a.id.localeCompare(b.id);
  });
  return { keep: sorted[0], drops: sorted.slice(1) };
}

async function sharedOrgIds(keepUserId: string, dropUserId: string): Promise<string[]> {
  const keepMembers = await db.membership.findMany({ where: { userId: keepUserId }, select: { orgId: true } });
  const dropMembers = await db.membership.findMany({ where: { userId: dropUserId }, select: { orgId: true } });
  const keepSet = new Set(keepMembers.map((m) => m.orgId));
  // Save the alias to all orgs where the drop user had a membership AND
  // the keep user does too (so a future resolveSender in that org finds
  // the keeper via the dropped name).
  return dropMembers.map((m) => m.orgId).filter((id) => keepSet.has(id));
}

async function runMerges(dups: Dup[]): Promise<{ merges: number; failures: Array<{ keep: string; drop: string; err: string }> }> {
  let merges = 0;
  const failures: Array<{ keep: string; drop: string; err: string }> = [];
  for (const dup of dups) {
    const { keep, drops } = pickKeeper(dup.users);
    for (const drop of drops) {
      const aliasOrgs = await sharedOrgIds(keep.id, drop.id);
      console.log(`  MERGE: keep ${keep.id} (${JSON.stringify(keep.name)}, attendance=${keep.attendanceCount}) ← drop ${drop.id} (${JSON.stringify(drop.name)}, attendance=${drop.attendanceCount}); alias-orgs=${aliasOrgs.length}`);
      if (!APPLY) continue;
      try {
        await db.$transaction(async (tx) => {
          await mergePlayersCore(tx, keep.id, drop.id, { saveAliasInOrgIds: aliasOrgs });
        }, { timeout: 60_000 });
        merges++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failures.push({ keep: keep.id, drop: drop.id, err: msg });
        console.error(`    ✗ merge failed:`, msg);
      }
    }
  }
  return { merges, failures };
}

async function runRewrites(rewrites: Array<{ id: string; name: string | null; from: string; to: string }>): Promise<{ rewritten: number; failures: Array<{ id: string; err: string }> }> {
  let rewritten = 0;
  const failures: Array<{ id: string; err: string }> = [];
  for (const r of rewrites) {
    console.log(`  REWRITE: ${r.id} (${JSON.stringify(r.name)}) ${JSON.stringify(r.from)} → ${JSON.stringify(r.to)}`);
    if (!APPLY) continue;
    try {
      await db.user.update({ where: { id: r.id }, data: { phoneNumber: r.to } });
      rewritten++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push({ id: r.id, err: msg });
      console.error(`    ✗ rewrite failed:`, msg);
    }
  }
  return { rewritten, failures };
}

async function runUnnormaliseableNull(rows: Array<{ id: string; name: string | null; phoneNumber: string }>): Promise<{ nulled: number }> {
  let nulled = 0;
  for (const r of rows) {
    console.log(`  NULL-OUT (junk phone): ${r.id} (${JSON.stringify(r.name)}) stored=${JSON.stringify(r.phoneNumber)}`);
    if (!APPLY) continue;
    await db.user.update({ where: { id: r.id }, data: { phoneNumber: null } });
    nulled++;
  }
  return { nulled };
}

async function installCheckConstraint(): Promise<void> {
  // Drop first if it exists, so re-running is idempotent.
  await db.$executeRawUnsafe(`ALTER TABLE "User" DROP CONSTRAINT IF EXISTS user_phone_e164;`);
  // E.164: + followed by 7–15 digits, first digit 1-9 (no leading 0).
  await db.$executeRawUnsafe(
    `ALTER TABLE "User" ADD CONSTRAINT user_phone_e164 CHECK ("phoneNumber" IS NULL OR "phoneNumber" ~ '^\\+[1-9][0-9]{6,14}$');`,
  );
  console.log("  ✓ CHECK constraint user_phone_e164 installed.");
}

async function verifyCleanState(): Promise<{ ok: boolean; reasons: string[] }> {
  const reasons: string[] = [];
  const { dups, rewrites, unnormaliseable } = await scan();
  if (dups.length > 0) reasons.push(`${dups.length} duplicate cluster(s) remain`);
  if (rewrites.length > 0) reasons.push(`${rewrites.length} non-canonical phone(s) remain`);
  if (unnormaliseable.length > 0) reasons.push(`${unnormaliseable.length} unnormaliseable phone(s) remain`);
  return { ok: reasons.length === 0, reasons };
}

async function main() {
  console.log(`=== phone-normalise migration — mode: ${INSTALL_CONSTRAINT ? "install-constraint" : APPLY ? "APPLY" : "DRY-RUN"} ===`);
  console.log("");

  if (INSTALL_CONSTRAINT) {
    const { ok, reasons } = await verifyCleanState();
    if (!ok) {
      console.error("✗ Refusing to install CHECK constraint while violations remain:");
      for (const r of reasons) console.error("    -", r);
      console.error("  Run with --apply first, then re-run with --install-constraint.");
      process.exit(1);
    }
    await installCheckConstraint();
    await db.$disconnect();
    return;
  }

  const { dups, rewrites, unnormaliseable } = await scan();
  console.log(`Found ${dups.length} duplicate phone cluster(s), ${rewrites.length} non-canonical rewrite(s), ${unnormaliseable.length} unnormaliseable.`);
  console.log("");

  if (dups.length > 0) {
    console.log("--- DUPLICATES ---");
    for (const d of dups) {
      console.log(`\n  canonical ${d.normalised}:`);
      for (const u of d.users) console.log(`    - ${u.id} | name=${JSON.stringify(u.name)} | stored=${JSON.stringify(u.phoneNumber)} | created ${u.createdAt.toISOString().slice(0,10)} | attendance=${u.attendanceCount}`);
    }
    console.log("");
    console.log("--- MERGE PLAN ---");
    const mergeRes = await runMerges(dups);
    console.log(`  → merges executed: ${mergeRes.merges} (failures: ${mergeRes.failures.length})`);
  }

  if (rewrites.length > 0) {
    console.log("\n--- REWRITE PLAN (canonicalise stored phone) ---");
    const rewriteRes = await runRewrites(rewrites);
    console.log(`  → rewrites executed: ${rewriteRes.rewritten} (failures: ${rewriteRes.failures.length})`);
  }

  if (unnormaliseable.length > 0) {
    console.log("\n--- UNNORMALISABLE (will be set to NULL — preserves user, drops junk phone) ---");
    const nullRes = await runUnnormaliseableNull(unnormaliseable);
    console.log(`  → nulled: ${nullRes.nulled}`);
  }

  // Post-merge sweep: a merge may leave the KEEPER with a non-canonical
  // phone (the merge only frees `drop.phoneNumber`; it doesn't touch
  // `keep.phoneNumber` unless `keep` had none). Re-scan + rewrite.
  if (APPLY && dups.length > 0) {
    console.log("\n--- POST-MERGE SWEEP (catch keepers whose stored phone is still non-canonical) ---");
    const second = await scan();
    if (second.rewrites.length === 0) {
      console.log("  (no remaining non-canonical phones — clean)");
    } else {
      const sweepRes = await runRewrites(second.rewrites);
      console.log(`  → sweep rewrites: ${sweepRes.rewritten} (failures: ${sweepRes.failures.length})`);
    }
  }

  console.log("");
  if (APPLY) {
    const { ok, reasons } = await verifyCleanState();
    if (ok) {
      console.log("✓ Post-migration verify: DB is fully canonical. Safe to install CHECK constraint:");
      console.log("    npx tsx --env-file=.env scripts/normalise-phones-migration.ts --install-constraint");
    } else {
      console.warn("⚠ Post-migration verify FOUND ISSUES:");
      for (const r of reasons) console.warn("    -", r);
    }
  } else {
    console.log("(dry-run — no writes. Re-run with --apply to execute.)");
  }

  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
