/**
 * SEVERAL ADMIN ACTIONS IN ONE MESSAGE: THE PAID CHECK (Sutton FC,
 * 2026-11-23 14:44).
 *
 * "@Match Time switch to 5aside, then invite local player pool for the
 * remaining slots" came back as ONE action (switch_format): the admin
 * prompt said "THE ACTION, exactly one." The prompt was rewritten whole so
 * the extractor lists every action, in the order asked (`actions`).
 *
 * This reads, ONCE per case:
 *   A. the incident's own words (players' group and admin group), and the
 *      same shape in Turkish and in held-out wordings: every action, in
 *      order;
 *   B. a part MatchTime has no action for: the action, and "other" or
 *      nothing for the rest, never a guessed action;
 *   C. what must stay ONE action: the Vets' four-part message (who plays and
 *      the teams are other owners'), a question beside an action, and one
 *      request from two places.
 *
 * Each case goes through the production path: the router (`routeBatch`)
 * and then the admin extractor (`extractForRoute` "admin_ops") with the
 * inputs `admin-ops-engine-batch.ts` and `admin-group-understand.ts` give
 * it. The extractor is read whatever the route, so a router miss and an
 * extractor miss are told apart.
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-several-admin-actions.ts
 *   ONLY=<text> ...   the cases whose text contains it
 *
 * About 26 model calls (a router and an extractor call per case), a few
 * cents on the dev key: Haiku 5.5 at $0.10 and $0.50 per million tokens.
 * Stops at MAX_USD (default $0.50).
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). No database,
 * sends nothing. Prints each case PASS or FAIL with what came back, then
 * the totals: model calls and dollars.
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { routeBatch } from "../src/lib/pipeline/router.ts";
import { extractForRoute } from "../src/lib/pipeline/extractors.ts";
import { organisersContext } from "../src/lib/admin-group-context.ts";
import { gamesToComeLines, type GameToCome } from "../src/lib/game-move-rules.ts";
import { londonDateTimeToUtc } from "../src/lib/london-time.ts";
import { perSideOf } from "../src/lib/flex-format-rules.ts";
import { t } from "../src/lib/i18n/t.ts";
import type { AdminFacts, Route } from "../src/lib/pipeline/types.ts";

const MAX_USD = Number(process.env.MAX_USD ?? 0.5);
spendDevApiKeyOrExit("the several admin actions live check");

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

// Monday 23 November 2026, 14:44 London: the incident's minute.
const NOW = londonDateTimeToUtc("2026-11-23", "14:44");
const at = (d: string, time: string) => londonDateTimeToUtc(d, time);
const en = t("en");
const tr = t("tr");

type Hist = { author: string | null; body: string };
interface Club {
  label: string;
  organiser: string;
  games: GameToCome[];
  pg: Hist[];
  hq: Array<{ fromMatchTime: boolean; text: string }>;
}

const SUTTON: Club = {
  label: "Sutton FC",
  organiser: "Kemal",
  games: [
    { id: "sut24", date: at("2026-11-24", "21:00"), activityId: "sutton", activityName: "Tuesday Football 7-a-side" },
    { id: "sut01", date: at("2026-12-01", "21:00"), activityId: "sutton", activityName: "Tuesday Football 7-a-side" },
  ],
  pg: [
    { author: "MatchTime", body: en.squad_status_lead({ withBench: false, confirmed: 7, maxPlayers: 14, need: 7, matchLabel: "Tue 24 Nov at 21:00" }) },
    { author: "Faris", body: "in" },
    { author: "Adam", body: "only 7 of us this week?" },
  ],
  hq: [{ fromMatchTime: false, text: "numbers are low for Tuesday" }],
};
const FNF: Club = {
  label: "FNF",
  organiser: "Raihan",
  games: [
    { id: "fnf27", date: at("2026-11-27", "21:00"), activityId: "fnf", activityName: "Friday Night Football 9-a-side" },
    { id: "fnf04", date: at("2026-12-04", "21:00"), activityId: "fnf", activityName: "Friday Night Football 9-a-side" },
  ],
  pg: [
    { author: "MatchTime", body: en.squad_status_lead({ withBench: true, confirmed: 18, maxPlayers: 18, need: 0, matchLabel: "Fri 27 Nov at 21:00" }) },
    { author: "Naim", body: "pitch is waterlogged apparently" },
  ],
  hq: [{ fromMatchTime: false, text: "Goals say the pitch is flooded on Friday" }],
};
const ERDAL: Club = {
  label: "Turkish club",
  organiser: "Erdal",
  games: [
    { id: "erd24", date: at("2026-11-24", "21:00"), activityId: "erdal", activityName: "Salı Futbol 7'ye 7" },
    { id: "erd01", date: at("2026-12-01", "21:00"), activityId: "erdal", activityName: "Salı Futbol 7'ye 7" },
  ],
  pg: [
    { author: "MatchTime", body: tr.squad_status_lead({ withBench: false, confirmed: 7, maxPlayers: 14, need: 7, matchLabel: "24 Kasım Salı 21:00" }) },
    { author: "Mehmet", body: "varım" },
  ],
  hq: [{ fromMatchTime: false, text: "salı sayı az" }],
};
/** FNF's organisers, short of a player for Friday. */
const FEE: Club = { ...FNF, label: "FNF, one short", hq: [{ fromMatchTime: false, text: "anyone free Friday? we're one short" }] };
const VETS: Club = {
  label: "Vets",
  organiser: "Davide",
  games: [
    { id: "vets23", date: at("2026-11-23", "20:30"), activityId: "vets", activityName: "Football 8-a-side" },
    { id: "vets30", date: at("2026-11-30", "20:30"), activityId: "vets", activityName: "Football 8-a-side" },
  ],
  pg: [
    { author: "MatchTime", body: en.squad_status_lead({ withBench: true, confirmed: 14, maxPlayers: 16, need: 2, matchLabel: "Mon 23 Nov at 20:30" }) },
    { author: "Luca", body: "might be late tonight" },
  ],
  hq: [],
};

