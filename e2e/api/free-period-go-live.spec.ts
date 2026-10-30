/**
 * THE FREE PERIOD STARTS AT GO-LIVE, NOT AT APPROVAL (owner decision 2,
 * 2026-10-12; go-live plan 2.6, slice S4b), against a real Postgres and
 * the real routes, with the billing cron's clock pinned by `x-test-now`.
 *
 * One club is taken along the whole path with the setup hold on:
 *
 *   approved and SETTING UP   seeded by hand, as e2e/api/setup-go-live.spec.ts
 *                             does: the approval that holds a club (slice S3,
 *                             PR #235) is not on main yet, so there is no
 *                             real approval to drive that leaves a club
 *                             setting up. Everything after it is real.
 *   19 days of silence        the billing cron, at any date, does not know
 *                             the club: no billing row, no DM, no month.
 *                             MatchTime removed from its group changes no
 *                             billing state either.
 *   GO                        the organiser's DM, through /api/whatsapp/
 *                             dm-reply, which calls `goLiveClub`: the free
 *                             period starts in that transaction, from the
 *                             go-live.
 *   two months                the cron is walked along them, as in the last
 *                             case of billing-cron.spec.ts: nothing where a
 *                             free period counted from approval would have
 *                             ended, the reminders nine and two days before
 *                             the real end, grace for a week, and the first
 *                             billing month anchored on that end, in which
 *                             the games from before go-live count for nothing.
 *
 * The second test runs the same rules on fixed dates (approved 1 October,
 * live 20 October, clock changes, 31 December) and the transaction itself
 * (all or nothing, the race, a second start) under tsx.
 *
 * The e2e server runs with BILLING_ENABLED=1 (e2e/helpers/env.ts).
 * Deterministic: no model, and no Stripe call (no month here is charged).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import { E2E, REPO_ROOT } from "../helpers/env";
import { testDb } from "../helpers/test-db";
import { freePeriodEnd } from "@/lib/club-billing-rules";
import { formatLondon, londonDateTimeToUtc } from "@/lib/london-time";
import { addDmIntentBodies, GO_READS } from "../helpers/stub";

const execFileAsync = promisify(execFile);

test.describe.configure({ mode: "serial" });

const CRON = { authorization: `Bearer ${E2E.CRON_SECRET}` };
const PI = { "x-api-key": E2E.WHATSAPP_API_KEY };
const DAY = 24 * 60 * 60 * 1000;

const ORG = "e2e-fp-harbour";
const GROUP = "120363900000000291@g.us";
const OWNER = { id: "e2e-fp-hana", name: "Hana Harbour", phone: "+447700902901" };
const PLAYER = { id: "e2e-fp-pia", name: "Pia Player", phone: "+447700902902" };
/** Approved 19 days before the organiser says GO (1 October to 20 October). */
const HELD_DAYS = 19;

const digits = (p: string) => p.replace(/^\+/, "");
/** A UTC instant for a plain-timestamp column: the app reads those as UTC. */
const utc = (at: Date) => at.toISOString();

async function cron(request: APIRequestContext, at: Date | string) {
  const res = await request.get("/api/cron/billing", { headers: { ...CRON, "x-test-now": typeof at === "string" ? at : at.toISOString() } });
  expect(res.status(), await res.text()).toBe(200);
  return res.json() as Promise<{ enabled: boolean; clubs: Array<{ orgId: string; transition?: string; opened?: number[]; closed?: string; error?: string }> }>;
}

/** `time` London on the London date `days` days after the London date of `at`. */
function londonAt(at: Date, days: number, time: string): Date {
  const [y, m, d] = formatLondon(at, "yyyy-MM-dd").split("-").map(Number);
  return londonDateTimeToUtc(new Date(Date.UTC(y, m - 1, d + days, 12)).toISOString().slice(0, 10), time);
}

const billingDms = () =>
  testDb().all<{ text: string; refId: string }>(
    `SELECT text, "refId" FROM "PlatformJob" WHERE purpose = 'billing' AND phone = $1 ORDER BY "createdAt"`,
    [digits(OWNER.phone)],
  );
const club = () =>
  testDb().one<{ stage: string; bot: boolean; status: string; approved: Date; live: Date | null }>(
    `SELECT "setupStage" AS stage, "whatsappBotEnabled" AS bot, "billingStatus" AS status,
            "approvedAt" AT TIME ZONE 'UTC' AS approved, "liveAt" AT TIME ZONE 'UTC' AS live
       FROM "Organisation" WHERE id = $1`,
    [ORG],
  );
