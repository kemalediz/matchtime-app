/**
 * The first sync-participants run created 56 dupe Users because the bot
 * sent phones without a leading "+" and normalisePhone preserved the
 * no-+ format. Each dupe got a synthetic wa-sync+<slug>-<ts>@matchtime.local
 * email and a Membership row.
 *
 * For each such dupe:
 *   - Build the canonical phone "+<digits>".
 *   - If a User with that canonical phone already exists →
 *       move the dupe's Membership.leftAt restoration onto the canonical
 *       (best-effort: if canonical has an active Membership, keep it;
 *        otherwise create one), then delete the dupe Membership + dupe User.
 *   - If no canonical exists →
 *       update the dupe's phoneNumber to "+<digits>" so it's a real new
 *       member going forward.
 *
 * Idempotent: re-running on a clean DB is a no-op.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as never);

  const dupes = await db.user.findMany({
    where: {
      email: { startsWith: "wa-sync+" },
    },
    select: {
      id: true,
      name: true,
      phoneNumber: true,
      email: true,
      memberships: { select: { id: true, orgId: true, role: true, leftAt: true } },
    },
  });

  console.log(`Found ${dupes.length} wa-sync dupe User(s).`);

  let merged = 0;
  let renamed = 0;
  let skipped = 0;

  for (const dupe of dupes) {
    if (!dupe.phoneNumber || dupe.phoneNumber.startsWith("+")) {
      // Already canonical-shaped — leave alone (probably a genuine new
      // member already cleaned up on a prior run).
      skipped += 1;
      continue;
    }
    const canonicalPhone = `+${dupe.phoneNumber}`;
    const canonical = await db.user.findUnique({
      where: { phoneNumber: canonicalPhone },
      select: {
        id: true,
        name: true,
        memberships: { select: { id: true, orgId: true, leftAt: true } },
      },
    });

    if (canonical) {
      // Merge: dupe's Membership rows → canonical (only if canonical
      // doesn't already have an active membership for that org).
      for (const dm of dupe.memberships) {
        const existing = canonical.memberships.find((m) => m.orgId === dm.orgId);
        if (!existing) {
          await db.membership.update({
            where: { id: dm.id },
            data: { userId: canonical.id },
          });
        } else {
          if (existing.leftAt !== null && dm.leftAt === null) {
            // Canonical was soft-removed but WA group sees them → restore.
            await db.membership.update({
              where: { id: existing.id },
              data: { leftAt: null },
            });
          }
          await db.membership.delete({ where: { id: dm.id } });
        }
      }
      // Now safe to delete the dupe User (no FK rows left for it).
      await db.user.delete({ where: { id: dupe.id } });
      merged += 1;
      console.log(
        `  merged: ${dupe.name?.padEnd(25) ?? "(unnamed)"} ${dupe.phoneNumber} → canonical ${canonical.id} (${canonical.name ?? "(unnamed)"})`,
      );
    } else {
      await db.user.update({
        where: { id: dupe.id },
        data: { phoneNumber: canonicalPhone },
      });
      renamed += 1;
      console.log(
        `  renamed: ${dupe.name?.padEnd(25) ?? "(unnamed)"} ${dupe.phoneNumber} → ${canonicalPhone} (no canonical existed — kept as new member)`,
      );
    }
  }

  console.log("");
  console.log(`Done. merged=${merged}  renamed=${renamed}  skipped=${skipped}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => process.exit(0));
