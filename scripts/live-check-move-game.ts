/**
 * MOVING A GAME BY WHATSAPP: THE PAID CHECK (2026-11-10, Kemal: "@Match
 * Time move Monday's game to 8:15", "@Match Time from now on we kick off at
 * 8:15"; every admin feature also works by tagging MatchTime).
 *
 * Each case ONCE through the real router (HQ's organisers' header and
 * context as production renders them, or the players' group) and the real
 * admin extractor, shown the club's games to come exactly as production
 * shows them (`gamesToComeLines`). The extractor is read whatever the route,
 * so a router miss and an extractor miss are told apart. What code then
 * does is the shipped rule (`moveGameWordsOf`, `planMoveGame`): no database.
 *
 *   one       one game moves:      "one:<game id>@<HH:mm or ->/<weekday or ->"
 *   weekly    the weekly game:     "weekly:<activity id>@<HH:mm or ->/<weekday or ->"
 *   which     MatchTime asks which game
 *   not       anything that is not move_game
 *
 * A second part reads the club's OTHER admin requests with the same GAMES TO
 * COME block, so a new line in their context changes none of them.
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-move-game.ts
 *   ONLY=<text> ...   the cases whose text contains it
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). No database,
 * sends nothing. Prints each case, the calls made and the cost.
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { routeBatch } from "../src/lib/pipeline/router.ts";
import { extractForRoute } from "../src/lib/pipeline/extractors.ts";
import { organisersContext } from "../src/lib/admin-group-context.ts";
import { gamesToComeLines, moveGameWordsOf, planMoveGame, type GameToCome, type WeeklyGame } from "../src/lib/game-move-rules.ts";
import { londonDateTimeToUtc } from "../src/lib/london-time.ts";
import type { AdminFacts } from "../src/lib/pipeline/types.ts";

const MAX_USD = Number(process.env.MAX_USD ?? 0.4);
spendDevApiKeyOrExit("the move-a-game live check");

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

// Tuesday 10 November 2026, 10:00 London.
const NOW = londonDateTimeToUtc("2026-11-10", "10:00");
const at = (d: string, t: string) => londonDateTimeToUtc(d, t);
const VETS: WeeklyGame = { id: "vets", name: "Monday Vets" };
const SEVENS: WeeklyGame = { id: "sevens", name: "Thursday 7s" };
const MON = { id: "mon16", date: at("2026-11-16", "20:30"), activityId: "vets", activityName: "Monday Vets" };
const MON2 = { id: "mon23", date: at("2026-11-23", "20:30"), activityId: "vets", activityName: "Monday Vets" };
const THU = { id: "thu19", date: at("2026-11-19", "19:00"), activityId: "sevens", activityName: "Thursday 7s" };
/** One weekly game (the Vets), and a club with two. */
const ONE = { games: [MON, MON2], weekly: [VETS] };
const TWO = { games: [MON, THU, MON2], weekly: [VETS, SEVENS] };
const WHICH_POST = "Which game shall I move to 20:15: Mon 16 Nov 20:30 (Monday Vets) or Thu 19 Nov 19:00 (Thursday 7s)? Tag me again and name the day, for example *@Match Time move Monday's game to 20:15*.";
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function got(f: AdminFacts | null, club: { games: GameToCome[]; weekly: WeeklyGame[] }): string {
  if (f?.action !== "move_game") return `not(${f?.action ?? "none"})`;
  const plan = planMoveGame(moveGameWordsOf(f), club.games, club.weekly);
  const dt = (time?: string | null, day?: number | null) => `${time ?? "-"}/${day === null || day === undefined ? "-" : DAYS[day]}`;
  switch (plan.kind) {
    case "one":
      return `one:${plan.game.id}@${dt(f.newTime ? plan.toTime : null, plan.toDayOfWeek)}`;
    case "every-week":
      return `weekly:${plan.activityId}@${dt(plan.time, plan.dayOfWeek)}`;
    case "which":
    case "which-weekly":
      return "which";
    default:
      return plan.kind;
  }
}

interface Case {
  text: string;
  where: "HQ" | "PG";
  club: { games: GameToCome[]; weekly: WeeklyGame[] };
  want: string;
  why: string;
  /** MatchTime's last line in HQ, shown in the router's recent lines and to the extractor. */
  lastPost?: string;
  /** A routes the router may also give (it then must still read right). */
  route?: string[];
}