const billingRow = () =>
  testDb().one<{ starts: Date; ends: Date; grace: Date | null; reason: string | null }>(
    `SELECT "trialStartedAt" AT TIME ZONE 'UTC' AS starts, "trialEndsAt" AT TIME ZONE 'UTC' AS ends,
            "graceEndsAt" AT TIME ZONE 'UTC' AS grace, "pausedReason" AS reason
       FROM "ClubBilling" WHERE "orgId" = $1`,
    [ORG],
  );
const months = () =>
  testDb().all<{ index: number; status: string; starts: Date; ends: Date; scheduled: number | null; played: number | null; invoice: string | null }>(
    `SELECT index, status, "startsAt" AT TIME ZONE 'UTC' AS starts, "endsAt" AT TIME ZONE 'UTC' AS ends, scheduled, played, "stripeInvoiceId" AS invoice
       FROM "ClubBillingMonth" WHERE "orgId" = $1 ORDER BY index`,
    [ORG],
  );
const billingTraces = async () => ({
  rows: await testDb().count(`SELECT COUNT(*) FROM "ClubBilling" WHERE "orgId" = $1`, [ORG]),
  months: await testDb().count(`SELECT COUNT(*) FROM "ClubBillingMonth" WHERE "orgId" = $1`, [ORG]),
  notices: await testDb().count(`SELECT COUNT(*) FROM "BillingNotice" WHERE "orgId" = $1`, [ORG]),
  events: await testDb().count(`SELECT COUNT(*) FROM "BillingEvent" WHERE "orgId" = $1`, [ORG]),
  dms: (await billingDms()).length,
});

test.beforeAll(() => resetDb());
test.afterAll(() => resetDb());

