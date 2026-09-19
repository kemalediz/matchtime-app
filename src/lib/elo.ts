/**
 * Lightweight Elo for pickup sport matches.
 *
 * Each player has a `matchRating` PER CLUB (starts at 1000), stored on
 * `Membership`. After every match with a known score we update it as
 * follows:
 *
 *   expectedProb = 1 / (1 + 10^((oppTeamAvg - myTeamAvg) / 400))
 *   actual       = 1 (won) | 0 (lost) | 0.5 (draw)
 *   K            = 32 * (1 + |scoreDiff| / 5)   ← bigger scoreDiff → bigger update
 *   newRating    = oldRating + K * (actual - expectedProb)
 *
 * Small margins → small nudge. Blowouts → big nudge. Over time, players
 * who consistently win against stronger teams climb; players who lose
 * against weaker teams drop. Self-calibrating, no tuning required.
 *
 * ── IT IS THE CLUB'S NUMBER, NOT THE PLAYER'S ────────────────────────
 *
 * Until 2026-09-19 it lived on `User.matchRating`, one integer for the
 * whole person, so a result at one club moved them up another club's
 * leaderboard. It now lives on `Membership.matchRating`, and
 * `lib/membership-elo.ts` is the only place it is read or written. This
 * file stayed pure: `PlayerEloInput.matchRating` below is just "this
 * player's rating at the club this match belongs to", and the function
 * never learns where that came from.
 *
 * ── `matchRating` DOES NOT PICK TEAMS. THAT IS DELIBERATE ────────────
 *
 * It is a LEADERBOARD number. `lib/match-history.ts` ranks the Elo top
 * and bottom from it, and that is the whole of its job. No code that
 * builds a team sheet reads it any more. `lib/team-generation.ts`, the
 * path the WhatsApp bot and the admin dashboard have shared since
 * 2026-09-15, rates players with `computePlayerRating`, a seed-and-peer
 * blend with no Elo term. The one rival formula still standing,
 * `app/api/cron/generate-teams/route.ts:57-92`, has no Elo term either
 * (it is a plain peer mean falling back to the seed), so `matchRating`
 * reaches no team sheet on any path.
 *
 * If you are here because the Elo "isn't being used", that is not a bug
 * and please do not wire it back in. Until 2026-09-15 the admin
 * dashboard DID blend it in (0.5 x peerAvg + 0.5 x matchRating/200)
 * while the WhatsApp path did not, so the club had two buttons that
 * built different teams from the same squad. Kemal's call was that the
 * blended, Elo-free formula is the one used everywhere. On the live
 * Sutton squad the Elo term was moving players up to seven draft places
 * and compressing the whole rating spread from 2.49 to 1.37, because an
 * Elo that has only moved for eight players is still clustered near its
 * 1000 start and drags everyone toward 5.0.
 *
 * The tombstone with the reasoning is at the top of
 * `app/actions/teams.ts`; `scripts/compare-rating-formulas.ts`
 * re-measures the difference on a live squad at any time.
 */

export interface PlayerEloInput {
  userId: string;
  team: "RED" | "YELLOW";
  matchRating: number;
}

export interface EloDelta {
  userId: string;
  before: number;
  after: number;
  delta: number;
}

/**
 * Compute new matchRating for every player involved in a match. Pure
 * function — caller persists the results.
 */
export function computeEloDeltas(
  players: PlayerEloInput[],
  redScore: number,
  yellowScore: number,
): EloDelta[] {
  const red = players.filter((p) => p.team === "RED");
  const yellow = players.filter((p) => p.team === "YELLOW");
  if (red.length === 0 || yellow.length === 0) return [];

  const redAvg = avg(red.map((p) => p.matchRating));
  const yellowAvg = avg(yellow.map((p) => p.matchRating));

  const redExpected = 1 / (1 + Math.pow(10, (yellowAvg - redAvg) / 400));
  const yellowExpected = 1 - redExpected;

  const actual = actualScore(redScore, yellowScore);
  const k = kFactor(redScore, yellowScore);

  return players.map((p) => {
    const expected = p.team === "RED" ? redExpected : yellowExpected;
    const actualForMe = p.team === "RED" ? actual : 1 - actual;
    const delta = Math.round(k * (actualForMe - expected));
    return {
      userId: p.userId,
      before: p.matchRating,
      after: p.matchRating + delta,
      delta,
    };
  });
}

function avg(xs: number[]): number {
  if (xs.length === 0) return 1000;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function actualScore(red: number, yellow: number): number {
  if (red > yellow) return 1;
  if (red < yellow) return 0;
  return 0.5;
}

function kFactor(red: number, yellow: number): number {
  const diff = Math.abs(red - yellow);
  return 32 * (1 + diff / 5);
}
