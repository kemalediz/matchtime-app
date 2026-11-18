/**
 * WHAT A MONTH COVERS, BY WHATSAPP: THE PAID CHECK (2026-11-18, PR #611).
 *
 * The admin extractor gained `month_coverage` and its `coverage` field
 * (the whole month, or the games left), placed into the prompt #623
 * rewrote. This reads, ONCE per case, the phrases the PR lists:
 *
 *   A. the action: an add that says which, a change of coverage by name,
 *      EN and TR, two players in one message, an answer to MatchTime's own
 *      "whole month, or just the games left?";
 *   B. what must NOT be it, or must not say "whole": an add that does not
 *      say ("he's paid" alone), a payment said alone, a question, a payment
 *      for several players.
 *
 * The rest of the admin prompt is checked by `live-check-open-squad.ts`
 * (one pass, run beside this).
 *
 * Each case goes through the production path for the organisers' group:
 * the router (`routeBatch`, with the organisers' header and
 * `organisersContext`), then the admin extractor (`extractForRoute`
 * "admin_ops") with what `admin-group-understand.ts` gives it. An add is
 * read by the extractor whatever the route (the monthly reader owns the
 * add; the extractor's coverage rides on it, `month-newcomers.ts`).
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-month-coverage.ts
 *   ONLY=<text> ...   the cases whose text contains it
 *
 * About 16 cases and 30 Haiku calls, a few cents. Stops at MAX_USD = 2.
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). No database,
 * sends nothing.
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { routeBatch } from "../src/lib/pipeline/router.ts";
import { extractForRoute } from "../src/lib/pipeline/extractors.ts";
import { organisersContext } from "../src/lib/admin-group-context.ts";
import { gamesToComeLines, type GameToCome } from "../src/lib/game-move-rules.ts";
import { londonDateTimeToUtc } from "../src/lib/london-time.ts";
import { monthSetupCopy } from "../src/lib/i18n/month-setup.ts";
import type { AdminFacts, Route } from "../src/lib/pipeline/types.ts";

const MAX_USD = 2;
spendDevApiKeyOrExit("the month coverage live check");

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

// Wednesday 18 November 2026, 10:00 London: November under way, 2 games left.
const NOW = londonDateTimeToUtc("2026-11-18", "10:00");
const GAMES: GameToCome[] = [
  { id: "v23", date: londonDateTimeToUtc("2026-11-23", "20:30"), activityId: "vets", activityName: "Football 7-a-side" },
  { id: "v30", date: londonDateTimeToUtc("2026-11-30", "20:30"), activityId: "vets", activityName: "Football 7-a-side" },
];
type HqLine = { fromMatchTime: boolean; text: string };
const HQ: HqLine[] = [
  { fromMatchTime: false, text: "pitch is booked for the rest of November" },
  { fromMatchTime: false, text: "Tom wants in, he's been paying the whole month anyway" },
];
const askEn = (name: string) => monthSetupCopy("en").hq_cover_ask({ name, month: "November", left: 2, whole: 5 });
const askTr = (name: string) => monthSetupCopy("tr").hq_cover_ask({ name, month: "Kasım", left: 2, whole: 5 });

type Check = (f: AdminFacts | null) => boolean;
const lc = (xs: string[] | undefined) => (xs ?? []).map((x) => x.toLowerCase().replace(/^@/, "")).sort().join(",");
const cover = (refs: string, coverage: "whole" | "left" | undefined): Check => (f) =>
  f?.action === "month_coverage" && lc(f.coveredRefs) === refs && f.coverage === coverage;
/** Never "whole" when the words do not say it (MatchTime then asks). */
const NOT_WHOLE: Check = (f) => f?.coverage !== "whole";
const NOT_COVERAGE: Check = (f) => f?.action !== "month_coverage";

interface Case {
  group: "A" | "B";
  text: string;
  /** MatchTime's last post in the organisers' group (a question it asked). */
  question?: string;
  routes: Route[] | "any";
  want: Check;
  expect: string;
}
const OPS: Route[] = ["admin_ops"];