// ── What a case wants of the WHOLE list ───────────────────────────────

const listOf = (f: AdminFacts | null): AdminFacts[] => (f ? [f, ...(f.then ?? [])] : []);
type Step = (a: AdminFacts) => boolean;
const is = (action: AdminFacts["action"], more: Step = () => true): Step => (a) => a.action === action && more(a);
const side = (n: number): Step => is("switch_format", (a) => perSideOf(a) === n);
const POOL: Step = is("recruit", (a) => a.pool === true && a.partnerClubs !== true);
const OTHER: Step = is("other");
/** Exactly these actions, in this order. */
const exactly = (...steps: Step[]) => (f: AdminFacts | null) => {
  const l = listOf(f);
  return l.length === steps.length && steps.every((s, i) => s(l[i]));
};
/** This action first, then nothing or "other" only (never a guessed action). */
const thenNothingElse = (first: Step) => (f: AdminFacts | null) => {
  const l = listOf(f);
  return l.length >= 1 && first(l[0]) && l.slice(1).every(OTHER);
};

function shown(f: AdminFacts | null): string {
  if (!f) return "no admin facts";
  return listOf(f)
    .map((a) => {
      const keep: Record<string, unknown> = { action: a.action };
      for (const k of ["words", "size", "aSide", "matchDay", "pool", "ownClub", "partnerClubs", "clubRef", "quietOff", "game", "newDay", "newTime", "remindAt", "note", "breakMonths"] as const) {
        const v = (a as unknown as Record<string, unknown>)[k];
        if (v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0)) keep[k] = v;
      }
      return JSON.stringify(keep);
    })
    .join(" ; then ") + (f.toMatchTime ? "  (toMatchTime)" : "  (NOT toMatchTime)");
}

// ── The cases ─────────────────────────────────────────────────────────

