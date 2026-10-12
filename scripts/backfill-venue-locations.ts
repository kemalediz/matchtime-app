/**
 * VENUE LOCATION BACKFILL (2026-10-12): look up the venue of every weekly
 * game that has no place linked.
 *
 *   node --env-file=.env --import tsx scripts/backfill-venue-locations.ts                    (dry run, every club)
 *   node --env-file=.env --import tsx scripts/backfill-venue-locations.ts --org sutton-fc    (dry run, one club)
 *   node --env-file=.env --import tsx scripts/backfill-venue-locations.ts --limit 5          (at most 5 Google calls)
 *   node --env-file=.env --import tsx scripts/backfill-venue-locations.ts --apply            (writes)
 *
 * Options:
 *   --apply     link what was found. Without it NOTHING is written.
 *   --org X     one club only, by id or slug. `--org` with no value is
 *               REFUSED (it must never mean "every club").
 *   --limit N   at most N Google calls, then stop.
 * Any other argument is refused.
 *
 * DRY RUN IS THE DEFAULT. A dry run still asks Google (that is how it
 * knows what it would link), and prints one line per activity:
 *
 *   club id, activity id, the typed venue text, the resolved address, confidence, outcome
 *
 * WITH --apply:
 *   - a HIGH confidence match is linked as high;
 *   - a LOW confidence match is linked as LOW, so its organiser is asked
 *     "We are not sure this is where you play. Is this the right place?"
 *     on /admin/activities instead of being told nothing was found;
 *   - a venue Google answered nothing for is recorded as "none" (the page
 *     then says it could not be found, which is now true);
 *   - a failed call and a placeholder ("TBD") are left exactly as they were;
 *   - NOTHING is ever marked confirmed. Only an organiser confirms.
 * Each link upserts the shared `Venue` row on Google's place id, records
 * Google's answer in `VenueQuery`, and sets `venueMatchSource = 'backfill'`.
 *
 * IT STOPS, prints what it did, and exits non-zero when Google answers
 * with a quota or rate limit, refuses the key, or is not configured. What
 * it had already resolved is still printed (and, with --apply, linked):
 * those answers are good. `--limit` reaching N is a normal end (exit 0).
 *
 * COST: at most one Google Geocoding call per DISTINCT venue text and
 * country, and none for a query already in `VenueQuery`. The app's
 * per-club daily cap does not apply here and is not consumed.
 *
 * WHAT GOOGLE IS SENT: the venue text and the country (as a region bias).
 * Never a club name, a person or a phone.
 *
 * DATABASE: `DIRECT_URL`, else the app's `DATABASE_URL`. Reads are plain
 * Prisma finds. The only writes are a `venue.upsert`, a
 * `venueQuery.upsert` and an `activity.updateMany` per activity, and only
 * behind --apply. There is no raw SQL, no transaction and no session SET
 * of any kind (a leaked SET on the production pooler broke writes on
 * 2026-09-29). An activity is written only if its venue text is still the
 * one that was looked up and nothing was linked to it meanwhile.
 *
 * REQUIRES the columns and tables in
 * prisma/migrations/20261012150000_venue_location/migration.sql and
 * `GOOGLE_MAPS_API_KEY` in the environment.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { geocode } from "../src/lib/geocode.ts";
import { BACKFILL_USAGE, parseBackfillArgs, planVenueBackfill, type BackfillRow } from "../src/lib/venue-backfill.ts";
import { storeGoogleMatch, type VenueStoreClient } from "../src/lib/venue-store.ts";

async function main(): Promise<number> {
  const args = parseBackfillArgs(process.argv.slice(2));
  if (!args.ok) {
    console.error(`${args.error}\n${BACKFILL_USAGE}`);
    return 2;
  }

  const connectionString = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("Neither DIRECT_URL nor DATABASE_URL is set. Run with node --env-file=.env --import tsx ...");
    return 1;
  }
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    console.error("GOOGLE_MAPS_API_KEY is not set: nothing can be looked up.");
    return 1;
  }
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

  try {
    if (args.org) {
      const club = await db.organisation.findFirst({ where: { OR: [{ id: args.org }, { slug: args.org }] }, select: { id: true } });
      if (!club) {
        console.error(`No club has the id or slug "${args.org}". Nothing was done.`);
        return 2;
      }
    }

    const activities = await db.activity.findMany({
      where: {
        venueId: null,
        ...(args.org ? { org: { OR: [{ id: args.org }, { slug: args.org }] } } : {}),
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

    console.log(args.apply ? "APPLY" : "DRY RUN (nothing is written; pass --apply to link what is found)");
    console.log(
      `${rows.length} activities with no place linked${args.org ? ` in club ${args.org}` : " across EVERY club"}` +
        `${args.limit ? `, at most ${args.limit} Google calls` : ""}.\n`,
    );

    const plan = await planVenueBackfill(rows, (query) => geocode(query), {
      limit: args.limit,
      cached: async (key) => {
        const row = await db.venueQuery.findUnique({
          where: { key },
          select: { venueId: true, confidence: true, venue: { select: { formattedAddress: true } } },
        });
        return row
          ? { venueId: row.venueId, confidence: row.confidence === "high" ? "high" : "low", address: row.venue.formattedAddress }
          : null;
      },
    });

    console.log(["club id", "activity id", "typed venue", "resolved address", "confidence", "outcome"].join("\t"));
    for (const l of plan.lines) {
      console.log([l.orgId, l.activityId, l.venue, l.address ?? "", l.confidence ?? "", l.outcome].join("\t"));
    }

    const count = (o: string) => plan.lines.filter((l) => l.outcome === o).length;
    console.log(
      `\n${plan.googleCalls} Google calls. ${count("link")} high confidence, ${count("link-low")} low confidence, ` +
        `${count("not-found")} not found, ${count("error")} failed, ${count("placeholder")} placeholders.`,
    );

    const STOPPED = {
      off: "Google Geocoding is not configured.",
      quota: "Google answered with a quota or rate limit.",
      denied: "Google refused the key.",
      limit: `--limit ${args.limit} Google calls reached.`,
    } as const;
    if (plan.stopped) {
      console.log(`STOPPED EARLY: ${STOPPED[plan.stopped]} ${rows.length - plan.lines.length} activities were not looked at.`);
    }
    const exitCode = plan.stopped && plan.stopped !== "limit" ? 1 : 0;

    if (!args.apply) {
      console.log(`\nDry run: nothing was written. ${count("link") + count("link-low")} would be linked with --apply.`);
      return exitCode;
    }

    const now = new Date();
    let high = 0;
    let low = 0;
    let none = 0;
    let skipped = 0;
    for (const l of plan.lines) {
      const stillTheSame = { id: l.activityId, venue: l.venue, venueId: null };

      if (l.outcome === "not-found") {
        const { count: written } = await db.activity.updateMany({
          where: stillTheSame,
          data: { venueLookupStatus: "none", venueResolvedAt: now },
        });
        if (written > 0) none += 1;
        continue;
      }
      if (l.outcome !== "link" && l.outcome !== "link-low") continue;

      let venueId = l.venueId;
      let confidence = l.confidence ?? "low";
      if (l.hit) {
        const stored = await storeGoogleMatch(db as unknown as VenueStoreClient, { key: l.key, hit: l.hit, name: l.venue, confidence });
        venueId = stored.venueId;
        confidence = stored.confidence;
      }
      if (!venueId) continue;

      const { count: written } = await db.activity.updateMany({
        where: stillTheSame,
        data: {
          venueId,
          venueConfidence: confidence,
          venueMatchSource: "backfill",
          venueLookupStatus: "found",
          venueResolvedAt: now,
        },
      });
      if (written === 0) skipped += 1;
      else if (confidence === "high") high += 1;
      else low += 1;
    }
    console.log(
      `\nApplied: ${high + low} activities linked (${high} high confidence, ${low} low confidence for the organiser to check), ` +
        `${none} recorded as not found${skipped ? `, ${skipped} skipped (changed since they were read)` : ""}. Nothing was marked confirmed.`,
    );
    return exitCode;
  } finally {
    await db.$disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