const CASES: Case[] = [
  // ── One game ──
  { text: "@Match Time move Monday's game to 8:15", where: "HQ", club: ONE, want: "one:mon16@20:15/-", why: "KEMAL'S CASE (in the prompt)" },
  { text: "@Match Time pazartesi maçını 20:15'e al", where: "HQ", club: ONE, want: "one:mon16@20:15/-", why: "KEMAL'S CASE, TR (in the prompt)" },
  { text: "@Match Time the game on the 23rd kicks off at 7pm instead", where: "HQ", club: ONE, want: "one:mon23@19:00/-", why: "a date, held out" },
  { text: "@Match Time this Monday we start at 8 not half 8", where: "HQ", club: ONE, want: "one:mon16@20:00/-", why: "no am or pm, held out" },
  { text: "@Match Time move Monday's game to Tuesday 9pm", where: "HQ", club: ONE, want: "one:mon16@21:00/tuesday", why: "a new day and time, held out" },
  { text: "@Match Time haftaya pazartesi maçı 21:00'de", where: "HQ", club: ONE, want: "one:mon16@21:00/-", why: "next week's Monday is the 16th from Tuesday the 10th, TR, held out" },
  { text: "@Match Time move Thursday's game to 8pm", where: "HQ", club: TWO, want: "one:thu19@20:00/-", why: "two weekly games, one named, held out" },
  { text: "@Match Time move tonight's game to 9", where: "PG", club: ONE, want: "one:mon16@21:00/-", why: "players' group (code checks the organiser), held out" },
  // ── The weekly game, from now on ──
  { text: "@Match Time from now on we kick off at 8:15", where: "HQ", club: ONE, want: "weekly:vets@20:15/-", why: "KEMAL'S CASE (in the prompt)" },
  { text: "@Match Time artık her hafta 20:15'te başlıyoruz", where: "HQ", club: ONE, want: "weekly:vets@20:15/-", why: "TR every week, held out" },
  { text: "@Match Time we're playing Wednesdays from now on, same time", where: "HQ", club: ONE, want: "weekly:vets@-/wednesday", why: "a new day every week, held out" },
  { text: "@Match Time every week the Thursday game is at 7:30 now", where: "HQ", club: TWO, want: "weekly:sevens@19:30/-", why: "two weekly games, one named, held out" },
  // ── Which game? ──
  { text: "@Match Time move the game to 8pm", where: "HQ", club: TWO, want: "which", why: "two weekly games, none named: ask" },
  { text: "@Match Time Monday's", where: "HQ", club: TWO, lastPost: WHICH_POST, want: "one:mon16@20:15/-", why: "the answer to MatchTime's which-game question", route: ["admin_ops", "unsure"] },
  // ── Not a move ──
  { text: "@Match Time what time is kick off on Monday?", where: "HQ", club: ONE, want: "not", why: "a question", route: ["question", "help", "admin_ops", "unsure"] },
  { text: "shall we kick off at 8 next week lads?", where: "PG", club: ONE, want: "not", why: "to the others, untagged", route: ["none", "question", "admin_ops", "unsure", "offer"] },
  { text: "@Match Time make it 8 aside", where: "HQ", club: ONE, want: "not", why: "a size, not a time (switch_format)", route: ["admin_ops"] },
];

/**
 * THE CLUB'S OTHER ADMIN REQUESTS, now read with GAMES TO COME beside them:
 * each must still come out as before. The full suites of each action are
 * run separately, as shipped; these show the new block changes nothing.
 */