type Where = "PG" | "HQ";
interface Case {
  group: "A" | "B" | "C" | "D";
  /** D only: the reading need not be spoken to MatchTime. */
  anyTo?: boolean;
  club: Club;
  where: Where;
  text: string;
  routes: Route[] | "any";
  want: (f: AdminFacts | null) => boolean;
  expect: string;
  why: string;
}
const OPS: Route[] = ["admin_ops"];

const CASES: Case[] = [
  // ── A. Every action, in order ──
  { group: "A", club: SUTTON, where: "PG", text: "@Match Time switch to 5aside, then invite local player pool for the remaining slots", routes: OPS, want: exactly(side(5), POOL), expect: "switch_format 5; then recruit pool", why: "THE INCIDENT, word for word (held out)" },
  { group: "A", club: SUTTON, where: "HQ", text: "@Match Time switch to 5aside, then invite local player pool for the remaining slots", routes: "any", want: exactly(side(5), POOL), expect: "switch_format 5; then recruit pool", why: "the incident's words, the admin group" },
  { group: "A", club: ERDAL, where: "PG", text: "@Match Time 5'e 5 yap, sonra kalan yerler için yakındaki havuzdan oyuncu çağır", routes: OPS, want: exactly(side(5), POOL), expect: "switch_format 5; then recruit pool", why: "the incident, TR (held out)" },
  { group: "A", club: SUTTON, where: "PG", text: "@Match Time make it 6 a side and turn off quiet hours", routes: OPS, want: exactly(side(6), is("quiet_hours", (a) => a.quietOff === true)), expect: "switch_format 6; then quiet_hours off", why: "two settings (held out)" },
  { group: "A", club: ERDAL, where: "PG", text: "@Match Time 6'ya 6 yap ve sessiz saatleri kapat", routes: OPS, want: exactly(side(6), is("quiet_hours", (a) => a.quietOff === true)), expect: "switch_format 6; then quiet_hours off", why: "two settings, TR (held out)" },
  { group: "A", club: SUTTON, where: "PG", text: "@Match Time first move Tuesday's game to 9:30, then ask the pool for 2 more", routes: OPS, want: exactly(is("move_game", (a) => a.game === 1 && a.newTime === "21:30"), POOL), expect: "move_game game 1 21:30; then recruit pool", why: "a move, then the pool (held out)" },

  // ── B. A part MatchTime has no action for ──
  { group: "B", club: FNF, where: "PG", text: "@Match Time cancel Friday and tell the bench", routes: OPS, want: thenNothingElse(is("cancel_match")), expect: "cancel_match; then other or nothing", why: "the brief's example (held out)" },
  { group: "B", club: ERDAL, where: "PG", text: "@Match Time salı maçını iptal et ve yedeklere haber ver", routes: OPS, want: thenNothingElse(is("cancel_match")), expect: "cancel_match; then other or nothing", why: "the same, TR (held out)" },
  { group: "B", club: SUTTON, where: "PG", text: "@Match Time make it 5 a side and book us a bigger pitch", routes: OPS, want: exactly(side(5), OTHER), expect: "switch_format 5; then other", why: "MatchTime cannot book a pitch (held out)" },

  // ── C. Must stay ONE action ──
  { group: "C", club: VETS, where: "PG", text: "@Match Time switch to 7aside, take Luca to bench, @Zak is IN and then make the teams", routes: "any", want: exactly(side(7)), expect: "switch_format 7 only", why: "the Vets' message: who plays and the teams are other owners'" },
  { group: "C", club: SUTTON, where: "PG", text: "@Match Time go 7 a side tonight, how many are we now?", routes: "any", want: exactly(side(7)), expect: "switch_format 7 only", why: "a question beside an action (held out)" },
  { group: "C", club: SUTTON, where: "PG", text: "@Match Time ask the lads and the player pool for Tuesday", routes: OPS, want: exactly(is("recruit", (a) => a.ownClub === true && a.pool === true)), expect: "ONE recruit, club and pool", why: "one request, two places (held out)" },
  { group: "C", club: SUTTON, where: "PG", text: "@Match Time make it 5 aside", routes: OPS, want: exactly(side(5)), expect: "switch_format 5 only", why: "one action" },

  // ── D. A free place, or free to play (review of #629, item 9) ──
  { group: "D", club: FEE, where: "HQ", text: "Tom's free Friday", routes: "any", want: exactly(is("other")), anyTo: true, expect: "other (free to play)", why: "an organiser's availability, after \"anyone free Friday?\"" },
  { group: "D", club: FEE, where: "HQ", text: "Tom's free Friday, he washed the bibs", routes: "any", want: exactly(is("fee_waiver", (a) => (a.coveredRefs ?? []).join() === "Tom")), expect: "fee_waiver Tom", why: "its free-place counterpart" },
];

