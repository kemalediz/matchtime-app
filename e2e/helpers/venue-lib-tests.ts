/**
 * VENUE LOCATION against the REAL embedded Postgres, under tsx (the lib
 * imports the Prisma 7 generated client, which Playwright's transpiler
 * cannot load). Invoked by e2e/api/venue-location.spec.ts via execFile;
 * exits non-zero with a readable message on any failure.
 *
 * What only a real database can show (review of PR #241, fix 9):
 *
 *   - THE CAP UNDER REAL CONCURRENCY. 20 lookups for one club fired at
 *     the same instant: EXACTLY 10 reach "Google", 10 are refused, and 10
 *     rows are counted. Not 9, not 11, not 0.
 *   - A cached answer is charged to the cap exactly like a call: 20
 *     parallel lookups of words already answered make no Google call and
 *     still only 10 get through.
 *   - The Change box is under the same cap when 20 pins are pasted at once.
 *   - The query cache is written only from Google's answer, and a second
 *     club is never linked to a place another club's activity row names.
 *   - Orphaned private pins are cleaned up.
 *
 * "Google" is a counting function handed to the lib. No network.
 */
import assert from "node:assert/strict";
import { assertSafeTestDbUrl, E2E_DB_URL } from "./env";

const P = "e2e-venue-lib-";

