/**
 * READ-ONLY. What each club WOULD pay under the games-played club fee, for
 * its recent billing months. Slice P1 of MDs/club-fee-billing-plan-2026-10-01.md
 * (sections 2A and 13.2): shown to Kemal on real data before anything charges.
 *
 *   node --env-file=.env --import tsx scripts/club-billing-month-report.ts [options]
 *
 * Options:
 *   --months N   completed months per club, newest last (default 3)
 *   --org X      one club, by id or slug (default: every club with an activity)
 *   --current    also the month running now, counted so far
 *   --games      list every scheduled game: kickoff, played or not and why,
 *                and its match ids
 *
 * WRITES NOTHING. It only reads, through Prisma find methods (plain SELECTs):
 * no create, update, upsert or delete, no raw SQL, no transaction and no
 * session SET of any kind, so it is safe against the production pooler.
 * `src/lib/__tests__/club-billing-month-report-guard.test.ts` pins that.
 * Nothing is sent to anyone and nothing in Stripe is touched.
 *
 * WHICH MONTHS. A club whose free month has ended (`ClubBilling.trialEndsAt`
 * in the past) is shown on its real months (index 1 = the first month after
 * the free one). Every other club has no billing months yet, so it is shown
 * on WOULD-BE months on the day its months would run from: the London day of
 * `trialEndsAt` (or approval + 30 days), or the 1st (plain calendar months)
 * for a club that predates self-join, such as Sutton FC, which is exempt and
 * never billed. Prices: the club's plan (Standard GBP 9.99 or its Custom
 * maximum); a Free or exempt club is shown at GBP 9.99, labelled.
 *
 * Pause spans come from the `mt.paused` / `mt.resumed` BillingEvent rows,
 * which exist only from P1 on (no club has ever been paused for billing:
 * BILLING_ENABLED has never been on in production).
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { countClubMonth, monthBounds, monthFee, monthIndexAt, type CycleGame } from "../src/lib/club-billing-cycle-rules.ts";
import { loadClubMonthInput } from "../src/lib/club-billing-month-loader.ts";
import { STANDARD_PRICE_PENCE, TRIAL_DAYS, planPricePence } from "../src/lib/club-billing-rules.ts";
import { formatLondon, londonDateTimeToUtc } from "../src/lib/london-time.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

interface Args {
  months: number;
  org: string | null;
  current: boolean;
  games: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { months: 3, org: null, current: false, games: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--months") args.months = Number(argv[++i]);
    else if (a === "--org") args.org = argv[++i] ?? null;
    else if (a === "--current") args.current = true;
    else if (a === "--games") args.games = true;
    else {
      console.error(`Unknown option ${a}. Options: --months N, --org <id|slug>, --current, --games`);
      process.exit(1);
    }
  }
  if (!Number.isInteger(args.months) || args.months < 0 || args.months > 36) {
    console.error("--months must be a whole number from 0 to 36");
    process.exit(1);
  }
  return args;
}

const money = (p: number) => `£${(p / 100).toFixed(2)}`;
const day = (d: Date) => formatLondon(d, "d MMM yyyy");
/** The last day of a month, as organisers see it: the day before `endsAt`. */
const lastDay = (endsAt: Date) => day(new Date(endsAt.getTime() - 1));

/**
 * A would-be anchor on London day `d`: 00:00 London on the `d`th of
 * January three years back. January has 31 days, so the day is never
 * clamped at the anchor itself and every later boundary follows `d`.
 */
function syntheticAnchor(d: number, now: Date): Date {
  const y = Number(formatLondon(now, "yyyy")) - 3;
  return londonDateTimeToUtc(`${y}-01-${String(d).padStart(2, "0")}`, "00:00");
}

