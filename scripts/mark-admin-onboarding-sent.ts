/**
 * Mark a club's standard welcome notices to its admins as already sent
 * (src/lib/admin-onboarding-rules.ts), so MatchTime never sends them:
 *
 *   A  "Getting <club> ready"   claim `org-<orgId>:getting-ready`
 *   B  "Teams for <weekday>"    claim `org-<orgId>:first-teams`
 *
 * For a club whose manager posted them by hand. FNF
 * (cmv9nmp81000006l2iau88fig) needs this once after the PR merges: it went
 * live and had both posted in its admin group by hand on 2026-10-15.
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/mark-admin-onboarding-sent.ts <orgId or slug>          # dry run
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/mark-admin-onboarding-sent.ts <orgId or slug> --apply  # write the claims
 *
 * Idempotent: a second run changes nothing. The seed nudge has its own
 * script (scripts/mark-seed-nudged.ts). To undo, delete those rows.
 */
import { db } from "../src/lib/db.ts";
import { markAdminOnboardingSent } from "../src/lib/admin-onboarding.ts";

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const arg = args.find((a) => !a.startsWith("--"));
  if (!arg) throw new Error("usage: npx tsx scripts/mark-admin-onboarding-sent.ts <orgId or slug> [--apply]");
  const r = await markAdminOnboardingSent({ arg, apply });
  if (r.status === "no-club") throw new Error(`no club with id or slug "${r.arg}"`);
  const claimed = new Set(r.alreadyClaimed);
  for (const key of r.keys) console.log(`  ${key}${claimed.has(key) ? " (already claimed)" : ""}`);
  console.log(
    r.status === "dry-run"
      ? `${r.club} (${r.orgId}): DRY RUN, nothing written. Run again with --apply to claim these.`
      : `${r.club} (${r.orgId}): claimed. Neither notice will be sent.`,
  );
}
main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
