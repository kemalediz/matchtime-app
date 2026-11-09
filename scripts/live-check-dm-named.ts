/**
 * "@MATCH TIME DM THESE PEOPLE": THE PAID CHECK (2026-11-09).
 *
 * ⚠️  THIS CALLS THE REAL MODEL AND COSTS MONEY. Dev key only.
 *
 * The case (Vets MNF, 2026-11-09): Shane tagged six people, "Any of you
 * boys fancy it?", and the owner wants to answer "@Match Time DM these
 * people", "@Match Time DM the people above", or quote Shane's message and
 * say "@Match Time DM them". MatchTime is to DM the people tagged in that
 * message the club's invite. The model only decides that the people TAGGED
 * are meant (`playersFrom: ["named"]`); code finds who they are from
 * WhatsApp's own mention data (`named-invite-rules.ts`).
 *
 * Each case ONCE through the real router and, when it routes to admin_ops
 * (or an attendance route with a recruit side request, which the analyze
 * route reads with the same admin extractor, `recruit-source.ts`), the real
 * admin extractor, the way production reads it:
 *
 *   QUOTED  a WhatsApp reply to Shane's message (the router and the
 *           extractor are shown it under THEY ARE REPLYING TO)
 *   ABOVE   Shane's message in the same flush as the owner's (the router
 *           sees both lines) and in the extractor's RECENT CHAT
 *   ALONE   the owner's message alone (Shane's was in an earlier flush):
 *           the router sees only it, the extractor sees Shane's in RECENT CHAT
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-dm-named.ts
 *   MEASURE=1 ...   print each call's tokens and cost
 *   ONLY=<text> ... the cases whose text contains it
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). No database,
 * sends nothing. Stops at MAX_USD.
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { routeBatch, type RouterMessage } from "../src/lib/pipeline/router.ts";
import { extractForRoute } from "../src/lib/pipeline/extractors.ts";
import { recruitPlacesFromWords } from "../src/lib/recruit-source.ts";
import type { ContextMessage } from "../src/lib/reply-context.ts";

const MAX_USD = Number(process.env.MAX_USD ?? 0.5);
spendDevApiKeyOrExit("the DM-named live check");

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

const NOW = new Date("2026-11-09T17:30:00Z");
/** Shane's message as the server holds it: the mentions the roster could
 *  name are named, the rest stay raw "@<digits>" (`mention-names.ts`). */
const SHANE = "@Bilal Hussain @447747410069 @Matt Walker @Stuart Belcher @447594772036 @Troy Dyall - Any of you boys fancy it?";
const SHANE_TR = "@Bilal Hussain @447747410069 @Matt Walker @Stuart Belcher - bu akşam gelebilecek var mı?";
const quoted = (text: string): ContextMessage => ({ at: new Date(NOW.getTime() - 4 * 60_000), text, topic: null, match: null, author: { name: "Shane Murphy" } });

type Shape = "quoted" | "above" | "alone";
interface Case {
  text: string;
  shape: Shape;
  /** Shane's message (the tagged one). */
  tagged?: string;
  /** "named": the people tagged; "club": the club's recent players; "not": no recruit. */
  want: Array<"named" | "club" | "not">;
  why: string;
}

