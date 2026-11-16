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
 *   --mom and --by need ANTHROPIC_API_KEY_DEV (the repo-root .env, which
 *   --env-file loads): who-is-who is one model call (Haiku) on the
 *   DEVELOPER's key, as for every script here (MDs/dev-vs-production-api-
 *   keys.md). Never ANTHROPIC_API_KEY, the product's. Without the key the
 *   script refuses at once. With --score alone it calls no model at all.
 *
 *   --score  "<team> <n> <team> <n>", the club's own team names (or red,
 *            yellow, kırmızı, sarı), in either order.
 *   --mom    the player's name as the organisers said it; placed among the
 *            match's players (CONFIRMED and the team sheet) exactly as a
 *            pick reported in HQ is (`hqMom`, admin-group-score.ts):
 *            who-is-who is shown the whole club with the players marked,
 *            and `resolveMomRef` reads its answer. Ambiguous, not one of
 *            the players, or a name who-is-who could not say (no answer,
 *            the call failed): refused.
 *   --by     the organiser recording it (an OWNER or ADMIN of the club, by
 *            name, looked up by who-is-who in the same call); default the
 *            club's first owner.
 *   Either --score or --mom may be left out to record only the other; --by
 *   needs --mom. Arguments are read strictly: an unknown or repeated flag,
 *   --flag=value, or a flag with a missing or blank value is refused.
 *   Who-is-who gets 60 seconds in all; no answer by then is a refusal.
 *   With any MT_TEST_* (e2e stub) variable set, the script runs only
 *   against the e2e harness's own database.
 *
 * Refuses, and writes nothing, when the match is not found, has not been
 * played, a team or the name cannot be placed, --by is not an organiser,
 * or who-is-who could not answer (its call failed: the refusal says so).
 * Every check runs before the first write.
 *
 * The two writes are NOT one transaction: `setMatchMom` opens its own and
 * takes no client, and the score goes through the shared score writer and
 * its Elo reconcile. When the Man of the Match write fails after the score
 * was written, the script says PARTLY WRITTEN, what is recorded, and the
 * re-run that finishes it.
 *
 * In the stubbed e2e suite who-is-who is the suite's stand-in
 * (`personPickerFor`, chosen by a test seam that production ignores): no
 * key, no call.
 */
import { db } from "../src/lib/db";
import { resolveTeamLabels } from "../src/lib/team-labels";
import { resolveTeamRef } from "../src/lib/pipeline/score-teams";
import { resolvePerson } from "../src/lib/pipeline/identity";
import { identifyRefs, personPickerFor } from "../src/lib/pipeline/identify-batch";
import { loadClubWhoRoster } from "../src/lib/club-who-roster";
import { applyScoreWrites } from "../src/lib/score-engine";
import { buildScoreApplyDeps } from "../src/lib/owner-deps";
import { currentMom, matchPlayers, resolveMomRef, setMatchMom } from "../src/lib/mom-pick";
import { anthropicModel } from "../src/lib/pipeline/llm";
import { extractorStubFromEnv } from "../src/lib/pipeline/extractor-stub";
import type { Member } from "../src/lib/pipeline/types";
import { modelPersonPicker, PERSON_PICKER_STUB_ENV, refKey, stubSeamAllowed, type PersonPicker, type PersonPicks } from "../src/lib/pipeline/who-is-who";
import Anthropic from "@anthropic-ai/sdk";
import {
  assertProductionKeyForgotten,
  DEV_KEY_ENV,
  DevApiKeyMissingError,
  forgetProductionApiKey,
  ProductionKeyInProcessError,
  requireDevApiKey,
} from "../e2e/helpers/dev-api-key";
import { E2E_DB_URL } from "../e2e/helpers/env";