// ── Running a case through the production path ───────────────────────

async function run(c: Case, i: number): Promise<boolean> {
  const id = `sa${i}`;
  const message =
    c.where === "HQ"
      ? { id, authorName: c.club.organiser, body: c.text, reply: null, organisers: { context: organisersContext({ pending: [], recent: c.club.hq }), senderIsOrganiser: true } }
      : { id, authorName: c.club.organiser, body: c.text, reply: null };
  const r = await routeBatch(model, [message], { now: NOW });
  const routed = r.routes[0];
  const route = routed?.route ?? null;

  const history: Hist[] = c.where === "HQ" ? c.club.hq.map((h) => ({ author: h.fromMatchTime ? "MatchTime" : "Organiser", body: h.text })) : c.club.pg;
  const lastBotPost = [...history].reverse().find((h) => (h.author ?? "").toLowerCase() === "matchtime")?.body ?? null;
  const ex = await extractForRoute(model, "admin_ops", {
    id,
    body: c.text,
    authorName: c.club.organiser,
    tagged: true,
    history,
    lastBotPost,
    reply: null,
    games: gamesToComeLines(c.club.games),
    now: NOW,
  });
  const f = ex.facts.kind === "admin" ? ex.facts : null;

  const routeOk = c.routes === "any" || (route !== null && c.routes.includes(route as Route));
  const factsOk = c.want(f) && (c.anyTo === true || f?.toMatchTime === true);
  const ok = routeOk && factsOk;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${c.group} ${c.where} [${c.club.label}] ${JSON.stringify(c.text)}\n` +
      `      routed ${route}${routed?.alsoRoutes?.length ? ` also ${routed.alsoRoutes.join(",")}` : ""}${routeOk ? "" : `  ROUTER MISS (want ${(c.routes as Route[]).join("|")})`}\n` +
      `      extractor ${shown(f)}${factsOk ? "" : "  EXTRACTOR MISS"}\n` +
      `      want ${c.expect}   (${c.why})`,
  );
  return ok;
}

async function main() {
  const only = process.env.ONLY;
  const cases = CASES.filter((c) => !only || c.text.includes(only));
  const totals = { A: [0, 0], B: [0, 0], C: [0, 0], D: [0, 0] } as Record<Case["group"], [number, number]>;
  console.log(`\n== Several admin actions in one message: ${cases.length} cases, each once ==\n`);
  for (const [i, c] of cases.entries()) {
    const ok = await run(c, i);
    totals[c.group][ok ? 0 : 1]++;
  }
  const pass = totals.A[0] + totals.B[0] + totals.C[0] + totals.D[0];
  const fail = totals.A[1] + totals.B[1] + totals.C[1] + totals.D[1];
  console.log(
    `\nA. every action, in order: ${totals.A[0]} passed, ${totals.A[1]} failed` +
      `\nB. a part with no action: ${totals.B[0]} passed, ${totals.B[1]} failed` +
      `\nC. stays one action: ${totals.C[0]} passed, ${totals.C[1]} failed` +
      `\nD. a free place, or free to play: ${totals.D[0]} passed, ${totals.D[1]} failed` +
      `\n\n${pass} passed, ${fail} failed. Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`,
  );
}

main().catch((err) => {
  console.error(err);
  console.log(`Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(1);
});
