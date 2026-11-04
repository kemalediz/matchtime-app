/**
 * `lib/club-summary/load.ts` (slice A0) against the REAL embedded Postgres,
 * under tsx (the loader imports the Prisma 7 generated client, which
 * Playwright's transpiler cannot load). Invoked by
 * e2e/api/club-summary.spec.ts via execFile; exits non-zero with a readable
 * message on any failure. No model, no network: $0.
 *
 * What a real database shows that the unit tests' fake cannot: every select
 * and where the loader sends is valid Prisma against this schema, the
 * nested counts and member filters return what the summary expects, and
 * the DATE column of a month reads back as its "YYYY-MM-01".
 *
 * Two clubs of their own (the seeded world is not touched):
 *   - a monthly club shaped like the Vets: 7-a-side, 12 to 16 players, pay
 *     as you go at 800p, payments off, a collector, November running with
 *     13 regulars (13 paid) and one regular who left, a held December, an
 *     alias, a nameless member;
 *   - a weekly club shaped like Sutton: Stripe connected, collection on,
 *     a cancelled match today holding next week's announcement.
 */
import assert from "node:assert/strict";
import { assertSafeTestDbUrl, E2E_DB_URL } from "./env";

const NOW = new Date("2030-11-04T12:00:00.000Z"); // a Monday, GMT
const P = "e2e-cs";