const HARNESS = "scripts/set-match-result.ts (who-is-who, for --mom and --by)";
/** The documented way to run this script, for the re-run it prints. */
const INVOCATION = "node --env-file=.env ./node_modules/.bin/tsx scripts/set-match-result.ts";
/**
 * Who-is-who's whole budget: an API that takes the call and never answers
 * would otherwise hold the script for the SDK's 10 minutes per attempt,
 * times its retries, times who-is-who's own second attempt, saying nothing.
 * `MT_TEST_WHO_IS_WHO_TIMEOUT_MS` shortens it for the e2e test (an MT_TEST_
 * variable: only ever honoured against the harness's database, below).
 */
const WHO_TIMEOUT_MS = Number(process.env.MT_TEST_WHO_IS_WHO_TIMEOUT_MS) > 0 ? Number(process.env.MT_TEST_WHO_IS_WHO_TIMEOUT_MS) : 60_000;

/** One shell word, whatever it holds: single quotes, a ' written as '\''. */
const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const quoted = (names: string[]): string => names.map((n) => `"${n}"`).join(" and ");

function fail(msg: string): never {
  console.error(`REFUSED: ${msg}. Nothing written.`);
  process.exit(1);
}

interface Args {
  match: string | null;
  score: string | null;
  mom: string | null;
  by: string | null;
  apply: boolean;
}
const VALUED = ["match", "score", "mom", "by"] as const;

/**
 * THE ARGUMENTS, STRICTLY (2026-11-16, review of #609). A forgiving reader
 * turned `--mom ""`, `--mom=Pat` or a forgotten value into "no --mom", and
 * the score was written with no Man of the Match and no word said; `--by ""`
 * became the first owner. Every flag is known, given once, and a valued
 * flag has a non-blank value after a space. Anything else is refused,
 * before the database is read.
 */
function readArgs(argv: string[]): Args {
  const out: Args = { match: null, score: null, mom: null, by: null, apply: false };
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) fail(`unexpected "${token}": every value goes after its flag (--mom <name>)`);
    const name = token.slice(2);
    const base = name.split("=")[0];
    const known = base === "apply" || (VALUED as readonly string[]).includes(base);
    if (!known) fail(`unknown flag "${token}" (known: --match, --score, --mom, --by, --apply)`);
    if (name !== base) fail(`"${token}": write the value after a space (--${base} <value>)`);
    if (seen.has(name)) fail(`--${name} is given twice`);
    seen.add(name);
    if (name === "apply") {
      out.apply = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--") || value.trim() === "") fail(`--${name} needs a value`);
    out[name as (typeof VALUED)[number]] = value;
    i++;
  }
  return out;
}

/**
 * The e2e suite's stand-ins (MT_TEST_* variables) answer for the model and
 * other services. Left in an operator's shell they would make this script
 * read real data with them: refused unless the database is the harness's
 * own embedded Postgres for this checkout.
 */
