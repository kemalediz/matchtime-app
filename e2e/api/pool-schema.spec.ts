/**
 * The local player pool's data model, against real Postgres (slice L1,
 * 2026-10-24). `src/lib/pool/__tests__/schema-sql.test.ts` pins the CHECK
 * text to the TypeScript; this proves the database really enforces it:
 *
 *   - a well-formed record of every kind is accepted;
 *   - each CHECK refuses the row it exists for, by its name;
 *   - one open pool ask per (match, club), one open invitation per
 *     (club, person);
 *   - the guest CHECK lets a POOL guest in (match set, no home club) and
 *     still holds the old rule for rows without `guestVia`;
 *   - the migration re-runs cleanly on a database that already has it.
 *
 * No model, no WhatsApp: SQL only. $0.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { test, expect, resetDb } from "../fixtures";
import { MATCH, ORG_ID } from "../helpers/constants";
import { REPO_ROOT } from "../helpers/env";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });
test.beforeAll(() => resetDb());
test.afterAll(() => resetDb());

const OTHER_ORG = "e2e-pool-other-org";
const NOW = new Date();
let seq = 0;
const id = (p: string) => `e2e-pool-${p}-${++seq}`;

async function user(db: TestDb): Promise<string> {
  const uid = id("user");
  await db.run(`INSERT INTO "User" (id, name, email, "updatedAt") VALUES ($1, 'Ali Kaya', $2, now())`, [uid, `${uid}@e2e-test.invalid`]);
  return uid;
}

/** A confirmed, active profile; `over` replaces columns. */
async function profile(db: TestDb, over: Record<string, unknown> = {}): Promise<string> {
  const row: Record<string, unknown> = {
    id: id("profile"),
    userId: await user(db),
    status: "active",
    consentAt: NOW,
    consentVersion: 1,
    consentChannel: "whatsapp",
    consentEvidence: "wamid.TEST",
    adultConfirmedAt: NOW,
    displayName: "Ali K",
    areaDistrict: "SM1",
    areaLat: 51.36,
    areaLng: -0.19,
    maxMiles: 3,
    updatedAt: NOW,
    ...over,
  };
  const cols = Object.keys(row);
  await db.run(
    `INSERT INTO "PoolProfile" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
    Object.values(row),
  );
  return row.id as string;
}

async function insert(db: TestDb, table: string, row: Record<string, unknown>): Promise<void> {
  const cols = Object.keys(row);
  await db.run(
    `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
    Object.values(row),
  );
}

