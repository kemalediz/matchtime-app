/**
 * "WHO IS THAT?" ABOUT A PLACE: THE PAID CHECK (2026-11-17, Sutton).
 *
 * ⚠️  THIS CALLS THE REAL MODEL AND COSTS MONEY. Dev key only.
 *
 * Two prompts changed for MatchTime's question "Do you mean Yoobie, or is
 * Abu Ayoub a new player?" and its answer:
 *
 *   ROUTER      the MATCHTIME ASKED bullet now covers a place in the squad:
 *               the asker's answer goes where the earlier message went
 *               (other_att), a stats answer still to question.
 *   ATTENDANCE  the extractor is shown the earlier message and says whether
 *               THE MESSAGE answers it (answersClarification), with the
 *               earlier claim and the person named, or newPlayer.
 *
 * Each case ONCE, made-up names only, plus regression cases with no
 * MATCHTIME ASKED line at all.
 *
 *   node --env-file=../../../.env ./node_modules/.bin/tsx scripts/live-check-ask-who-is.ts
 *   MAX_USD=...   stop before spending more (default 0.50)
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). No database,
 * sends nothing.
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { extractForRoute } from "../src/lib/pipeline/extractors.ts";
import { routeBatch } from "../src/lib/pipeline/router.ts";
import type { StatsClarification } from "../src/lib/pipeline/awaiting-answer.ts";
import type { AttendanceFacts } from "../src/lib/pipeline/types.ts";

const MAX_USD = Number(process.env.MAX_USD ?? 0.5);
spendDevApiKeyOrExit("the ask-who-is live check");

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

const NOW = new Date("2026-11-17T13:20:00Z");
const ASKED = "@Match Time Abu Ayoub is IN as a guest";
const STATS_ASKED = "@Match Time Zork's chemistry";
const ORGANISER = "Olly Organiser";
const clar = (body: string, about?: "attendance"): StatsClarification => ({
  id: "am-1",
  orgId: "org-1",
  askerUserId: "u-olly",
  askerName: ORGANISER,
  questionBody: body,
  askedAt: new Date(NOW.getTime() - 3 * 60_000),
  ...(about ? { about } : {}),
});

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, got: unknown) => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(got)}`}`);
};

async function router() {
  const cases: Array<{ name: string; body: string; clar: StatsClarification | null; want: string[] }> = [
    { name: "router: \"new\" after the attendance question", body: "new", clar: clar(ASKED, "attendance"), want: ["other_att"] },
    { name: "router: \"Yoobie\" after the attendance question", body: "Yoobie", clar: clar(ASKED, "attendance"), want: ["other_att"] },
    { name: "router: \"yeni biri\" after the attendance question", body: "yeni biri", clar: clar(ASKED, "attendance"), want: ["other_att"] },
    { name: "router: \"I'm out tonight\" is still the sender's own", body: "I'm out tonight", clar: clar(ASKED, "attendance"), want: ["self_att"] },
    { name: "router (regression): \"Idris\" after a stats question", body: "Idris", clar: clar(STATS_ASKED), want: ["question"] },
    { name: "router (regression): \"Kai out\" with no line", body: "Kai out", clar: null, want: ["other_att"] },
  ];
  for (const c of cases) {
    const res = await routeBatch(model, [{ id: "m1", authorName: ORGANISER, body: c.body }], {
      ...(c.clar ? { clarifications: [c.clar] } : {}),
      now: NOW,
    });
    const route = res.routes[0]?.route;
    check(c.name, c.want.includes(route ?? ""), res.routes[0]);
  }
}

type Want = (f: AttendanceFacts) => boolean;
const other = (f: AttendanceFacts, ref: string) => f.claims.find((c) => c.subject === "other" && c.personRef.trim().toLowerCase() === ref.toLowerCase());

async function extractor() {
  const cases: Array<{ name: string; body: string; clarifying?: string; tagged?: boolean; want: Want }> = [
    {
      name: "extractor: \"new\" answers: Abu Ayoub in, newPlayer",
      body: "new",
      clarifying: ASKED,
      want: (f) => f.answersClarification === true && other(f, "Abu Ayoub")?.polarity === "in" && other(f, "Abu Ayoub")?.newPlayer === true,
    },
    {
      name: "extractor: \"he's a new player\" answers: Abu Ayoub in, newPlayer",
      body: "he's a new player",
      clarifying: ASKED,
      want: (f) => f.answersClarification === true && other(f, "Abu Ayoub")?.newPlayer === true,
    },
    {
      name: "extractor: \"yeni biri\" answers: Abu Ayoub in, newPlayer",
      body: "yeni biri",
      clarifying: ASKED,
      want: (f) => f.answersClarification === true && other(f, "Abu Ayoub")?.newPlayer === true,
    },
    {
      name: "extractor: \"Yoobie\" answers: Yoobie in, not new",
      body: "Yoobie",
      clarifying: ASKED,
      want: (f) => f.answersClarification === true && other(f, "Yoobie")?.polarity === "in" && !other(f, "Yoobie")?.newPlayer,
    },
    {
      name: "extractor: \"I mean Yoobie\" answers: Yoobie in",
      body: "I mean Yoobie",
      clarifying: ASKED,
      want: (f) => f.answersClarification === true && other(f, "Yoobie")?.polarity === "in",
    },
    {
      name: "extractor: \"I'm out tonight\" is not an answer: the sender out",
      body: "I'm out tonight",
      clarifying: ASKED,
      want: (f) => !f.answersClarification && f.claims.some((c) => c.subject === "sender" && c.polarity === "out") && !f.claims.some((c) => c.newPlayer),
    },
    {
      name: "extractor (regression): the original message, no line: Abu Ayoub in, not new",
      body: ASKED,
      tagged: true,
      want: (f) => !f.answersClarification && other(f, "Abu Ayoub")?.polarity === "in" && !other(f, "Abu Ayoub")?.newPlayer,
    },
    {
      name: "extractor (regression): \"Abu Ayoub is in, he's new\" with no line: not an answer",
      body: "Abu Ayoub is in, he's new",
      want: (f) => !f.answersClarification && other(f, "Abu Ayoub")?.polarity === "in" && !other(f, "Abu Ayoub")?.newPlayer,
    },
    {
      name: "extractor (regression): \"I'm in\" with no line",
      body: "I'm in",
      want: (f) => !f.answersClarification && f.claims.length === 1 && f.claims[0].subject === "sender" && f.claims[0].polarity === "in",
    },
  ];
  for (const c of cases) {
    const res = await extractForRoute(model, "other_att", {
      id: "m1",
      body: c.body,
      authorName: ORGANISER,
      tagged: c.tagged ?? false,
      history: [],
      lastBotPost: null,
      ...(c.clarifying ? { clarifying: c.clarifying } : {}),
      now: NOW,
    });
    const f = res.facts;
    check(c.name, f.kind === "attendance" && c.want(f), f);
  }
}

void (async () => {
  await router();
  await extractor();
  console.log(`\n${pass} passed, ${fail} failed; ${calls} model calls, $${usd.toFixed(4)}`);
  process.exit(fail > 0 ? 1 : 0);
})();
