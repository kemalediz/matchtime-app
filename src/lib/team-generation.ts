/**
 * THE team-generation helper for the two paths a human can trigger.
 * Since 2026-09-15 a WhatsApp "@Match Time generate the teams" and the
 * admin dashboard's Generate/Regenerate button share this one
 * implementation: the LLM-adjusted blend of seed and peer ratings
 * (`computeClubRating`, then `runRatingAdjuster` on top).
 *
 * THE RATING IT BALANCES ON IS CLUB-SCOPED as of 2026-09-19. The seed
 * is `Membership.seedRating` for this match's org and the peer scores
 * are this player's 60 most recent ratings FROM THIS ORG, so no other
 * club can move a number here. It used to read the global
 * `User.seedRating` and a global 60-row window, which is how a club
 * that left MatchTime in June kept picking Sutton FC's Tuesday sides.
 *
 * Callers: the LLM analyse route via `lib/owner-deps.ts` when a player
 * asks the bot to generate teams, and the admin dashboard's
 * Generate/Regenerate button via `app/actions/teams.ts#generateTeams`.
 * That second one used to be a SECOND implementation with its own
 * rating formula, so the same squad got different teams depending on
 * which button was pressed; the tombstone at the top of
 * `app/actions/teams.ts` records what it did and why it went.
 *
 * THIS IS NOW THE ONLY CODE THAT PICKS TEAMS, as of 2026-09-19.
 * `app/api/cron/generate-teams/route.ts` used to carry a third rating
 * formula (`ratings.length >= 3 ? mean of the last 60 peer scores :
 * seedRating ?? 5.0`), call `balanceTeams` itself, write
 * `TeamAssignment` rows and flip `Match.status`, on a live `0 12 * * *`
 * schedule. Slice 3 deleted that and the cron delegates here, so the
 * noon sweep, the WhatsApp command and the dashboard button cannot
 * disagree any more. If you add a fourth caller, it calls in here; a
 * rating formula outside this file is a bug, and the history in
 * `app/actions/teams.ts`'s tombstone says why.
 *
 * NO AUTHORISATION LIVES HERE. Every caller authorises first: the
 * analyse route by its own gates, the server action by `auth()` then
 * `requireOrgAdmin`. A new caller must do the same before it calls in.
 *
 * IT DOES NOT POST. The ready-to-send group message comes back as
 * `groupPost` and nothing in this file queues a `BotJob`. Whether the
 * club hears about it is the caller's decision: the WhatsApp route
 * posts, the dashboard discards.
 *
 * Balances the confirmed squad via the Activity's configured strategy
 * (snake-draft + hill-climb, rating-only, etc.), writes TeamAssignment
 * rows, flips the Match into TEAMS_GENERATED, and returns a
 * ready-to-post group message with the Red/Yellow lineup.
 */
import { db } from "./db";
import { balanceTeams, type BalancingStrategy } from "./team-balancer";
import type { PlayerWithRating } from "@/types";
import { formatLondon } from "./london-time";
import { adjustRatings, type AdjusterMessage } from "./rating-adjuster";
import { computeClubRating } from "./player-rating";
import { resolveTeamLabels } from "./team-labels";
import { sanitiseTeamNames } from "./message-analyzer";

export type GenerateTeamsResult =
  | { ok: true; groupPost: string; matchId: string }
  | { ok: false; reason: string };

/**
 * Pure formatter for the group "teams" post.
 *
 * MOVED to `./group-copy` (2026-09-01) and re-exported here so every
 * existing import keeps working. Same reason as composeSquadStatusPost:
 * this file imports the Prisma client, and a pure formatter should be
 * reachable from a process that must not load it.
 */
import {
  formatTeamsPost,
  teamGenReasonNotEnough,
  teamGenReasonNotFound,
  teamGenReasonStatus,
} from "./group-copy";
export { formatTeamsPost };

export interface GenerateTeamsOptions {
  /** Pin specific userIds to specific teams. Honoured by the
   *  balancer even when it makes the rating-diff worse — admin
   *  intent overrides the optimiser. Used by the LLM "put me on
   *  Red" pathway. */
  pinnedToTeam?: Record<string, "RED" | "YELLOW">;
  /** Fun, MatchTime-invented display names for THIS match, [redName,
   *  yellowName]. Set when an admin asks the bot to choose the team
   *  names ("you pick the names this week"). Sanitised here; when valid
   *  they're persisted to Match.teamLabels (highest-precedence display
   *  override) and used in the group post. When absent/invalid we do NOT
   *  touch Match.teamLabels — a prior per-match override survives. */
  teamNames?: [string, string];
}

