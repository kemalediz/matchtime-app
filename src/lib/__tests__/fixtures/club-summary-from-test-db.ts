/**
 * THE CLUB SUMMARY OF A SCHEDULER TEST'S OWN WORLD (club summary, slice A1).
 *
 * Since A1 the scheduler reads its club facts from the club summary. The
 * scheduler tests written before it describe their club with a mocked
 * Prisma client that answers the reads the scheduler USED to make (a
 * partial club row, the switches through a mocked `getOrgFeatures`, the
 * matches with their activity, the running and live months in the shapes
 * `loadSchedulerMonths` and `loadLiveMonths` read). This module stands in
 * for `@/lib/club-summary/load` in those tests:
 *
 *   vi.mock("@/lib/club-summary/load", () => import("./fixtures/club-summary-from-test-db"));
 *
 * and builds the summary that world describes, through the real
 * `buildClubSummary`, from those same reads. Missing club columns take the
 * schema's defaults, or the value the test's switches already say (in a
 * real club `getOrgFeatures` reads the same columns). So each test keeps
 * its world and its assertions; what the real loader reads is pinned by
 * `club-summary/__tests__/load.test.ts`, the scheduler's characterisation
 * (`scheduler-club-summary-characterisation.test.ts`) and the club
 * scenario replays.
 */
import { vi } from "vitest";
import { db } from "@/lib/db";
import { getOrgFeatures } from "@/lib/org-features";
import { buildClubSummary, type ActivityRow, type ClubRows, type MatchRow, type MonthRow, type OrgRow } from "@/lib/club-summary/derive";
import type { ClubSummary } from "@/lib/club-summary/types";
import type { LoadClubOptions } from "@/lib/club-summary/load";
import { orgRow } from "@/lib/club-summary/__tests__/fixtures";
import { closedLatelyWhere, schedulerMatchWhere } from "@/lib/scheduler-windows";
import { londonMonthStart, monthStartToDate } from "@/lib/squad-month-rules";
import { nextMonthStart } from "@/lib/month-signup-rules";
import { isSameRecurringFixture } from "@/lib/match-slot";

const actual = await vi.importActual<typeof import("@/lib/club-summary/load")>("@/lib/club-summary/load");
export const CLUB_ORG_SELECT = actual.CLUB_ORG_SELECT;

type Raw = Record<string, unknown>;
const DEFAULTS = orgRow({ id: "x", name: "x" });

/** The test's club row, completed: its own columns, else what its switches
 *  say, else the schema's default. */
function orgOf(raw: Raw, orgId: string, f: Raw): OrgRow {
  const has = (k: string) => raw[k] !== undefined;
  const from = <T,>(k: string, v: T) => (has(k) ? raw[k] : v) as never;
  const row = orgRow({
    ...(Object.fromEntries(Object.keys(DEFAULTS).filter(has).map((k) => [k, raw[k]])) as Partial<OrgRow>),
    id: orgId,
    name: from("name", "Club"),
    whatsappGroupId: from("whatsappGroupId", null),
    language: from("language", typeof f.language === "string" ? f.language : "en"),
    squadMode: from("squadMode", f.squadMode === "monthly" ? "monthly" : "weekly"),
    listAnnouncer: from("listAnnouncer", f.listAnnouncer === "organisers" ? "organisers" : "matchtime"),
    momChosenBy: from("momChosenBy", f.momChosenBy === "organisers" ? "organisers" : "players"),
    benchPickMode: from("benchPickMode", f.benchPickMode === "organiser" ? "organiser" : "first-come"),
    paymentTrackingEnabled: from("paymentTrackingEnabled", f.paymentTracking === true),
    paymentCollectionEnabled: from("paymentCollectionEnabled", f.paymentCollection === true),
    rollingSquadEnabled: from("rollingSquadEnabled", f.rollingSquad === true),
  });
  return { ...row, approvedAt: (raw.approvedAt as Date | null | undefined) ?? null, liveAt: (raw.liveAt as Date | null | undefined) ?? null };
}

function activityOf(a: Raw, active: boolean): ActivityRow {
  const sport = (a.sport ?? {}) as Raw;
  return {
    id: String(a.id ?? ""),
    name: String(a.name ?? a.id ?? ""),
    isActive: active,
    dayOfWeek: (a.dayOfWeek as number) ?? 0,
    time: (a.time as string) ?? "20:00",
    venue: (a.venue as string) ?? "",
    matchDurationMins: (a.matchDurationMins as number) ?? 60,
    minPlayers: (a.minPlayers as number | null) ?? null,
    maxPlayers: (a.maxPlayers as number | null) ?? null,
    feePerPlayer: (a.feePerPlayer as number | null) ?? null,
    feeSplitTotal: (a.feeSplitTotal as boolean) ?? false,
    createdAt: (a.createdAt as Date) ?? new Date(0),
    sport: { name: String(sport.name ?? "Football"), playersPerTeam: (sport.playersPerTeam as number) ?? 7 },
  };
}

