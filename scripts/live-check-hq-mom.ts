/**
 * MAN OF THE MATCH PICKED BY THE ORGANISERS, IN HQ: THE PAID CHECK
 * (2026-10-18).
 *
 * Approved by Kemal for HQ work: dev key only, each case once. The unit
 * and e2e tests stub the models; this proves the real router sends an
 * organiser's own words about the result and Man of the Match, under the
 * organisers' header and the WAITING line that now names Man of the Match,
 * to `score`, and that the real (rewritten) score extractor reports the
 * name for `answerHqScore` to resolve and record, EN and TR. The router
 * prompt is unchanged by this work; the score prompt was rewritten, so
 * `scripts/live-check-hq-score.ts` is run beside this for the score cases.
 *
 *   DATABASE_URL=postgresql://none@127.0.0.1:1/none \
 *     node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-hq-mom.ts
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). No database:
 * the state is built here; the score writer, the MoM writer and HQ's log
 * are recorders. Prints each case, the calls made and the cost.
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { routeBatch } from "../src/lib/pipeline/router.ts";
import { organisersContext, type ScoreWaiting } from "../src/lib/admin-group-context.ts";
import { answerHqScore } from "../src/lib/admin-group-score.ts";
import { hasScorelineShape } from "../src/lib/pipeline/score-ask.ts";
import { world } from "../src/lib/pipeline/__tests__/helpers.ts";
import type { SquadState } from "../src/lib/pipeline/types.ts";
import type { ScoreApplyDeps } from "../src/lib/score-engine.ts";
import type { MomPickDeps } from "../src/lib/mom-pick.ts";

const MAX_USD = 2;
spendDevApiKeyOrExit("the HQ Man of the Match live check");

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
const ASK_EN = "🏁 *Friday 5-a-side*: what was the final score, which team won, and who was Man of the Match? Reply here and I'll record it.";
const ASK_TR = "🏁 *Cuma 5'li maç*: maç kaç kaç bitti, hangi takım kazandı ve Man of the Match kim? Buraya yazın, kaydedeyim.";
const MOM_ASK_EN = "Score saved: Yellow 7, Red 4. Who was Man of the Match?";
const MOM_ASK_TR = "Skor kaydedildi: Sarı 7, Kırmızı 4. Man of the Match kim?";

const PLAYERS = [
  { userId: "u-naim", name: "Naim Rahman", isAdmin: false, hasPhone: true },
  { userId: "u-ali1", name: "Ali Can", isAdmin: false, hasPhone: true },
  { userId: "u-ali2", name: "Ali Veli", isAdmin: false, hasPhone: true },
  { userId: "u-imti", name: "Imtiaz Ahmed", isAdmin: false, hasPhone: true },
];

type Want = { score?: { red: number; yellow: number }; mom?: string; momAsked?: true } | "nothing";
interface Case {
  text: string;
  lang: "en" | "tr";
  want: Want;
  /** The score is already recorded (Red 4, Yellow 7): only the MoM waits. */
  scored?: boolean;
  quoted?: string;
  why: string;
}

const CASES: Case[] = [
  { text: "Yellow won 7-4, MoM Naim", lang: "en", want: { score: { red: 4, yellow: 7 }, mom: "u-naim" }, why: "the owner's own example" },
  { text: "7-4 to the yellows, man of the match Imtiaz", lang: "en", want: { score: { red: 4, yellow: 7 }, mom: "u-imti" }, why: "score then MoM, spelt out" },
  { text: "great game lads, yellows won 7-4 and Naim got MoM", lang: "en", want: { score: { red: 4, yellow: 7 }, mom: "u-naim" }, why: "chatty, one message" },
  { text: "Yellow won 7-4, MoM Ali", lang: "en", want: { score: { red: 4, yellow: 7 }, momAsked: true }, why: "two Alis: score saved, which Ali asked" },
  { text: "Yellow won 7-4", lang: "en", want: { score: { red: 4, yellow: 7 }, momAsked: true }, why: "no name: score saved, MoM asked" },
  { text: "MoM was Naim", lang: "en", scored: true, want: { mom: "u-naim" }, why: "the name in a second message" },
  { text: "man of the match tonight was Imtiaz", lang: "en", scored: true, want: { mom: "u-imti" }, why: "second message, spelt out" },
  { text: "Naim", lang: "en", scored: true, quoted: MOM_ASK_EN, want: { mom: "u-naim" }, why: "bare name replying to the MoM question" },
  { text: "Yellow won 7-4", lang: "en", quoted: ASK_EN, want: { score: { red: 4, yellow: 7 }, momAsked: true }, why: "reply to the scheduled ask, no name" },
  { text: "Naim was class tonight", lang: "en", scored: true, want: "nothing", why: "praise, not a pick" },
  { text: "Sarı 7-4 kazandı, maçın adamı Naim", lang: "tr", want: { score: { red: 4, yellow: 7 }, mom: "u-naim" }, why: "TR, one message" },
  { text: "maç 7-4 bitti sarılar kazandı, maçın adamı Imtiaz'dı", lang: "tr", want: { score: { red: 4, yellow: 7 }, mom: "u-imti" }, why: "TR chatty, suffix on the name" },
  { text: "maçın adamı Naim", lang: "tr", scored: true, want: { mom: "u-naim" }, why: "TR second message" },
  { text: "Naim", lang: "tr", scored: true, quoted: MOM_ASK_TR, want: { mom: "u-naim" }, why: "TR bare name replying to the question" },
  { text: "Sarı 7-4 kazandı", lang: "tr", quoted: ASK_TR, want: { score: { red: 4, yellow: 7 }, momAsked: true }, why: "TR reply to the ask, no name" },
];

