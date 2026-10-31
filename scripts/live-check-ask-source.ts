/**
 * WHERE THE PLAYERS COME FROM, ASKED IN HQ: THE PAID CHECK (2026-10-28,
 * Kemal: "stricter", and ask when in limbo between the partner clubs and
 * the MatchTime player pool).
 *
 * Each case ONCE through the real router (the organisers' header, as
 * production renders it) and, on ask_group and admin_ops, the real admin
 * extractor, told truly whether the bot was tagged. What HQ would do, by
 * the same rule as `admin-group-understand.ts` and `ask-source-rules.ts`,
 * for a club that has BOTH partner clubs and the pool (the other three
 * club shapes differ only in code, which the unit tests pin):
 *
 *   pool      the pool is asked          partners  the partner clubs
 *   group     the players' group         which     MatchTime asks which
 *   quiet     nothing leaves HQ          other     another route
 *
 * Then the ANSWERS to MatchTime's question: the admin extractor reads the
 * organiser's next message with the question as MatchTime's last post, as
 * HQ does; "not" means it is not an answer and the message is handled as
 * it would have been.
 *
 *   npx tsx --env-file=.env scripts/live-check-ask-source.ts
 *   MEASURE=1 ...   one real call, its tokens and cost, then stop
 *   ONLY=<text> ... the cases whose text contains it
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). No database,
 * sends nothing. Prints each case, the calls made and the cost.
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { routeBatch } from "../src/lib/pipeline/router.ts";
import { extractForRoute } from "../src/lib/pipeline/extractors.ts";
import { organisersContext } from "../src/lib/admin-group-context.ts";
// The tag as the Pi reports it for these cases: "@Match Time" written in the body
// (`messageMentionsBotExplicitly` was replaced by `piMentionsBot`, 2026-10-30).
const messageMentionsBotExplicitly = (m: { body: string }): boolean => /@match\s*time/i.test(m.body);
import { decideRecruitSource, sourcesFromAnswer } from "../src/lib/ask-source-rules.ts";
import { t } from "../src/lib/i18n/t.ts";

const MAX_USD = Number(process.env.MAX_USD ?? 0.5);
spendDevApiKeyOrExit("the HQ ask-source live check");

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
    if (process.env.MEASURE) console.log(`[measure] ${req.label}: in ${r.usage.inputTokens} + cache read ${r.usage.cacheReadTokens} + cache write ${r.usage.cacheWriteTokens}, out ${r.usage.outputTokens}, $${(r.costUsd ?? 0).toFixed(5)}`);
    return r;
  },
};

type Got = "pool" | "partners" | "group" | "which" | "quiet" | "other";
const NOW = new Date("2026-10-28T15:30:00Z");

const CASES: Array<{ text: string; want: Got[]; why: string }> = [
  // The pool, asked for in the organiser's own words.
  { text: "@Match Time ask the player pool for one", want: ["pool"], why: "explicit pool" },
  { text: "@Match Time havuzdan bul", want: ["pool"], why: "TR explicit pool" },
  { text: "@Match Time get someone from outside the club, we're short", want: ["pool"], why: "outside the club and partners" },
  // The partners, asked for.
  { text: "@Match Time ask our partner clubs", want: ["partners"], why: "explicit partners" },
  { text: "@Match Time ask Friday MT Community", want: ["partners"], why: "a partner club by name" },
  { text: "@Match Time partner kulüplere sor", want: ["partners"], why: "TR partners" },
  // Ambiguous: players wanted, no source said.
  { text: "@Match Time we need 2 players for Thursday", want: ["which"], why: "ambiguous" },
  { text: "@Match Time find us someone", want: ["which"], why: "ambiguous" },
  { text: "@Match Time 2 kişi lazım", want: ["which"], why: "TR ambiguous" },
  { text: "@Match Time bize oyuncu bul", want: ["which"], why: "TR ambiguous" },
  { text: "can you find us a player for Friday", want: ["which", "quiet"], why: "untagged ambiguous: asks MatchTime, or the others" },
  { text: "we need 2 players for Thursday", want: ["quiet", "which"], why: "untagged shortage: the organisers' own chat, or an ask" },
  // The club's own players.
  { text: "@Match Time chase the lads", want: ["group", "other"], why: "the club's own players: never pool or partners" },
  { text: "@Match Time remind the group", want: ["group", "other"], why: "the club's own players: never pool or partners" },
  { text: "@Match Time ask the group if anyone can play", want: ["group"], why: "the players' group" },
  { text: "@Match Time gruba sor, oynayabilecek var mı", want: ["group"], why: "TR the players' group" },
];

const QUESTION = t("en").hq_ask_source({ options: ["club", "partners", "pool"] });
const QUESTION_TR = t("tr").hq_ask_source({ options: ["club", "partners", "pool"] });
type Answer = "pool" | "partners" | "club" | "not";
const ANSWERS: Array<{ text: string; question: string; want: Answer[]; why: string }> = [
  { text: "the pool", question: QUESTION, want: ["pool"], why: "the pool, bare" },
  { text: "pool please mate", question: QUESTION, want: ["pool"], why: "the pool, chatty" },
  { text: "havuza", question: QUESTION_TR, want: ["pool"], why: "TR the pool" },
  { text: "partners", question: QUESTION, want: ["partners"], why: "partners, bare" },
  { text: "ask the partner clubs first", question: QUESTION, want: ["partners"], why: "partners, in a sentence" },
  { text: "partner kulüplere", question: QUESTION_TR, want: ["partners"], why: "TR partners" },
  { text: "the group", question: QUESTION, want: ["club"], why: "the players' group" },
  { text: "gruba sor", question: QUESTION_TR, want: ["club"], why: "TR the players' group" },
  { text: "Tom out", question: QUESTION, want: ["not"], why: "a squad change, not an answer" },
  { text: "who's bringing the bibs?", question: QUESTION, want: ["not"], why: "chatter, not an answer" },
];

async function hqCase(i: number, c: (typeof CASES)[number]): Promise<boolean> {
  const id = `s${i}`;
  const tagged = messageMentionsBotExplicitly({ body: c.text });
  const context = organisersContext({ pending: [], recent: [] });
  const r = await routeBatch(model, [{ id, authorName: "Raihan", body: c.text, organisers: { context, senderIsOrganiser: true } }], { floor: true });
  const route = r.routes[0]?.route ?? null;
  let got: Got = route === "none" || route === null || (route === "unsure" && !tagged) ? "quiet" : "other";
  let detail = "";
  if (route === "ask_group" || route === "admin_ops") {
    const ex = await extractForRoute(model, "admin_ops", { id, body: c.text, authorName: "Raihan", tagged, history: [], lastBotPost: null, now: NOW });
    const f = ex.facts.kind === "admin" ? ex.facts : null;
    detail = ` -> ${f?.action ?? ex.facts.kind}${f?.pool ? " pool" : f?.partnerClubs ? ` partners "${f.clubRef ?? ""}"` : f?.sourceUnsaid ? " unsaid" : ""}, toMatchTime ${f?.toMatchTime === true}`;
    const asked = tagged || f?.toMatchTime === true;
    if (!asked) got = "quiet";
    else if (f?.action === "recruit") {
      const d = decideRecruitSource(f, { partners: true, pool: true });
      // 2026-10-28: the places named are a list; one place is this suite's case.
      const one = d.kind === "sources" && d.sources.length === 1 ? d.sources[0] : null;
      got = d.kind === "ask-which" ? "which" : one === "club" ? (route === "ask_group" ? "group" : "other") : (one ?? "other");
    } else got = "other";
  }
  const ok = c.want.includes(got);
  console.log(`${ok ? "PASS" : "FAIL"}  ${JSON.stringify(c.text)}  routed ${route}${detail}  => ${got}   (${c.why}; want ${c.want.join("|")})`);
  return ok;
}

async function answerCase(i: number, c: (typeof ANSWERS)[number]): Promise<boolean> {
  const id = `a${i}`;
  const ex = await extractForRoute(model, "admin_ops", {
    id,
    body: c.text,
    authorName: "Raihan",
    tagged: false,
    history: [{ author: "Raihan", body: "@Match Time we need a player for Thursday" }, { author: "MatchTime", body: c.question }],
    lastBotPost: c.question,
    now: NOW,
  });
  const f = ex.facts.kind === "admin" ? ex.facts : null;
  const picked = sourcesFromAnswer(f);
  const got: Answer = picked && picked.length === 1 ? picked[0] : "not";
  const ok = c.want.includes(got);
  console.log(`${ok ? "PASS" : "FAIL"}  ANSWER ${JSON.stringify(c.text)}  -> ${f?.action ?? ex.facts.kind}${f?.pool ? " pool" : f?.partnerClubs ? " partners" : f?.sourceUnsaid ? " unsaid" : ""}  => ${got}   (${c.why}; want ${c.want.join("|")})`);
  return ok;
}

async function main() {
  if (process.env.MEASURE) {
    await hqCase(0, CASES[6]);
    console.log(`\nMEASURED: ${calls} calls, $${usd.toFixed(5)} (dev key).`);
    return;
  }
  let pass = 0;
  let fail = 0;
  const only = process.env.ONLY;
  for (const [i, c] of CASES.entries()) {
    if (only && !c.text.includes(only)) continue;
    (await hqCase(i, c)) ? pass++ : fail++;
  }
  for (const [i, c] of ANSWERS.entries()) {
    if (only && !c.text.includes(only)) continue;
    (await answerCase(i, c)) ? pass++ : fail++;
  }
  console.log(`\n${pass} passed, ${fail} failed. Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  console.log(`Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(1);
});