function matchOf(m: Raw): MatchRow {
  const date = m.date as Date;
  return {
    id: String(m.id),
    activityId: String(m.activityId ?? (m.activity as Raw | undefined)?.id ?? ""),
    date,
    status: String(m.status ?? "UPCOMING"),
    maxPlayers: (m.maxPlayers as number) ?? 14,
    attendanceDeadline: (m.attendanceDeadline as Date) ?? new Date(date.getTime() - 5 * 3600_000),
    feePerPlayer: (m.feePerPlayer as number | null) ?? null,
    feePendingConfirm: (m.feePendingConfirm as number | null) ?? null,
    paymentLinksReleasedAt: (m.paymentLinksReleasedAt as Date | null) ?? null,
    rollingSeededAt: (m.rollingSeededAt as Date | null) ?? null,
    attendances: ((m.attendances as Raw[] | undefined) ?? []).map((a) => ({ status: String(a.status) })),
    _count: { teamAssignments: ((m._count as Raw | undefined)?.teamAssignments as number) ?? ((m.teamAssignments as unknown[] | undefined) ?? []).length },
  };
}

/** A month row as the test's world answers the scheduler's old month reads. */
function monthOf(r: Raw, activities: ActivityRow[], orgId: string): MonthRow | null {
  const fixture = r.activity as Raw | undefined;
  const activityId =
    (r.activityId as string | undefined) ??
    activities.find((a) => fixture && isSameRecurringFixture({ orgId, venue: a.venue, dayOfWeek: a.dayOfWeek }, { orgId, venue: String(fixture.venue), dayOfWeek: Number(fixture.dayOfWeek) }))?.id;
  if (!activityId) return null;
  const closed = r.status === "closed" || r.closed === true;
  return {
    id: String(r.id),
    activityId,
    monthStart: r.monthStart as Date,
    status: String(r.status ?? (closed ? "closed" : "running")),
    listOpenedAt: (r.listOpenedAt as Date | null) ?? null,
    pricedAt: (r.pricedAt as Date | null) ?? null,
    closedAt: (r.closedAt as Date | null) ?? (closed ? new Date() : null),
    createdAt: (r.createdAt as Date) ?? new Date(0),
    startedMidMonthAt: (r.startedMidMonthAt as Date | null) ?? null,
    members: [],
  };
}

export async function loadClubRows(orgId: string, now: Date, opts: LoadClubOptions = {}): Promise<ClubRows | null> {
  const raw = ((opts.org as Raw | null | undefined) ?? ((await db.organisation.findUnique({ where: { id: orgId } })) as Raw | null)) ?? null;
  if (!raw) return null;
  const features = await getOrgFeatures(orgId);
  const org = orgOf(raw, orgId, features as unknown as Raw);

  const loaded = ((await db.match.findMany({ where: schedulerMatchWhere(orgId, now), orderBy: { date: "asc" } })) ?? []) as Raw[];
  const matches = loaded.filter((m) => m && m.date instanceof Date).map(matchOf);
  // The games: each match's own activity, and the club's games as the
  // scheduler's same-sport readers read them. `activity.count` says
  // whether any is active (the bot introduction's read).
  const active = ((await db.activity.count({ where: { orgId, isActive: true } })) as number) > 0;
  const games = new Map<string, ActivityRow>();
  for (const m of loaded) if (m?.activity) games.set(String(m.activityId ?? (m.activity as Raw).id), activityOf({ id: m.activityId, ...(m.activity as Raw) }, active));
  const others = ((await db.activity.findMany({ where: { orgId }, select: { id: true, minPlayers: true, sport: { select: { name: true, playersPerTeam: true } } } })) ?? []) as Raw[];
  others.forEach((a, i) => {
    const id = String(a.id ?? `other-${i}`);
    if (!games.has(id)) games.set(id, activityOf({ ...a, id }, active));
  });
  // A world whose `activity.count` says it has an active game it shows no
  // row of (a club the day it goes live): that game.
  if (active && games.size === 0) games.set("active-game", activityOf({ id: "active-game" }, true));
  const activities = [...games.values()];

  let months: MonthRow[] = [];
  let heldKeys: string[] = [];
  if (org.squadMode === "monthly") {
    const current = londonMonthStart(now);
    const running = ((await db.squadMonth.findMany({ where: { orgId, OR: [{ status: "running" }, closedLatelyWhere(now)] } })) ?? []) as Raw[];
    const live = ((await db.squadMonth.findMany({
      where: { orgId, status: { in: ["open", "priced", "running"] }, monthStart: { in: [monthStartToDate(current), monthStartToDate(nextMonthStart(current))] } },
    })) ?? []) as Raw[];
    const byId = new Map<string, MonthRow>();
    for (const r of [...running, ...live]) {
      const row = r && monthOf(r, activities, orgId);
      if (row && !byId.has(row.id)) byId.set(row.id, row);
    }
    months = [...byId.values()];
    heldKeys = (((await db.sentNotification.findMany({ where: { key: { startsWith: `org-${orgId}:msu:held:` } }, select: { key: true } })) ?? []) as Raw[]).map((h) => String(h.key));
  }
  return { org, features, collectorName: null, collectionLive: false, activities, matches, lastPlayed: [], months, heldKeys, members: null };
}

export async function loadClubSummary(orgId: string, now: Date, opts: LoadClubOptions = {}): Promise<ClubSummary | null> {
  const rows = await loadClubRows(orgId, now, opts);
  return rows ? buildClubSummary(rows, now) : null;
}