test("a well-formed record of every kind is accepted", async ({ db }) => {
  await db.run(
    `INSERT INTO "Organisation" (id, name, slug, "inviteCode", "updatedAt") VALUES ($1, 'Partner FC', $1, $1, now()) ON CONFLICT DO NOTHING`,
    [OTHER_ORG],
  );
  await db.run(`UPDATE "Organisation" SET "playStyle" = 'casual', town = 'sutton', "featurePlayerPool" = true WHERE id = $1`, [ORG_ID]);

  const pending = id("profile");
  await insert(db, "PoolProfile", { id: pending, status: "pending-verify", confirmCode: "K7QP2", displayName: "Bo T", areaDistrict: "SM1", areaLat: 51.36, areaLng: -0.19, updatedAt: NOW });
  const p = await profile(db, { source: "campaign", sourceCode: "li-kemal", shareCode: "AB12cd", town: "sutton" });
  await insert(db, "PoolSport", { id: id("sport"), profileId: p, sport: "football", formats: [5, 7], level: "intermediate" });
  await insert(db, "PoolSport", { id: id("sport"), profileId: p, sport: "padel", levelText: "played at uni" });
  await insert(db, "PoolSport", { id: id("sport"), profileId: p, sport: "other", otherName: "Ultimate frisbee" });
  await insert(db, "PoolAvailability", { id: id("avail"), profileId: p, day: 2, fromMin: 1140, toMin: 1320 });
  await insert(db, "PoolAvailability", { id: id("avail"), profileId: p, day: 2, fromMin: 420, toMin: 510 });

  const ask = id("ask");
  await insert(db, "PoolAsk", { id: ask, matchId: MATCH.upcoming, orgId: ORG_ID, places: 2, via: "page", updatedAt: NOW });
  const offerUser = (await db.one<{ userId: string }>(`SELECT "userId" FROM "PoolProfile" WHERE id = $1`, [p]))!.userId;
  const offer = id("offer");
  await insert(db, "PoolOffer", { id: offer, poolAskId: ask, matchId: MATCH.upcoming, orgId: ORG_ID, userId: offerUser, distanceMiles: 1.8, expiresAt: NOW, outcome: "accepted", resolvedAt: NOW, repliedVia: "link" });
  await insert(db, "PoolBlock", { id: id("block"), orgId: ORG_ID, userId: offerUser, by: "player" });
  await insert(db, "PoolCampaign", { code: "lf-sutton-goals", source: "leaflet", label: "Goals North Cheam leaflets" });
  await insert(db, "GuestPlace", { id: id("gp"), orgId: ORG_ID, matchId: MATCH.upcoming, userId: offerUser, source: "pool", poolOfferId: offer, updatedAt: NOW });
  await insert(db, "GuestPlace", { id: id("gp"), orgId: ORG_ID, matchId: MATCH.pay, userId: offerUser, source: "partner", fromOrgId: OTHER_ORG, result: "played", resultAt: NOW, updatedAt: NOW });
  await insert(db, "ClubInvitation", { id: id("inv"), orgId: ORG_ID, userId: offerUser, origin: "organiser", clubYesAt: NOW, updatedAt: NOW });

  expect(await db.count(`SELECT count(*) FROM "PoolProfile" WHERE id IN ($1, $2)`, [pending, p])).toBe(2);
});

