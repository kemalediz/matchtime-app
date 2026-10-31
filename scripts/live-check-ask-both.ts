/**
 * SEVERAL PLACES IN ONE ASK, AND THE QUESTION IN THE PLAYERS' GROUP: THE
 * PAID CHECK (2026-10-28, Friday MT Community: "@Match Time find me players
 * feom partner clubs and player pool" got "No new players to ask for
 * Football 9-a-side right now.").
 *
 * Each case ONCE through the real router and the real admin extractor, the
 * way production reads it:
 *
 *   PG      the players' group (no organisers' header): `admin_ops` reads
 *           the admin extractor; an attendance route's "recruit" side
 *           request is read by `recruit-source.ts` (the admin extractor,
 *           told it was tagged). What the analyze route then does, by
 *           `ask-source-rules.ts`, for a club with partner clubs AND the
 *           pool: the places named, or "which" (MatchTime asks).
 *   HQ      the organisers' group: the router with the organisers' header,
 *           then the admin extractor on ask_group or admin_ops.
 *   ANSWER  the organiser's next message after MatchTime's question (the
 *           players' group's "who shall I ask?", or the "nobody left, want
 *           me to ask ...?" offer), read with the question as MatchTime's
 *           last post, as `ask-source-group.ts` reads it.
 *
 *   npx tsx --env-file=.env scripts/live-check-ask-both.ts
 *   MEASURE=1 ...   one real call pair, its tokens and cost, then stop
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
import { recruitPlacesFromWords } from "../src/lib/recruit-source.ts";
import { t } from "../src/lib/i18n/t.ts";
import type { AdminFacts } from "../src/lib/pipeline/types.ts";

const MAX_USD = Number(process.env.MAX_USD ?? 0.5);
spendDevApiKeyOrExit("the ask-both live check");

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

const NOW = new Date("2026-10-28T11:01:00Z");
const BOTH = { partners: true, pool: true };
/** "partners+pool", "club+partners+pool", "which", "none" (nothing recruited), "quiet". */
type Got = string;

const decided = (f: Pick<AdminFacts, "pool" | "partnerClubs" | "ownClub" | "sourceUnsaid">): Got => {
  const d = decideRecruitSource(f, BOTH);
  return d.kind === "ask-which" ? "which" : d.sources.join("+");
};

const PG: Array<{ text: string; want: Got[]; why: string }> = [
  { text: "@Match Time find me players feom partner clubs and player pool", want: ["partners+pool"], why: "THE LIVE CASE, with its typo" },
  { text: "@Match Time ask our partner clubs and the player pool", want: ["partners+pool"], why: "both, plain" },
  { text: "@Match Time partnerlere ve havuza sor", want: ["partners+pool"], why: "TR both" },
  { text: "@Match Time ask Sutton and the pool for one", want: ["partners+pool"], why: "a partner by name and the pool" },
  { text: "@Match Time find us players everywhere", want: ["club+partners+pool"], why: "everywhere" },
  { text: "@Match Time her yerden oyuncu bul", want: ["club+partners+pool"], why: "TR everywhere" },
  { text: "@Match Time find us a player for Friday", want: ["which"], why: "unclear: MatchTime asks" },
  { text: "@Match Time cumaya bir oyuncu bul", want: ["which"], why: "TR unclear" },
  { text: "@Match Time we need 2 more, can you sort it", want: ["which"], why: "unclear, a shortage" },
  { text: "@Match Time ask the pool for a player", want: ["pool"], why: "one place, unchanged" },
  { text: "@Match Time ask the lads from the last 5 games", want: ["club"], why: "the club's own players, unchanged" },
];