async function main() {
  const url = process.env.MT_E2E_DATABASE_URL ?? E2E_DB_URL;
  assertSafeTestDbUrl(url);
  process.env.DATABASE_URL = url;
  process.env.GOOGLE_MAPS_API_KEY = "e2e-dummy-maps-key-never-real";

  const { db } = await import("@/lib/db");
  const { resolveActivityVenue, changeActivityVenue } = await import("@/lib/venue-location");
  const { VENUE_LOOKUPS_PER_CLUB_PER_DAY: CAP } = await import("@/lib/venue-location-rules");

  let n = 0;
  const ok = (label: string) => console.log(`  ok ${++n}: ${label}`);
  const NOW = new Date();

  // "Google": counts every call, answers a distinct place per address.
  let googleCalls = 0;
  const google = (async (input: string) => {
    googleCalls += 1;
    const address = new URL(input).searchParams.get("address") ?? "";
    // A little latency, so the 20 requests really overlap.
    await new Promise((r) => setTimeout(r, 30));
    return new Response(
      JSON.stringify({
        status: "OK",
        results: [
          {
            place_id: `${P}pid-${address.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
            formatted_address: `${address}, London, UK`,
            geometry: { location: { lat: 51.5, lng: -0.1 }, location_type: "GEOMETRIC_CENTER" },
            types: ["establishment"],
            address_components: [{ short_name: "GB", types: ["country"] }],
          },
        ],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const sport = await db.sport.findFirst({ select: { id: true } });
  assert.ok(sport, "the seeded sport");

  let phoneSeq = 0;
  async function club(key: string, venues: string[]): Promise<{ orgId: string; activityIds: string[] }> {
    const orgId = `${P}${key}`;
    const phone = `+4477009019${String(++phoneSeq).padStart(2, "0")}`;
    await db.user.create({ data: { id: `${orgId}-u`, name: "Vera Venue", email: `${orgId}@e2e-test.invalid`, phoneNumber: phone, onboarded: true } });
    await db.organisation.create({ data: { id: orgId, name: `Venue ${key}`, slug: orgId, inviteCode: `${orgId}-invite` } });
    await db.membership.create({ data: { userId: `${orgId}-u`, orgId, role: "OWNER" } });
    const activityIds: string[] = [];
    for (const [i, venue] of venues.entries()) {
      const id = `${orgId}-a${i}`;
      await db.activity.create({ data: { id, orgId, sportId: sport!.id, name: `Game ${i}`, dayOfWeek: 2, time: "20:00", venue } });
      activityIds.push(id);
    }
    return { orgId, activityIds };
  }

  async function cleanup() {
    await db.activity.updateMany({ where: { id: { startsWith: P } }, data: { venueId: null } });
    await db.venueQuery.deleteMany({ where: { venue: { placeId: { startsWith: P } } } });
    await db.venue.deleteMany({ where: { OR: [{ placeId: { startsWith: P } }, { name: { startsWith: "Lib Pin" } }] } });
    await db.organisation.deleteMany({ where: { id: { startsWith: P } } });
    await db.user.deleteMany({ where: { id: { startsWith: P } } });
  }
  await cleanup();

  const tally = (results: Array<{ status: string }>) =>
    results.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});

  try {
    // ── 1. 20 parallel lookups of 20 different venues: exactly 10 calls ──
    const a = await club("cap", Array.from({ length: 20 }, (_, i) => `Lib Arena Number ${i} Pitch`));
    googleCalls = 0;
    const first = await Promise.all(a.activityIds.map((id) => resolveActivityVenue(id, { now: NOW, fetchImpl: google })));
    assert.equal(googleCalls, CAP, `exactly ${CAP} Google calls for 20 parallel lookups, got ${googleCalls}`);
    assert.deepEqual(tally(first), { found: CAP, capped: 20 - CAP });
    assert.equal(await db.venueLookup.count({ where: { orgId: a.orgId } }), CAP, "exactly the cap in VenueLookup rows");
    const statuses = await db.activity.groupBy({ by: ["venueLookupStatus"], where: { orgId: a.orgId }, _count: true });
    assert.deepEqual(
      Object.fromEntries(statuses.map((s) => [s.venueLookupStatus, s._count])),
      { found: CAP, capped: 20 - CAP },
      "each activity records what its lookup came to",
    );
    assert.equal(await db.activity.count({ where: { orgId: a.orgId, venueId: { not: null } } }), CAP);
    ok(`20 parallel lookups: exactly ${CAP} outbound, ${20 - CAP} refused and recorded as capped`);

    // And nothing more today, in parallel again.
    googleCalls = 0;
    const capped = a.activityIds.filter((_, i) => first[i].status === "capped");
    const again = await Promise.all(capped.map((id) => resolveActivityVenue(id, { now: NOW, fetchImpl: google })));
    assert.equal(googleCalls, 0);
    assert.deepEqual(tally(again), { capped: capped.length });
    ok("after the cap, a second parallel wave makes no call at all");

    // ── 2. A cached answer is charged exactly like a call ──
    const answered = await db.venueQuery.findMany({ where: { venue: { placeId: { startsWith: P } } }, select: { key: true, venueId: true } });
    assert.equal(answered.length, CAP, "one VenueQuery row per Google answer");
    const words = (await db.activity.findFirst({ where: { orgId: a.orgId, venueId: { not: null } }, select: { venue: true, venueId: true } }))!;
    const b = await club("reuse", Array.from({ length: 20 }, () => words.venue));
    googleCalls = 0;
    const reused = await Promise.all(b.activityIds.map((id) => resolveActivityVenue(id, { now: NOW, fetchImpl: google })));
    assert.equal(googleCalls, 0, "words Google already answered cost no call");
    assert.deepEqual(tally(reused), { found: CAP, capped: 20 - CAP }, "and are still charged to the cap, one each");
    const kinds = await db.venueLookup.groupBy({ by: ["kind"], where: { orgId: b.orgId }, _count: true });
    assert.deepEqual(Object.fromEntries(kinds.map((k) => [k.kind, k._count])), { reuse: CAP });
    assert.equal(await db.activity.count({ where: { orgId: b.orgId, venueId: words.venueId } }), CAP, "linked to the SAME shared place");
    ok(`20 parallel reuses: 0 outbound, exactly ${CAP} through, each charged as "reuse"`);

    // ── 3. Another club's activity row is never the source of a place ──
    const hostile = await club("hostile", ["Lib Contested Ground East"]);
    const pin = await db.venue.create({ data: { placeId: null, name: "Lib Pin hostile", lat: 1, lng: 1, source: "map-link" } });
    // Everything a hostile client could wish to have written on its own row.
    await db.activity.update({
      where: { id: hostile.activityIds[0] },
      data: { venueId: pin.id, venueConfidence: "high", venueMatchSource: "text", venueLookupStatus: "found" },
    });
    const victim = await club("victim", ["Lib Contested Ground East"]);
    googleCalls = 0;
    const got = await resolveActivityVenue(victim.activityIds[0], { now: NOW, fetchImpl: google });
    assert.equal(got.status, "found");
    assert.equal(googleCalls, 1, "Google was asked: the other club's row answered nothing");
    const linked = await db.activity.findUnique({ where: { id: victim.activityIds[0] }, select: { venueId: true, venueRef: { select: { placeId: true, source: true } } } });
    assert.notEqual(linked!.venueId, pin.id);
    assert.equal(linked!.venueRef!.source, "google");
    assert.ok(linked!.venueRef!.placeId!.startsWith(P));
    ok("a row dressed up as a confident text match on another club's activity is never reused");

    // ── 4. 20 pins pasted at once: the Change box is under the same cap ──
    const c = await club("pins", ["Lib Pin Ground"]);
    const pins = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        changeActivityVenue(c.activityIds[0], `${c.orgId}-u`, `https://www.google.com/maps/place/Lib+Pin+${i}/@51.5,-0.1,17z/data=!3d51.5${i}!4d-0.1`, {
          now: NOW,
          fetchImpl: google,
        }),
      ),
    );
    assert.deepEqual(tally(pins), { found: CAP, capped: 20 - CAP });
    assert.equal(await db.venueLookup.count({ where: { orgId: c.orgId } }), CAP);
    ok(`20 parallel pins: exactly ${CAP} accepted`);

    // ── 5. Orphaned pins do not pile up ──
    const pinsNow = await db.venue.count({ where: { name: { startsWith: "Lib Pin " }, id: { not: pin.id } } });
    assert.ok(pinsNow >= 1 && pinsNow <= CAP);
    // A later change (a new day, so the cap has room) sweeps the ones the race left behind.
    const later = new Date(NOW.getTime() + 26 * 60 * 60 * 1000);
    await db.venue.updateMany({ where: { name: { startsWith: "Lib Pin " } }, data: { createdAt: new Date(NOW.getTime() - 10 * 60 * 1000) } });
    const replaced = await changeActivityVenue(c.activityIds[0], `${c.orgId}-u`, "https://maps.google.com/?q=51.6,-0.2", { now: later, fetchImpl: google });
    assert.equal(replaced.status, "found");
    const current = (await db.activity.findUnique({ where: { id: c.activityIds[0] }, select: { venueId: true } }))!.venueId;
    const left = await db.venue.findMany({ where: { source: "map-link", placeId: null, activities: { none: {} }, id: { not: pin.id } }, select: { id: true } });
    assert.deepEqual(left, [], "no private pin is left that nothing links");
    assert.ok(current);
    assert.equal(await db.venue.count({ where: { id: pin.id } }), 1, "a pin that IS linked (the hostile club's own) is never swept");
    ok("orphaned pins are deleted; a pin in use and every Google place stay");

    console.log(`OK: ${n} venue checks against Postgres`);
  } finally {
    await cleanup().catch((err) => console.error("cleanup failed:", err));
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