export async function generateTeamsForMatch(
  matchId: string,
  opts: GenerateTeamsOptions = {},
): Promise<GenerateTeamsResult> {
  const match = await db.match.findUnique({
    where: { id: matchId },
    include: {
      activity: { include: { sport: true, org: true } },
      attendances: {
        where: { status: "CONFIRMED" },
        include: { user: { include: { activityPositions: true } } },
      },
    },
  });
  // No match means no org to take a language from: the English reason.
  if (!match) return { ok: false, reason: teamGenReasonNotFound() };
  const lang = match.activity.org.language;
  if (match.status === "COMPLETED" || match.status === "CANCELLED") {
    return { ok: false, reason: teamGenReasonStatus(match.status, lang) };
  }

  const sport = match.activity.sport;
  const perTeam = sport.playersPerTeam;
  if (match.attendances.length < perTeam * 2) {
    return {
      ok: false,
      reason: teamGenReasonNotEnough({ confirmed: match.attendances.length, needed: perTeam * 2, lang }),
    };
  }

  // ── THE BALANCER'S INPUT IS CLUB-SCOPED ──────────────────────────
  //
  // Everything below is scoped to THIS match's org. Until 2026-09-19
  // it was not: the seed came from the global `User.seedRating` and the
  // peer ratings were this player's 60 most recent FROM ANY CLUB, so
  // Sutton FC's Tuesday sides were partly picked by Sutton Lads, a club
  // that removed MatchTime in June 2026 and whose ratings will
  // therefore never correct themselves. Slice 2 of
  // `MDs/club-scoped-ratings-design-2026-09-18.md`.
  const orgId = match.activity.org.id;

  // ONE aggregate per generation, not one per player. It is the same
  // number for all fourteen of them, and fourteen identical aggregates
  // per team sheet would be a bug even though each returns the right
  // answer. Null when the club has never rated anybody.
  const clubMean = await db.rating.aggregate({
    _avg: { score: true },
    where: { match: { activity: { orgId } } },
  });
  const clubMeanRating = clubMean._avg.score ?? null;

  // ONE query for the seeds, for the same reason. `Membership` is the
  // club-scoped seed since slice 1; `User.seedRating` still exists and
  // still holds the same values, but reading it here is what let one
  // club's opinion decide another club's draft. A squad member with no
  // membership row for this org simply has no club seed and falls to
  // the club mean, which is the right answer for a guest.
  const seedRows = await db.membership.findMany({
    where: { orgId, userId: { in: match.attendances.map((a) => a.userId) } },
    select: { userId: true, seedRating: true },
  });
  const clubSeedByUser = new Map(seedRows.map((m) => [m.userId, m.seedRating]));

  const basePlayers: PlayerWithRating[] = await Promise.all(
    match.attendances.map(async (a) => {
      // `take: 60` sits NEXT TO the org filter on purpose: sixty of
      // THIS club's rows, not sixty rows from anywhere then filtered.
      // The difference is not cosmetic. Ehtisham has 65 ratings, so a
      // global window truncated at 60 was letting a dead club's rows
      // EVICT his own club's before the code ever saw them.
      const ratings = await db.rating.findMany({
        where: { playerId: a.userId, match: { activity: { orgId } } },
        orderBy: { createdAt: "desc" },
        take: 60,
      });
      // Bayesian blend: the prior acts with weight 3, smoothly
      // dominated by peer ratings as more arrive. Replaces the old
      // step function (which jumped from pure-seed → pure-peer at
      // exactly 3 ratings). The prior is this club's seed, else this
      // club's mean, else 5.0.
      const { rating } = computeClubRating({
        clubSeedRating: clubSeedByUser.get(a.userId) ?? null,
        clubPeerRatings: ratings.map((r) => r.score),
        clubMeanRating,
      });
      const pap = a.user.activityPositions.find((p) => p.activityId === match.activityId);
      return {
        id: a.userId,
        name: a.user.name ?? "Unknown",
        positions: pap?.positions ?? [],
        rating,
        image: a.user.image,
      };
    }),
  );

  // Phase 4 — hybrid LLM rating adjuster. LLM reads the last week of
  // group chat and proposes per-player deltas for tonight (sick,
  // tentative, hot streak, rusty). Deltas clamped to [-2, +2] in the
  // adjuster itself. Falls through silently to base ratings on any
  // failure — team generation never blocks on the LLM.
  //
  // THE CATCH IS NOT BELT AND BRACES. `adjustRatings` swallows its own
  // model errors, but `runRatingAdjuster` is more than that call: it
  // reads AnalyzedMessage and User, and it upserts one RatingAdjustment
  // audit row per player. A Postgres hiccup in any of those used to
  // take the whole team sheet down with it, which is exactly the thing
  // the adjuster's own header promises cannot happen. Since 2026-09-15
  // the ADMIN DASHBOARD runs this too (it used to skip the adjuster
  // entirely), so the blast radius of an unprotected LLM-shaped
  // dependency is now a button an admin presses on match night.
  //
  // Base ratings are the fallback and they are complete on their own —
  // the deltas are a margin adjustment, never the rating.
  let adjustments: Awaited<ReturnType<typeof runRatingAdjuster>> = new Map();
  try {
    adjustments = await runRatingAdjuster({
      matchId: match.id,
      orgId: match.activity.org.id,
      sportName: sport.name,
      matchDate: match.date,
      basePlayers,
    });
  } catch (err) {
    console.error("[team-generation] rating adjuster failed, using base ratings:", err);
  }

  const players: PlayerWithRating[] = basePlayers.map((p) => {
    const adj = adjustments.get(p.id);
    if (!adj || adj.delta === 0) return p;
    const adjusted = Math.max(1, Math.min(10, p.rating + adj.delta));
    return { ...p, rating: adjusted };
  });

  const composition = sport.positionComposition as Record<string, number> | null;
  const result = balanceTeams({
    players,
    perTeam,
    strategy: sport.balancingStrategy as BalancingStrategy,
    composition: composition ?? undefined,
    pinnedToTeam: opts.pinnedToTeam,
  });

  await db.teamAssignment.deleteMany({ where: { matchId } });
  await db.teamAssignment.createMany({
    data: [
      ...result.red.map((p) => ({ matchId, userId: p.id, team: "RED" as const })),
      ...result.yellow.map((p) => ({ matchId, userId: p.id, team: "YELLOW" as const })),
    ],
  });
  // If the requester asked MatchTime to invent fun names this week,
  // sanitise and persist them as the per-match display override. When
  // no (valid) names are given we leave Match.teamLabels untouched so a
  // prior override from an earlier request this week isn't clobbered.
  const validNames = sanitiseTeamNames(opts.teamNames);
  await db.match.update({
    where: { id: matchId },
    data: {
      status: "TEAMS_GENERATED",
      ...(validNames ? { teamLabels: validNames } : {}),
    },
  });

  // `match` still carries its pre-update teamLabels, so a prior override
  // survives when no new names are given this run.
  const matchLabelSource = validNames ? { teamLabels: validNames } : match;
  // The group's language decides the default team names and the words
  // around them; `org` is the full row here, so it carries `language`.
  const [redLabel, yellowLabel] = resolveTeamLabels(
    matchLabelSource,
    match.activity.org,
    sport,
    lang,
  );
  const kickoff = formatLondon(match.date, "HH:mm");
  const groupPost = formatTeamsPost({
    redLabel,
    yellowLabel,
    red: result.red,
    yellow: result.yellow,
    kickoff,
    venue: match.activity.venue,
    lang,
  });

  return { ok: true, groupPost, matchId };
}

