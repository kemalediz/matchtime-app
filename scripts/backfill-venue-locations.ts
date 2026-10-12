/**
 * VENUE LOCATION BACKFILL (2026-10-12): look up the venue of every weekly
 * game that has no place linked.
 *
 *   node --env-file=.env --import tsx scripts/backfill-venue-locations.ts            (dry run)
 *   node --env-file=.env --import tsx scripts/backfill-venue-locations.ts --apply    (writes)
 *
 * Options:
 *   --apply     link the HIGH confidence matches. Without it NOTHING is written.
 *   --org X     one club only, by id or slug (default: every club)
 *
 * DRY RUN IS THE DEFAULT. A dry run still asks Google (that is how it
 * knows what it would link), and prints one line per activity:
 *
 *   club id, activity id, the typed venue text, the resolved address, confidence
 *
 * WITH --apply it links ONLY the high confidence matches: it upserts the
 * shared `Venue` row on Google's place id and sets the activity's
 * `venueId`, with `venueMatchSource = 'backfill'` and no confirmation.
 * A low confidence match, a venue that is not found and a failed call are
 * left exactly as they were, for the organiser's confirm line on
 * /admin/activities.
 *
 * COST: at most one Google Geocoding call per DISTINCT venue text and
 * country, whatever the number of activities. The per-club daily cap of
 * the app does not apply here and is not consumed.
 *
 * WHAT GOOGLE IS SENT: the venue text and the country (as a region bias).
 * Never a club name, a person or a phone.
 *
 * DATABASE: `DIRECT_URL`, else the app's `DATABASE_URL`. Reads are plain
 * Prisma finds. The only writes are a `venue.upsert` and an
 * `activity.updateMany` per linked activity, and only behind --apply.
 * There is no raw SQL, no transaction and no session SET of any kind
 * (a leaked SET on the production pooler broke writes on 2026-09-29).
 * An activity is written only if its venue text is still the one that was
 * looked up and nothing was linked to it meanwhile.
 *
 * REQUIRES the columns in
 * prisma/migrations/20261012150000_venue_location/migration.sql and
 * `GOOGLE_MAPS_API_KEY` in the environment.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { geocode } from "../src/lib/geocode.ts";
import { planVenueBackfill, type BackfillRow } from "../src/lib/venue-backfill.ts";

async function main() {
  const apply = process.argv.includes("--apply");
  const orgArg = process.argv.includes("--org") ? process.argv[process.argv.indexOf("--org") + 1] : null;

  const connectionString = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("Neither DIRECT_URL nor DATABASE_URL is set. Run with node --env-file=.env --import tsx ...");
    process.exit(1);
  }
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    console.error("GOOGLE_MAPS_API_KEY is not set: nothing can be looked up.");
    process.exit(1);
  }
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

  try {
    const activities = await db.activity.findMany({
      where: {
        venueId: null,
        ...(orgArg ? { org: { OR: [{ id: orgArg }, { slug: orgArg }] } } : {}),
      },
      orderBy: [{ orgId: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        orgId: true,
        venue: true,
        org: {
          select: {
            language: true,
            memberships: {
              where: { role: "OWNER", leftAt: null },
              orderBy: { createdAt: "asc" },
              take: 1,
              select: { user: { select: { phoneNumber: true } } },
            },
          },
        },
      },
    });

    const rows: BackfillRow[] = activities.map((a) => ({
      activityId: a.id,
      orgId: a.orgId,
      venue: a.venue,
      ownerPhone: a.org.memberships[0]?.user.phoneNumber ?? null,
      language: a.org.language,
    }));

    console.log(`${apply ? "APPLY" : "DRY RUN (nothing is written; pass --apply to link the high confidence matches)"}`);
    console.log(`${rows.length} activities with no place linked${orgArg ? ` in club ${orgArg}` : ""}.\n`);

    const plan = await planVenueBackfill(rows, (query) => geocode(query));
    if (plan.off) {
      console.error("Google Geocoding is off (no key). Nothing was looked up.");
      process.exit(1);
    }

    console.log(["club id", "activity id", "typed venue", "resolved address", "confidence", "outcome"].join("\t"));
    for (const l of plan.lines) {
      console.log([l.orgId, l.activityId, l.venue, l.address ?? "", l.confidence ?? "", l.outcome].join("\t"));
    }

    const count = (o: string) => plan.lines.filter((l) => l.outcome === o).length;
    console.log(
      `\n${plan.googleCalls} Google calls. ${count("link")} high confidence, ${count("low-confidence")} low confidence, ` +
        `${count("not-found")} not found, ${count("error")} failed, ${count("placeholder")} placeholders.`,
    );

    if (!apply) {
      console.log(`\nDry run: nothing was written. ${count("link")} would be linked with --apply.`);
      return;
    }

    const now = new Date();
    let linked = 0;
    let skipped = 0;
    for (const l of plan.lines) {
      if (l.outcome !== "link" || !l.hit) continue;
      const venue = await db.venue.upsert({
        where: { placeId: l.hit.placeId },
        update: {},
        create: {
          placeId: l.hit.placeId,
          name: l.venue,
          formattedAddress: l.hit.formattedAddress || null,
          lat: l.hit.lat,
          lng: l.hit.lng,
          source: "google",
        },
        select: { id: true },
      });
      const { count: written } = await db.activity.updateMany({
        where: { id: l.activityId, venue: l.venue, venueId: null },
        data: {
          venueId: venue.id,
          venueConfidence: "high",
          venueMatchSource: "backfill",
          venueQueryKey: l.key,
          venueResolvedAt: now,
        },
      });
      if (written > 0) linked += 1;
      else skipped += 1;
    }
    console.log(`\nApplied: ${linked} activities linked${skipped ? `, ${skipped} skipped (changed since they were read)` : ""}.`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
