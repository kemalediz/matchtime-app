/**
 * LOCAL ONLY. The club fee, end to end, in Stripe TEST mode on this Mac:
 * a local database, the app on http://localhost:3000, and `stripe listen`
 * forwarding Stripe's events to it. The runbook that drives it is section 16
 * of MDs/club-fee-billing-plan-2026-10-01.md.
 *
 *   set -a; source .env.billing-local; set +a
 *   node --env-file=.env --import tsx scripts/billing-local-test.ts <command>
 *
 * (The values sourced from .env.billing-local win over .env: node's
 * --env-file never overrides a variable that is already set.)
 *
 * Commands:
 *   setup    schema (prisma db push) and the CHECK constraints on the LOCAL
 *            database, then one test club in its free month: an owner (who
 *            is also the platform owner, for /admin/clubs) and a money
 *            collector, a weekly Tuesday 5-a-side. Prints sign-in links.
 *   links    the sign-in links again (they last an hour).
 *   games    month 1's Tuesdays as match rows: all but the last played (one
 *            IN each), the last cancelled. Prints the expected charge.
 *   times    month 1's dates and the cron calls (with x-test-now) that open
 *            it, close it, and retry a failed charge.
 *   status   the club's billing state, card, months, and the billing DMs it
 *            WOULD have sent (PlatformJob rows; nothing leaves this Mac:
 *            the WhatsApp Pi only ever polls production).
 *
 * REFUSES TO RUN unless DATABASE_URL and DIRECT_URL are on this Mac,
 * STRIPE_SECRET_KEY is a test key and NEXTAUTH_URL is localhost
 * (`localBillingTestRefusal`, pinned by billing-local-guard.test.ts).
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { localBillingTestRefusal } from "../src/lib/billing-local-guard";
import { signMagicLinkToken } from "../src/lib/magic-link";
import { monthBounds, monthFee } from "../src/lib/club-billing-cycle-rules";
import { formatLondon, londonDateTimeToUtc } from "../src/lib/london-time";

const ORG = "billtest-club";
const OWNER = "billtest-owner";
const COLLECTOR = "billtest-collector";
const DAY = 24 * 60 * 60 * 1000;
const ROOT = path.resolve(__dirname, "..");
const SQL_FILES = [
  "attendance-event-append-only.sql",
  "org-approval-check.sql",
  "admin-channel-check.sql",
  "organiser-pick-check.sql",
  "org-billing-check.sql",
  "club-billing-month-check.sql",
];

function stop(msg: string): never {
  console.error(`\nSTOPPED: ${msg}\n`);
  process.exit(1);
}

const refusal = localBillingTestRefusal(process.env);
if (refusal) stop(refusal);

const base = process.env.NEXTAUTH_URL!.replace(/\/+$/, "");
const pool = new Pool({ connectionString: process.env.DIRECT_URL, max: 2 });
const run = (sql: string, params: unknown[] = []) => pool.query(sql, params);

function link(userId: string, nextPath: string): string {
  return `${base}/r/${signMagicLinkToken({ userId, purpose: "sign-in", nextPath, ttlSeconds: 60 * 60 })}`;
}

function printLinks() {
  console.log("\nSign-in links (each works for an hour; open them in different browsers or private windows):");
  console.log(`  Money collector (pays):  ${link(COLLECTOR, `/billing/${ORG}`)}`);
  console.log(`  Owner, settings card:    ${link(OWNER, "/admin/settings")}`);
  console.log(`  Owner, /admin/clubs:     ${link(OWNER, "/admin/clubs")}`);
}

async function trialEnd(): Promise<Date> {
  const r = await run(`SELECT "trialEndsAt" FROM "ClubBilling" WHERE "orgId"=$1`, [ORG]);
  if (!r.rows[0]) stop("No test club yet. Run setup first.");
  return r.rows[0].trialEndsAt as Date;
}

async function setup() {
  console.log("Applying the schema to the LOCAL database (prisma db push)...");
  execFileSync("npx", ["prisma", "db", "push"], { cwd: ROOT, stdio: "inherit", env: process.env });
  for (const f of SQL_FILES) {
    console.log(`Arming ${f}...`);
    execFileSync("psql", [process.env.DIRECT_URL!, "-v", "ON_ERROR_STOP=1", "-q", "-f", path.join(ROOT, "prisma", "sql", f)], { stdio: "inherit" });
  }
  const exists = await run(`SELECT 1 FROM "Organisation" WHERE id=$1`, [ORG]);
  if (exists.rowCount) {
    console.log("\nThe test club already exists. To start again: dropdb matchtime_billing && createdb matchtime_billing, then setup.");
    printLinks();
    return;
  }
  const now = new Date();
  await run(
    `INSERT INTO "Organisation" (id,name,slug,"inviteCode","approvalStatus",language,"approvedAt","approvalDecidedAt","billingStatus","createdAt","updatedAt")
     VALUES ($1,'Billing Test FC',$1,'billtest-invite','approved','en',$2,$2,'trial',$2,$2)`,
    [ORG, now],
  );
  for (const [id, name, phone, superadmin] of [
    [OWNER, "Test Owner", "+447700909001", true],
    [COLLECTOR, "Test Collector", "+447700909002", false],
  ] as const) {
    await run(
      `INSERT INTO "User" (id,name,email,"phoneNumber",onboarded,"isActive","isSuperadmin","updatedAt") VALUES ($1,$2,$3,$4,true,true,$5,now())`,
      [id, name, `${id}@billing-local.invalid`, phone, superadmin],
    );
  }
  await run(`INSERT INTO "Membership" (id,"userId","orgId",role) VALUES ($1,$2,$3,'OWNER'),($4,$5,$3,'PLAYER')`, [
    `${OWNER}-m`,
    OWNER,
    ORG,
    `${COLLECTOR}-m`,
    COLLECTOR,
  ]);
  await run(`UPDATE "Organisation" SET "paymentHolderId"=$2 WHERE id=$1`, [ORG, COLLECTOR]);
  await run(`INSERT INTO "ClubBilling" ("orgId","trialStartedAt","trialEndsAt","updatedAt") VALUES ($1,$2,$3,now())`, [
    ORG,
    now,
    new Date(now.getTime() + 30 * DAY),
  ]);
  await run(
    `INSERT INTO "Sport" (id,"orgId",name,preset,"playersPerTeam",positions,"teamLabels","updatedAt")
     VALUES ('billtest-sport',$1,'Football 5-a-side','football-5aside',5,'{GK,DEF,MID,FWD}','{Red,Yellow}',now())`,
    [ORG],
  );
  await run(
    `INSERT INTO "Activity" (id,"orgId","sportId",name,"dayOfWeek",time,venue,"feePerPlayer","createdAt","updatedAt")
     VALUES ('billtest-activity',$1,'billtest-sport','Tuesday 5s',2,'20:00','Test Arena',8,$2,now())`,
    [ORG, new Date(now.getTime() - 60 * DAY)],
  );
  console.log("\nTest club 'Billing Test FC' created: free month from now, ends in 30 days, Test Collector collects.");
  printLinks();
}

async function games() {
  const m = monthBounds(await trialEnd(), 1);
  const tuesdays: Date[] = [];
  for (let t = m.startsAt.getTime(); t < m.endsAt.getTime() + DAY; t += DAY) {
    const day = formatLondon(new Date(t), "yyyy-MM-dd");
    const at = londonDateTimeToUtc(day, "20:00");
    if (formatLondon(at, "i") === "2" && at >= m.startsAt && at < m.endsAt && !tuesdays.some((d) => d.getTime() === at.getTime())) tuesdays.push(at);
  }
  await run(`DELETE FROM "Attendance" WHERE "matchId" LIKE 'billtest-m%'`);
  await run(`DELETE FROM "Match" WHERE id LIKE 'billtest-m%'`);
  for (const [i, at] of tuesdays.entries()) {
    const last = i === tuesdays.length - 1;
    await run(
      `INSERT INTO "Match" (id,"activityId",date,"maxPlayers",status,"attendanceDeadline","updatedAt") VALUES ($1,'billtest-activity',$2,10,$3,$2,now())`,
      [`billtest-m${i}`, at, last ? "CANCELLED" : "COMPLETED"],
    );
    if (!last) {
      await run(`INSERT INTO "Attendance" (id,"matchId","userId",status,"updatedAt") VALUES ($1,$2,$3,'CONFIRMED',now())`, [`billtest-a${i}`, `billtest-m${i}`, COLLECTOR]);
    }
  }
  const played = tuesdays.length - 1;
  const fee = monthFee({ priceAtStartPence: 999, played, scheduled: tuesdays.length });
  console.log(`Month 1 (${formatLondon(m.startsAt, "EEE d MMM")} to the day before ${formatLondon(m.endsAt, "EEE d MMM")}): ${tuesdays.length} Tuesdays.`);
  console.log(`Seeded ${played} played and 1 cancelled. Expected charge: ${played} of ${tuesdays.length} = £${(fee.amountPence / 100).toFixed(2)}.`);
}

async function times() {
  const m = monthBounds(await trialEnd(), 1);
  const closeDay = formatLondon(m.endsAt, "yyyy-MM-dd");
  const open = new Date(m.startsAt.getTime() + 60 * 60 * 1000);
  const close = londonDateTimeToUtc(closeDay, "10:30");
  const curl = (at: Date) =>
    `curl -s -H "authorization: Bearer $CRON_SECRET" -H "x-test-now: ${at.toISOString()}" ${base}/api/cron/billing | python3 -m json.tool`;
  console.log(`Month 1 runs from ${formatLondon(m.startsAt, "EEE d MMM HH:mm")} to ${formatLondon(m.endsAt, "EEE d MMM HH:mm")} (London).`);
  console.log(`\n1. Open month 1 (the cron as if it ran an hour after the free month ended):\n   ${curl(open)}`);
  console.log(`\n2. Close and charge month 1 (10:30 London the morning after it ends):\n   ${curl(close)}`);
  for (const d of [1, 3, 5]) {
    const at = londonDateTimeToUtc(formatLondon(new Date(close.getTime() + d * DAY), "yyyy-MM-dd"), "10:30");
    console.log(`\n   Retry day ${d} after a declined charge:\n   ${curl(at)}`);
  }
}

async function status() {
  const org = (await run(`SELECT "billingStatus","billingPlan","billingPricePence" FROM "Organisation" WHERE id=$1`, [ORG])).rows[0];
  if (!org) stop("No test club yet. Run setup first.");
  const cb = (
    await run(
      `SELECT "trialEndsAt","graceEndsAt","currentPeriodEnd","cancelAtPeriodEnd","stripeCustomerId","cardBrand","cardLast4","cardHolderUserId","paymentFailedAt","pausedReason","vatCountryCheck" FROM "ClubBilling" WHERE "orgId"=$1`,
      [ORG],
    )
  ).rows[0];
  console.log("Club:", org);
  console.log("ClubBilling:", cb);
  // Read through Prisma (a find): club-billing-months.ts stays the only
  // writer of the months, and no raw SQL here names their table.
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DIRECT_URL! }) });
  try {
    const months = await prisma.clubBillingMonth.findMany({
      where: { orgId: ORG },
      orderBy: { index: "asc" },
      select: { id: true, index: true, status: true, scheduled: true, played: true, amountPence: true, stripeInvoiceId: true, reason: true, startsAt: true, endsAt: true },
    });
    console.log("Months:");
    console.table(months);
  } finally {
    await prisma.$disconnect();
  }
  const dms = await run(`SELECT "createdAt",text FROM "PlatformJob" WHERE purpose='billing' AND "refId" LIKE $1 ORDER BY "createdAt" DESC LIMIT 8`, [`${ORG}:%`]);
  console.log("Billing DMs it would have sent (newest first, never sent from this Mac):");
  for (const r of dms.rows) console.log(`\n[${(r.createdAt as Date).toISOString()}]\n${r.text}`);
}

async function main() {
  const cmd = process.argv[2];
  try {
    if (cmd === "setup") await setup();
    else if (cmd === "links") printLinks();
    else if (cmd === "games") await games();
    else if (cmd === "times") await times();
    else if (cmd === "status") await status();
    else stop("Usage: scripts/billing-local-test.ts setup | links | games | times | status");
  } finally {
    await pool.end();
  }
}

void main();
