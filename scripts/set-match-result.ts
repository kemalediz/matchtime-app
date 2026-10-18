/**
 * RECORD A MATCH'S RESULT AND ITS MAN OF THE MATCH, BY HAND (2026-10-18).
 *
 * For a result the organisers gave somewhere MatchTime could not read it
 * (FNF, Fri 16 Oct: the score and Man of the Match were named on the pitch,
 * before "organisers pick" existed). It writes through the SAME shared
 * writers the bot uses, nothing of its own:
 *
 *   the score   `applyScoreWrites` with `buildScoreApplyDeps()`
 *               (score-engine.ts, owner-deps.ts): `setMatchScore` (the
 *               scores and COMPLETED in one update) and the Elo reconcile.
 *   the MoM     `setMatchMom` (mom-pick.ts): the one MoMVote row that the
 *               crown, the badges and the stats read, exactly as for a pick
 *               reported in the admin group.
 *
 * DRY RUN by default: prints what it would write and writes nothing.
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/set-match-result.ts \
 *     --match <matchId> --score "Yellow 7 Red 4" --mom Naim [--by <organiser>] [--apply]
 *
 *   --score  "<team> <n> <team> <n>", the club's own team names (or red,
 *            yellow, kırmızı, sarı), in either order.
 *   --mom    the player's name as the organisers said it; resolved against
 *            the match's players (CONFIRMED and the team sheet) with the
 *            pipeline's `resolvePerson`. Ambiguous or unknown: refused.
 *   --by     the organiser recording it (an OWNER or ADMIN of the club, by
 *            name); default the club's first owner.
 *   Either --score or --mom may be left out to record only the other.
 *
 * Refuses, and writes nothing, when the match is not found, has not been
 * played, a team or the name cannot be placed, or --by is not an organiser.
 */
import { db } from "../src/lib/db.ts";
import { resolveTeamLabels } from "../src/lib/team-labels.ts";
import { resolveTeamRef } from "../src/lib/pipeline/score-teams.ts";
import { resolvePerson } from "../src/lib/pipeline/identity.ts";
import { applyScoreWrites } from "../src/lib/score-engine.ts";
import { buildScoreApplyDeps } from "../src/lib/owner-deps.ts";
import { currentMom, matchPlayers, resolveMomRef, setMatchMom } from "../src/lib/mom-pick.ts";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : null;
}
const APPLY = process.argv.includes("--apply");

function fail(msg: string): never {
  console.error(`REFUSED: ${msg}. Nothing written.`);
  process.exit(1);
}

/** "Yellow 7 Red 4" / "Red 4 - Yellow 7" -> the two sides, in the club's labels. */
function parseScoreArg(text: string, labels: readonly [string, string]): { red: number; yellow: number } | null {
  const m = text.trim().match(/^(.+?)\s+(\d{1,2})\s*[-,:]?\s*(.+?)\s+(\d{1,2})$/);
  if (!m) return null;
  const a = resolveTeamRef(m[1], labels, null);
  const b = resolveTeamRef(m[3], labels, null);
  if (!a || !b || a === b) return null;
  const first = Number(m[2]);
  const second = Number(m[4]);
  return a === "RED" ? { red: first, yellow: second } : { red: second, yellow: first };
}

async function main() {
  const matchId = arg("match");
  const scoreText = arg("score");
  const momText = arg("mom");
  if (!matchId || (!scoreText && !momText)) fail('usage: --match <id> --score "<team> <n> <team> <n>" --mom <name> [--by <organiser>] [--apply]');

  const match = await db.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      date: true,
      status: true,
      redScore: true,
      yellowScore: true,
      teamLabels: true,
      activity: {
        select: {
          name: true,
          orgId: true,
          matchDurationMins: true,
          sport: { select: { teamLabels: true } },
          org: { select: { name: true, teamLabels: true, language: true, momChosenBy: true } },
        },
      },
    },
  });
  if (!match) fail(`match ${matchId} not found`);
  if (match.status === "CANCELLED") fail("the match was cancelled");
  if (match.date.getTime() + match.activity.matchDurationMins * 60_000 > Date.now()) fail("the match has not finished yet");
  const labels = resolveTeamLabels(match, match.activity.org, match.activity.sport, match.activity.org.language) as [string, string];
  console.log(`${match.activity.org.name}: ${match.activity.name}, ${match.date.toISOString()} (${match.status})`);
  console.log(`  teams: ${labels[0]} (red) and ${labels[1]} (yellow); recorded now: ${match.redScore ?? "?"}-${match.yellowScore ?? "?"}`);
  console.log(`  Man of the Match chosen by: ${match.activity.org.momChosenBy}`);

  const score = scoreText ? parseScoreArg(scoreText, labels) : null;
  if (scoreText && !score) fail(`cannot read "${scoreText}" as "<team> <n> <team> <n>" with ${labels[0]} and ${labels[1]}`);

  let mom: { userId: string; name: string } | null = null;
  if (momText) {
    const r = resolveMomRef(momText, await matchPlayers(match.id));
    if (r.kind === "ambiguous") fail(`"${momText}" could be ${r.names.join(" or ")}`);
    if (r.kind === "not-in-match") fail(`"${momText}" is not one of the match's players`);
    mom = { userId: r.userId, name: r.name };
  }

  // Who records the pick: an owner or admin of the club.
  const organisers = await db.membership.findMany({
    where: { orgId: match.activity.orgId, role: { in: ["OWNER", "ADMIN"] }, leftAt: null },
    select: { userId: true, role: true, user: { select: { name: true } } },
    orderBy: [{ role: "asc" }, { id: "asc" }],
  });
  const roster = organisers.map((o) => ({ userId: o.userId, name: o.user?.name ?? "", isAdmin: true, hasPhone: false }));
  const byText = arg("by");
  const byPick = byText ? resolvePerson(byText, roster) : null;
  if (byText && byPick?.kind !== "resolved") fail(`--by "${byText}" is not one organiser of the club`);
  // Owners sort first (the same order as `onlyOrganisersLine`).
  const by = byPick?.kind === "resolved" ? byPick.member : roster[0];
  if (mom && !by) fail("the club has no owner or admin to record the pick");

  const previous = match.redScore !== null && match.yellowScore !== null ? { red: match.redScore, yellow: match.yellowScore } : null;
  if (score) console.log(`  score: ${labels[0]} ${score.red}, ${labels[1]} ${score.yellow}${previous ? ` (replaces ${previous.red}-${previous.yellow})` : ""}`);
  if (mom) {
    const before = await currentMom(match.id);
    console.log(`  Man of the Match: ${mom.name}, recorded by ${by!.name}${before.length ? ` (replaces ${before.map((b) => b.name).join(", ")})` : ""}`);
  }

  if (!APPLY) {
    console.log("DRY RUN. Pass --apply to write.");
    return;
  }
  if (score && !(previous && previous.red === score.red && previous.yellow === score.yellow)) {
    const [res] = await applyScoreWrites({
      writes: [{ kind: "score", matchId: match.id, red: score.red, yellow: score.yellow, ...(previous ? { previous } : {}), sourceMessageId: "script:set-match-result", reason: "set by hand" }],
      deps: buildScoreApplyDeps(),
    });
    if (!res.ok) fail(`the score write failed (${res.error})`);
    console.log(`  score written; ${res.eloApplied} rating(s) moved${res.eloError ? `; Elo: ${res.eloError}` : ""}`);
  }
  if (mom) {
    await setMatchMom({ matchId: match.id, playerId: mom.userId, byUserId: by!.userId });
    console.log("  Man of the Match written.");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
