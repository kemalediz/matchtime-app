/**
 * THE ONLY DATABASE READ BEHIND THE ROUTER GATE.
 *
 * Split out of `awaiting-answer.ts` on purpose. `router.ts` and
 * `gate.ts` are imported by `e2e/replay/router-recall-live.ts`, a plain
 * `tsx` script with no server and no database, and by the Playwright
 * worker. `gate.ts` used to carry the same note about its type-only
 * `message-analyzer` import; §10 step 8 deleted that import along with
 * `AnalysisVerdict`, and kept the note, because THE CONSTRAINT OUTLIVED
 * THE IMPORT: any future Prisma-touching import from `gate.ts` or
 * `router.ts` has to be type-only for exactly this reason. So the
 * predicates live in the pure module and the three queries live here,
 * and nothing in the router's import graph pulls in Prisma.
 *
 * READ-ONLY BY CONSTRUCTION: every statement in this file is a
 * `findMany`. The gate never writes.
 */
import { SCORE_ASK_KIND, SCORE_ASK_TTL_MS, parseScoreAskKey } from "./score-ask";
import { resolveTeamLabels } from "../team-labels";
import { SCORE_CORRECTION_WINDOW_MS } from "./score-window";
import { db } from "../db";
import {
  GROUP_QUESTION_TTL_MS,
  STATS_CLARIFICATION_INTENT,
  STATS_CLARIFIED_INTENT,
  openQuestionAt,
  openStatsClarifications,
  type AwaitingQuestion,
  type StatsClarification,
} from "./awaiting-answer";

/** How far back to look for rows worth considering at all. Any question
 *  older than this is outside the TTL anyway; the bound is here so the
 *  three queries stay indexed and small. */
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * READ-ONLY. Every question this org has open right now.
 *
 * Three cheap indexed reads, bounded to a day. `PendingBenchConfirmation`
 * is legacy — the 2026-05-19 bench redesign replaced it with
 * `BenchSlotOffer` and nothing writes it any more — but it is what
 * case 1 actually was, it costs one indexed query, and leaving it out
 * would mean the mechanism could not reproduce half its own evidence.
 */
export async function loadAwaitingQuestions(
  orgId: string,
  now: Date = new Date(),
): Promise<AwaitingQuestion[]> {
  const since = new Date(now.getTime() - LOOKBACK_MS);

  const [offers, pending, tentative] = await Promise.all([
    db.benchSlotOffer.findMany({
      where: { resolvedAt: null, createdAt: { gte: since }, match: { activity: { orgId } } },
      select: { id: true, createdAt: true, match: { select: { date: true } } },
    }),
    db.pendingBenchConfirmation.findMany({
      where: { resolvedAt: null, createdAt: { gte: since }, match: { activity: { orgId } } },
      select: { id: true, createdAt: true, expiresAt: true },
    }),
    db.tentativeAvailability.findMany({
      where: {
        resolvedAt: null,
        notifiedAt: { not: null, gte: since },
        match: { activity: { orgId } },
      },
      select: { id: true, notifiedAt: true, match: { select: { date: true } } },
    }),
  ]);

  return [
    ...offers.map((o) => ({
      id: o.id,
      orgId,
      kind: "bench-slot-offer" as const,
      askedAt: o.createdAt,
      closesAt: o.match.date,
    })),
    ...pending.map((p) => ({
      id: p.id,
      orgId,
      kind: "bench-confirmation" as const,
      askedAt: p.createdAt,
      closesAt: p.expiresAt,
    })),
    ...tentative.map((t) => ({
      id: t.id,
      orgId,
      kind: "tentative-followup" as const,
      askedAt: t.notifiedAt!,
      closesAt: t.match.date,
    })),
  ];
}

/**
 * What `gateBatch` actually wants: the one open question, or null.
 *
 * Kept here rather than at the call site so wiring the gate up is a
 * single expression, and so the "which question" tie-break lives in one
 * place.
 */
export async function loadOpenQuestion(
  orgId: string,
  now: Date = new Date(),
): Promise<AwaitingQuestion | null> {
  return openQuestionAt(await loadAwaitingQuestions(orgId, now), orgId, now);
}

/**
 * READ-ONLY. The stats clarifications this org has open right now: the
 * "who do you mean?" questions MatchTime put to individual posters in
 * the last hour and has not had answered. One indexed read of
 * `AnalyzedMessage` (`[orgId, createdAt]`), rows the analyze route
 * writes for every owned message anyway. See the essay at the foot of
 * `awaiting-answer.ts`.
 */