const HQ: Array<{ text: string; want: Got[]; why: string }> = [
  { text: "@Match Time find me players from partner clubs and the player pool", want: ["partners+pool"], why: "HQ both" },
  { text: "@Match Time partnerlere ve havuza sor", want: ["partners+pool"], why: "HQ TR both" },
  { text: "@Match Time find us players everywhere", want: ["club+partners+pool"], why: "HQ everywhere" },
  { text: "@Match Time her yerden oyuncu bul", want: ["club+partners+pool"], why: "HQ TR everywhere" },
];

const Q_GROUP = t("en").hq_ask_source({ options: ["club", "partners", "pool"], inGroup: true });
const Q_GROUP_TR = t("tr").hq_ask_source({ options: ["club", "partners", "pool"], inGroup: true });
const OFFER = t("en").recruit_nobody_left_ask({ matchName: "Football 9-a-side", options: ["partners", "pool"] });
const OFFER_TR = t("tr").recruit_nobody_left_ask({ matchName: "Football 9-a-side", options: ["partners", "pool"] });
const OFFER_POOL = t("en").recruit_nobody_left_ask({ matchName: "Football 9-a-side", options: ["pool"] });
const OFFER_POOL_TR = t("tr").recruit_nobody_left_ask({ matchName: "Football 9-a-side", options: ["pool"] });
const ANSWERS: Array<{ text: string; question: string; want: Got[]; why: string }> = [
  { text: "the pool", question: Q_GROUP, want: ["pool"], why: "group question: the pool" },
  { text: "havuza", question: Q_GROUP_TR, want: ["pool"], why: "group question TR: the pool" },
  { text: "my recent players", question: Q_GROUP, want: ["club"], why: "group question: the club's own" },
  { text: "partners and the pool", question: Q_GROUP, want: ["partners+pool"], why: "group question: two places" },
  { text: "all of them", question: Q_GROUP, want: ["club+partners+pool"], why: "group question: all" },
  { text: "hepsine", question: Q_GROUP_TR, want: ["club+partners+pool"], why: "group question TR: all" },
  { text: "both", question: OFFER, want: ["partners+pool"], why: "nobody-left offer: both" },
  { text: "ikisine de", question: OFFER_TR, want: ["partners+pool"], why: "nobody-left offer TR: both" },
  { text: "the pool please", question: OFFER, want: ["pool"], why: "nobody-left offer: one of the two" },
  { text: "yes", question: OFFER_POOL, want: ["pool"], why: "a yes to a one-place offer" },
  { text: "evet", question: OFFER_POOL_TR, want: ["pool"], why: "TR yes to a one-place offer" },
  { text: "Naim is out", question: Q_GROUP, want: ["not"], why: "a squad change, not an answer" },
  { text: "bibs are in my car", question: OFFER, want: ["not"], why: "chatter, not an answer" },
];

async function pgCase(i: number, c: (typeof PG)[number]): Promise<boolean> {
  const id = `g${i}`;
  const r = await routeBatch(model, [{ id, authorName: "Kemal", body: c.text }], { floor: true });
  const route = r.routes[0]?.route ?? null;
  let got: Got = "none";
  let detail = "";
  if (route === "admin_ops") {
    const ex = await extractForRoute(model, "admin_ops", { id, body: c.text, authorName: "Kemal", tagged: true, history: [], lastBotPost: null, now: NOW });
    const f = ex.facts.kind === "admin" ? ex.facts : null;
    detail = ` -> ${f?.action ?? ex.facts.kind} ${JSON.stringify({ pool: f?.pool, partnerClubs: f?.partnerClubs, ownClub: f?.ownClub, sourceUnsaid: f?.sourceUnsaid, clubRef: f?.clubRef })}`;
    if (f?.action === "recruit") got = decided(f);
  } else if (route === "offer" || route === "other_att" || route === "self_att" || route === "unsure") {
    const ex = await extractForRoute(model, route, { id, body: c.text, authorName: "Kemal", tagged: true, history: [], lastBotPost: null, now: NOW });
    const side = ex.facts.kind === "attendance" ? (ex.facts.sideRequests ?? []) : [];
    detail = ` -> side ${JSON.stringify(side)}`;
    if (side.includes("recruit")) {
      const places = await recruitPlacesFromWords({ id, body: c.text, authorName: "Kemal", now: NOW, model });
      detail += ` places ${JSON.stringify(places)}`;
      // The route: no read is the blast as today; a read with no place is the question.
      got = !places ? "club" : places.sources === null ? "which" : places.sources.join("+");
    }
  }
  const ok = c.want.includes(got);
  console.log(`${ok ? "PASS" : "FAIL"}  PG ${JSON.stringify(c.text)}  routed ${route}${detail}  => ${got}   (${c.why}; want ${c.want.join("|")})`);
  return ok;
}