function stateFor(c: Case): SquadState {
  const s = world({
    completedMatch: {
      id: "done-1",
      participantUserIds: PLAYERS.map((p) => p.userId),
      ...(c.lang === "tr" ? { teamLabels: ["Kırmızı", "Sarı"] as [string, string] } : {}),
      ...(c.scored ? { redScore: 4, yellowScore: 7, status: "COMPLETED" } : {}),
    },
    features: { language: c.lang },
  });
  return { ...s, features: { ...s.features, momChosenBy: "organisers" } };
}

async function main() {
  let pass = 0;
  let fail = 0;
  console.log(`\n== Man of the Match in the organisers' group: ${CASES.length} cases, each once ==\n`);
  const only = process.env.ONLY ? new Set(process.env.ONLY.split(",").map(Number)) : null;
  for (const [i, c] of CASES.entries()) {
    if (only && !only.has(i)) continue;
    const id = `3EB0C4F1A9E2${String(i).padStart(4, "0")}`;
    const state = stateFor(c);
    const labels = (state.completedMatch?.teamLabels ?? state.teamLabels) as [string, string];
    const day = c.lang === "tr" ? "Sal 1 Eyl" : "Tue 1 Sep";
    const waiting: ScoreWaiting = c.scored ? { kind: "mom", day } : { kind: "result", day, labels, mom: true };
    const context = organisersContext({
      pending: [],
      quoted: c.quoted ? { text: c.quoted, fromMatchTime: true } : null,
      quotedIsMatchTime: !!c.quoted,
      recent: c.quoted ? [{ fromMatchTime: true, text: c.quoted }] : [],
      score: waiting,
    });
    const routed = await routeBatch(model, [{ id, authorName: "Raihan", body: c.text, organisers: { context } }], { floor: true });
    const route = routed.routes.find((r) => r.messageId === id)?.route ?? "none";

    const written: Array<{ red: number; yellow: number }> = [];
    const picks: string[] = [];
    const apply: ScoreApplyDeps = {
      recordScore: async (a) => void written.push({ red: a.red, yellow: a.yellow }),
      reconcileElo: async () => ({ moved: 0 }),
      recordScoreAsk: async () => {},
    };
    const mom: MomPickDeps = {
      players: async () => PLAYERS,
      mvpLabel: async () => "Man of the Match",
      current: async () => [],
      set: async (a) => (picks.push(a.playerId), { previous: [] }),
    };
    // As `admin-group-understand.ts`: `score`; a scoreline the router could
    // not place while a score waits; an approve with nothing to approve
    // while the result waits (nothing is pending here); or a reply to the
    // MoM question (the quoted row's ref, stood in for by MOM_ASK_*).
    const answersMomAsk = c.quoted === MOM_ASK_EN || c.quoted === MOM_ASK_TR;
    const r =
      route === "score" || route === "approve" || answersMomAsk || (route === "unsure" && hasScorelineShape(c.text))
        ? await answerHqScore({
            orgId: "org-live",
            lang: c.lang,
            messageId: id,
            body: c.text,
            senderUserId: "u-kemal",
            senderName: "Raihan",
            organiser: true,
            addressed: !!c.quoted,
            history: c.quoted ? [{ author: "MatchTime", body: c.quoted }] : [],
            now: NOW,
            deps: { model, apply, loadState: async () => state, recordQuestion: async () => {}, mom },
          })
        : null;
    const outcome = r && r !== "organisers-only" ? r.outcome : r === "organisers-only" ? r : "nothing";
    const reply = r && r !== "organisers-only" ? r.replyText : null;
    let ok: boolean;
    if (c.want === "nothing") ok = written.length === 0 && picks.length === 0;
    else {
      const w = c.want;
      const scoreOk = w.score
        ? written.length === 1 && written[0].red === w.score.red && written[0].yellow === w.score.yellow
        : written.length === 0;
      const momOk = w.mom ? picks.length === 1 && picks[0] === w.mom : picks.length === 0;
      const askOk = w.momAsked ? /Man of the Match/.test(reply ?? "") && picks.length === 0 : true;
      ok = scoreOk && momOk && askOk;
    }
    ok ? pass++ : fail++;
    console.log(
      `${ok ? "PASS" : "FAIL"}  [${c.lang}] ${JSON.stringify(c.text)}  routed ${route} -> ${outcome}` +
        `${written.length ? ` score ${JSON.stringify(written)}` : ""}${picks.length ? ` mom ${picks.join(",")}` : ""}${reply ? `  "${reply}"` : ""}   (${c.why})`,
    );
  }
  console.log(`\n${pass} passed, ${fail} failed. Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
}

main().catch((err) => {
  console.error(err);
  console.log(`Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(1);
});
