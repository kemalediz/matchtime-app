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
    seedRating: 6,
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
  await db.rating.createMany({
    data: [
      { matchId: MATCH.rate, raterId: U.player, playerId: U.rater, score: 8 },
      { matchId: MATCH.rate, raterId: U.third, playerId: U.rater, score: 7 },
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
}