/** Each case: a row that breaks exactly one rule, and the constraint that says so. */
const REFUSED: Array<{ name: string; constraint: string; write: (db: TestDb) => Promise<unknown> }> = [
  { name: "an unknown profile status", constraint: "PoolProfile_status_check", write: (db) => profile(db, { status: "deleted" }) },
  { name: "an active profile with no consent record", constraint: "PoolProfile_consent_check", write: (db) => profile(db, { consentEvidence: null }) },
  { name: "an active profile with no 18+ tick", constraint: "PoolProfile_consent_check", write: (db) => profile(db, { adultConfirmedAt: null }) },
  { name: "an active profile with no user", constraint: "PoolProfile_user_check", write: (db) => profile(db, { userId: null }) },
  { name: "paused with no reason", constraint: "PoolProfile_paused_check", write: (db) => profile(db, { status: "paused" }) },
  { name: "a reason while not paused", constraint: "PoolProfile_paused_check", write: (db) => profile(db, { pausedReason: "self", pausedAt: NOW }) },
  { name: "stopped with no time", constraint: "PoolProfile_stopped_check", write: (db) => profile(db, { status: "stopped" }) },
  { name: "a confirm code left on an active profile", constraint: "PoolProfile_confirmCode_check", write: (db) => profile(db, { confirmCode: "K7QX2" }) },
  { name: "a confirm code with a 0 in it", constraint: "PoolProfile_confirmCode_check", write: (db) => profile(db, { status: "pending-verify", userId: null, confirmCode: "K0QP2" }) },
  // Slice L2: a pool code is 5 characters; 4 is a self-join connect code's length.
  { name: "a 4-character confirm code", constraint: "PoolProfile_confirmCode_check", write: (db) => profile(db, { status: "pending-verify", userId: null, confirmCode: "K7QP" }) },
  { name: "a full postcode", constraint: "PoolProfile_areaDistrict_check", write: (db) => profile(db, { areaDistrict: "SM1 2AB" }) },
  { name: "a travel distance off the list", constraint: "PoolProfile_maxMiles_check", write: (db) => profile(db, { maxMiles: 4 }) },
  { name: "no area and no venue", constraint: "PoolProfile_area_check", write: (db) => profile(db, { areaDistrict: null, areaLat: null, areaLng: null }) },
  { name: "half a centre point", constraint: "PoolProfile_areaPoint_check", write: (db) => profile(db, { areaLng: null }) },
  { name: "a blank display name", constraint: "PoolProfile_displayName_check", write: (db) => profile(db, { displayName: "  " }) },
  { name: "a town that is not a slug", constraint: "PoolProfile_town_check", write: (db) => profile(db, { town: "Sutton" }) },
  {
    name: "a sport off the catalogue",
    constraint: "PoolSport_sport_check",
    write: async (db) => insert(db, "PoolSport", { id: id("sport"), profileId: await profile(db), sport: "quidditch" }),
  },
  {
    name: "an 'other' sport with no name",
    constraint: "PoolSport_otherName_check",
    write: async (db) => insert(db, "PoolSport", { id: id("sport"), profileId: await profile(db), sport: "other" }),
  },
  {
    name: "a format football does not have",
    constraint: "PoolSport_formats_check",
    write: async (db) => insert(db, "PoolSport", { id: id("sport"), profileId: await profile(db), sport: "football", formats: [6] }),
  },
  {
    name: "a format on a sport without formats",
    constraint: "PoolSport_formats_check",
    write: async (db) => insert(db, "PoolSport", { id: id("sport"), profileId: await profile(db), sport: "tennis", formats: [2] }),
  },
  {
    name: "a level and its own words both",
    constraint: "PoolSport_one_level_check",
    write: async (db) => insert(db, "PoolSport", { id: id("sport"), profileId: await profile(db), sport: "squash", level: "pro", levelText: "x" }),
  },
  {
    name: "a range that ends before it starts",
    constraint: "PoolAvailability_range_check",
    write: async (db) => insert(db, "PoolAvailability", { id: id("avail"), profileId: await profile(db), day: 1, fromMin: 1320, toMin: 60 }),
  },
  {
    name: "a closed ask with no closing time",
    constraint: "PoolAsk_closed_check",
    write: (db) => insert(db, "PoolAsk", { id: id("ask"), matchId: MATCH.pay, orgId: ORG_ID, places: 1, via: "page", status: "filled", updatedAt: NOW }),
  },
  {
    name: "an ask for no players",
    constraint: "PoolAsk_places_check",
    write: (db) => insert(db, "PoolAsk", { id: id("ask"), matchId: MATCH.pay, orgId: ORG_ID, places: 0, via: "page", updatedAt: NOW }),
  },
  {
    name: "an ask approved some other way",
    constraint: "PoolAsk_via_check",
    write: (db) => insert(db, "PoolAsk", { id: id("ask"), matchId: MATCH.pay, orgId: ORG_ID, places: 1, via: "email", updatedAt: NOW }),
  },
  {
    name: "an outcome with no time",
    constraint: "PoolOffer_resolved_check",
    write: async (db) => {
      const ask = id("ask");
      await insert(db, "PoolAsk", { id: ask, matchId: MATCH.rate, orgId: ORG_ID, places: 1, via: "page", updatedAt: NOW });
      return insert(db, "PoolOffer", { id: id("offer"), poolAskId: ask, matchId: MATCH.rate, orgId: ORG_ID, userId: "u", distanceMiles: 1, expiresAt: NOW, outcome: "declined" });
    },
  },
  {
    name: "a third wave",
    constraint: "PoolOffer_wave_check",
    write: async (db) => {
      const ask = id("ask");
      await insert(db, "PoolAsk", { id: ask, matchId: MATCH.rate, orgId: ORG_ID, places: 1, via: "auto", status: "cancelled", closedAt: NOW, updatedAt: NOW });
      return insert(db, "PoolOffer", { id: id("offer"), poolAskId: ask, matchId: MATCH.rate, orgId: ORG_ID, userId: "u2", distanceMiles: 1, expiresAt: NOW, wave: 3 });
    },
  },
  { name: "a block by nobody", constraint: "PoolBlock_by_check", write: (db) => insert(db, "PoolBlock", { id: id("block"), orgId: ORG_ID, userId: "u", by: "owner" }) },
  { name: "a campaign code with capitals", constraint: "PoolCampaign_code_check", write: (db) => insert(db, "PoolCampaign", { code: "LI-Kemal", source: "linkedin", label: "x" }) },
  {
    name: "a partner guest with no home club",
    constraint: "GuestPlace_from_check",
    write: async (db) => insert(db, "GuestPlace", { id: id("gp"), orgId: ORG_ID, matchId: MATCH.rate, userId: await user(db), source: "partner", updatedAt: NOW }),
  },
  {
    name: "a pool guest naming a home club",
    constraint: "GuestPlace_from_check",
    write: async (db) => insert(db, "GuestPlace", { id: id("gp"), orgId: ORG_ID, matchId: MATCH.rate, userId: await user(db), source: "pool", fromOrgId: OTHER_ORG, updatedAt: NOW }),
  },
  {
    name: "a played game with no time",
    constraint: "GuestPlace_resultAt_check",
    write: async (db) => insert(db, "GuestPlace", { id: id("gp"), orgId: ORG_ID, matchId: MATCH.rate, userId: await user(db), source: "pool", result: "played", updatedAt: NOW }),
  },
  {
    name: "an organiser's invitation without the club's yes",
    constraint: "ClubInvitation_state_check",
    write: async (db) => insert(db, "ClubInvitation", { id: id("inv"), orgId: ORG_ID, userId: await user(db), origin: "organiser", updatedAt: NOW }),
  },
  {
    name: "an accepted invitation without the player's yes",
    constraint: "ClubInvitation_state_check",
    write: async (db) =>
      insert(db, "ClubInvitation", { id: id("inv"), orgId: ORG_ID, userId: await user(db), origin: "after-game", status: "accepted", clubYesAt: NOW, closedAt: NOW, updatedAt: NOW }),
  },
  { name: "a play style off the list", constraint: "Organisation_playStyle_check", write: (db) => db.run(`UPDATE "Organisation" SET "playStyle" = 'serious' WHERE id = $1`, [ORG_ID]) },
];