function refuseTestSeamsOnRealData(): void {
  const set = Object.keys(process.env)
    .filter((k) => k.startsWith("MT_TEST_") && (process.env[k] ?? "").trim() !== "")
    .sort();
  if (set.length > 0 && process.env.DATABASE_URL !== E2E_DB_URL) {
    fail(`test stub variables are set (${set.join(", ")}) and DATABASE_URL is not the e2e harness's database: the script would use the test stand-ins on real data. Unset them`);
  }
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

/**
 * Who-is-who's picker, and whether it is the real model. A real call goes
 * on the DEVELOPER's key, handed to the client directly
 * (`requireDevApiKey`); `main()` has already dropped the production key
 * from the process, and `assertProductionKeyForgotten` refuses to build a
 * client if it has not, so no client here can fall back to it. This script
 * never reads ANTHROPIC_API_KEY (`e2e/helpers/no-production-key-in-
 * harnesses.test.ts`). With a test seam set (the stubbed e2e suite; never
 * in production, `stubSeamAllowed`) it is the stand-in `personPickerFor`
 * would choose, and needs no key. Throws `DevApiKeyMissingError` when a
 * real call would be needed and there is no key.
 */
function whoIsWhoPicker(): { picker: PersonPicker; model: boolean } {
  const seam = stubSeamAllowed() && (process.env[PERSON_PICKER_STUB_ENV] === "1" || extractorStubFromEnv() !== null);
  if (seam) return { picker: personPickerFor(), model: false };
  const apiKey = requireDevApiKey(HARNESS);
  assertProductionKeyForgotten(HARNESS);
  // The client's own limits sit inside the overall budget (`WHO_TIMEOUT_MS`).
  const client = new Anthropic({ apiKey, timeout: WHO_TIMEOUT_MS, maxRetries: 1 });
  return { picker: modelPersonPicker(anthropicModel({ apiKey, client })), model: true };
}

async function main() {
  // FIRST: `node --env-file=.env` may have loaded the product's key too.
  // Gone before anything can build a client (MDs/dev-vs-production-api-keys.md).
  // (MT_TEST_KEEP_PRODUCTION_KEY: the e2e test that proves the guard in
  // `whoIsWhoPicker` refuses when this did not happen.)
  if (process.env.MT_TEST_KEEP_PRODUCTION_KEY !== "1") forgetProductionApiKey();
  refuseTestSeamsOnRealData();
  const args = readArgs(process.argv.slice(2));
  const { match: matchId, score: scoreText, mom: momText, by: byText, apply: APPLY } = args;
  if (!matchId || (!scoreText && !momText)) fail('usage: --match <id> --score "<team> <n> <team> <n>" --mom <name> [--by <organiser>] [--apply]');
  // --by only names who records the pick: alone it would change nothing
  // and still ask the model.
  if (byText && !momText) fail("--by says who records the Man of the Match: it needs --mom");

  // FAIL FAST: a name to look up and no key to look it up with is refused
  // before anything is read. No name, no picker and no call.
  let picker: { picker: PersonPicker; model: boolean } | null = null;
  if (momText) {
    try {
      picker = whoIsWhoPicker();
    } catch (err) {
      if (err instanceof ProductionKeyInProcessError) {
        console.error(`${err.message}\nNothing written.`);
        process.exit(1);
      }
      if (!(err instanceof DevApiKeyMissingError)) throw err;
      fail(
        `--mom and --by are looked up by who-is-who, a model call on ${DEV_KEY_ENV}, and it is not set. ` +
          `Add ${DEV_KEY_ENV}="sk-ant-..." to the repo-root .env and run with node --env-file=.env (MDs/dev-vs-production-api-keys.md), ` +
          `or record the score alone`,
      );
    }
  }

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

  // Who may record the pick: an owner or admin of the club.
  const organisers = await db.membership.findMany({
    where: { orgId: match.activity.orgId, role: { in: ["OWNER", "ADMIN"] }, leftAt: null },
    select: { userId: true, role: true, user: { select: { name: true } } },
    orderBy: [{ role: "asc" }, { id: "asc" }],
  });
  const roster: Member[] = organisers.map((o) => ({ userId: o.userId, name: o.user?.name ?? "", isAdmin: true, hasPhone: false }));

  // WHO THE NAMES ARE, as hqMom asks it: who-is-who is shown the WHOLE
  // club with the match's players marked, so a namesake who did not play
  // makes the name ambiguous instead of the one player of that name being
  // taken. --by is asked in the same call; organisers are marked too.
  const players = momText ? await matchPlayers(match.id) : [];
  let people: PersonPicks = new Map();
  let clubNameOf = new Map<string, string>();
  if (picker) {
    const refs = [momText, byText].filter((r): r is string => !!r);
    const organiserIds = new Set(roster.map((o) => o.userId));
    const club = (await loadClubWhoRoster(match.activity.orgId, players, "played this game")).map((m) =>
      organiserIds.has(m.userId) ? { ...m, note: m.note ? `${m.note}; an organiser` : "an organiser" } : m,
    );
    const said = [momText ? `Man of the Match: ${momText}` : null, byText ? `Recorded by: ${byText}` : null].filter(Boolean).join("\n");
    const TIMED_OUT = Symbol("timed out");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const who = await Promise.race([
      identifyRefs({
        picker: picker.picker,
        refs,
        body: said,
        author: null,
        senderUserId: null,
        roster: club,
        where: "a match result the club's organisers gave, recorded by hand",
      }),
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), WHO_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
    if (who === TIMED_OUT) {
      console.log(`  who-is-who: no answer in ${WHO_TIMEOUT_MS / 1000}s; what a request still open was billed is not known here`);
      fail(`who-is-who could not answer for ${quoted(refs)} (the call failed (timed out after ${WHO_TIMEOUT_MS / 1000}s))`);
    }
    people = who.people;
    // What it cost, on every run that asks the model, dry runs included.
    // As identifyRefs counts it: a call that errored before any answer is
    // 0 calls and $0 here; one whose answer came back but could not be read
    // (cut off at its token limit, say) is billed, and counted.
    if (picker.model) console.log(`  who-is-who: ${who.calls} call${who.calls === 1 ? "" : "s"}, $${who.costUsd.toFixed(4)} on the dev key (${DEV_KEY_ENV})`);
    clubNameOf = new Map(club.map((m) => [m.userId, m.name || (m.aliases ?? [])[0] || "?"]));
    // No answer to be had (the call failed, the daily cap refused it, the
    // answer could not be read): say THAT, not "ambiguous" or "not one
    // organiser", which would send the operator after the wrong problem.
    // Every name it could not answer for, in one refusal.
    const unanswered = refs.flatMap((ref) => {
      const pick = people.get(refKey(ref));
      return pick?.kind === "unidentified" ? [{ ref, why: pick.why }] : [];
    });
    if (unanswered.length > 0) fail(`who-is-who could not answer for ${quoted(unanswered.map((u) => u.ref))} (${unanswered[0].why}); try again`);
  }

  let mom: { userId: string; name: string } | null = null;
  if (momText) {
    const r = resolveMomRef(momText, players, people, clubNameOf);
    if (r.kind === "ambiguous") fail(`"${momText}" could be ${r.names.join(" or ")}`);
    if (r.kind === "not-in-match") fail(`"${momText}" is not one of the match's players`);
    if (r.kind === "unsure") fail(`MatchTime could not say who "${momText}" is (who-is-who was not sure, or gave no answer)`);
    mom = { userId: r.userId, name: r.name };
  }

  const byPick = byText ? resolvePerson(byText, roster, people) : null;
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
  let scoreWritten: string | null = null;
  if (score && !(previous && previous.red === score.red && previous.yellow === score.yellow)) {
    const [res] = await applyScoreWrites({
      writes: [{ kind: "score", matchId: match.id, red: score.red, yellow: score.yellow, ...(previous ? { previous } : {}), sourceMessageId: "script:set-match-result", reason: "set by hand" }],
      deps: buildScoreApplyDeps(),
    });
    if (!res.ok) fail(`the score write failed (${res.error})`);
    scoreWritten = `${labels[0]} ${score.red}, ${labels[1]} ${score.yellow}`;
    console.log(`  score written; ${res.eloApplied} rating(s) moved${res.eloError ? `; Elo: ${res.eloError}` : ""}`);
  }
  if (mom) {
    try {
      await setMatchMom({ matchId: match.id, playerId: mom.userId, byUserId: by!.userId });
    } catch (err) {
      // Not one transaction with the score (see the header): say exactly
      // what is in the database now, and how to finish.
      // The whole command, copy-pasteable: every value one shell word.
      const again = [INVOCATION, "--match", shellQuote(match.id), "--mom", shellQuote(momText!), ...(byText ? ["--by", shellQuote(byText)] : []), "--apply"].join(" ");
      console.error(
        scoreWritten
          ? `PARTLY WRITTEN: the score IS recorded (${scoreWritten}; the match is COMPLETED), but the Man of the Match (${mom.name}) was NOT written. ` +
              `To record him, run this (no --score: the score stays as it is):\n  ${again}\nThe error follows.`
          : `FAILED: the Man of the Match (${mom.name}) was not written, and nothing else was either. The error follows.`,
      );
      console.error(err);
      process.exit(1);
    }
    console.log("  Man of the Match written.");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