export async function loadOpenStatsClarifications(
  orgId: string,
  now: Date = new Date(),
): Promise<StatsClarification[]> {
  const rows = await db.analyzedMessage.findMany({
    where: {
      orgId,
      intent: { in: [STATS_CLARIFICATION_INTENT, STATS_CLARIFIED_INTENT] },
      createdAt: { gte: new Date(now.getTime() - GROUP_QUESTION_TTL_MS) },
    },
    select: { id: true, orgId: true, intent: true, authorUserId: true, authorName: true, body: true, createdAt: true },
  });
  return openStatsClarifications(rows, orgId, now);
}

/**
 * The "which team won?" question MatchTime has open for this club, if
 * any (2026-10-07, `score-ask.ts`): the scoreline, when it was asked,
 * who posted it, the team names of the match it is about, and the
 * club's admins (who may answer for the sender). One indexed read, null
 * on almost every batch; the admins are read only when a question
 * exists. The analyze route uses it to decide which messages are
 * answers; the engine reads the same row through `load-state.ts`.
 *
 * A QUESTION IS ONLY EVER VALID FOR A MATCH WITH NO RESULT. A row for a
 * match that has one is not returned, whoever left it there.
 */
export async function loadOpenScoreAsk(
  orgId: string,
  now: Date = new Date(),
): Promise<{
  matchId: string;
  first: number;
  second: number;
  askedAt: Date;
  askerUserId: string | null;
  labels: [string, string];
  adminUserIds: string[];
} | null> {
  const row = await db.sentNotification.findFirst({
    where: {
      kind: SCORE_ASK_KIND,
      createdAt: { gte: new Date(now.getTime() - SCORE_ASK_TTL_MS) },
      match: { activity: { orgId }, redScore: null, yellowScore: null },
    },
    orderBy: { createdAt: "desc" },
    select: {
      key: true,
      createdAt: true,
      targetUser: true,
      match: {
        select: {
          teamLabels: true,
          activity: {
            select: {
              sport: { select: { teamLabels: true } },
              org: { select: { teamLabels: true, language: true } },
            },
          },
        },
      },
    },
  });
  const parsed = row ? parseScoreAskKey(row.key) : null;
  if (!row || !parsed || !row.match) return null;
  const admins = await db.membership.findMany({
    where: { orgId, role: { in: ["OWNER", "ADMIN"] }, leftAt: null },
    select: { userId: true },
  });
  return {
    ...parsed,
    askedAt: row.createdAt,
    askerUserId: row.targetUser ?? null,
    labels: resolveTeamLabels(
      { teamLabels: row.match.teamLabels },
      { teamLabels: row.match.activity.org.teamLabels },
      row.match.activity.sport,
      row.match.activity.org.language,
    ),
    adminUserIds: admins.map((a) => a.userId),
  };
}

/**
 * The match a tagged score correction would correct, if there is one:
 * the club's latest PLAYED match, when it has a recorded result and
 * kicked off inside the correction window. Its team names are what
 * `isScoreCorrectionText` reads a correction against.
 *
 * The selection is `load-state.ts`'s for `completedMatch` (the ten most
 * recent matches that have kicked off, the first whose duration has
 * passed), so the router override and the engine are talking about the
 * same match. Called only when a tagged message in the batch already
 * looks like a correction (`mayBeScoreCorrection`), so almost never.
 */
export async function loadScoreCorrectionTarget(
  orgId: string,
  now: Date = new Date(),
): Promise<{ matchId: string; labels: [string, string] } | null> {
  const candidates = await db.match.findMany({
    where: {
      activity: { orgId },
      status: { in: ["TEAMS_GENERATED", "TEAMS_PUBLISHED", "COMPLETED"] },
      date: { lte: now },
    },
    select: {
      id: true,
      date: true,
      redScore: true,
      yellowScore: true,
      teamLabels: true,
      activity: {
        select: {
          matchDurationMins: true,
          sport: { select: { teamLabels: true } },
          org: { select: { teamLabels: true, language: true } },
        },
      },
    },
    orderBy: { date: "desc" },
    take: 10,
  });
  const latest = candidates.find(
    (m) => m.date.getTime() + m.activity.matchDurationMins * 60 * 1000 <= now.getTime(),
  );
  if (!latest || latest.redScore === null || latest.yellowScore === null) return null;
  if (now.getTime() - latest.date.getTime() > SCORE_CORRECTION_WINDOW_MS) return null;
  return {
    matchId: latest.id,
    labels: resolveTeamLabels(
      { teamLabels: latest.teamLabels },
      { teamLabels: latest.activity.org.teamLabels },
      latest.activity.sport,
      latest.activity.org.language,
    ),
  };
}
