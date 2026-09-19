/**
 * Idempotent, resettable seed for the ISOLATED e2e database.
 *
 * Runs ONLY under tsx (e2e/run.ts and e2e/helpers/seed-cli.ts) — the
 * Prisma 7 generated client can't be loaded by Playwright's transpiler,
 * so specs trigger reseeds via `resetDb()` (which shells out to
 * seed-cli.ts) and read/write the DB through the pg helper instead.
 *
 * `seedAll(db)` wipes EVERY table (TRUNCATE … CASCADE) and recreates the
 * fixture world from scratch with deterministic ids, so any spec can
 * start from a known state. Safe because test-db refuses anything that
 * isn't a local loopback Postgres.
 *
 * Fixture world:
 *   Org "E2E Test FC" — bot on, payments on (all 3 methods), collector =
 *   Colin Collector, stripeChargesEnabled true (renders card/bank
 *   buttons; actual Stripe calls fail loudly with "not connected"
 *   because there's no Connect account and STRIPE_SECRET_KEY is empty).
 *
 *   Matches:
 *     PAY      COMPLETED, ended ~2h ago, fee £8, links released.
 *     RATE     COMPLETED yesterday 20:00 London, rating window open.
 *     UPCOMING +2 days 20:00 London, maxPlayers 5, 4 confirmed + 1 bench.
 *
 *   All phones are in the UK reserved-fictitious range 07700 900xxx.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { E2E } from "./env";
import { U, PHONE, NAME, ORG_ID, SPORT_ID, ACTIVITY_ID, MATCH, FEE, londonAt } from "./constants";

export { U, PHONE, NAME, ORG_ID, SPORT_ID, ACTIVITY_ID, MATCH, FEE, londonAt };

async function wipe(db: PrismaClient): Promise<void> {
  const rows = await db.$queryRawUnsafe<{ tablename: string }[]>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '_prisma%'`,
  );
  if (rows.length === 0) return;
  const list = rows.map((r) => `"${r.tablename}"`).join(", ");
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${list} CASCADE`);
}

export async function seedAll(db: PrismaClient): Promise<void> {
  await wipe(db);

  // ── Users ──────────────────────────────────────────────────────────
  const userRows = (Object.keys(U) as Array<keyof typeof U>).map((k) => ({
    id: U[k],
    name: NAME[k],
    email: `${k}@e2e-test.invalid`,
    phoneNumber: k === "guest" ? null : PHONE[k as keyof typeof PHONE],
    onboarded: true,
    isActive: true,
  }));
  await db.user.createMany({ data: userRows });

  // ── Org / sport / activity ─────────────────────────────────────────
  await db.organisation.create({
    data: {
      id: ORG_ID,
      name: "E2E Test FC",
      slug: "e2e-test-fc",
      inviteCode: "e2e-invite-code",
      whatsappGroupId: E2E.GROUP_ID,
      whatsappBotEnabled: true,
      paymentCollectionEnabled: true,
      paymentTrackingEnabled: true,
      payMethodPayByBank: true,
      payMethodCard: true,
      payMethodDirect: true,
      stripeChargesEnabled: true, // renders card/bank buttons; no Connect acct
      paymentHolderId: U.collector,
    },
  });

  // NO `seedRating` HERE, ON PURPOSE. Until slice 7 these users carried
  // `User.seedRating: 6`, a column nothing had read since slice 2, so
  // the fixture world was already unseeded in every way that counted.
  // It stays unseeded now that the column is gone, for two reasons.
  //
  // It is what a member created since slice 4 actually looks like: the
  // club has no opinion until an admin types one, and the balancer
  // shrinks toward the CLUB MEAN instead.
  //
  // And the two specs that need a seed write one themselves, on the
  // membership, which is the real path: `stats.spec.ts` sets and clears
  // `GUEST_SEED` inside each test, and `finish-setup.spec.ts` reads back
  // what the form wrote. Handing every member a blanket 6 here would
  // replace the club mean (6.33) as the balancer's prior and turn
  // `stats.spec.ts`'s "6.8 is nowhere on the page" from a real
  // assertion into a vacuous one, because 6.8 would no longer be a
  // number this fixture can produce.
  await db.membership.createMany({
    data: (Object.keys(U) as Array<keyof typeof U>).map((k) => ({
      id: `e2e-mem-${k}`,
      userId: U[k],
      orgId: ORG_ID,
      role: k === "admin" ? ("OWNER" as const) : ("PLAYER" as const),
      provisionallyAddedAt: k === "walt" ? new Date() : null,
    })),
  });

  // Alias used by the findExistingOrgMember spec ("Patso" → Pat Player).
  await db.userAlias.create({
    data: { orgId: ORG_ID, userId: U.player, alias: "patso", source: "manual" },
  });

  await db.sport.create({
    data: {
      id: SPORT_ID,
      orgId: ORG_ID,
      name: "Football 5-a-side",
      preset: "football-5aside",
      playersPerTeam: 5,
      positions: ["GK", "DEF", "MID", "FWD"],
      teamLabels: ["Red", "Yellow"],
      mvpLabel: "Man of the Match",
    },
  });

  await db.activity.create({
    data: {
      id: ACTIVITY_ID,
      orgId: ORG_ID,
      sportId: SPORT_ID,
      name: "E2E 5-a-side",
      dayOfWeek: 2,
      time: "20:00",
      venue: "E2E Arena",
      matchDurationMins: 60,
      ratingWindowHours: 120,
      feePerPlayer: FEE,
    },
  });

  const now = Date.now();

  // ── PAY match — COMPLETED, ended ~2h ago, fee set, links released ──
  const payDate = new Date(now - 3 * 60 * 60 * 1000);
  await db.match.create({
    data: {
      id: MATCH.pay,
      activityId: ACTIVITY_ID,
      date: payDate,
      maxPlayers: 10,
      status: "COMPLETED",
      attendanceDeadline: new Date(now - 4 * 60 * 60 * 1000),
      postMatchEndFlow: false, // keep due-posts output focused on RATE match
      feePerPlayer: FEE,
      feeSetByUserId: U.collector,
      feeSetAt: new Date(now - 2 * 60 * 60 * 1000),
      paymentLinksReleasedAt: new Date(now - 2 * 60 * 60 * 1000),
    },
  });
  await db.attendance.createMany({
    data: [
      { matchId: MATCH.pay, userId: U.collector, status: "CONFIRMED", position: 1 },
      // Unpaid player — sees the three pay methods.
      { matchId: MATCH.pay, userId: U.player, status: "CONFIRMED", position: 2 },
      // Paid by card for 2 people — collect page must show NET £16, not gross.
      {
        matchId: MATCH.pay,
        userId: U.rater,
        status: "CONFIRMED",
        position: 3,
        paidAt: new Date(now - 60 * 60 * 1000),
        paymentMethod: "card",
        paymentAmount: 16.61, // gross the player paid (qty 2)
        paymentQuantity: 2,
      },
      // Direct-pending (said they'll pay the collector, not confirmed yet).
      {
        matchId: MATCH.pay,
        userId: U.guest,
        status: "CONFIRMED",
        position: 4,
        paymentMethod: "direct",
        paymentAmount: FEE,
        paymentQuantity: 1,
        directPendingAt: new Date(now - 90 * 60 * 1000),
      },
      // Unpaid — mutated by the pay spec's "pay directly" flow.
      { matchId: MATCH.pay, userId: U.fresh, status: "CONFIRMED", position: 5 },
    ],
  });

  // ── RATE match — COMPLETED yesterday 20:00 London, window open ─────
  const rateDate = londonAt(-1, 20, 0);
  await db.match.create({
    data: {
      id: MATCH.rate,
      activityId: ACTIVITY_ID,
      date: rateDate,
      maxPlayers: 10,
      status: "COMPLETED",
      attendanceDeadline: new Date(rateDate.getTime() - 5 * 60 * 60 * 1000),
      postMatchEndFlow: true,
      redScore: 3,
      yellowScore: 2,
    },
  });
  await db.attendance.createMany({
    data: [
      { matchId: MATCH.rate, userId: U.rater, status: "CONFIRMED", position: 1 },
      { matchId: MATCH.rate, userId: U.player, status: "CONFIRMED", position: 2 },
      { matchId: MATCH.rate, userId: U.third, status: "CONFIRMED", position: 3 },
      { matchId: MATCH.rate, userId: U.stale, status: "CONFIRMED", position: 4 },
      { matchId: MATCH.rate, userId: U.opt, status: "CONFIRMED", position: 5 },
    ],
  });
  // Pre-existing ratings RECEIVED by Riley Rater so /profile/stats has data.
  //
  // The third row is Pat's, not Riley's, and it is a 4 on purpose. It
  // pulls the CLUB's mean below Riley's own average, which is what makes
  // the two rating numbers differ on the rendered page: Riley is shown
  // the raw mean of his own two scores (7.5) while the balancer reads
  // those two scores shrunk toward a club mean of 6.33 (6.8). With only
  // Riley's rows the club mean was his own average and the two numbers
  // coincided, so `stats.spec.ts` could not have told them apart.
  // Nothing else keys off it: both assertions in `rate.spec.ts` filter
  // on `raterId = U.rater`, and this row's rater is Trudy.
  await db.rating.createMany({
    data: [
      { matchId: MATCH.rate, raterId: U.player, playerId: U.rater, score: 8 },
      { matchId: MATCH.rate, raterId: U.third, playerId: U.rater, score: 7 },
      { matchId: MATCH.rate, raterId: U.third, playerId: U.player, score: 4 },
    ],
  });
  await db.teamAssignment.createMany({
    data: [
      { matchId: MATCH.rate, userId: U.rater, team: "RED" },
      { matchId: MATCH.rate, userId: U.player, team: "RED" },
      { matchId: MATCH.rate, userId: U.third, team: "YELLOW" },
      { matchId: MATCH.rate, userId: U.stale, team: "YELLOW" },
      { matchId: MATCH.rate, userId: U.opt, team: "YELLOW" },
    ],
  });

  // ── UPCOMING match — +2 days 20:00 London, 4/5 confirmed + 1 bench ─
  const upDate = londonAt(2, 20, 0);
  await db.match.create({
    data: {
      id: MATCH.upcoming,
      activityId: ACTIVITY_ID,
      date: upDate,
      maxPlayers: 5,
      status: "UPCOMING",
      attendanceDeadline: new Date(upDate.getTime() - 5 * 60 * 60 * 1000),
    },
  });
  await db.attendance.createMany({
    data: [
      { matchId: MATCH.upcoming, userId: U.admin, status: "CONFIRMED", position: 1 },
      { matchId: MATCH.upcoming, userId: U.collector, status: "CONFIRMED", position: 2 },
      { matchId: MATCH.upcoming, userId: U.player, status: "CONFIRMED", position: 3 },
      { matchId: MATCH.upcoming, userId: U.third, status: "CONFIRMED", position: 4 },
      { matchId: MATCH.upcoming, userId: U.bench, status: "BENCH", position: 5 },
    ],
  });

  await seedAttendanceEvents(db);
}

/**
 * Give the fixture world an attendance HISTORY, not just a state.
 *
 * Every seeded `Attendance` row above gets the event that would have
 * created it, so the log agrees with the table from the first moment of
 * the suite. Two things need that:
 *
 *   · `squadStateAt(log, now)` can be asserted equal to the live squad
 *     — the property the whole table exists for, and it is worthless if
 *     the fixture starts with a table full of rows and an empty log.
 *   · while the COVERAGE gate is armed (see
 *     prisma/sql/attendance-event-coverage.sql, which one spec arms and
 *     disarms), a mid-suite `resetDb()` would otherwise be refused.
 *
 * Timestamps are back-dated by position so the fold has an order to
 * follow and a "mid-week" instant is a real question, not a tie.
 */
async function seedAttendanceEvents(db: PrismaClient): Promise<void> {
  const rows = await db.attendance.findMany({
    orderBy: [{ matchId: "asc" }, { position: "asc" }],
    select: { matchId: true, userId: true, status: true, position: true },
  });
  const base = Date.now() - 14 * 24 * 60 * 60 * 1000;
  await db.attendanceEvent.createMany({
    data: rows.map((r, i) => ({
      matchId: r.matchId,
      userId: r.userId,
      orgId: ORG_ID,
      fromStatus: null,
      toStatus: r.status,
      fromPosition: null,
      toPosition: r.position,
      cause: "test-fixture",
      actorKind: "system",
      sourceRef: "e2e:seed",
      at: new Date(base + i * 60_000),
    })),
  });
}
