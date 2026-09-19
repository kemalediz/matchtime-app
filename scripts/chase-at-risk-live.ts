/**
 * ═══════════════════════════════════════════════════════════════════════
 * LIVE VALIDATION — the at-risk cancellation warning on the 17:00 chase.
 *
 * A stubbed test proves the PROMPT changed. It cannot prove the model
 * writes a call-off warning when told to, or — the direction that
 * actually matters — that it never writes one when it wasn't. That is a
 * behaviour question, and behaviour questions need the real model, run
 * enough times to see the variance. (Cressoft rule, and the MatchTime
 * lesson: a stubbed sim passed while the real model still mis-classified.)
 *
 * ── ZERO WRITES, AND ZERO READS ──────────────────────────────────────
 * There is no Prisma client in this file. The squad state is built in
 * memory, right here, and handed to `composeChaseFromMatch` — the exact
 * function `composeChaseText` calls once it has finished reading the
 * database. Production is 6/14 at ~57h out, which is deliberately NOT at
 * risk on these thresholds, so waiting for the state was never an option
 * and mutating a customer's data to force it is not on the table.
 *
 * ── IT COSTS REAL MONEY ──────────────────────────────────────────────
 * Every compose is a real Sonnet call on ANTHROPIC_API_KEY_DEV, the
 * developer's key. It refuses to run without one.
 * The default sweep is 25 calls, a few cents.
 *
 * ── HOW TO RUN ───────────────────────────────────────────────────────
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/chase-at-risk-live.ts
 *
 *   RUNS=10     runs per scenario (default 10)
 *   ONLY=AT-RISK,HEALTHY  run only these scenarios
 *   FULL=1      print every composed message, not just the failures
 * ═══════════════════════════════════════════════════════════════════════
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import {
  composeChaseFromMatch,
  type ChaseComposeMatch,
} from "../src/lib/message-analyzer.ts";
import { computeChaseRisk } from "../src/lib/chase-risk.ts";
import { buildFormatSwitchFacts } from "../src/lib/format-switch.ts";

const NAMES = [
  "Elvin", "Mustafa", "Idris", "Sait", "Ibrahim Sahin", "Ersin",
  "Kemal", "Habib", "Najib", "Mojib", "Ehtisham", "Kieran",
  "Rashad", "Ayoub",
];

function squad(n: number): ChaseComposeMatch["attendances"] {
  return NAMES.slice(0, n).map((name, i) => ({
    status: "CONFIRMED",
    user: { id: `u${i}`, name, phoneNumber: "+447700900000" },
  }));
}

/** Now, snapped down to the hour, so a synthetic kickoff reads like a
 *  real one ("21:00") instead of whatever minute the script started. */
const CLOCK = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);

function matchAt(hoursOut: number, confirmed: number): ChaseComposeMatch {
  return {
    date: new Date(CLOCK.getTime() + hoursOut * 3_600_000),
    status: "UPCOMING",
    maxPlayers: 14,
    activity: { name: "Tuesday 7-a-side", venue: "Sim Arena" },
    attendances: squad(confirmed),
  };
}

interface Scenario {
  id: string;
  what: string;
  match: ChaseComposeMatch;
  alternatives?: Array<{ sportName: string; totalPlayers: number }>;
  /** What the SERVER decided. Asserted, not assumed. */
  expectAtRisk: boolean;
}

const FIVE_A_SIDE = [{ sportName: "Football 5-a-side", totalPlayers: 10 }];

const SCENARIOS: Scenario[] = [
  {
    id: "AT-RISK",
    what: "6/14, 24h out (need 8) — at risk, no viable smaller format",
    match: matchAt(24, 6),
    alternatives: FIVE_A_SIDE, // 6 confirmed does not fill 10 → NOT VIABLE
    expectAtRisk: true,
  },
  {
    id: "HEALTHY",
    what: "6/14, 96h out (need 8) — same shortfall, too early to be at risk",
    match: matchAt(96, 6),
    alternatives: FIVE_A_SIDE,
    expectAtRisk: false,
  },
  {
    id: "AT-RISK+SWITCH",
    what: "10/14, 20h out (need 4) — at risk AND 5-a-side is VIABLE",
    match: matchAt(20, 10),
    alternatives: FIVE_A_SIDE, // 10 confirmed fills 10 → VIABLE, benches nobody
    expectAtRisk: true,
  },
  {
    id: "SWITCH-ONLY",
    what: "11/14, 20h out (need 3) — NOT at risk, but 5-a-side is VIABLE",
    // The control for the verbatim-copy rate. One player short of the
    // at-risk threshold and the same 20h out, so the system prompt's
    // "short AND within 24h AND viable" switch rule fires exactly as it
    // does in AT-RISK+SWITCH — the only difference is the at-risk block.
    // Any gap in the copy rate between the two is the block's doing.
    match: matchAt(20, 11),
    alternatives: FIVE_A_SIDE,
    expectAtRisk: false,
  },
];

