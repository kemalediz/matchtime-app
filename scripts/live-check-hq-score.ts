/**
 * THE MATCH SCORE IN THE ADMIN GROUP: THE PAID CHECK (2026-10-16).
 *
 * Approved by Kemal for this change: dev key only, each case once. The
 * unit and e2e tests stub the models; they prove the wiring and HQ's
 * rules. This proves the real router sends an organiser's own score
 * words, under the organisers' header and the new "WAITING: the final
 * score" line, to `score`, and that the real score extractor plus the
 * shipped engine then record it, ask once, or leave it, through
 * `answerHqScore` exactly as production runs it. EN and TR, ambiguous
 * ones included. The router prompt is unchanged by this work.
 *
 *   DATABASE_URL=postgresql://none@127.0.0.1:1/none \
 *     node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-hq-score.ts
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). No database:
 * the state is built here, the writer and HQ's log are recorders. Prints
 * each case, the calls made and the cost. Stops at MAX_USD.
 */
import { quoteFromPi } from "../src/lib/reply-context.ts";
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { routeBatch } from "../src/lib/pipeline/router.ts";
import { organisersContext, type ScoreWaiting } from "../src/lib/admin-group-context.ts";
import { answerHqScore } from "../src/lib/admin-group-score.ts";
import { world } from "../src/lib/pipeline/__tests__/helpers.ts";
import type { SquadState } from "../src/lib/pipeline/types.ts";
import type { ScoreApplyDeps } from "../src/lib/score-engine.ts";

const MAX_USD = 2;
spendDevApiKeyOrExit("the HQ score live check");

let calls = 0;
let usd = 0;
const inner = anthropicModel();
const model: PipelineModel = {
  name: "metered",
  async complete(req) {
    if (usd >= MAX_USD) throw new Error(`stopped at $${MAX_USD}`);
    const r = await inner.complete(req);
    calls++;
    usd += r.costUsd ?? 0;
    return r;
  },
};

const NOW = new Date("2026-09-01T18:00:00.000Z");
const ASK_POST = "🏁 *Tuesday 5-a-side*: what was the final score, and which team won? Reply here and I'll record it.";

type Want = { red: number; yellow: number } | "asked" | "nothing" | "changed";
interface Case {
  text: string;
  lang: "en" | "tr";
  want: Want;
  recorded?: { red: number; yellow: number };
  quoted?: string;
  addressed?: boolean;
  why: string;
}

const CASES: Case[] = [
  { text: "Yellow won 7-4", lang: "en", want: { red: 4, yellow: 7 }, why: "winner named" },
  { text: "7-4 to the yellows tonight", lang: "en", want: { red: 4, yellow: 7 }, why: "'to' a team" },
  { text: "reds won 5-3, great game", lang: "en", want: { red: 5, yellow: 3 }, why: "winner, chatty" },
  { text: "final score 6-6", lang: "en", want: { red: 6, yellow: 6 }, why: "a draw" },
  { text: "@Match Time Yellow 7 Red 4", lang: "en", want: { red: 4, yellow: 7 }, addressed: true, why: "tagged, by position" },
  { text: "7-4 to yellows", lang: "en", want: { red: 4, yellow: 7 }, quoted: ASK_POST, addressed: true, why: "reply to the scheduled ask" },
  // A lone team name beside a scoreline is the engine's call (`score-teams.ts`): asking is right.
  { text: "7-4 yellows", lang: "en", want: "asked", quoted: ASK_POST, addressed: true, why: "reply to the ask, lone name: asks which team" },
  { text: "7-4", lang: "en", want: "asked", why: "no team: which team won?" },
  { text: "7-4 or 7-5, yellow won anyway", lang: "en", want: "asked", why: "ambiguous: two scorelines" },
  { text: "I think it was 7-4 or 7-5 to yellow, not sure", lang: "en", want: "asked", why: "ambiguous, hedged" },
  { text: "who is bringing the bibs next week?", lang: "en", want: "nothing", why: "chatter, a score waiting" },
  { text: "we lost 9-2 to Sutton Lads in the cup last week", lang: "en", want: "nothing", why: "another game" },
  { text: "no, it was 7-5 to yellow", lang: "en", want: "changed", recorded: { red: 4, yellow: 7 }, why: "organiser corrects a recorded result" },
  { text: "Sarı 7-4 kazandı", lang: "tr", want: { red: 4, yellow: 7 }, why: "TR winner" },
  { text: "maç 7-4 bitti, sarılar kazandı", lang: "tr", want: { red: 4, yellow: 7 }, why: "TR, chatty" },
  { text: "Kırmızı 5 Sarı 3", lang: "tr", want: { red: 5, yellow: 3 }, why: "TR by position" },
  { text: "7-4", lang: "tr", want: "asked", why: "TR no team" },
  { text: "7-4 mü 7-5 mi emin değilim, sarı kazandı", lang: "tr", want: "asked", why: "TR ambiguous" },
  { text: "yarın topları kim getiriyor?", lang: "tr", want: "nothing", why: "TR chatter" },
];

