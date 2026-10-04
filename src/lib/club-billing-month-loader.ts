/**
 * CLUB FEE BILLING, games played (slice P1): READ a club's billing month.
 * Plan: MDs/club-fee-billing-plan-2026-10-01.md, sections 2A and 13.2.
 *
 * Turns the club's rows into `countClubMonth`'s input: its activities, the
 * month's matches with their IN counts, the club's attendance setting and
 * its pause spans (`mt.paused` / `mt.resumed`). It ONLY READS (find
 * methods), and takes the client as an argument so the read-only report
 * script (scripts/club-billing-month-report.ts) can pass its own client
 * and nothing here imports the app's `db`. The month close (P2) will call
 * it with the app's client.
 */
import type { Prisma } from "@/generated/prisma/client";
import {
  BILLED_EVENT_TYPE,
  BILLING_OFF_EVENT_TYPE,
  BILLING_ON_EVENT_TYPE,
  PAUSED_EVENT_TYPE,
  RESUMED_EVENT_TYPE,
  UNBILLED_EVENT_TYPE,
  notChargedSpansFrom,
  type CountClubMonthInput,
  type CycleActivity,
} from "./club-billing-cycle-rules";

/** The match columns the count reads, and the IN (CONFIRMED) count. */
const MATCH_SELECT = {
  id: true,
  activityId: true,
  date: true,
  status: true,
  isHistorical: true,
  redScore: true,
  yellowScore: true,
  _count: { select: { attendances: { where: { status: "CONFIRMED" as const } } } },
} as const;

/* eslint-disable @typescript-eslint/no-explicit-any -- Prisma's delegate
   methods are generic over their arguments; a structural type with `any`
   arguments is what lets both a plain PrismaClient (the script) and the
   app's extended `db` fit. The arguments are pinned by the unit tests. */
type Find<R> = (args: any) => PromiseLike<R>;

/** The read methods the loader uses, and nothing else (no write method is
 *  reachable through this type). */
export interface MonthLoaderClient {
  organisation: { findUnique: Find<{ featureAttendance: boolean } | null> };
  activity: { findMany: Find<CycleActivity[]> };
  match: {
    /** Typed on the exact select, so the IN count (`_count`) is part of
     *  the result type for both clients. */
    findMany: (args: {
      where: Prisma.MatchWhereInput;
      select: typeof MATCH_SELECT;
      orderBy: Prisma.MatchOrderByWithRelationInput;
    }) => PromiseLike<
      Array<{
        id: string;
        activityId: string;
        date: Date;
        status: string;
        isHistorical: boolean;
        redScore: number | null;
        yellowScore: number | null;
        _count: { attendances: number };
      }>
    >;
  };
  billingEvent: { findMany: Find<Array<{ type: string; receivedAt: Date }>> };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * The count's input for one club and one month, or null when the club does
 * not exist. `now` is passed through for a month still running (games to
 * come are "upcoming"); omit it when closing a month.
 */
export async function loadClubMonthInput(
  client: MonthLoaderClient,
  orgId: string,
  month: { startsAt: Date; endsAt: Date },
  opts: { now?: Date } = {},
): Promise<CountClubMonthInput | null> {
  const org = await client.organisation.findUnique({ where: { id: orgId }, select: { featureAttendance: true } });
  if (!org) return null;

  const matches = await client.match.findMany({
    where: { activity: { orgId }, isHistorical: false, date: { gte: month.startsAt, lt: month.endsAt } },
    select: MATCH_SELECT,
    orderBy: { date: "asc" },
  });
  const withMatches = [...new Set(matches.map((m) => m.activityId))];

  const activities = await client.activity.findMany({
    where: { orgId, OR: [{ isActive: true }, { id: { in: withMatches } }] },
    select: { id: true, dayOfWeek: true, time: true, venue: true, isActive: true, createdAt: true },
  });

  // Every span in which games are never charged (P2 review, H1): the
  // club's billing pauses and not-billable spells (Free, suspended), and
  // the GLOBAL spells when BILLING_ENABLED was off (orgId NULL).
  const events = await client.billingEvent.findMany({
    where: {
      OR: [
        { orgId, type: { in: [PAUSED_EVENT_TYPE, RESUMED_EVENT_TYPE, UNBILLED_EVENT_TYPE, BILLED_EVENT_TYPE] } },
        { orgId: null, type: { in: [BILLING_OFF_EVENT_TYPE, BILLING_ON_EVENT_TYPE] } },
      ],
      receivedAt: { lt: month.endsAt },
    },
    orderBy: { receivedAt: "asc" },
    select: { type: true, receivedAt: true },
  });

  return {
    startsAt: month.startsAt,
    endsAt: month.endsAt,
    activities,
    matches: matches.map((m) => ({
      id: m.id,
      activityId: m.activityId,
      date: m.date,
      status: m.status,
      isHistorical: m.isHistorical,
      redScore: m.redScore,
      yellowScore: m.yellowScore,
      confirmedCount: m._count.attendances,
    })),
    pauseSpans: notChargedSpansFrom(events.map((e) => ({ type: e.type, at: e.receivedAt }))),
    tracksAttendance: org.featureAttendance,
    ...(opts.now ? { now: opts.now } : {}),
  };
}