test("a held club's free months start when it goes LIVE: silent and unbilled while setting up, then the whole free period from GO", async ({ request }) => {
  test.setTimeout(180_000);
  const db = testDb();
  const seededAt = new Date();
  const approved = new Date(seededAt.getTime() - HELD_DAYS * DAY);

  // ── Approved and setting up (by hand: see the header) ───────────────
  for (const u of [OWNER, PLAYER]) {
    await db.run(
      `INSERT INTO "User" (id, name, email, "phoneNumber", onboarded, "isActive", "updatedAt") VALUES ($1,$2,$3,$4,true,true,now())`,
      [u.id, u.name, `${u.id}@e2e-test.invalid`, u.phone],
    );
  }
  // The club does NOT track attendance: any ended match would count as played.
  await db.run(
    `INSERT INTO "Organisation" ("id","name","slug","inviteCode","approvalStatus","approvedAt","whatsappGroupId",
       "whatsappBotEnabled","setupStage","billingStatus","featureAttendance","language","createdAt","updatedAt")
     VALUES ($1,'Harbour FC',$1,$2,'approved',$3::timestamp,$4,false,'setting-up','exempt',false,'en',$3::timestamp,now())`,
    [ORG, `${ORG}-invite`, utc(approved), GROUP],
  );
  await db.run(`INSERT INTO "Membership" (id,"userId","orgId",role) VALUES ($1,$2,$3,'OWNER'), ($4,$5,$3,'PLAYER')`, [
    `${OWNER.id}-mem`,
    OWNER.id,
    ORG,
    `${PLAYER.id}-mem`,
    PLAYER.id,
  ]);
  await db.run(
    `INSERT INTO "ClubConnect" ("id","orgId","userId","phone","code","status","expiresAt","groupId","groupSubject","linkedAt","updatedAt")
     VALUES ($1,$2,$3,$4,'FP29','closed',now() + interval '1 hour',$5,'Harbour Tuesday 5s',$6::timestamp,now())`,
    [`${ORG}-cc`, ORG, OWNER.id, digits(OWNER.phone), GROUP, utc(new Date(approved.getTime() - 3_600_000))],
  );
  await db.run(
    `INSERT INTO "Sport" ("id","orgId","name","playersPerTeam","positions","teamLabels","createdAt","updatedAt")
     VALUES ($1,$2,'Football 5-a-side',5,ARRAY['GK','DEF','MID','FWD'],ARRAY['Red','Yellow'],$3::timestamp,now())`,
    [`${ORG}-sport`, ORG, utc(approved)],
  );
  await db.run(
    `INSERT INTO "Activity" ("id","orgId","sportId","name","dayOfWeek","time","venue","isActive","deadlineHours","createdAt","updatedAt")
     VALUES ($1,$2,$3,'Weekly game',2,'20:00','Harbour Pitches',true,5,$4::timestamp,now())`,
    [`${ORG}-activity`, ORG, `${ORG}-sport`, utc(approved)],
  );
  // Fixtures the crons made while the club waited: two already completed
  // (one with players IN and a score), and one that kicked off three hours
  // ago and is still open, which going live force-completes.
  await db.run(
    `INSERT INTO "Match" (id,"activityId",date,"maxPlayers",status,"attendanceDeadline","redScore","yellowScore","updatedAt")
     VALUES ($1,$4,$5::timestamp,10,'COMPLETED',$5::timestamp,3,2,now()),
            ($2,$4,$6::timestamp,10,'COMPLETED',$6::timestamp,NULL,NULL,now()),
            ($3,$4,$7::timestamp,10,'UPCOMING',$7::timestamp,NULL,NULL,now())`,
    [
      `${ORG}-m-two-weeks`,
      `${ORG}-m-last-week`,
      `${ORG}-m-tonight`,
      `${ORG}-activity`,
      utc(new Date(seededAt.getTime() - 14 * DAY)),
      utc(new Date(seededAt.getTime() - 7 * DAY)),
      utc(new Date(seededAt.getTime() - 3 * 3_600_000)),
    ],
  );
  await db.run(
    `INSERT INTO "Attendance" (id,"matchId","userId",status,position,"updatedAt") VALUES ($1,$3,$4,'CONFIRMED',1,now()), ($2,$3,$5,'CONFIRMED',2,now())`,
    [`${ORG}-att1`, `${ORG}-att2`, `${ORG}-m-two-weeks`, OWNER.id, PLAYER.id],
  );

  // ── Setting up: billing does not know the club, at any date ─────────
  const NONE = { rows: 0, months: 0, notices: 0, events: 0, dms: 0 };
  const fromApproval = freePeriodEnd(approved);
  for (const at of [
    londonAt(seededAt, 0, "12:00"),
    // Where a free period counted from the APPROVAL would send its
    // reminders, end, and run out of its grace week.
    londonAt(fromApproval, -9, "09:00"),
    londonAt(fromApproval, -2, "09:00"),
    londonAt(fromApproval, 1, "12:00"),
    londonAt(fromApproval, 8, "12:00"),
    londonAt(fromApproval, 40, "12:00"),
  ]) {
    const report = await cron(request, at);
    expect(report.enabled).toBe(true);
    expect(report.clubs.map((c) => c.orgId)).not.toContain(ORG);
  }
  expect(await billingTraces()).toEqual(NONE);
  expect(await club()).toMatchObject({ stage: "setting-up", bot: false, status: "exempt", live: null });

  // MatchTime removed from its group while setting up: billing is told,
  // and neither creates nor pauses anything. The removal is recorded, so
  // a GO now is REFUSED and starts no free period for a group MatchTime
  // is not in.
  const removed = await request.post("/api/whatsapp/bot-removed", { headers: PI, data: { groupId: GROUP } });
  expect(removed.status(), await removed.text()).toBe(200);
  expect(await removed.json()).toMatchObject({ ok: true, billing: "setting-up", setup: "removed", orgId: ORG });
  expect(await billingTraces()).toEqual(NONE);
  expect(await club()).toMatchObject({ stage: "setting-up", status: "exempt" });
  addDmIntentBodies(GO_READS);
  const refused = await request.post("/api/whatsapp/dm-reply", {
    headers: PI,
    data: { phone: digits(OWNER.phone), body: "GO", waMessageId: `e2e-fp-go0-${Date.now()}`, authorName: null },
  });
  expect(await refused.json()).toMatchObject({ handled: "setup-go", outcome: "removed-from-group", orgId: ORG });
  expect(await billingTraces()).toEqual(NONE);
  expect(await club()).toMatchObject({ stage: "setting-up", bot: false, status: "exempt", live: null });
  // The organiser adds MatchTime back to the group.
  const readded = await request.post("/api/whatsapp/bot-added", {
    headers: PI,
    data: { groupId: GROUP, groupSubject: "Harbour Tuesday 5s", addedByPhone: digits(OWNER.phone) },
  });
  expect(readded.status(), await readded.text()).toBe(200);
  expect(await billingTraces()).toEqual(NONE);

  // ── GO ──────────────────────────────────────────────────────────────
  addDmIntentBodies(GO_READS);
  const go = await request.post("/api/whatsapp/dm-reply", {
    headers: PI,
    data: { phone: digits(OWNER.phone), body: "GO", waMessageId: `e2e-fp-go-${Date.now()}`, authorName: null },
  });
  expect(go.status(), await go.text()).toBe(200);
  expect(await go.json()).toMatchObject({ handled: "setup-go", outcome: "went-live", orgId: ORG });
  // "Done" goes on, in the same message, with the free period and the
  // club fee tip: the organiser hears the price on day 0.
  const done = await testDb().one<{ text: string }>(
    `SELECT text FROM "PlatformJob" WHERE purpose = 'setup-reply' AND phone = $1 ORDER BY "createdAt" DESC LIMIT 1`,
    [digits(OWNER.phone)],
  );
  expect(done!.text).toMatch(
    /^Done: I'm introducing myself in "Harbour Tuesday 5s" now\. It can take a few minutes to appear\.\n\nYour first three months are free\.\n\n💷 \*Club fee tip:\* after that MatchTime only charges for the games you play, up to £4\.99 a month for the group/,
  );

  const after = (await club())!;
  expect(after).toMatchObject({ stage: "live", bot: true, status: "trial" });
  const live = after.live!;
  expect(live.getTime()).toBeGreaterThanOrEqual(seededAt.getTime());
  const row = (await billingRow())!;
  // The free period runs from the go-live, three London calendar months.
  expect(row.starts).toEqual(live);
  expect(row.ends).toEqual(freePeriodEnd(live));
  expect(formatLondon(row.ends, "HH:mm:ss")).toBe(formatLondon(live, "HH:mm:ss"));
  const [ly, lm] = formatLondon(live, "yyyy-MM").split("-").map(Number);
  const [ey, em] = formatLondon(row.ends, "yyyy-MM").split("-").map(Number);
  expect(ey * 12 + em - (ly * 12 + lm)).toBe(3);
  // Not from the approval: the 19 days of silence were not taken off it.
  expect((row.ends.getTime() - fromApproval.getTime()) / DAY).toBeGreaterThan(HELD_DAYS - 3.1);
  expect((row.ends.getTime() - approved.getTime()) / DAY).toBeGreaterThan(88.9 + HELD_DAYS - 3.1);
  // The fixtures from before the GO are completed and quiet; going live
  // then made next week's game (2026-10-15, the cron's own generator).
  const fixtures = await db.all<{ id: string; status: string; flow: boolean }>(
    `SELECT id, status, "postMatchEndFlow" AS flow FROM "Match" WHERE "activityId" = $1 ORDER BY date`,
    [`${ORG}-activity`],
  );
  expect(fixtures.slice(0, 3)).toEqual([
    { id: `${ORG}-m-two-weeks`, status: "COMPLETED", flow: false },
    { id: `${ORG}-m-last-week`, status: "COMPLETED", flow: false },
    { id: `${ORG}-m-tonight`, status: "COMPLETED", flow: false },
  ]);
  expect(fixtures.slice(3)).toEqual([{ id: expect.any(String), status: "UPCOMING", flow: true }]);

  // A second GO, and a second removal-free look by the cron: nothing moves.
  addDmIntentBodies(GO_READS);
  const again = await request.post("/api/whatsapp/dm-reply", {
    headers: PI,
    data: { phone: digits(OWNER.phone), body: "GO", waMessageId: `e2e-fp-go2-${Date.now()}`, authorName: null },
  });
  expect(await again.json()).toMatchObject({ handled: "setup-go", outcome: "already-live" });
  expect(await billingRow()).toEqual(row);
  expect(await db.count(`SELECT COUNT(*) FROM "ClubBilling" WHERE "orgId" = $1`, [ORG])).toBe(1);

  // ── The three months, walked with the cron ────────────────────────────
  const ends = row.ends;
  const endKey = ends.toISOString();
  const endDay = formatLondon(ends, "EEE d MMM");

  // Where a free period counted from the approval would have ended, and
  // the day after its grace week: still free, nothing said. (Skipped when
  // that day is already inside the real free period's last nine days,
  // which it never is for a 19 day hold.)
  for (const at of [londonAt(fromApproval, 1, "12:00"), londonAt(fromApproval, 8, "12:00")]) {
    expect(at.getTime()).toBeLessThan(londonAt(ends, -9, "09:00").getTime());
    const report = await cron(request, at);
    const mine = report.clubs.find((c) => c.orgId === ORG);
    // Billing knows the club now, and has nothing to do for it yet.
    expect(mine).toBeDefined();
    expect(mine).not.toHaveProperty("transition");
    expect(mine).not.toHaveProperty("opened");
    expect(mine).not.toHaveProperty("error");
    expect((await club())!.status).toBe("trial");
  }
  expect(await billingDms()).toEqual([]);

  // Ten days before the end: nothing. Nine days before: nothing at 08:00
  // London, the first card reminder at 09:00, once.
  await cron(request, londonAt(ends, -10, "12:00"));
  await cron(request, londonAt(ends, -9, "08:00"));
  expect(await billingDms()).toEqual([]);
  await cron(request, londonAt(ends, -9, "09:00"));
  await cron(request, londonAt(ends, -9, "10:00"));
  let dms = await billingDms();
  expect(dms).toHaveLength(1);
  expect(dms[0].refId).toBe(`${ORG}:trial-21:${endKey}`);
  expect(dms[0].text).toContain(`Hi Hana Harbour, Harbour FC's free period on MatchTime ends on ${endDay}.`);

  // Two days before the end, 09:00 London: the second reminder, once.
  await cron(request, londonAt(ends, -3, "12:00"));
  expect(await billingDms()).toHaveLength(1);
  await cron(request, londonAt(ends, -2, "09:00"));
  await cron(request, londonAt(ends, -2, "10:00"));
  dms = await billingDms();
  expect(dms).toHaveLength(2);
  expect(dms[1].refId).toBe(`${ORG}:trial-28:${endKey}`);
  expect(dms[1].text).toContain(`a quick reminder: Harbour FC's free period ends on ${endDay}.`);

  // The last free minute, then the end: a week's grace from the end, and
  // the first billing month opens ON the end. No month before it.
  await cron(request, new Date(ends.getTime() - 60_000));
  expect((await club())!.status).toBe("trial");
  expect(await months()).toEqual([]);
  const atEnd = await cron(request, endKey);
  expect(atEnd.clubs.find((c) => c.orgId === ORG)).toMatchObject({ transition: "trial->grace", opened: [1] });
  expect((await club())!.status).toBe("grace");
  expect((await billingRow())!.grace).toEqual(new Date(ends.getTime() + 7 * DAY));
  let ms = await months();
  expect(ms).toHaveLength(1);
  expect(ms[0]).toMatchObject({ index: 1, status: "open", starts: ends });
  expect(ms[0].starts.getTime()).toBeGreaterThan(live.getTime());

  // The "free period has ended" DM, in the daytime, once.
  await cron(request, londonAt(ends, 1, "12:00"));
  await cron(request, londonAt(ends, 1, "13:00"));
  dms = await billingDms();
  expect(dms).toHaveLength(3);
  expect(dms[2].refId).toBe(`${ORG}:trial-ended:${endKey}`);
  expect(dms[2].text).toContain("Hi Hana Harbour, Harbour FC's free period has ended.");

  // The grace week ends with no card: paused, a week after the REAL end.
  await cron(request, new Date(ends.getTime() + 7 * DAY - 60_000));
  expect((await club())!.status).toBe("grace");
  await cron(request, new Date(ends.getTime() + 7 * DAY));
  expect((await club())!.status).toBe("paused");
  expect((await billingRow())!.reason).toBe("no-card");

  // ── The first billing month closes: nothing from before go-live counts ─
  const closeAt = londonAt(ms[0].ends, 0, "10:00");
  const closing = await cron(request, closeAt);
  expect(closing.clubs.find((c) => c.orgId === ORG)?.closed).toBe("1:no-games");
  ms = await months();
  expect(ms[0]).toMatchObject({ index: 1, status: "no-games", played: 0, invoice: null });
  // Weekly games WERE scheduled in it; the three matches completed before
  // go-live (this club counts any ended match) are simply not in it.
  expect(ms[0].scheduled).toBeGreaterThanOrEqual(4);
  const games = await db.one<{ games: Array<{ matchIds: string[]; played: boolean }> }>(
    `SELECT games FROM "ClubBillingMonth" WHERE "orgId" = $1 AND index = 1`,
    [ORG],
  );
  expect(games!.games.flatMap((g) => g.matchIds)).toEqual([]);
  expect(games!.games.some((g) => g.played)).toBe(false);
});

test("the same rules on fixed dates, and the go-live transaction itself, against a real Postgres (tsx)", async () => {
  test.setTimeout(180_000);
  const { stdout, stderr } = await execFileAsync("npx", ["tsx", "e2e/helpers/free-period-go-live-lib-tests.ts"], {
    cwd: REPO_ROOT,
    env: process.env,
    timeout: 170_000,
  }).catch((err: Error & { stdout?: string; stderr?: string }) => {
    throw new Error(`free-period-from-go-live lib tests failed:\n${err.stdout ?? ""}\n${err.stderr ?? ""}`);
  });
  expect(stdout, stderr).toMatch(/OK: 1[0-9] free-period-from-go-live checks against Postgres/);
});
