/**
 * Wipe the isolated payment-test fixture created by seed-pay-test.ts.
 * Deletes the test org (cascades activities/matches/attendances/
 * memberships) and the fictitious Test Player Two. Leaves everything else
 * untouched. Safe to run anytime.
 */
import { db } from "@/lib/db";

const SLUG = "mt-test-payments";

async function main() {
  const org = await db.organisation.findUnique({ where: { slug: SLUG }, select: { id: true } });
  if (org) {
    const { wipeOrg } = await import("@/lib/wipe-org");
    await wipeOrg(org.id);
    console.log("🗑️  wiped org", org.id);
  } else {
    console.log("no test org found");
  }
  const p2 = await db.user.findUnique({ where: { phoneNumber: "+447700900123" }, select: { id: true } });
  if (p2) {
    await db.user.delete({ where: { id: p2.id } }).catch((e) => console.warn("p2 delete:", e.message));
    console.log("🗑️  deleted Test Player Two");
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
