/**
 * THE FREE PERIOD STARTS AT GO-LIVE (owner decision 2, 2026-10-12; go-live
 * plan 2.6, slice S4b): the real `goLiveClub` (src/lib/club-setup.ts) and
 * the real billing writer against the REAL embedded Postgres, under tsx
 * (the lib imports the Prisma 7 generated client, which Playwright's
 * transpiler cannot load). Invoked by e2e/api/free-period-go-live.spec.ts
 * via execFile; exits non-zero with a readable message on any failure.
 *
 * The clock is passed in, so the dates are the brief's own: a club
 * approved on 1 October and live on 20 October is free until 20 December.
 *
 * What only a real database can show: the go-live and the free period
 * commit TOGETHER or not at all, two GOs at once start ONE free period, a
 * second start changes nothing, the CHECK constraints accept every write,
 * and a club that is still setting up has no billing state whatever is
 * thrown at it. No Stripe call is made (no month here is ever charged) and
 * no model is called.
 */
import assert from "node:assert/strict";
import { assertSafeTestDbUrl, E2E_DB_URL } from "./env";

const P = "e2e-fpgl-";

async function main() {
  const url = process.env.MT_E2E_DATABASE_URL ?? E2E_DB_URL;
  assertSafeTestDbUrl(url);
  process.env.DATABASE_URL = url;
  process.env.BILLING_ENABLED = "1";
  // The emergency switch would replace every allowance below with $50.
  delete process.env.AI_DAILY_CAP_DISABLED;

  const { db } = await import("@/lib/db");
  const { goLiveClub, liveByUser } = await import("@/lib/club-setup");
  const { setBillingState, startTrial } = await import("@/lib/club-billing");
  const { freePeriodEnd } = await import("@/lib/club-billing-rules");
  const { reminderAt, billingDmsDue, TRIAL_21_DAYS_BEFORE_END } = await import("@/lib/club-billing-schedule-rules");
  const { monthBounds, countClubMonth } = await import("@/lib/club-billing-cycle-rules");
  const { loadClubMonthInput } = await import("@/lib/club-billing-month-loader");
  const { closeMonth, closeNextDueMonth, openDueMonths } = await import("@/lib/club-billing-months");
  const { loadCurrentMonth } = await import("@/lib/club-billing-month-summary");
  const { sendScheduledBillingDms, sendClubFeeTip } = await import("@/lib/club-billing-dms");
  const { handleBillingRemoval, handleBillingReAdd } = await import("@/lib/club-billing-removal");
  const { aiAllowanceUsd, NEW_CLUB_CAP_USD, DAILY_CAP_USD } = await import("@/lib/ai-budget");
  const { newClubDmCap, NEW_CLUB_MEMBER_DMS_PER_DAY } = await import("@/lib/club-decision-rules");
  const { formatLondon } = await import("@/lib/london-time");

  let n = 0;
  const ok = (label: string) => {
    n++;
    console.log(`  ok ${n}: ${label}`);
  };
  const DAY = 24 * 3_600_000;
  const london = (d: Date | null | undefined) => (d ? formatLondon(d, "yyyy-MM-dd HH:mm") : null);
  // Approved Thu 1 Oct 2026, 10:00 London; live Tue 20 Oct 2026, 19:30 London.
  const APPROVED = new Date("2026-10-01T09:00:00Z");
  const LIVE = new Date("2026-10-20T18:30:00Z");
  const FREE_UNTIL = new Date("2026-12-20T19:30:00Z");

  let seq = 0;
  /** An approved club that is setting up: bot off, group linked, exempt, no billing row. */
  async function club(key: string, over: Record<string, unknown> = {}, opts: { approvedAt?: Date } = {}) {
    const id = `${P}${key}`;
    const num = String(++seq).padStart(2, "0");
    await db.user.create({
      data: { id: `${id}-u`, name: "Fay Freeperiod", email: `${id}@e2e-test.invalid`, phoneNumber: `+4477009027${num}`, onboarded: true },
    });
    await db.organisation.create({
      data: {
        id,
        name: `Freeperiod ${key}`,
        slug: id,
        inviteCode: `${id}-invite`,
        approvalStatus: "approved",
        approvedAt: opts.approvedAt ?? APPROVED,
        whatsappGroupId: `1203639000027${num}@g.us`,
        whatsappBotEnabled: false,
        setupStage: "setting-up",
        createdAt: new Date("2026-09-20T09:00:00Z"),
        ...over,
      } as never,
    });
    await db.membership.create({ data: { userId: `${id}-u`, orgId: id, role: "OWNER" } });
    return id;
  }
  const groupOf = async (id: string) => (await db.organisation.findUnique({ where: { id }, select: { whatsappGroupId: true } }))!.whatsappGroupId!;
  const state = (id: string) =>
    db.organisation.findUnique({
      where: { id },
      select: {
        setupStage: true,
        whatsappBotEnabled: true,
        liveAt: true,
        approvedAt: true,
        billingStatus: true,
        clubBilling: { select: { trialStartedAt: true, trialEndsAt: true, graceEndsAt: true, pausedReason: true } },
      } as never,
    }) as unknown as Promise<{
      setupStage: string;
      whatsappBotEnabled: boolean;
      liveAt: Date | null;
      approvedAt: Date | null;
      billingStatus: string;
      clubBilling: { trialStartedAt: Date; trialEndsAt: Date; graceEndsAt: Date | null; pausedReason: string | null } | null;
    }>;
  const billingRows = (id: string) => db.clubBilling.count({ where: { orgId: id } });
  /** Every trace billing could leave for a club. */
  async function billingTraces(id: string) {
    return {
      rows: await billingRows(id),
      months: await db.clubBillingMonth.count({ where: { orgId: id } }),
      notices: await db.billingNotice.count({ where: { orgId: id } }),
      events: await db.billingEvent.count({ where: { orgId: id } }),
      dms: await db.platformJob.count({ where: { purpose: "billing", refId: { startsWith: `${id}:` } } }),
    };
  }
  const NONE = { rows: 0, months: 0, notices: 0, events: 0, dms: 0 };

  const cleanup = async () => {
    await db.platformJob.deleteMany({ where: { refId: { startsWith: P } } });
    await db.billingEvent.deleteMany({ where: { orgId: { startsWith: P } } });
    await db.sentNotification.deleteMany({ where: { key: { contains: P } } });
    await db.botJob.deleteMany({ where: { orgId: { startsWith: P } } });
    // Including the games going live made, which carry generated ids.
    await db.attendance.deleteMany({ where: { match: { activity: { orgId: { startsWith: P } } } } });
    await db.match.deleteMany({ where: { activity: { orgId: { startsWith: P } } } });
    await db.organisation.deleteMany({ where: { id: { startsWith: P } } });
    await db.user.deleteMany({ where: { id: { startsWith: P } } });
  };

  try {
    await cleanup();

    // ── 1. While it is setting up: no billing state, whatever is tried ──
    const a = await club("held");
    await db.sport.create({
      data: { id: `${a}-sport`, orgId: a, name: "Football 5-a-side", playersPerTeam: 5, positions: ["GK"], teamLabels: ["Red", "Yellow"] } as never,
    });
    await db.activity.create({
      data: {
        id: `${a}-act`,
        orgId: a,
        sportId: `${a}-sport`,
        name: "Weekly game",
        dayOfWeek: 2,
        time: "20:00",
        venue: "Park",
        isActive: true,
        createdAt: new Date("2026-09-20T09:00:00Z"),
      } as never,
    });
    // Fixtures the crons generated, and auto-completed, while it waited.
    const match = (id: string, date: Date, status: string) =>
      db.match.create({ data: { id: `${a}-${id}`, activityId: `${a}-act`, date, maxPlayers: 10, status, attendanceDeadline: date } as never });
    await match("oct06", new Date("2026-10-06T19:00:00Z"), "COMPLETED");
    await match("oct13", new Date("2026-10-13T19:00:00Z"), "COMPLETED");
    await match("oct20", new Date("2026-10-20T17:00:00Z"), "UPCOMING"); // kicked off 90 minutes before the GO
    await db.attendance.create({ data: { matchId: `${a}-oct06`, userId: `${a}-u`, status: "CONFIRMED", position: 1 } as never });
    await db.match.update({ where: { id: `${a}-oct13` }, data: { redScore: 4, yellowScore: 4 } });

    const during = new Date("2026-10-10T12:00:00Z");
    assert.deepEqual(await setBillingState(a, { type: "approved" }, APPROVED), { ok: false, reason: "no-change" });
    assert.deepEqual(await setBillingState(a, { type: "start-trial" }, during), { ok: false, reason: "no-change" });
    assert.deepEqual(await setBillingState(a, { type: "went-live" }, during), { ok: false, reason: "no-change" });
    assert.deepEqual(await startTrial(a, during), { ok: false, reason: "setting-up" });
    ok("setting up: the approval's own billing call, the owner's Start free period and a stray went-live all start nothing");

    // Every later moment the cron could look at it, the old free period's
    // end and grace week (counted from approval) included.
    for (const at of ["2026-10-10T12:00:00Z", "2026-11-22T10:00:00Z", "2026-12-01T10:00:00Z", "2026-12-08T12:00:00Z", "2027-01-05T12:00:00Z"]) {
      const now = new Date(at);
      assert.deepEqual(await openDueMonths(a, now), { opened: [], skipped: "not-billed" }, at);
      assert.deepEqual(await closeNextDueMonth(a, now), { skipped: "none" }, at);
      assert.deepEqual(await sendScheduledBillingDms(a, now), [], at);
      assert.equal(await sendClubFeeTip(a, now), "not-billed", at);
    }
    assert.deepEqual(await billingTraces(a), NONE);
    assert.equal((await state(a)).billingStatus, "exempt");
    ok("setting up: no billing month opens or closes, no card reminder, no 'free period ended', no club fee tip, at any date");

    const removed = await handleBillingRemoval(await groupOf(a), { flagOn: true, now: during });
    assert.deepEqual(removed, { kind: "logged", orgId: a, why: "setting-up" });
    assert.deepEqual(await handleBillingReAdd(await groupOf(a), { flagOn: true, now: during }), { kind: "not-removed" });
    assert.deepEqual(await billingTraces(a), NONE);
    assert.equal((await state(a)).billingStatus, "exempt");
    ok("setting up: MatchTime removed from the group (and added back) creates and pauses no billing state");

    const settingUpOct = await loadClubMonthInput(db as never, a, { startsAt: APPROVED, endsAt: new Date("2026-11-01T00:00:00Z") }, { now: during });
    assert.equal(countClubMonth(settingUpOct!).played, 0);
    ok("setting up: a count over the weeks it waited finds no game played, completed matches or not");

    // ── 2. Go live: the free period starts in the same transaction ─────
    const out = await goLiveClub(a, liveByUser(`${a}-u`), LIVE);
    assert.equal(out.outcome, "went-live");
    let s = await state(a);
    assert.equal(s.setupStage, "live");
    assert.equal(s.whatsappBotEnabled, true);
    assert.equal(s.liveAt?.getTime(), LIVE.getTime());
    assert.equal(s.billingStatus, "trial");
    assert.equal(s.clubBilling?.trialStartedAt.getTime(), LIVE.getTime());
    assert.equal(s.clubBilling?.trialEndsAt.toISOString(), FREE_UNTIL.toISOString());
    assert.equal(london(s.clubBilling?.trialEndsAt), "2026-12-20 19:30");
    assert.equal(s.clubBilling?.trialEndsAt.getTime(), freePeriodEnd(LIVE).getTime());
    assert.notEqual(s.clubBilling?.trialEndsAt.getTime(), freePeriodEnd(APPROVED).getTime());
    ok("approved 1 October, live 20 October: free from 20 October until 20 December (London), not 1 December");

    const ends = s.clubBilling!.trialEndsAt;
    assert.equal(london(reminderAt(ends, TRIAL_21_DAYS_BEFORE_END)), "2026-12-11 09:00");
    const sched = { status: "trial", trialEndsAt: ends, graceEndsAt: null, pausedAt: null, pausedReason: null };
    assert.deepEqual(billingDmsDue(sched, new Date("2026-12-01T12:00:00Z"), { trial21Delivered: false }), []);
    assert.deepEqual(await sendScheduledBillingDms(a, new Date("2026-12-01T12:00:00Z")), []);
    assert.equal(london(monthBounds(ends, 1).startsAt), "2026-12-20 19:30");
    assert.deepEqual(await openDueMonths(a, new Date("2026-12-10T12:00:00Z")), { opened: [] });
    ok("its first card reminder is due on 11 December, nothing on 1 December, and no billing month exists inside the free period");

    // The AI allowance and the member DM cap follow the same first day.
    const allowanceRow = await db.organisation.findUnique({
      where: { id: a },
      select: {
        createdAt: true,
        aiDailyCapUsd: true,
        aiWindowStartAt: true,
        whatsappBotEnabled: true,
        whatsappGroupId: true,
        approvalStatus: true,
        setupStage: true,
        approvedAt: true,
        liveAt: true,
        billingStatus: true,
      } as never,
    });
    assert.equal(aiAllowanceUsd(allowanceRow as never, new Date("2026-12-05T12:00:00Z")), NEW_CLUB_CAP_USD);
    assert.equal(aiAllowanceUsd(allowanceRow as never, new Date(ends.getTime() - 1)), NEW_CLUB_CAP_USD);
    assert.equal(aiAllowanceUsd(allowanceRow as never, ends), DAILY_CAP_USD);
    assert.equal(newClubDmCap(s, new Date("2026-11-01T12:00:00Z")), NEW_CLUB_MEMBER_DMS_PER_DAY);
    assert.equal(newClubDmCap(s, new Date(LIVE.getTime() + 28 * DAY)), null);
    ok("the higher AI allowance ends at the same moment as the free period, and the member DM cap runs 28 days from go-live");

    // ── 3. A second start is a no-op ───────────────────────────────────
    const again = await goLiveClub(a, liveByUser(`${a}-u`), new Date(LIVE.getTime() + 3 * DAY));
    assert.equal(again.outcome, "already-live");
    for (const type of ["approved", "went-live", "start-trial"] as const) {
      assert.deepEqual(await setBillingState(a, { type }, new Date(LIVE.getTime() + 3 * DAY)), { ok: false, reason: "no-change" }, type);
    }
    assert.deepEqual(await startTrial(a, new Date(LIVE.getTime() + 3 * DAY)), { ok: false, reason: "not-exempt" });
    s = await state(a);
    assert.equal(await billingRows(a), 1);
    assert.equal(s.clubBilling?.trialStartedAt.getTime(), LIVE.getTime());
    assert.equal(s.clubBilling?.trialEndsAt.getTime(), FREE_UNTIL.getTime());
    ok("a second GO, a late approval event and Start free period change nothing: one row, the same end date");

    // ── 4. Games from before go-live are never billable ────────────────
    const ms = await db.match.findMany({ where: { activityId: `${a}-act` }, select: { id: true, status: true, postMatchEndFlow: true }, orderBy: { date: "asc" } });
    // The games played before go-live, then the next game going live made
    // with the cron's generator (2026-10-15): upcoming, nothing to bill.
    assert.deepEqual(ms.slice(0, 3), [
      { id: `${a}-oct06`, status: "COMPLETED", postMatchEndFlow: false },
      { id: `${a}-oct13`, status: "COMPLETED", postMatchEndFlow: false },
      { id: `${a}-oct20`, status: "COMPLETED", postMatchEndFlow: false },
    ]);
    assert.deepEqual(
      ms.slice(3).map((m) => ({ status: m.status, postMatchEndFlow: m.postMatchEndFlow })),
      [{ status: "UPCOMING", postMatchEndFlow: true }],
    );
    for (const featureAttendance of [true, false]) {
      await db.organisation.update({ where: { id: a }, data: { featureAttendance } });
      const kind = featureAttendance ? "tracks attendance" : "does NOT track attendance";
      // A month that covers them (it cannot exist: months start at the end
      // of the free period): the loader still leaves every one out.
      const oct = await loadClubMonthInput(db as never, a, { startsAt: APPROVED, endsAt: new Date("2026-11-01T00:00:00Z") });
      const counted = countClubMonth(oct!);
      assert.equal(counted.played, 0, kind);
      assert.ok(counted.scheduled >= 3, kind);
      // The control: without the go-live span the same rows WOULD count.
      assert.ok(countClubMonth({ ...oct!, pauseSpans: [] }).played >= 2, `${kind}: control`);
    }
    ok("the three matches completed before go-live (one with an IN, one with a score, one force-completed at GO) are never a game played, with or without attendance tracking");

    // The real first month, through both callers of the count.
    await db.organisation.update({ where: { id: a }, data: { featureAttendance: false } });
    assert.deepEqual(await openDueMonths(a, new Date(FREE_UNTIL.getTime() + 60_000)), { opened: [1] });
    const m1 = await db.clubBillingMonth.findFirst({ where: { orgId: a, index: 1 } });
    assert.equal(m1?.startsAt.getTime(), FREE_UNTIL.getTime());
    assert.equal(london(m1?.endsAt), "2027-01-20 00:00");
    const current = await loadCurrentMonth(a, new Date("2027-01-02T12:00:00Z"), { plan: "standard", pricePence: null });
    assert.equal(current?.played, 0);
    assert.equal(current?.soFarPence, 0);
    const closed = await closeMonth(m1!.id, new Date("2027-01-20T10:00:00Z"));
    assert.equal("outcome" in closed ? closed.outcome : JSON.stringify(closed), "no-games");
    const m1After = await db.clubBillingMonth.findUnique({ where: { id: m1!.id } });
    assert.equal(m1After?.played, 0);
    assert.equal(m1After?.amountPence ?? 0, 0);
    assert.equal(m1After?.stripeInvoiceId, null);
    ok("month 1 is anchored on 20 December; the billing page's count and the month close both find 0 played, and nothing is invoiced (a club that does not track attendance)");

    // ── 5. Two GOs at the same instant: one free period ────────────────
    for (let round = 1; round <= 3; round++) {
      const r = await club(`race${round}`);
      const [x, y] = await Promise.all([goLiveClub(r, liveByUser("u-other-admin"), LIVE), goLiveClub(r, liveByUser(`${r}-u`), LIVE)]);
      assert.deepEqual([x.outcome, y.outcome].sort(), ["already-live", "went-live"], `round ${round}`);
      assert.equal(await billingRows(r), 1, `round ${round}`);
      const rs = await state(r);
      assert.equal(rs.billingStatus, "trial");
      assert.equal(rs.clubBilling?.trialEndsAt.getTime(), FREE_UNTIL.getTime());
      assert.equal(await db.billingEvent.count({ where: { orgId: r } }), 1, `round ${round}: one billed marker`);
    }
    ok("two GOs at the same instant: one went live, one free period, one row");

    // ── 6. All or nothing ───────────────────────────────────────────────
    const f = await club("atomic");
    // The billing step's own marker row already exists, so its insert fails
    // inside the go-live transaction.
    await db.billingEvent.create({ data: { id: `mt_billed_${f}_${LIVE.getTime()}`, type: "mt.test-collision", orgId: null, receivedAt: LIVE, processedAt: LIVE } });
    await assert.rejects(goLiveClub(f, liveByUser(`${f}-u`), LIVE));
    let fs = await state(f);
    assert.equal(fs.setupStage, "setting-up");
    assert.equal(fs.whatsappBotEnabled, false);
    assert.equal(fs.liveAt, null);
    assert.equal(fs.billingStatus, "exempt");
    assert.equal(await billingRows(f), 0);
    assert.equal(await db.botJob.count({ where: { orgId: f } }), 0);
    assert.equal(await db.sentNotification.count({ where: { key: `org-${f}:bot-intro` } }), 0);
    ok("the billing write fails: the WHOLE go-live rolls back (still setting up, bot off, no hello, no billing row)");
    await db.billingEvent.delete({ where: { id: `mt_billed_${f}_${LIVE.getTime()}` } });
    const retry = new Date(LIVE.getTime() + 5 * 60_000);
    assert.equal((await goLiveClub(f, liveByUser(`${f}-u`), retry)).outcome, "went-live");
    fs = await state(f);
    assert.equal(fs.billingStatus, "trial");
    assert.equal(fs.clubBilling?.trialStartedAt.getTime(), retry.getTime());
    assert.equal(fs.clubBilling?.trialEndsAt.getTime(), freePeriodEnd(retry).getTime());
    ok("and the organiser's next GO goes through: live, free from that moment");

    // ── 7. Other go-live days ───────────────────────────────────────────
    const days: Array<[string, string, string, string]> = [
      // key, approved, live, expected end (UTC)
      ["sameday", "2026-10-12T09:00:00Z", "2026-10-12T13:00:00Z", "2026-12-12T14:00:00.000Z"],
      ["autumn", "2026-08-20T09:00:00Z", "2026-08-25T11:00:00Z", "2026-10-25T12:00:00.000Z"],
      ["spring", "2027-01-20T09:00:00Z", "2027-01-28T01:30:00Z", "2027-03-28T01:30:00.000Z"],
      ["dec31", "2026-12-15T09:00:00Z", "2026-12-31T22:00:00Z", "2027-02-28T22:00:00.000Z"],
    ];
    for (const [key, approved, live, end] of days) {
      const id = await club(key, {}, { approvedAt: new Date(approved) });
      assert.equal((await goLiveClub(id, liveByUser(`${id}-u`), new Date(live))).outcome, "went-live", key);
      const ds = await state(id);
      assert.equal(ds.clubBilling?.trialStartedAt.toISOString(), new Date(live).toISOString(), key);
      assert.equal(ds.clubBilling?.trialEndsAt.toISOString(), end, key);
    }
    ok("approved and live on the same day; across both clock changes; live on 31 December is free until 28 February");

    // ── 8. When nothing starts, the club still goes live ───────────────
    const off = await club("flagoff");
    assert.equal((await goLiveClub(off, liveByUser(`${off}-u`), LIVE, { billingEnabled: false })).outcome, "went-live");
    assert.equal((await state(off)).billingStatus, "exempt");
    assert.deepEqual(await billingTraces(off), NONE);
    // Billing on later: the owner's button starts it, from that moment.
    const later = new Date("2026-11-03T12:00:00Z");
    assert.deepEqual(await startTrial(off, later), { ok: true, trialEndsAt: new Date("2027-01-03T12:00:00Z") });
    assert.equal((await state(off)).clubBilling?.trialStartedAt.getTime(), later.getTime());
    ok("billing off at go-live: live, exempt, no row; with billing on later the owner's Start free period starts it from that day");

    const free = await club("planfree", { billingPlan: "free" });
    assert.equal((await goLiveClub(free, liveByUser(`${free}-u`), LIVE)).outcome, "went-live");
    assert.equal((await state(free)).billingStatus, "exempt");
    assert.deepEqual(await billingTraces(free), NONE);
    ok("plan Free: live, never a free period");

    // ── 9. Approval got there first ─────────────────────────────────────
    // A row no production path writes for a setting-up club; the go-live
    // must leave it exactly as it is rather than start a second period.
    const first = await club("approvalfirst", { billingStatus: "trial" });
    await db.clubBilling.create({ data: { orgId: first, trialStartedAt: APPROVED, trialEndsAt: freePeriodEnd(APPROVED) } });
    assert.equal((await goLiveClub(first, liveByUser(`${first}-u`), LIVE)).outcome, "went-live");
    const ps = await state(first);
    assert.equal(await billingRows(first), 1);
    assert.equal(ps.billingStatus, "trial");
    assert.equal(ps.clubBilling?.trialStartedAt.getTime(), APPROVED.getTime());
    assert.equal(ps.clubBilling?.trialEndsAt.getTime(), freePeriodEnd(APPROVED).getTime());
    ok("a free period an approval had already started is never started again at go-live");

    // ── 10. A club that was never held keeps today's dates ─────────────
    const never = await club("neverheld", { setupStage: "live", whatsappBotEnabled: true });
    assert.deepEqual(await setBillingState(never, { type: "approved" }, new Date(APPROVED.getTime() + 2000)), {
      ok: true,
      from: "exempt",
      to: "trial",
      resumed: false,
    });
    const ns = await state(never);
    assert.equal(ns.liveAt, null);
    assert.equal(ns.clubBilling?.trialStartedAt.getTime(), APPROVED.getTime());
    assert.equal(ns.clubBilling?.trialEndsAt.toISOString(), "2026-12-01T10:00:00.000Z");
    assert.equal(newClubDmCap(ns, new Date(APPROVED.getTime() + 28 * DAY - 1)), NEW_CLUB_MEMBER_DMS_PER_DAY);
    assert.equal(newClubDmCap(ns, new Date(APPROVED.getTime() + 28 * DAY)), null);
    assert.deepEqual(await handleBillingRemoval(await groupOf(never), { flagOn: true, now: during }), { kind: "paused", orgId: never, stripe: "no-customer" });
    ok("a never-held club: free from its approval until 1 December, DM cap from approval, and a removal pauses it, all as before");

    console.log(`OK: ${n} free-period-from-go-live checks against Postgres`);
  } finally {
    await cleanup().catch((err) => console.error("cleanup failed:", err));
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