const CASES: Case[] = [
  // ── A. The action ──
  { group: "A", text: "@Match Time add Tom to the November list, he's paid the whole month", routes: "any", want: cover("tom", "whole"), expect: "month_coverage [Tom] whole" },
  { group: "A", text: "@Match Time Tom'u Kasım listesine ekle, ayın tamamını ödedi", routes: "any", want: cover("tom", "whole"), expect: "month_coverage [Tom] whole (TR)" },
  { group: "A", text: "@Match Time add Zara to the November list for the games left", routes: "any", want: cover("zara", "left"), expect: "month_coverage [Zara] left" },
  { group: "A", text: "@Match Time Dan covers the whole month", routes: OPS, want: cover("dan", "whole"), expect: "admin_ops; month_coverage [Dan] whole" },
  { group: "A", text: "@Match Time Dan sadece kalan maçları ödüyor", routes: OPS, want: cover("dan", "left"), expect: "admin_ops; month_coverage [Dan] left (TR)" },
  { group: "A", text: "@Match Time Riley only covers the games left", routes: OPS, want: cover("riley", "left"), expect: "admin_ops; month_coverage [Riley] left (held out)" },
  { group: "A", text: "@Match Time add Tom for the games left, and Ian covers the whole month", routes: "any", want: (f) => f?.action === "month_coverage" && lc(f.coveredRefs) === "ian,tom" && f.coverage === undefined, expect: "month_coverage [Tom, Ian], coverage not said" },
  // [] answers the open question; naming the player asked about ("Ben") is
  // the same row (`applyMonthCoverageWords`: a named player is that player).
  { group: "A", text: "@Match Time whole month", question: askEn("Ben"), routes: "any", want: (f) => cover("", "whole")(f) || cover("ben", "whole")(f), expect: "the answer: month_coverage [] (or [Ben]) whole" },
  { group: "A", text: "@Match Time sadece kalanlar", question: askTr("Ben"), routes: "any", want: cover("", "left"), expect: "the answer: month_coverage [] left (TR)" },
  { group: "A", text: "@Match Time Riley covers the whole month", question: askEn("Ben"), routes: "any", want: cover("riley", "whole"), expect: "names Riley while Ben is asked about: [Riley] whole, never []" },
  // ── B. Not it, or not "whole" ──
  { group: "B", text: "@Match Time add Ben to the November list, he's paid", routes: "any", want: NOT_WHOLE, expect: "not whole (he's paid alone; MatchTime asks)" },
  { group: "B", text: "@Match Time Ben'i Kasım listesine ekle, ödedi", routes: "any", want: NOT_WHOLE, expect: "not whole (TR)" },
  { group: "B", text: "@Match Time add Tom to the November list", routes: "any", want: NOT_WHOLE, expect: "not whole (nothing said)" },
  { group: "B", text: "@Match Time Tom paid for the whole month", routes: "any", want: NOT_COVERAGE, expect: "not month_coverage (a payment said alone)" },
  { group: "B", text: "@Match Time Tom ayın tamamını ödedi", routes: "any", want: NOT_COVERAGE, expect: "not month_coverage (TR)" },
  { group: "B", text: "@Match Time how many games does Dan cover?", routes: "any", want: (f) => f?.action === "other", expect: "other (a question)" },
  { group: "B", text: "@Match Time Amir paid for 4 players", routes: "any", want: (f) => f?.action === "bulk_payment" && f.count === 4, expect: "bulk_payment, 4" },
];

function shown(f: AdminFacts | null): string {
  if (!f) return "no admin facts";
  return JSON.stringify({ action: f.action, coveredRefs: f.coveredRefs, coverage: f.coverage, payerRef: f.payerRef, count: f.count, toMatchTime: f.toMatchTime === true });
}

async function run(c: Case, i: number): Promise<boolean> {
  const id = `mc${i}`;
  const recent: HqLine[] = c.question ? [...HQ, { fromMatchTime: true, text: c.question }] : HQ;
  const r = await routeBatch(
    model,
    [{ id, authorName: "Davide", body: c.text, reply: null, organisers: { context: organisersContext({ pending: [], recent }), senderIsOrganiser: true } }],
    { now: NOW },
  );
  const route = r.routes[0]?.route ?? null;
  const ex = await extractForRoute(model, "admin_ops", {
    id,
    body: c.text,
    authorName: "Davide",
    tagged: true,
    history: recent.map((h) => ({ author: h.fromMatchTime ? "MatchTime" : "Organiser", body: h.text })),
    lastBotPost: c.question ?? null,
    reply: null,
    games: gamesToComeLines(GAMES),
    now: NOW,
  });
  const f = ex.facts.kind === "admin" ? ex.facts : null;
  const routeOk = c.routes === "any" || (route !== null && c.routes.includes(route as Route));
  const factsOk = c.want(f);
  const ok = routeOk && factsOk;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${c.group} ${JSON.stringify(c.text)}${c.question ? " (answering the question)" : ""}\n` +
      `      routed ${route}${routeOk ? "" : "  ROUTER MISS"}\n` +
      `      extractor ${shown(f)}${factsOk ? "" : "  EXTRACTOR MISS"}\n` +
      `      want ${c.expect}`,
  );
  return ok;
}

async function main() {
  const only = process.env.ONLY;
  const cases = CASES.filter((c) => !only || c.text.includes(only));
  let pass = 0;
  for (const [i, c] of cases.entries()) if (await run(c, i)) pass++;
  console.log(`\n${pass}/${cases.length} passed. Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(pass === cases.length ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  console.log(`Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(1);
});