function stateFor(c: Case): SquadState {
  return world({
    completedMatch: {
      id: "done-1",
      participantUserIds: ["u-sait"],
      ...(c.lang === "tr" ? { teamLabels: ["Kırmızı", "Sarı"] as [string, string] } : {}),
      ...(c.recorded ? { redScore: c.recorded.red, yellowScore: c.recorded.yellow, status: "COMPLETED" } : {}),
    },
    features: { language: c.lang },
  });
}

async function main() {
  let pass = 0;
  let fail = 0;
  console.log(`\n== Score in the organisers' group: ${CASES.length} cases, each once ==\n`);
  const only = process.env.ONLY ? new Set(process.env.ONLY.split(",").map(Number)) : null;
  for (const [i, c] of CASES.entries()) {
    if (only && !only.has(i)) continue;
    // A WhatsApp-shaped id, as production sends.
    const id = `3EB0C4F1A9D2${String(i).padStart(4, "0")}`;
    const state = stateFor(c);
    const labels = (state.completedMatch?.teamLabels ?? state.teamLabels) as [string, string];
    const waiting: ScoreWaiting | null = c.recorded ? null : { kind: "result", day: c.lang === "tr" ? "Sal 1 Eyl" : "Tue 1 Sep", labels };
    const context = organisersContext({
      pending: [],
      recent: c.quoted ? [{ fromMatchTime: true, text: c.quoted }] : [],
      score: waiting,
    });
    const quotedReply = c.quoted ? quoteFromPi({ id: null, text: c.quoted, fromMatchTime: true }) : null;
    const routed = await routeBatch(model, [{ id, authorName: "Raihan", body: c.text, organisers: { context }, reply: quotedReply }], { floor: true });
    const route = routed.routes.find((r) => r.messageId === id)?.route ?? "none";
    if (process.env.DEBUG) console.log(JSON.stringify(routed.routes), routed.degradations.map((d) => d.detail));

    const written: Array<{ red: number; yellow: number }> = [];
    const apply: ScoreApplyDeps = {
      recordScore: async (a) => void written.push({ red: a.red, yellow: a.yellow }),
      reconcileElo: async () => ({ moved: 0 }),
      recordScoreAsk: async () => {},
    };
    // As `admin-group-understand.ts`: `score`, or a scoreline the router
    // could not place while a score is waiting.
    const r =
      route === "score"
        ? await answerHqScore({
            orgId: "org-live",
            lang: c.lang,
            messageId: id,
            body: c.text,
            senderUserId: "u-kemal",
            senderName: "Raihan",
            organiser: true,
            addressed: !!c.addressed,
            history: c.quoted ? [{ author: "MatchTime", body: c.quoted }] : [],
            reply: quotedReply,
            now: NOW,
            deps: { model, apply, loadState: async () => state, recordQuestion: async () => {} },
          })
        : null;
    const outcome = r && r !== "organisers-only" ? r.outcome : r === "organisers-only" ? r : "nothing";
    let ok: boolean;
    if (c.want === "nothing") ok = written.length === 0 && (route !== "score" || outcome === "nothing" || outcome === "hq-not-understood" || outcome === "hq-score-not-changed");
    else if (c.want === "asked") ok = written.length === 0 && outcome === "hq-score-asked";
    else if (c.want === "changed") ok = outcome === "hq-score-changed" && written.length === 1 && written[0].red === 5 && written[0].yellow === 7;
    else ok = outcome === "hq-score-saved" && written.length === 1 && written[0].red === c.want.red && written[0].yellow === c.want.yellow;
    ok ? pass++ : fail++;
    const reply = r && r !== "organisers-only" ? r.replyText : null;
    console.log(`${ok ? "PASS" : "FAIL"}  [${c.lang}] ${JSON.stringify(c.text)}  routed ${route} -> ${outcome}${written.length ? ` ${JSON.stringify(written)}` : ""}${reply ? `  "${reply}"` : ""}   (${c.why})`);
  }
  console.log(`\n${pass} passed, ${fail} failed. Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
}

main().catch((err) => {
  console.error(err);
  console.log(`Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(1);
});