for (const c of REFUSED) {
  test(`refused: ${c.name}`, async ({ db }) => {
    await expect(c.write(db)).rejects.toThrow(new RegExp(c.constraint));
  });
}

test("one open pool ask per match and club; a closed one does not count", async ({ db }) => {
  // The first test left one open ask on the upcoming match.
  await expect(
    insert(db, "PoolAsk", { id: id("ask"), matchId: MATCH.upcoming, orgId: ORG_ID, places: 1, via: "notice", updatedAt: NOW }),
  ).rejects.toThrow(/PoolAsk_one_open_per_match_club/);
  await insert(db, "PoolAsk", { id: id("ask"), matchId: MATCH.upcoming, orgId: ORG_ID, places: 1, via: "notice", status: "closed", closedAt: NOW, updatedAt: NOW });
});

test("one open invitation per club and person", async ({ db }) => {
  const uid = await user(db);
  await insert(db, "ClubInvitation", { id: id("inv"), orgId: ORG_ID, userId: uid, origin: "after-game", updatedAt: NOW });
  await expect(insert(db, "ClubInvitation", { id: id("inv"), orgId: ORG_ID, userId: uid, origin: "after-game", updatedAt: NOW })).rejects.toThrow(
    /ClubInvitation_one_open_per_club_user/,
  );
});

test("the guest CHECK: a pool guest has a match and no home club; the old rule holds without guestVia", async ({ db }) => {
  const membership = async (over: Record<string, unknown>) =>
    insert(db, "Membership", { id: id("mem"), userId: await user(db), orgId: ORG_ID, role: "PLAYER", ...over });
  await membership({ guestVia: "pool", guestMatchId: MATCH.upcoming });
  await membership({ guestVia: "partner", guestFromOrgId: OTHER_ORG, guestMatchId: MATCH.upcoming });
  await membership({ guestFromOrgId: OTHER_ORG, guestMatchId: MATCH.upcoming });
  await membership({});
  for (const bad of [
    { guestMatchId: MATCH.upcoming },
    { guestVia: "pool", guestFromOrgId: OTHER_ORG, guestMatchId: MATCH.upcoming },
    { guestVia: "pool" },
    { guestVia: "partner", guestMatchId: MATCH.upcoming },
    { guestVia: "friend", guestMatchId: MATCH.upcoming },
  ]) {
    await expect(membership(bad), JSON.stringify(bad)).rejects.toThrow(/Membership_guest_check/);
  }
});