const CASES: Case[] = [
  // The new feature.
  { text: "@Match Time DM these people", shape: "quoted", tagged: SHANE, want: ["named"], why: "THE CASE: a reply quoting Shane" },
  { text: "@Match Time DM them", shape: "quoted", tagged: SHANE, want: ["named"], why: "a reply, the shortest form" },
  { text: "@Match Time DM the people above", shape: "above", tagged: SHANE, want: ["named"], why: "the message above, same flush" },
  { text: "@Match Time DM the people above", shape: "alone", tagged: SHANE, want: ["named"], why: "the message above, an earlier flush" },
  { text: "@Match Time can you message these lads and invite them", shape: "quoted", tagged: SHANE, want: ["named"], why: "a reply, held-out wording" },
  { text: "@Match Time bu kişilere özelden yaz", shape: "quoted", tagged: SHANE_TR, want: ["named"], why: "TR, a reply" },
  { text: "@Match Time yukarıda etiketlenenlere mesaj at", shape: "above", tagged: SHANE_TR, want: ["named"], why: "TR, the message above" },
  // What stays as it was.
  { text: "@Match Time message the lads from the last 5 matches and invite them", shape: "alone", want: ["club"], why: "the recent players, unchanged" },
  { text: "@Match Time ask the regulars if they can play", shape: "alone", want: ["club"], why: "the regulars, unchanged" },
  { text: "@Match Time ask the group", shape: "above", tagged: SHANE, want: ["club"], why: "the group, with a tagged message above" },
  { text: "Any of you boys fancy it?", shape: "above", tagged: SHANE, want: ["not"], why: "a member asking the tagged people himself" },
  // Review of #566: a tagged drop that asks for a replacement names a person
  // too, and must stay the ordinary recruit, never "the people tagged".
  { text: "@Match Time @Najib Ahmadi is out, find a replacement", shape: "alone", want: ["club"], why: "a drop and a recruit, a person tagged" },
  { text: "Najib Ahmadi can't make it, @Match Time get someone", shape: "alone", want: ["club"], why: "a drop and a recruit, the bot tagged after" },
  { text: "@Match Time @Najib Ahmadi gelemiyor, yerine birini bul", shape: "alone", want: ["club"], why: "TR, a drop and a recruit" },
  { text: "Najib Ahmadi yok, @Match Time birini bul", shape: "alone", want: ["club"], why: "TR, a drop and a recruit, the bot tagged after" },
];

function routerTurn(c: Case): RouterMessage[] {
  const own: RouterMessage = { id: "m2", authorName: "Kemal", body: c.text, ...(c.shape === "quoted" ? { reply: quoted(c.tagged ?? SHANE) } : {}) };
  return c.shape === "above" ? [{ id: "m1", authorName: "Shane Murphy", body: c.tagged ?? SHANE }, own] : [own];
}

async function runCase(c: Case): Promise<boolean> {
  const r = await routeBatch(model, routerTurn(c), { floor: true });
  const route = r.routes.find((x) => x.messageId === "m2")?.route ?? null;
  const history = c.shape === "quoted" || !c.tagged ? [] : [{ author: "Shane Murphy", body: c.tagged }];
  const msg = { id: "m2", body: c.text, authorName: "Kemal", tagged: true, history, lastBotPost: null, now: NOW, ...(c.shape === "quoted" ? { reply: quoted(c.tagged ?? SHANE) } : {}) };
  let got: "named" | "club" | "not" = "not";
  let detail = "";
  if (route === "admin_ops") {
    const ex = await extractForRoute(model, "admin_ops", msg);
    const f = ex.facts.kind === "admin" ? ex.facts : null;
    detail = ` -> ${f?.action ?? ex.facts.kind} ${JSON.stringify({ namedPeople: f?.namedPeople, ownClub: f?.ownClub, pool: f?.pool, partnerClubs: f?.partnerClubs, sourceUnsaid: f?.sourceUnsaid })}`;
    if (f?.action === "recruit") got = f.namedPeople ? "named" : "club";
  } else if (route === "offer" || route === "other_att" || route === "self_att" || route === "unsure") {
    const ex = await extractForRoute(model, route, msg);
    const side = ex.facts.kind === "attendance" ? (ex.facts.sideRequests ?? []) : [];
    detail = ` -> side ${JSON.stringify(side)}`;
    if (side.includes("recruit")) {
      const places = await recruitPlacesFromWords({ id: "m2", body: c.text, authorName: "Kemal", now: NOW, model, reply: msg.reply ?? null });
      detail += ` places ${JSON.stringify(places)}`;
      got = places?.named ? "named" : "club";
    }
  }
  const ok = c.want.includes(got);
  console.log(`${ok ? "PASS" : "FAIL"}  [${c.shape}] ${JSON.stringify(c.text)}  routed ${route}${detail}  => ${got}   (${c.why}; want ${c.want.join("|")})`);
  return ok;
}

async function main() {
  const only = process.env.ONLY;
  const cases = only ? CASES.filter((c) => c.text.includes(only)) : CASES;
  let pass = 0;
  for (const c of cases) {
    if (await runCase(c).catch((e) => (console.log(`ERROR ${c.text}: ${(e as Error).message}`), false))) pass++;
  }
  console.log(`\n${pass}/${cases.length} passed; calls ${calls}, cost $${usd.toFixed(4)}`);
}

main().catch((e) => {
  console.error(e);
  console.log(`\ncalls ${calls}, cost $${usd.toFixed(4)}`);
  process.exit(1);
});
