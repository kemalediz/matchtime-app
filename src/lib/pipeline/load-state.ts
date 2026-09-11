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
import { decidePaymentSnapshot, type PaymentSnapshot } from "./payment-answer";
import type { RatingProgress } from "../rating-progress-answer";
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

  // THE LAST MATCH ACTUALLY PLAYED — see `SquadState.completedMatch`.
  //
  // The three statuses and the "kickoff + duration has passed" test are
  // the shipped score path's, copied deliberately (`route.ts:3471-3487`):
  // a match only becomes COMPLETED when somebody records a score, so
  // asking for COMPLETED alone would mean the FIRST score of every match
  // had nowhere to land. `take: 10` then `.find(ended)` is also its
  // shape — the ten most recent, the first that has finished.
  const completedCandidates = await db.match.findMany({
    where: {
      activity: { orgId },
      status: { in: ["TEAMS_GENERATED", "TEAMS_PUBLISHED", "COMPLETED"] },
      date: { lte: now },
    },
    select: {
      id: true,
      date: true,
      status: true,
      isHistorical: true,
      redScore: true,
      yellowScore: true,
      activity: { select: { matchDurationMins: true } },
      attendances: { where: { status: "CONFIRMED" }, select: { userId: true } },
    },
    orderBy: { date: "desc" },
    take: 10,
  });
  const completed =
    completedCandidates.find(
      (m) =>
        new Date(m.date.getTime() + m.activity.matchDurationMins * 60 * 1000).getTime() <=
        now.getTime(),
    ) ?? null;

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
          // Same format as the upcoming match's label, so the RESULT
          // answer can name the night it is talking about. See the field.
          kickoffLabel: formatLondon(completed.date, "EEE HH:mm"),
          status: completed.status as "TEAMS_GENERATED" | "TEAMS_PUBLISHED" | "COMPLETED",
          isHistorical: completed.isHistorical,
          redScore: completed.redScore,
          yellowScore: completed.yellowScore,
          participantUserIds: completed.attendances.map((a) => a.userId),
        }
      : null,
    appearances: [...counts.entries()].map(([userId, matchesPlayed]) => ({
      userId,
      matches: matchesPlayed,
    })),
    // The window the line above was counted over, carried so the stats
    // answer can name it rather than imply "all time". See the field.
    appearanceWindowDays: LOOKBACK_DAYS,
    lastBotPost: lastBotJob?.text ?? null,
    features: {
      attendance: features.attendance,
      paymentTracking: features.paymentTracking ?? false,
      statsQa: features.statsQa ?? false,
      reminders: features.reminders ?? false,
    },
    smallerFormats,
    guestAskedUserIds: guestAsked,
    // NOT LOADED HERE, on purpose — see `SquadState.payments` and
    // `loadPaymentSnapshot` below. Everything else in this object is
    // read on every batch including the 69% that are banter; a payment
    // question is rare enough that its two extra reads belong behind a
    // topic check rather than in front of every joke.
    payments: null,
    // Nor this one, for the same reason — see `loadRatingProgressSnapshot`
    // below and `SquadState.ratingProgress`.
    ratingProgress: null,
  };
}

/**
 * THE SECOND TARGETED EXTRA READ — rating progress, and only when asked.
 *
 * Same shape, same three reasons, as `loadPaymentSnapshot` above: it is
 * four queries deep, it is asked for a handful of times a season, and
 * `compose.ts` cannot import Prisma so a lazy accessor on `SquadState`
 * is not available at all.
 *
 * It arrived on 2026-09-11, when `looksLikeRatingProgressRequest` was
 * deleted — two keyword tests ANDed over a whole body, the conjunction
 * shape behind the 2026-09-01 and 2026-09-10 incidents. The ask is now
 * `QuestionTopic.rating_progress` and this is where its answer comes
 * from.
 *
 * A THIN WRAPPER ON `loadRatingProgress`, deliberately: that function
 * has been the definition of "who has rated" since 2026-06-06 and is
 * what the DM surface still calls. Two selectors for one question is how
 * the group and the DM start disagreeing about the same club.
 */