const REGRESSION: Array<{ text: string; want: (f: AdminFacts | null) => boolean; label: string }> = [
  { text: "@Match Time cancel Monday's game", want: (f) => f?.action === "cancel_match" && /monday/i.test(f.matchDay ?? ""), label: "cancel_match Monday" },
  { text: "@Match Time salı maçı olmadı, iptal et", want: (f) => f?.action === "cancel_match" && f.pastGame === true, label: "cancel_match past, TR" },
  { text: "@Match Time it's back on, uncancel Monday", want: (f) => f?.action === "restore_match", label: "restore_match" },
  { text: "@Match Time make it 8 aside on Monday", want: (f) => f?.action === "switch_format" && f.size === 8 && f.aSide === true, label: "switch_format" },
  { text: "@Match Time we play 12 to 16", want: (f) => f?.action === "player_numbers" && f.minPlayers === 12 && f.maxPlayers === 16, label: "player_numbers" },
  { text: "@Match Time turn off quiet hours", want: (f) => f?.action === "quiet_hours" && f.quietOff === true, label: "quiet_hours" },
  { text: "@Match Time no football in December", want: (f) => f?.action === "season_break" && (f.breakMonths ?? []).includes("2026-12"), label: "season_break" },
  { text: "@Match Time ask the pool for a player for Monday", want: (f) => f?.action === "recruit" && f.pool === true, label: "recruit pool" },
  { text: "@Match Time Bilal plays free on Monday, no charge", want: (f) => f?.action === "fee_waiver" && (f.coveredRefs ?? []).includes("Bilal"), label: "fee_waiver" },
  { text: "@Match Time our pitch is Goals Sutton", want: (f) => f?.action === "set_venue" && f.venueName === "Goals Sutton", label: "set_venue" },
  { text: "@Match Time remind me tomorrow at 6 to bring the bibs", want: (f) => f?.action === "reminder" && f.remindAt === "2026-11-11 18:00", label: "reminder" },
];

async function main() {
  let pass = 0, exMiss = 0, routeMiss = 0, regFail = 0;
  const only = process.env.ONLY;
  for (const [i, c] of CASES.entries()) {
    if (only && !c.text.includes(only)) continue;
    const id = `c${i}`;
    const recent = c.lastPost ? [{ fromMatchTime: true, text: c.lastPost }] : [];
    const r = await routeBatch(
      model,
      [{ id, authorName: "Davide", body: c.text, ...(c.where === "HQ" ? { organisers: { context: organisersContext({ pending: [], recent }), senderIsOrganiser: true } } : {}) }],
      { floor: true },
    );
    const route = r.routes[0]?.route ?? null;
    const ex = await extractForRoute(model, "admin_ops", {
      id,
      body: c.text,
      authorName: "Davide",
      tagged: /@match\s*time/i.test(c.text),
      history: c.lastPost ? [{ author: "MatchTime", body: c.lastPost }] : [],
      lastBotPost: c.lastPost ?? null,
      reply: null,
      games: gamesToComeLines(c.club.games),
      now: NOW,
    });
    const g = got(ex.facts.kind === "admin" ? ex.facts : null, c.club);
    const extractorOk = c.want === "not" ? g.startsWith("not") : g === c.want;
    const reached = c.route ? c.route.includes(route ?? "") : route === "admin_ops";
    if (extractorOk && reached) pass++;
    if (!extractorOk) exMiss++;
    if (!reached) routeMiss++;
    console.log(
      `${extractorOk && reached ? "PASS" : "FAIL"}  ${c.where} ${JSON.stringify(c.text)}  routed ${route}  read ${g}   (${c.why}; want ${c.want}${!reached ? "; ROUTER MISS" : ""}${!extractorOk ? "; EXTRACTOR MISS" : ""})`,
    );
  }
  if (!only) {
    console.log("\nThe other admin requests, with GAMES TO COME beside them:");
    for (const [i, c] of REGRESSION.entries()) {
      const ex = await extractForRoute(model, "admin_ops", {
        id: `r${i}`,
        body: c.text,
        authorName: "Davide",
        tagged: true,
        history: [],
        lastBotPost: null,
        reply: null,
        games: gamesToComeLines(ONE.games),
        now: NOW,
      });
      const f = ex.facts.kind === "admin" ? ex.facts : null;
      const ok = c.want(f);
      if (!ok) regFail++;
      console.log(`${ok ? "PASS" : "FAIL"}  ${JSON.stringify(c.text)}  read ${JSON.stringify(f)}   (${c.label})`);
    }
  }
  console.log(`\n${pass} passed; extractor misses ${exMiss}; router misses ${routeMiss}; other admin requests failed ${regFail}. Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(exMiss + routeMiss + regFail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  console.log(`Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(1);
});
