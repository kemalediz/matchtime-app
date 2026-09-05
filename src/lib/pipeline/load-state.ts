/**
 * THE ONLY I/O IN THIS DIRECTORY.
 *
 * Loads a `SquadState` once per batch. After this returns, the engine is
 * a pure function of that value: no lazy re-reads, no clock, no second
 * query hiding inside a decision. That is what makes the whole engine
 * unit-testable from a plain object (§12.3).
 *
 * READ-ONLY BY CONSTRUCTION. Every statement here is a `findMany` /
 * `findFirst` / `count`. §10 step 2 is "still zero writes", and the
 * simplest way to keep a promise like that is to have nowhere in the
 * module that could break it.
 */
import { db } from "../db";
import { formatLondon } from "../london-time";
import { getOrgFeatures } from "../org-features";
import { selectRegistrationMatch } from "../registration-match-select";
import { resolveTeamLabels } from "../team-labels";
import { totalPlayersFor } from "../format-switch";
import { guestNameAskKey, GUEST_NAME_ASK_KIND } from "../guest-name-ask";
import type { SquadState } from "./types";

/** Statuses `selectRegistrationMatch` considers, plus COMPLETED so the
 *  "previous match still in flight" guard can see the whole picture. */
const LOOKBACK_DAYS = 30;

export async function loadSquadState(
  orgId: string,
  now: Date = new Date(),
): Promise<SquadState> {
  const features = await getOrgFeatures(orgId);

  const since = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const matches = await db.match.findMany({
    where: { activity: { orgId }, date: { gte: since } },
    select: {
      id: true,
      date: true,
      status: true,
      maxPlayers: true,
      teamLabels: true,
      activity: {
        select: {
          venue: true,
          sport: { select: { name: true, playersPerTeam: true, teamLabels: true } },
        },
      },
    },
    orderBy: { date: "asc" },
  });

  // Which match a write lands on is a PURE decision and it already has a
  // module (§13: "the pure-function core … the engine is built out of
  // these, not beside them"). The 2026-06-18 rollover incident — casual
  // "In"s landing on next week's empty match while this week was full —
  // is fixed here, once, for every path.
  const active = selectRegistrationMatch(
    matches.map((m) => ({ id: m.id, date: m.date, status: m.status })),
    now,
  );
  const match = active ? matches.find((m) => m.id === active.id)! : null;

  const org = await db.organisation.findUnique({
    where: { id: orgId },
    select: { teamLabels: true },
  });

  const memberships = await db.membership.findMany({
    where: { orgId, leftAt: null },
    select: {
      role: true,
      user: { select: { id: true, name: true, phoneNumber: true } },
    },
  });

  const roster = memberships.map((m) => ({
    userId: m.user.id,
    name: m.user.name ?? "",
    isAdmin: m.role === "OWNER" || m.role === "ADMIN",
    hasPhone: !!m.user.phoneNumber,
  }));

  const rows = match
    ? (
        await db.attendance.findMany({
          where: { matchId: match.id },
          select: { userId: true, status: true, position: true },
          orderBy: { position: "asc" },
        })
      ).map((a) => ({ userId: a.userId, status: a.status, position: a.position }))
    : [];

  const benchIds = rows.filter((r) => r.status === "BENCH").map((r) => r.userId);
  const offers = match
    ? await db.benchSlotOffer.findMany({
        where: { matchId: match.id, resolvedAt: null },
        select: { id: true, replacingUserId: true },
      })
    : [];

  const teams = match
    ? (
        await db.teamAssignment.findMany({
          where: { matchId: match.id },
          select: { userId: true, team: true },
          // INSERTION order, exactly as the shipped `show_teams_request`
          // path reads them (`route.ts:3709`: "so the re-post renders
          // the same players in the same order generate wrote them —
          // createMany writes red then yellow"). Without it Postgres
          // returns heap order, which changes after an UPDATE — i.e.
          // after exactly the manual admin swap `c408649` and corpus
          // case S19 exist to protect.
          orderBy: { id: "asc" },
        })
      ).map((t) => ({ userId: t.userId, team: t.team as "RED" | "YELLOW" }))
    : [];

  const completed = await db.match.findFirst({
    where: { activity: { orgId }, status: "COMPLETED", date: { lte: now } },
    select: {
      id: true,
      redScore: true,
      yellowScore: true,
      attendances: { where: { status: "CONFIRMED" }, select: { userId: true } },
    },
    orderBy: { date: "desc" },
  });

  // Appearances across completed matches, for the stats answer that
  // today costs a whole extra LLM call and once returned the squad
  // roster instead (§3.2 S16, 2026-05-14).
  const appearanceRows = await db.attendance.findMany({
    where: {
      status: "CONFIRMED",
      match: { activity: { orgId }, status: "COMPLETED", date: { gte: since } },
    },
    select: { userId: true },
  });
  const counts = new Map<string, number>();
  for (const a of appearanceRows) counts.set(a.userId, (counts.get(a.userId) ?? 0) + 1);

  // Alternative formats the org has configured, for the options answer.
  // TOTALS across both teams — never per-team. That units confusion IS
  // the 2026-08-30 incident.
  const activities = await db.activity.findMany({
    where: { orgId, isActive: true },
    select: { sport: { select: { name: true, playersPerTeam: true } } },
  });
  const currentTotal = match?.maxPlayers ?? 0;
  const smallerFormats = activities
    .map((a) => ({
      sportName: a.sport.name,
      totalPlayers: totalPlayersFor(a.sport.playersPerTeam),
    }))
    .filter((f) => f.totalPlayers > 0 && f.totalPlayers < currentTotal);

  const guestAsked = match
    ? (
        await db.sentNotification.findMany({
          where: { kind: GUEST_NAME_ASK_KIND, matchId: match.id },
          select: { key: true },
        })
      )
        .map((s) => roster.find((r) => guestNameAskKey(match.id, r.userId) === s.key)?.userId)
        .filter((id): id is string => !!id)
    : [];

  const lastBotJob = await db.botJob.findFirst({
    where: { orgId, kind: "group" },
    select: { text: true },
    orderBy: { createdAt: "desc" },
  });

  const [redLabel, yellowLabel] = match
    ? resolveTeamLabels(
        { teamLabels: match.teamLabels },
        org ? { teamLabels: org.teamLabels } : null,
        match.activity.sport,
      )
    : ["Red", "Yellow"];

  return {
    matchId: match?.id ?? null,
    maxPlayers: match?.maxPlayers ?? 0,
    kickoffLabel: match ? formatLondon(match.date, "EEE HH:mm") : "the next match",
    venue: match?.activity.venue ?? "",
    rows,
    roster,
    openOffers: offers.map((o) => ({
      id: o.id,
      replacingUserId: o.replacingUserId,
      offeredToUserIds: benchIds,
    })),
    teams,
    teamLabels: [redLabel, yellowLabel],
    completedMatch: completed
      ? {
          id: completed.id,
          redScore: completed.redScore,
          yellowScore: completed.yellowScore,
          participantUserIds: completed.attendances.map((a) => a.userId),
        }
      : null,
    appearances: [...counts.entries()].map(([userId, matchesPlayed]) => ({
      userId,
      matches: matchesPlayed,
    })),
    lastBotPost: lastBotJob?.text ?? null,
    features: {
      attendance: features.attendance,
      paymentTracking: features.paymentTracking ?? false,
      statsQa: features.statsQa ?? false,
    },
    smallerFormats,
    guestAskedUserIds: guestAsked,
  };
}