async function main() {
  const url = process.env.MT_E2E_DATABASE_URL ?? E2E_DB_URL;
  assertSafeTestDbUrl(url);
  process.env.DATABASE_URL = url;

  const { loadClubSummary } = await import("@/lib/club-summary/load");
  const { summaryScope } = await import("@/lib/club-summary/scope");
  const { getOrgFeatures } = await import("@/lib/org-features");
  const { db } = await import("@/lib/db");

  let n = 0;
  const ok = (label: string) => {
    n++;
    console.log(`  ✓ ${label}`);
  };

  const VETS = `${P}-vets`;
  const WEEKLY = `${P}-weekly`;
  const orgIds = [VETS, WEEKLY];

  async function cleanup() {
    const matches = await db.match.findMany({ where: { activity: { orgId: { in: orgIds } } }, select: { id: true } });
    const ids = matches.map((m) => m.id);
    await db.attendance.deleteMany({ where: { matchId: { in: ids } } });
    await db.teamAssignment.deleteMany({ where: { matchId: { in: ids } } });
    await db.sentNotification.deleteMany({ where: { OR: [{ matchId: { in: ids } }, { key: { startsWith: `org-${P}` } }] } });
    await db.match.deleteMany({ where: { id: { in: ids } } });
    await db.squadMonthMember.deleteMany({ where: { month: { orgId: { in: orgIds } } } });
    await db.squadMonth.deleteMany({ where: { orgId: { in: orgIds } } });
    await db.userAlias.deleteMany({ where: { orgId: { in: orgIds } } });
    await db.membership.deleteMany({ where: { orgId: { in: orgIds } } });
    await db.activity.deleteMany({ where: { orgId: { in: orgIds } } });
    await db.sport.deleteMany({ where: { orgId: { in: orgIds } } });
    await db.organisation.deleteMany({ where: { id: { in: orgIds } } });
    await db.user.deleteMany({ where: { id: { startsWith: `${P}-u` } } });
  }

  const user = async (id: string, name: string | null, phone: string | null) =>
    db.user.create({ data: { id: `${P}-u-${id}`, name, phoneNumber: phone, email: `${P}-${id}@e2e.test` } });

  try {
    await cleanup();

    // ── The Vets-shaped monthly club ────────────────────────────────────
    await db.organisation.create({
      data: { id: VETS, name: "CS Vets", slug: VETS, squadMode: "monthly", paygPricePence: 800, paymentHolderId: `${P}-u-davide`, whatsappBotEnabled: true, whatsappGroupId: `${VETS}@g.us` },
    });
    await db.sport.create({ data: { id: `${VETS}-sport`, orgId: VETS, name: "Football 7-a-side", playersPerTeam: 7, positions: [], teamLabels: [] } });
    await db.activity.create({
      data: { id: `${VETS}-act`, orgId: VETS, sportId: `${VETS}-sport`, name: "Monday Night Football", dayOfWeek: 1, time: "20:00", venue: "CS Vets Ground", minPlayers: 12, maxPlayers: 16 },
    });
    await user("davide", "Davide", "+447700955001");
    await db.membership.create({ data: { userId: `${P}-u-davide`, orgId: VETS, role: "OWNER", createdAt: new Date("2030-01-01T00:00:00Z") } });
    await user("nameless", null, "+447700955002");
    await db.membership.create({ data: { userId: `${P}-u-nameless`, orgId: VETS, createdAt: new Date("2030-02-01T00:00:00Z") } });
    await db.userAlias.create({ data: { userId: `${P}-u-nameless`, orgId: VETS, alias: "Smiler" } });
    const regulars: string[] = [];
    for (let i = 1; i <= 14; i++) {
      await user(`r${i}`, `Regular ${i}`, `+4477009561${String(i).padStart(2, "0")}`);
      await db.membership.create({ data: { userId: `${P}-u-r${i}`, orgId: VETS, createdAt: new Date(`2030-03-${String(i).padStart(2, "0")}T00:00:00Z`) } });
      regulars.push(`${P}-u-r${i}`);
    }
    const nov = await db.squadMonth.create({
      data: { orgId: VETS, activityId: `${VETS}-act`, monthStart: new Date("2030-11-01T00:00:00Z"), status: "running", listOpenedAt: new Date("2030-10-25T10:00:00Z"), createdAt: new Date("2030-10-28T10:00:00Z") },
    });
    for (const [i, id] of regulars.entries()) {
      await db.squadMonthMember.create({
        data: { monthId: nov.id, userId: id, kind: "regular", slot: i + 1, paidAt: i < 13 ? new Date("2030-10-30T10:00:00Z") : null, leftAt: i === 13 ? new Date("2030-11-01T10:00:00Z") : null },
      });
    }
    await db.sentNotification.create({ data: { key: `org-${VETS}:msu:held:2030-12-01:${VETS}-act`, kind: "month-held" } });
    const vetsMatch = async (id: string, date: string, status: "UPCOMING" | "COMPLETED", confirmed: number, seeded: boolean) => {
      const at = new Date(date);
      await db.match.create({
        data: { id, activityId: `${VETS}-act`, date: at, maxPlayers: 14, status, attendanceDeadline: new Date(at.getTime() - 5 * 3600_000), rollingSeededAt: seeded ? new Date("2030-10-29T09:00:00Z") : null },
      });
      for (let i = 0; i < confirmed; i++) await db.attendance.create({ data: { matchId: id, userId: regulars[i], status: "CONFIRMED", position: i + 1 } });
    };
    await vetsMatch(`${VETS}-m-28oct`, "2030-10-28T20:00:00Z", "COMPLETED", 14, false);
    await vetsMatch(`${VETS}-m-11nov`, "2030-11-11T20:00:00Z", "UPCOMING", 13, true);
    await vetsMatch(`${VETS}-m-2dec`, "2030-12-02T20:00:00Z", "UPCOMING", 0, false);
    for (let i = 0; i < 14; i++) await db.teamAssignment.create({ data: { matchId: `${VETS}-m-28oct`, userId: regulars[i], team: i % 2 ? "RED" : "YELLOW" } });

    const vets = await loadClubSummary(VETS, NOW, { members: true });
    assert.ok(vets, "the Vets load");
    assert.equal(vets.squad.mode, "monthly");
    assert.equal(vets.squad.paygPricePence, 800);
    assert.deepEqual(vets.features, await getOrgFeatures(VETS), "features are getOrgFeatures'");
    ok("the club row, features and squad facts");

    assert.deepEqual(
      vets.squad.months.map((m) => [m.monthStart, m.status, m.regulars, m.paid.confirmed, m.paid.claimed]),
      [["2030-11-01", "running", 13, 13, 0]],
      "November: 13 regulars still on the month, 13 paid; the one who left is not counted",
    );
    ok("the month row: DATE column, nested member filter, paid counts");

    assert.deepEqual(vets.payments.collector, { userId: `${P}-u-davide`, name: "Davide" });
    assert.equal(vets.payments.messagesOn, false);
    ok("payments off, Davide collects");

    const g = vets.games[0];
    assert.deepEqual([g.formatPlaces, g.fewestToPlay, g.range.min, g.range.max], [14, 12, 12, 16]);
    ok("the game: 7-a-side, 14 places, 12 to 16");

    assert.equal(vets.nextMatchId, `${VETS}-m-11nov`);
    const next = vets.matches.find((m) => m.id === vets.nextMatchId)!;
    assert.deepEqual([next.confirmed, next.placesOpen, next.short, next.month?.phase, next.month?.seeded], [13, 1, false, "running", true]);
    const dec = vets.matches.find((m) => m.id === `${VETS}-m-2dec`)!;
    assert.deepEqual([dec.month?.phase, dec.month?.held, dec.month?.monthId], ["held", true, null]);
    const played = vets.matches.find((m) => m.id === `${VETS}-m-28oct`)!;
    assert.equal(played.teamsMade, true, "the team-assignment count");
    assert.equal(played.month?.phase, "none", "October has no row");
    assert.equal(vets.lastPlayedMatchId, `${VETS}-m-28oct`);
    ok("matches: next Monday 13 in, 1 place open, not short; December held; the last game played");

    const roster = vets.members!.roster;
    assert.equal(roster.length, 16);
    assert.equal(roster[0].userId, `${P}-u-davide`, "oldest membership first");
    const nameless = roster.find((m) => m.userId === `${P}-u-nameless`)!;
    assert.deepEqual([nameless.name, nameless.displayName, nameless.aliases], ["", "Smiler", ["Smiler"]]);
    assert.deepEqual(vets.members!.adminUserIds, [`${P}-u-davide`]);
    ok("members: one stable order, the alias as the printed line of a nameless member");

    // ── The Sutton-shaped weekly club ───────────────────────────────────
    await db.organisation.create({
      data: {
        id: WEEKLY,
        name: "CS Weekly",
        slug: WEEKLY,
        paymentCollectionEnabled: true,
        stripeConnectAccountId: "acct_cs",
        stripeChargesEnabled: true,
        whatsappBotEnabled: true,
        whatsappGroupId: `${WEEKLY}@g.us`,
      },
    });
    await db.sport.create({ data: { id: `${WEEKLY}-sport`, orgId: WEEKLY, name: "Football 7-a-side", playersPerTeam: 7, positions: [], teamLabels: [] } });
    await db.activity.create({ data: { id: `${WEEKLY}-act`, orgId: WEEKLY, sportId: `${WEEKLY}-sport`, name: "Monday 7s", dayOfWeek: 1, time: "21:30", venue: "CS Goals", feePerPlayer: 6 } });
    for (const [id, date, status] of [
      [`${WEEKLY}-m-today`, "2030-11-04T21:30:00Z", "CANCELLED"],
      [`${WEEKLY}-m-next`, "2030-11-11T21:30:00Z", "UPCOMING"],
    ] as const) {
      const at = new Date(date);
      await db.match.create({ data: { id, activityId: `${WEEKLY}-act`, date: at, maxPlayers: 14, status, attendanceDeadline: new Date(at.getTime() - 5 * 3600_000) } });
    }
    const weekly = await loadClubSummary(WEEKLY, NOW);
    assert.ok(weekly);
    assert.equal(weekly.members, null, "no members unless asked");
    assert.deepEqual([weekly.payments.collectionLive, weekly.payments.methods.card, weekly.payments.collector], [true, true, null]);
    assert.equal(weekly.nextMatchId, `${WEEKLY}-m-next`);
    const nextWeek = weekly.matches.find((m) => m.id === `${WEEKLY}-m-next`)!;
    assert.deepEqual(nextWeek.nextForPosting, { withHold: false, withoutHold: true }, "today's cancelled match holds the announcement only");
    assert.ok(weekly.matches.every((m) => m.month === null));
    ok("weekly: Stripe live, the cancelled-day hold kept as both values");

    // ── The scope reads each club once per request ──────────────────────
    const scope = summaryScope(NOW, loadClubSummary);
    const [a, b] = await Promise.all([scope.get(WEEKLY), scope.get(WEEKLY)]);
    assert.equal(a, b);
    assert.equal(await loadClubSummary(`${P}-nobody`, NOW), null);
    ok("the scope: one summary per club per request; an unknown club is null");

    console.log(`OK (${n} checks)`);
  } finally {
    await cleanup().catch((err) => console.error("cleanup failed:", err));
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