export async function loadRatingProgressSnapshot(orgId: string): Promise<RatingProgress> {
  const { loadRatingProgress } = await import("../rating-progress");
  return loadRatingProgress(orgId);
}

/**
 * THE ONE TARGETED EXTRA READ — payments, and only when asked.
 *
 * ── WHY IT IS NOT IN `loadSquadState` ────────────────────────────────
 * That function runs on EVERY batch. Sutton FC's own traffic is 69%
 * banter, and a payment question is a handful of messages a season.
 * Putting these reads in the loader would buy an answer nobody asked for
 * on every "haha" in the group.
 *
 * ── WHY IT IS NOT A LAZY ACCESSOR ON STATE ───────────────────────────
 * The obvious shape — `state.payments()` resolved inside the composer —
 * is not available. `compose.ts` must stay free of Prisma (its header
 * records why: the Playwright worker never loads it, and a static import
 * kills the corpus spec at load with an error nobody can read). A
 * function on `SquadState` that reaches the database would put Prisma
 * back on the composer's path the first time anyone called it.
 *
 * ── SO: LOAD AFTER EXTRACTION, PASS AS DATA ──────────────────────────
 * `answer-batch.ts` already loads state and THEN extracts, so by the
 * time ownership is decided it knows which topics are in the window. It
 * calls this once, only when a `payments` topic survived, and puts the
 * result on the state it hands to `decide()`. The engine stays a pure
 * function of one value; the composer stays a pure function of the
 * engine's result; the common path stays exactly as cheap as it was.
 *
 * TAKES THE MATCH RATHER THAN SELECTING ONE. The caller passes
 * `state.completedMatch` — the last match that ENDED — and
 * `decidePaymentSnapshot` narrows it to `COMPLETED && !isHistorical`.
 * A second selector here could disagree with the one the rest of the
 * request is using, which is the failure mode `answer-batch.ts`'s
 * `expectedMatchId` check exists for on the other match.
 */
export async function loadPaymentSnapshot(
  orgId: string,
  completedMatch: SquadState["completedMatch"],
): Promise<PaymentSnapshot> {
  const org = await db.organisation.findUnique({
    where: { id: orgId },
    select: {
      paymentTrackingEnabled: true,
      paymentCollectionEnabled: true,
      paymentHolderId: true,
    },
  });
  if (!org) {
    // An org row that cannot be found is the `ALL_OFF` case
    // `getOrgFeatures` already falls back to. "Not tracked" is the
    // honest answer and it is a refusal, not an empty list.
    return { kind: "not_tracked" };
  }
  if (!completedMatch) {
    return decidePaymentSnapshot({
      paymentTracking: org.paymentTrackingEnabled,
      paymentCollection: org.paymentCollectionEnabled,
      paymentHolderId: org.paymentHolderId,
      match: null,
    });
  }
  const row = await db.match.findUnique({
    where: { id: completedMatch.id },
    select: {
      paymentLinksReleasedAt: true,
      attendances: {
        where: { status: "CONFIRMED" },
        select: { userId: true, paidAt: true },
      },
      paymentCredits: { select: { count: true } },
    },
  });
  return decidePaymentSnapshot({
    paymentTracking: org.paymentTrackingEnabled,
    paymentCollection: org.paymentCollectionEnabled,
    paymentHolderId: org.paymentHolderId,
    match: row
      ? {
          kickoffLabel: completedMatch.kickoffLabel,
          status: completedMatch.status,
          isHistorical: completedMatch.isHistorical,
          paymentLinksReleasedAt: row.paymentLinksReleasedAt,
          confirmed: row.attendances.map((a) => ({ userId: a.userId, paid: a.paidAt !== null })),
          creditCount: row.paymentCredits.reduce((s, c) => s + c.count, 0),
        }
      : null,
  });
}
