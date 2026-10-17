/**
 * Set a club's quiet hours (2026-10-16), the same columns the "Quiet hours"
 * card on /admin/settings writes. For the manager: FNF goes OFF, Sutton FC
 * stays on the default.
 *
 *   npx tsx scripts/set-quiet-hours.ts <orgId|slug> off            # dry run
 *   npx tsx scripts/set-quiet-hours.ts <orgId|slug> 23:00 09:00    # dry run
 *   npx tsx scripts/set-quiet-hours.ts <orgId|slug> off --apply    # writes
 *
 * Dry run by default: prints the club, what it has now and what it would
 * get. `off` keeps the saved times (switching back on restores them).
 * Times are London "HH:MM": From (quiet hours start) then To (they end).
 * Needs the migration 20261016230000_quiet_hours_setting applied.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { quietHoursOf, validateQuietHours } from "../src/lib/message-hours.ts";

function usage(msg?: string): never {
  if (msg) console.error(msg);
  console.error("Usage: npx tsx scripts/set-quiet-hours.ts <orgId|slug> off|<from> <to> [--apply]");
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const [who, a, b] = args.filter((x) => x !== "--apply");
  if (!who || !a) usage();
  const v = a.toLowerCase() === "off" ? validateQuietHours({ enabled: false }) : validateQuietHours({ enabled: true, from: a, to: b });
  if (!v.ok) usage(v.error === "same-time" ? "From and To must be different times." : "Give off, or two London times like 23:00 09:00.");

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  try {
    const org = await db.organisation.findFirst({
      where: { OR: [{ id: who }, { slug: who }] },
      select: { id: true, name: true, slug: true, quietHoursEnabled: true, quietHoursFrom: true, quietHoursTo: true },
    });
    if (!org) usage(`No club with id or slug "${who}".`);

    const show = (q: { enabled: boolean; from: string; to: string }) => (q.enabled ? `ON, ${q.from} to ${q.to} London` : `OFF (saved times ${q.from} to ${q.to})`);
    const now = quietHoursOf(org);
    const next = v.value.enabled ? v.value : { ...now, enabled: false };
    console.log(`${apply ? "APPLYING" : "DRY RUN"}: ${org.name} (${org.slug}, ${org.id})`);
    console.log(`  now:  ${show(now)}`);
    console.log(`  next: ${show(next)}`);
    if (!apply) {
      console.log("\nNothing written. Add --apply to write.");
      return;
    }
    const data = v.value.enabled
      ? { quietHoursEnabled: true, quietHoursFrom: v.value.from, quietHoursTo: v.value.to }
      : { quietHoursEnabled: false };
    const row = await db.organisation.update({ where: { id: org.id }, data, select: { quietHoursEnabled: true, quietHoursFrom: true, quietHoursTo: true } });
    console.log(`  written: ${show(quietHoursOf(row))}`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
