/**
 * ONE-OFF: give clubs already in their free period the new length (Kemal,
 * 2026-10-28: "make the trial 3 months everywhere"; it was two months).
 *
 *   node --env-file=.env --import tsx scripts/extend-free-periods.ts           # dry run: lists, writes nothing
 *   node --env-file=.env --import tsx scripts/extend-free-periods.ts --apply   # writes
 *
 * `ClubBilling.trialEndsAt` is stored when a free period starts, so a
 * constant change alone reaches only clubs that start from now on. This
 * moves the stored end of every club still INSIDE its free period and
 * NEVER billed (no ClubBillingMonth row) to FREE_PERIOD_MONTHS from its same
 * start. Never earlier, never a free period that is over, idempotent.
 * The rule is `extendedFreePeriodEnd` (club-billing-rules.ts); the writer is
 * `extendFreePeriods` (club-billing.ts): a compare-and-set on the old end,
 * in a transaction that re-checks there is no billing month, with an
 * `mt.free-period-extended` audit row. No session SET, nothing messaged,
 * nothing in Stripe.
 */
import { FREE_PERIOD_MONTHS } from "../src/lib/club-billing-rules";
import { extendFreePeriods } from "../src/lib/club-billing";
import { db } from "../src/lib/db";

async function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== "--apply");
  if (unknown.length) {
    console.error(`Unknown option ${unknown[0]}. Options: --apply`);
    process.exit(1);
  }
  const apply = args.includes("--apply");
  const rows = await extendFreePeriods({ apply });
  console.log(`${apply ? "APPLY" : "DRY RUN"}: free period length is now ${FREE_PERIOD_MONTHS} months.`);
  if (rows.length === 0) console.log("No club needs its free period moved.");
  for (const r of rows) {
    console.log(
      `${r.written ? "moved " : apply ? "SKIPPED (raced or billed)" : "would move"}  ${r.name} (${r.orgId}, ${r.status}): ` +
        `started ${r.trialStartedAt.toISOString()}, end ${r.from.toISOString()} -> ${r.to.toISOString()}`,
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