async function hqCase(i: number, c: (typeof HQ)[number]): Promise<boolean> {
  const id = `h${i}`;
  const tagged = messageMentionsBotExplicitly({ body: c.text });
  const context = organisersContext({ pending: [], recent: [] });
  const r = await routeBatch(model, [{ id, authorName: "Raihan", body: c.text, organisers: { context, senderIsOrganiser: true } }], { floor: true });
  const route = r.routes[0]?.route ?? null;
  let got: Got = "other";
  let detail = "";
  if (route === "ask_group" || route === "admin_ops") {
    const ex = await extractForRoute(model, "admin_ops", { id, body: c.text, authorName: "Raihan", tagged, history: [], lastBotPost: null, now: NOW });
    const f = ex.facts.kind === "admin" ? ex.facts : null;
    detail = ` -> ${f?.action ?? ex.facts.kind} ${JSON.stringify({ pool: f?.pool, partnerClubs: f?.partnerClubs, ownClub: f?.ownClub, sourceUnsaid: f?.sourceUnsaid })}`;
    if (!(tagged || f?.toMatchTime === true)) got = "quiet";
    else if (f?.action === "recruit") got = decided(f);
  }
  const ok = c.want.includes(got);
  console.log(`${ok ? "PASS" : "FAIL"}  HQ ${JSON.stringify(c.text)}  routed ${route}${detail}  => ${got}   (${c.why}; want ${c.want.join("|")})`);
  return ok;
}

async function answerCase(i: number, c: (typeof ANSWERS)[number]): Promise<boolean> {
  const id = `a${i}`;
  // As `ask-source-group.ts` reads it: the question as MatchTime's last post.
  const ex = await extractForRoute(model, "admin_ops", { id, body: c.text, authorName: "Kemal", tagged: false, history: [], lastBotPost: c.question, now: NOW });
  const f = ex.facts.kind === "admin" ? ex.facts : null;
  const got: Got = sourcesFromAnswer(f)?.join("+") ?? "not";
  const ok = c.want.includes(got);
  console.log(`${ok ? "PASS" : "FAIL"}  ANSWER ${JSON.stringify(c.text)} to ${JSON.stringify(c.question.slice(0, 50))}  -> ${f?.action ?? ex.facts.kind}  => ${got}   (${c.why}; want ${c.want.join("|")})`);
  return ok;
}

async function main() {
  if (process.env.MEASURE) {
    await pgCase(0, PG[0]);
    console.log(`\nMEASURED: ${calls} calls, $${usd.toFixed(5)} (dev key).`);
    return;
  }
  let pass = 0;
  let fail = 0;
  const only = process.env.ONLY;
  for (const [i, c] of PG.entries()) if (!only || c.text.includes(only)) (await pgCase(i, c)) ? pass++ : fail++;
  for (const [i, c] of HQ.entries()) if (!only || c.text.includes(only)) (await hqCase(i, c)) ? pass++ : fail++;
  for (const [i, c] of ANSWERS.entries()) if (!only || c.text.includes(only)) (await answerCase(i, c)) ? pass++ : fail++;
  console.log(`\n${pass} passed, ${fail} failed. Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  console.log(`Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(1);
});