/** MatchTime saying the match may not go ahead. */
const CALL_OFF =
  /\b(?:call(?:ed|ing)?\s+(?:it|this|the\s+(?:match|game|fixture))\s+off|calling\s+it\s+off|(?:match|game|fixture)(?:'s| is| will be| gets)?\s+off\b|cancel\w*)/i;

/** MatchTime claiming IT is the one cancelling. Kemal cancels. */
const BOT_CANCELS =
  /\bI(?:'ll| will| am| have to| may have to| might have to|'m)?\s+(?:going to\s+)?cancel\w*/i;

/** Blaming a person for the shortfall. */
const BLAME =
  /\b(?:let(?:ting)?\s+(?:us|the\s+lads|everyone)\s+down|no thanks to|blame|because\s+\w+\s+(?:bailed|dropped out|pulled out))\b/i;

async function run(): Promise<void> {
  // Development model calls go on the DEVELOPER's key. This assigns
  // ANTHROPIC_API_KEY_DEV over ANTHROPIC_API_KEY for this process, so the
  // library code below, the same modules production runs, picks it up
  // unchanged. It must happen before the first model call, because some
  // call sites cache their SDK client (message-analyzer.ts keeps a
  // module-level `_anthropic`). No fallback: see
  // MDs/llm-spend-september-2026.md.
  spendDevApiKeyOrExit("scripts/chase-at-risk-live.ts");

  const runs = Math.max(1, Number(process.env.RUNS ?? 10));
  const printAll = process.env.FULL === "1";
  let failures = 0;

  const only = process.env.ONLY?.split(",").map((s) => s.trim());
  for (const s of SCENARIOS) {
    if (only && !only.includes(s.id)) continue;
    const risk = computeChaseRisk({
      kickoff: s.match.date,
      confirmedCount: s.match.attendances.filter((a) => a.status === "CONFIRMED").length,
      maxPlayers: s.match.maxPlayers,
    });
    console.log(
      `\n${"═".repeat(72)}\n${s.id} — ${s.what}\n` +
        `server verdict: atRisk=${risk.atRisk} (need ${risk.need}, ` +
        `${risk.hoursToKickoff.toFixed(1)}h out)\n${"═".repeat(72)}`,
    );
    if (risk.atRisk !== s.expectAtRisk) {
      console.log(`  ❌ the ARITHMETIC is wrong before a single call was made`);
      failures++;
      continue;
    }

    // The EXACT line the server told the model to copy character for
    // character, if there is one. Tracked separately: it is a
    // pre-existing rule, and the at-risk block must not erode it.
    const proposal =
      buildFormatSwitchFacts({
        confirmedNames: s.match.attendances
          .filter((a) => a.status === "CONFIRMED")
          .map((a) => a.user.name ?? "(unnamed)"),
        currentMaxPlayers: s.match.maxPlayers,
        alternatives: s.alternatives ?? [],
      }).find((f) => f.proposal)?.proposal ?? null;

    let warned = 0;
    let botCancelled = 0;
    let blamed = 0;
    let nulls = 0;
    let switchMentioned = 0;
    let switchVerbatim = 0;

    for (let n = 0; n < runs; n++) {
      const text = await composeChaseFromMatch({
        kind: "daily-in-list",
        orgName: "Sutton Football Club",
        match: s.match,
        alternatives: s.alternatives,
        logLabel: `live-check ${s.id}`,
      });
      if (!text) {
        nulls++;
        console.log(`\n── run ${n + 1}/${runs}: NULL (would fall back to static text)`);
        continue;
      }
      const hasWarning = CALL_OFF.test(text);
      const botCancels = BOT_CANCELS.test(text);
      const blames = BLAME.test(text);
      if (hasWarning) warned++;
      if (botCancels) botCancelled++;
      if (blames) blamed++;
      if (proposal) {
        const mentions = /switch to/i.test(text);
        if (mentions) switchMentioned++;
        if (text.includes(proposal)) switchVerbatim++;
      }

      // A run is wrong when the warning disagrees with the server, or
      // when MatchTime claims the cancellation as its own.
      const wrong = hasWarning !== s.expectAtRisk || botCancels || blames;
      if (wrong || printAll) {
        console.log(
          `\n── run ${n + 1}/${runs} ${wrong ? "❌" : "✅"} ` +
            `warning=${hasWarning} botCancels=${botCancels} blames=${blames}\n` +
            `${text}`,
        );
      }
    }

    const wantWarnings = s.expectAtRisk ? runs : 0;
    const ok = warned === wantWarnings && botCancelled === 0 && blamed === 0 && nulls === 0;
    if (!ok) failures++;
    console.log(
      `\n${ok ? "✅" : "❌"} ${s.id}: call-off warning in ${warned}/${runs} ` +
        `(want ${wantWarnings}/${runs}), "I will cancel" in ${botCancelled}/${runs} ` +
        `(want 0), blame in ${blamed}/${runs} (want 0), null in ${nulls}/${runs} (want 0)`,
    );
    if (proposal) {
      console.log(
        `   format switch: proposed in ${switchMentioned}/${runs}, ` +
          `copied VERBATIM in ${switchVerbatim}/${runs} ` +
          `(pre-existing rule — compare AT-RISK+SWITCH against SWITCH-ONLY)`,
      );
    }
  }

  console.log(
    `\n${"═".repeat(72)}\n` +
      (failures === 0
        ? `All ${SCENARIOS.length} scenarios behaved. Database writes: 0. Database reads: 0.`
        : `⚠️  ${failures}/${SCENARIOS.length} scenarios misbehaved. Database writes: 0.`),
  );
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