const WHY: Record<CycleGame["outcome"], string> = {
  played: "played",
  cancelled: "cancelled",
  "nobody-in": "ended, nobody IN, no score",
  paused: "MatchTime paused for billing",
  "no-match": "no match row (week off, deleted, or not generated)",
  "not-completed": "never completed",
  upcoming: "still to come",
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is not set. Run with node --env-file=.env --import tsx ...");
    process.exit(1);
  }
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const now = new Date();

  try {
    const orgs = await db.organisation.findMany({
      where: {
        activities: { some: {} },
        ...(args.org ? { OR: [{ id: args.org }, { slug: args.org }] } : {}),
      },
      select: {
        id: true,
        name: true,
        slug: true,
        approvedAt: true,
        approvalStatus: true,
        dormantAt: true,
        featureAttendance: true,
        billingStatus: true,
        billingPlan: true,
        billingPricePence: true,
        clubBilling: { select: { trialEndsAt: true } },
      },
      orderBy: { name: "asc" },
    });
    if (orgs.length === 0) {
      console.log(args.org ? `No club with id or slug "${args.org}" and an activity.` : "No clubs with an activity.");
      return;
    }

    console.log(`Club fee, games played: would-be numbers (read only), ${formatLondon(now, "d MMM yyyy HH:mm")} London\n`);
    let shown = 0;
    for (const org of orgs) {
      const trialEndsAt =
        org.clubBilling?.trialEndsAt ?? (org.approvedAt ? new Date(org.approvedAt.getTime() + TRIAL_DAYS * DAY_MS) : null);
      const real = !!org.clubBilling && org.clubBilling.trialEndsAt.getTime() <= now.getTime();
      const anchorDay = trialEndsAt ? Number(formatLondon(trialEndsAt, "d")) : 1;
      const anchor = real ? org.clubBilling!.trialEndsAt : syntheticAnchor(anchorDay, now);
      const anchorNote = real
        ? `real months (free month ended ${day(anchor)})`
        : trialEndsAt
          ? `would-be months from the ${anchorDay}${ordinal(anchorDay)} (free month ${org.clubBilling ? "ends" : "would end"} ${day(trialEndsAt)})`
          : "would-be calendar months (club predates self-join: exempt, never billed)";

      const plan = planPricePence(org.billingPlan, org.billingPricePence);
      const exempt = org.billingStatus === "exempt" || plan === null;
      const price = plan ?? STANDARD_PRICE_PENCE;
      const priceNote = exempt
        ? `shown at ${money(price)} (${org.billingPlan === "free" ? "Free plan" : "exempt"}: not billed)`
        : `${org.billingPlan === "custom" ? "Custom" : "Standard"}, up to ${money(price)}`;

      console.log(`${org.name} (${org.slug})`);
      console.log(
        `  ${org.approvalStatus}, billing ${org.billingStatus}, ${priceNote}` +
          `${org.dormantAt ? `, dormant since ${day(org.dormantAt)}` : ""}` +
          `${org.featureAttendance ? "" : ", does not track IN (any ended match counts)"}`,
      );
      console.log(`  ${anchorNote}`);

      const k = monthIndexAt(anchor, now);
      const first = Math.max(1, k - args.months);
      const indices: number[] = [];
      for (let i = first; i < k; i += 1) indices.push(i);
      if (args.current && k >= 1) indices.push(k);
      if (indices.length === 0) console.log("  no completed month yet");

      for (const index of indices) {
        const month = monthBounds(anchor, index);
        const running = index === k;
        const input = await loadClubMonthInput(db, org.id, month, running ? { now } : {});
        if (!input) continue;
        const c = countClubMonth(input);
        const fee = monthFee({ priceAtStartPence: price, played: c.played, scheduled: c.scheduled });
        const label = `${day(month.startsAt)} to ${lastDay(month.endsAt)}`;
        const charge = fee.charge
          ? money(fee.amountPence)
          : fee.outcome === "below-minimum"
            ? `nothing (${money(fee.amountPence)} is under 30p)`
            : "nothing (no games played)";
        const extra = running ? `, ${c.upcoming} still to come (so far)` : "";
        console.log(`  ${real ? `month ${index}: ` : ""}${label}: ${c.played} of ${c.scheduled} played${extra}, ${charge}`);
        if (args.games) {
          for (const g of c.games) {
            const ev = g.evidence ? ` (${g.evidence === "in" ? "IN" : g.evidence === "score" ? "score" : "no IN tracking"})` : "";
            const ids = g.matchIds.length ? `  [${g.matchIds.join(", ")}]` : "";
            console.log(
              `      ${formatLondon(g.kickoff, "EEE d MMM HH:mm")}  ${g.source.padEnd(6)}  ${g.played ? "PLAYED" : "  -   "}  ${WHY[g.outcome]}${ev}${ids}`,
            );
          }
        }
      }
      console.log("");
      shown += 1;
    }
    console.log(`${shown} club(s). Nothing was written, sent or charged.`);
  } finally {
    await db.$disconnect();
  }
}

function ordinal(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return "th";
  return n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