async function runRatingAdjuster(args: {
  matchId: string;
  orgId: string;
  sportName: string;
  matchDate: Date;
  basePlayers: PlayerWithRating[];
}) {
  const cutoff = new Date(args.matchDate.getTime() - 7 * 24 * 60 * 60 * 1000);
  const recent = await db.analyzedMessage.findMany({
    where: {
      orgId: args.orgId,
      createdAt: { gte: cutoff },
      body: { not: null },
    },
    orderBy: { createdAt: "asc" },
    take: 300,
    select: { authorUserId: true, body: true, createdAt: true },
  });

  const userIds = recent
    .map((r) => r.authorUserId)
    .filter((id): id is string => !!id);
  const userNames = new Map<string, string>();
  if (userIds.length > 0) {
    const users = await db.user.findMany({
      where: { id: { in: [...new Set(userIds)] } },
      select: { id: true, name: true },
    });
    for (const u of users) userNames.set(u.id, u.name ?? "Unknown");
  }

  const messages: AdjusterMessage[] = recent.map((r) => ({
    authorName: r.authorUserId ? userNames.get(r.authorUserId) ?? null : null,
    body: r.body ?? "",
    timestamp: r.createdAt,
  }));

  const adjusterPlayers = args.basePlayers.map((p) => ({
    id: p.id,
    name: p.name,
    baseRating: p.rating,
  }));

  const adjustments = await adjustRatings({
    players: adjusterPlayers,
    messages,
    sportName: args.sportName,
    matchDate: args.matchDate,
  });

  // Persist audit rows. Upsert so re-running team generation for the
  // same match overwrites prior adjustments cleanly.
  for (const adj of adjustments.values()) {
    await db.ratingAdjustment.upsert({
      where: { matchId_userId: { matchId: args.matchId, userId: adj.playerId } },
      create: {
        matchId: args.matchId,
        userId: adj.playerId,
        delta: adj.delta,
        reason: adj.reason,
        confidence: adj.confidence,
      },
      update: {
        delta: adj.delta,
        reason: adj.reason,
        confidence: adj.confidence,
      },
    });
  }

  return adjustments;
}