test("the migrations re-run cleanly on a database that already has them, and their verify queries agree", async ({ db }) => {
  // L1 then L2, always as a pair: L2 replaces L1's 4-character confirm code
  // CHECK with the 5-character one (slice L2), so L1 alone would not re-run
  // over a 5-character code.
  const l1 = readFileSync(path.join(REPO_ROOT, "prisma/migrations/20261024200000_local_player_pool/migration.sql"), "utf8");
  const l2 = readFileSync(path.join(REPO_ROOT, "prisma/migrations/20261025090000_pool_signup_confirm/migration.sql"), "utf8");
  // L1's area CHECK names "venueIds", which the later drop migration removes
  // (chosen pitches retired, 2026-10-25). A re-run of L1 is a re-run on a
  // database from before that drop, so put the column back first; the drop
  // then takes the database back to today's shape, and re-runs as a no-op.
  const restoreVenueIds = `ALTER TABLE "PoolProfile" ADD COLUMN IF NOT EXISTS "venueIds" TEXT[] DEFAULT ARRAY[]::TEXT[];`;
  const dropVenueIds = readFileSync(path.join(REPO_ROOT, "prisma/migrations/20261028000000_drop_pool_venue_ids/migration.sql"), "utf8");
  await db.run(`${restoreVenueIds}\n${l1}\n${l2}\n${dropVenueIds}`);
  await db.run(`${restoreVenueIds}\n${l1}\n${l2}\n${dropVenueIds}`);
  await db.run(dropVenueIds);
  expect(await db.count(`SELECT count(*) FROM information_schema.columns WHERE table_name = 'PoolProfile' AND column_name = 'venueIds'`)).toBe(0);
  const l2Tables = await db.all(`SELECT table_name FROM information_schema.tables WHERE table_name IN ('PoolAttempt', 'PoolConsentRecord')`);
  expect(l2Tables).toHaveLength(2);
  const cols = await db.all(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'Organisation' AND column_name IN ('featurePlayerPool', 'poolAutoAsk', 'playStyle', 'town')`,
  );
  expect(cols).toHaveLength(4);
  const tables = await db.all(
    `SELECT table_name FROM information_schema.tables WHERE table_name IN ('PoolProfile', 'PoolSport', 'PoolAvailability', 'PoolAsk', 'PoolOffer', 'PoolBlock', 'PoolCampaign', 'GuestPlace', 'ClubInvitation')`,
  );
  expect(tables).toHaveLength(9);
  // The CHECK file and the migration leave the same constraints behind.
  const checks = await db.count(`SELECT count(*) FROM pg_constraint WHERE contype = 'c' AND conname LIKE ANY (ARRAY['Pool%', 'GuestPlace%', 'ClubInvitation%'])`);
  await db.run(readFileSync(path.join(REPO_ROOT, "prisma/sql/pool-check.sql"), "utf8"));
  expect(await db.count(`SELECT count(*) FROM pg_constraint WHERE contype = 'c' AND conname LIKE ANY (ARRAY['Pool%', 'GuestPlace%', 'ClubInvitation%'])`)).toBe(checks);
  expect(checks).toBeGreaterThan(30);
});

test("a profile always has a postcode district and its centre point (the area CHECK)", async ({ db }) => {
  await expect(profile(db, { areaDistrict: null, areaLat: null, areaLng: null })).rejects.toThrow(/PoolProfile_area_check/);
  await expect(profile(db, { areaLat: null, areaLng: null })).rejects.toThrow(/PoolProfile_area_check/);
  await expect(profile(db, { areaDistrict: null })).rejects.toThrow(/PoolProfile_area_check/);
  // A waiting sign-up is no exception: it is placed before it is written.
  await expect(
    insert(db, "PoolProfile", { id: id("profile"), status: "pending-verify", confirmCode: "M3XR9", displayName: "Cy D", updatedAt: NOW }),
  ).rejects.toThrow(/PoolProfile_area_check/);
});
