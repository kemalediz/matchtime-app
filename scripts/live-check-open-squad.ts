/**
 * NO SQUAD LIMIT BY WHATSAPP, AND THE REWRITTEN ADMIN PROMPT: THE PAID CHECK
 * (2026-11-17, PR #623, the Vets: "the main squad will always expand or
 * shrink without any limits and a bench").
 *
 * The admin extractor's prompt was rewritten as a whole for `open_squad`
 * (review item 4). This reads, ONCE per case, every phrase the PR lists:
 *
 *   A. the new action, on and off, EN and TR;
 *   B. what must NOT switch it: one game's wording, the most and the fewest,
 *      "back to full teams", a question, chat;
 *   C. what the club's other admin requests already do, for the Vets,
 *      Sutton FC, FNF and a Turkish club, since every one of them now sits
 *      in a regrouped prompt.
 *
 * Each case goes through the exact production path: the router
 * (`routeBatch`, with the players' group turn, or the organisers' header and
 * `organisersContext` lines for the admin group, and the quoted message as
 * `quoteFromPi` renders it), then the admin extractor (`extractForRoute`
 * "admin_ops") with the inputs `admin-ops-engine-batch.ts` (players' group)
 * and `admin-group-understand.ts` (admin group) give it: the chat history,
 * MatchTime's last post, the quote, the GAMES TO COME lines
 * (`gamesToComeLines`) and the time. An answer to MatchTime's "where shall I
 * look?" question goes straight to the extractor, as `ask-source-group.ts`
 * reads it. The extractor is read whatever the route, so a router miss and
 * an extractor miss are told apart.
 *
 * THE SETTING IS NOT SHOWN TO THE MODEL. Production gives neither the router
 * nor the extractor the club's openSquad; the model sees it only through
 * what MatchTime itself posted. So a Vets case "with the setting on" has the
 * open squad's week list in its history (no places line, "Anyone else, say
 * IN to play"), and "off" has the 7-a-side list with its places line, both
 * built from the shipped strings.
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-open-squad.ts
 *   ONLY=<text> ...   the cases whose text contains it
 *
 * Estimated: about 150 model calls (a router and an extractor call per
 * case, one for each answer case), roughly $1.20 to $1.50 on the dev key,
 * from the per-call cost of the other admin checks' caps; not measured
 * here. Stops at MAX_USD = 2.
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
import { quoteFromPi } from "../src/lib/reply-context.ts";
import { gamesToComeLines, type GameToCome } from "../src/lib/game-move-rules.ts";
import { londonDateTimeToUtc } from "../src/lib/london-time.ts";
import { perSideOf, playerRangeWordsOf } from "../src/lib/flex-format-rules.ts";
import { sourcesFromAnswer } from "../src/lib/ask-source-rules.ts";
import { poolAskRefusalText } from "../src/lib/pool/offer-copy.ts";
import { t } from "../src/lib/i18n/t.ts";
import type { AdminFacts, Route } from "../src/lib/pipeline/types.ts";

const MAX_USD = 2;
spendDevApiKeyOrExit("the open squad live check");

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

// Tuesday 17 November 2026, 10:00 London.
const NOW = londonDateTimeToUtc("2026-11-17", "10:00");
const at = (d: string, time: string) => londonDateTimeToUtc(d, time);

// ── The clubs, as production shows them to the model ─────────────────

type Hist = { author: string | null; body: string };
interface Club {
  label: string;
  /** The organiser who writes the cases. */
  organiser: string;
  /** The club's games to come, as `loadGamesToCome` returns them. */
  games: GameToCome[];
  /** The players' group's recent chat (MatchTime's posts as "MatchTime"). */
  pg: Hist[];
  /** The organisers' group's recent chat. */
  hq: Array<{ fromMatchTime: boolean; text: string }>;
  /** Partner clubs, shown to the router for an organiser in the players' group. */
  partners?: string[];
}

const en = t("en");
const tr = t("tr");

/** The Vets' week list, from the shipped strings, as `buildWeekListPost` lays it out. */
function vetsList(openSquad: boolean): string {
  const title = openSquad ? "Football" : "Football 7-a-side";
  return [
    `📋 *${title}, Mon 23 Nov at 20:30*`,
    "",
    en.mwk_list_squad({ month: "November" }),
    "1. Alex\n2. Chris\n3. Dave\n4. Bilal\n5. Rob\n6. Gary\n7. Steve\n8. Paul\n9. Mark\n10. Neil",
    "",
    en.mwk_list_payg,
    "11. Tom\n12. Zeeshan",
    openSquad ? en.mwk_list_open_squad({ price: "£8", short: 0 }) : en.mwk_list_open({ open: 2, price: "£8" }),
    "",
    openSquad ? en.mwk_list_all_in_open : en.mwk_list_all_in,
  ].join("\n");
}
const VETS_GAMES: GameToCome[] = [
  { id: "vets23", date: at("2026-11-23", "20:30"), activityId: "vets", activityName: "Football 7-a-side" },
  { id: "vets30", date: at("2026-11-30", "20:30"), activityId: "vets", activityName: "Football 7-a-side" },
];
const vets = (openSquad: boolean): Club => ({
  label: openSquad ? "Vets, no squad limit ON" : "Vets, no squad limit OFF",
  organiser: "Davide",
  games: VETS_GAMES,
  pg: [
    { author: "MatchTime", body: vetsList(openSquad) },
    { author: "Tom", body: "In" },
    { author: "Gary", body: "out this week lads, sorry, back next Monday" },
    { author: "Zeeshan", body: "in for Monday" },
  ],
  hq: [
    { fromMatchTime: false, text: "pitch is booked for the rest of November" },
    { fromMatchTime: false, text: "good, we've had 15 or 16 most weeks" },
  ],
});
const VETS_ON = vets(true);
const VETS_OFF = vets(false);

const SUTTON: Club = {
  label: "Sutton FC",
  organiser: "Kemal",
  games: [
    { id: "sut24", date: at("2026-11-24", "21:00"), activityId: "sutton", activityName: "Tuesday Football" },
    { id: "sut01", date: at("2026-12-01", "21:00"), activityId: "sutton", activityName: "Tuesday Football" },
  ],
  pg: [
    { author: "MatchTime", body: en.squad_status_lead({ withBench: false, confirmed: 8, maxPlayers: 10, need: 2, matchLabel: "Tue 24 Nov at 21:00" }) },
    { author: "Faris", body: "in" },
    { author: "Adam", body: "in, Amir is sorting my money" },
  ],
  hq: [
    { fromMatchTime: false, text: "Amir collected cash last week" },
    { fromMatchTime: false, text: "bibs are still at Bilal's" },
  ],
};

const FNF_PARTNERS = ["Sutton FC", "Friday MT Community"];
const FNF: Club = {
  label: "FNF",
  organiser: "Raihan",
  games: [
    { id: "fnf20", date: at("2026-11-20", "21:00"), activityId: "fnf", activityName: "Friday Night Football 9-a-side" },
    { id: "fnf27", date: at("2026-11-27", "21:00"), activityId: "fnf", activityName: "Friday Night Football 9-a-side" },
  ],
  pg: [
    { author: "MatchTime", body: en.squad_status_lead({ withBench: false, confirmed: 15, maxPlayers: 18, need: 3, matchLabel: "Fri 20 Nov at 21:00" }) },
    { author: "Hamzah", body: "in" },
    { author: "Naim", body: "can't make it Friday" },
  ],
  hq: [
    { fromMatchTime: false, text: "we're 3 short for Friday" },
    { fromMatchTime: false, text: "Sutton had spare players last time" },
  ],
  partners: FNF_PARTNERS,
};

const erdal = (openSquad: boolean): Club => ({
  label: openSquad ? "Turkish club, no squad limit ON" : "Turkish club, no squad limit OFF",
  organiser: "Erdal",
  games: [
    { id: "erd23", date: at("2026-11-23", "21:00"), activityId: "erdal", activityName: openSquad ? "Pazartesi Futbol" : "Pazartesi Futbol 7'ye 7" },
    { id: "erd30", date: at("2026-11-30", "21:00"), activityId: "erdal", activityName: openSquad ? "Pazartesi Futbol" : "Pazartesi Futbol 7'ye 7" },
  ],
  pg: [
    { author: "MatchTime", body: tr.squad_status_lead({ withBench: false, confirmed: 11, maxPlayers: 14, need: 3, matchLabel: "23 Kasım Pazartesi 21:00", openSquad }) },
    { author: "Mehmet", body: "varım" },
    { author: "Can", body: "bu hafta yokum abi" },
  ],
  hq: [{ fromMatchTime: false, text: "saha kasım sonuna kadar ayarlandı" }],
});
const ERDAL_ON = erdal(true);
const ERDAL_OFF = erdal(false);

// MatchTime's posts that a case quotes or answers.
const SUGGESTION = "We've got 16 for Monday, 2 on the bench. Shall we go 8-a-side? Davide, reply *yes* to this message and I'll switch it.";
const Q_GROUP = en.hq_ask_source({ options: ["club", "partners", "pool"], inGroup: true });
const OFFER = en.recruit_nobody_left_ask({ matchName: "Friday Night Football 9-a-side", options: ["partners", "pool"] });
const REFUSED = poolAskRefusalText("en", "no-venue", 1);
const TAGS_PEOPLE = "@Ali @Sam @Tom can any of you play Monday? we need a couple";

// ── What a case wants of the facts ────────────────────────────────────

type Check = (f: AdminFacts | null) => boolean;
const action = (a: AdminFacts["action"], more: Check = () => true): Check => (f) => f?.action === a && more(f);
const OPEN_ON = action("open_squad", (f) => f?.openSquadOff !== true);
const OPEN_OFF = action("open_squad", (f) => f?.openSquadOff === true);
/** Not switching the setting, and the action it should be. */
const notToggle = (inner: Check): Check => (f) => f?.action !== "open_squad" && inner(f);
const OTHER: Check = (f) => f?.action === "other";
/** Talk among people: other, or anything not meant for MatchTime. */
const CHAT: Check = (f) => f?.action === "other" || f?.toMatchTime === false;
const range = (want: { min?: number; max?: number; full?: boolean; day?: RegExp }): Check =>
  action("player_numbers", (f) => {
    const w = playerRangeWordsOf(f!);
    return (
      (w.minPlayers ?? undefined) === want.min &&
      (w.maxPlayers ?? undefined) === want.max &&
      (w.fullTeams === true) === (want.full === true) &&
      (!want.day || want.day.test(w.matchDay ?? ""))
    );
  });
const side = (n: number): Check => action("switch_format", (f) => perSideOf(f!) === n);
const lc = (xs: string[] | undefined) => (xs ?? []).map((x) => x.toLowerCase()).sort().join(",");
const recruit = (more: Check): Check => action("recruit", more);
const partner = (club: string, pool = false): Check =>
  recruit((f) => f?.partnerClubs === true && (f.clubRef ?? "").toLowerCase().includes(club.toLowerCase()) && (f.pool === true) === pool);
const answer = (want: string): Check => (f) => (sourcesFromAnswer(f)?.join("+") ?? "not") === want;

/** What came back, printed beside the verdict. */
function shown(f: AdminFacts | null): string {
  if (!f) return "no admin facts";
  const keep: Record<string, unknown> = { action: f.action, toMatchTime: f.toMatchTime };
  for (const k of [
    "openSquadOff", "minPlayers", "maxPlayers", "fullTeams", "size", "aSide", "matchDay", "pastGame", "game", "newDay", "newTime", "everyWeek",
    "coveredRefs", "payerRef", "count", "undo", "phrase", "remindAt", "note", "partnerClubs", "clubRef", "pool", "ownClub", "sourceUnsaid",
    "namedPeople", "breakMonths", "playMonths", "venueName", "venueChoice", "quietOff", "quietFrom", "quietTo",
  ] as const) {
    const v = (f as unknown as Record<string, unknown>)[k];
    if (v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0)) keep[k] = v;
  }
  return JSON.stringify(keep);
}

// ── The cases ─────────────────────────────────────────────────────────

const OPS: Route[] = ["admin_ops"];
const HQ_ASK: Route[] = ["ask_group", "admin_ops"];
type Where = "PG" | "HQ" | "ANSWER";
interface Case {
  group: "A" | "B" | "C";
  club: Club;
  where: Where;
  text: string;
  /** A message this one is a WhatsApp reply to. */
  quoted?: { text: string; fromMatchTime: boolean };
  /** For ANSWER: MatchTime's question, as its last post. */
  question?: string;
  routes: Route[] | "any";
  want: Check;
  expect: string;
  why: string;
}

const CASES: Case[] = [
  // ── A. The new action ──
  { group: "A", club: VETS_OFF, where: "PG", text: "@Match Time no squad limit from now on, everyone who says in plays", routes: OPS, want: OPEN_ON, expect: "open_squad", why: "on (in the prompt)" },
  { group: "A", club: ERDAL_OFF, where: "PG", text: "@Match Time bundan sonra kadro sınırı yok, varım diyen herkes oynar", routes: OPS, want: OPEN_ON, expect: "open_squad", why: "on, TR (in the prompt)" },
  { group: "A", club: VETS_OFF, where: "PG", text: "@Match Time remove the bench for this group, the pitch is big enough for everyone", routes: OPS, want: OPEN_ON, expect: "open_squad", why: "on, the bench named (in the prompt)" },
  { group: "A", club: ERDAL_OFF, where: "PG", text: "@Match Time bu grupta yedek olmasın, saha herkese yeter", routes: OPS, want: OPEN_ON, expect: "open_squad", why: "on, TR (in the prompt)" },
  {
    group: "A", club: VETS_OFF, where: "PG",
    text: "@Match Time the main squad will always expand or shrink without any limits and a bench, as the pitch is quite big to allow anyone",
    routes: OPS, want: OPEN_ON, expect: "open_squad", why: "THE OWNER'S OWN SENTENCE, tagged (held out)",
  },
  { group: "A", club: VETS_OFF, where: "HQ", text: "@Match Time no squad limit from now on, everyone who says in plays", routes: OPS, want: OPEN_ON, expect: "open_squad", why: "on, the admin group" },
  { group: "A", club: VETS_ON, where: "PG", text: "@Match Time put the limit and the bench back", routes: OPS, want: OPEN_OFF, expect: "open_squad, openSquadOff", why: "off (in the prompt)" },
  { group: "A", club: ERDAL_ON, where: "PG", text: "@Match Time kadro sınırını ve yedekleri geri getir", routes: OPS, want: OPEN_OFF, expect: "open_squad, openSquadOff", why: "off, TR (in the prompt)" },
  { group: "A", club: VETS_ON, where: "PG", text: "@Match Time bring the bench back", routes: OPS, want: OPEN_OFF, expect: "open_squad, openSquadOff", why: "off, the bench only (held out)" },
  { group: "A", club: ERDAL_ON, where: "PG", text: "@Match Time yedekleri geri getir", routes: OPS, want: OPEN_OFF, expect: "open_squad, openSquadOff", why: "off, TR, the bench only (held out)" },
  { group: "A", club: VETS_ON, where: "HQ", text: "@Match Time put the limit and the bench back", routes: OPS, want: OPEN_OFF, expect: "open_squad, openSquadOff", why: "off, the admin group" },

  // ── B. Must NOT switch it ──
  { group: "B", club: VETS_OFF, where: "PG", text: "@Match Time no limit tonight, anyone can come", routes: "any", want: notToggle(OTHER), expect: "other", why: "one game (in the prompt)" },
  { group: "B", club: ERDAL_OFF, where: "PG", text: "@Match Time bu akşam sınır yok, isteyen gelsin", routes: "any", want: notToggle(OTHER), expect: "other", why: "one game, TR (in the prompt)" },
  { group: "B", club: VETS_OFF, where: "PG", text: "@Match Time anyone can play this week", routes: "any", want: notToggle(OTHER), expect: "other", why: "one game (in the prompt)" },
  { group: "B", club: ERDAL_OFF, where: "PG", text: "@Match Time bu hafta herkes oynayabilir", routes: "any", want: notToggle(OTHER), expect: "other", why: "one game, TR (in the prompt)" },
  { group: "B", club: VETS_ON, where: "PG", text: "@Match Time max 14 again", routes: OPS, want: notToggle(range({ max: 14 })), expect: "player_numbers, maxPlayers 14", why: "the most, with the setting on (in the prompt)" },
  { group: "B", club: ERDAL_ON, where: "PG", text: "@Match Time yine en fazla 14 kişi", routes: OPS, want: notToggle(range({ max: 14 })), expect: "player_numbers, maxPlayers 14", why: "the most, TR, setting on (in the prompt)" },
  { group: "B", club: VETS_ON, where: "PG", text: "@Match Time set the minimum to 10", routes: OPS, want: notToggle(range({ min: 10 })), expect: "player_numbers, minPlayers 10", why: "the fewest, setting on (in the prompt)" },
  { group: "B", club: ERDAL_ON, where: "PG", text: "@Match Time en az 10 kişi olsun", routes: OPS, want: notToggle(range({ min: 10 })), expect: "player_numbers, minPlayers 10", why: "the fewest, TR, setting on (in the prompt)" },
  { group: "B", club: VETS_ON, where: "PG", text: "@Match Time back to full teams", routes: OPS, want: notToggle(range({ full: true })), expect: "player_numbers, fullTeams", why: "the fewest, never the limit, setting on (in the prompt)" },
  { group: "B", club: ERDAL_ON, where: "PG", text: "@Match Time yine tam takım", routes: OPS, want: notToggle(range({ full: true })), expect: "player_numbers, fullTeams", why: "TR, setting on (in the prompt)" },
  { group: "B", club: VETS_ON, where: "PG", text: "@Match Time is there a limit on numbers?", routes: "any", want: notToggle(OTHER), expect: "other", why: "a question (in the prompt)" },
  { group: "B", club: ERDAL_ON, where: "PG", text: "@Match Time kadro sınırı var mı?", routes: "any", want: notToggle(OTHER), expect: "other", why: "a question, TR (in the prompt)" },
  { group: "B", club: VETS_ON, where: "PG", text: "we're 12 tonight", routes: "any", want: notToggle(CHAT), expect: "other, toMatchTime false", why: "a count, untagged (in the prompt)" },
  { group: "B", club: ERDAL_ON, where: "PG", text: "bu akşam 12 kişiyiz", routes: "any", want: notToggle(CHAT), expect: "other, toMatchTime false", why: "a count, TR, untagged (in the prompt)" },

  // ── C. Existing behaviour: the Vets ──
  { group: "C", club: VETS_OFF, where: "PG", text: "@Match Time we play 12 to 16", routes: OPS, want: range({ min: 12, max: 16 }), expect: "player_numbers 12 to 16", why: "the range" },
  { group: "C", club: VETS_OFF, where: "PG", text: "@Match Time make it 8 aside", routes: OPS, want: side(8), expect: "switch_format 8 a side", why: "one game's size" },
  { group: "C", club: VETS_OFF, where: "PG", text: "yes", quoted: { text: SUGGESTION, fromMatchTime: true }, routes: OPS, want: side(8), expect: "switch_format 8 a side", why: "Davide's yes to the suggestion" },
  { group: "C", club: VETS_OFF, where: "PG", text: "@Match Time move Monday's game to 8:15", routes: OPS, want: action("move_game", (f) => f?.game === 1 && f.newTime === "20:15" && f.everyWeek !== true), expect: "move_game, game 1, 20:15", why: "one game moved" },
  { group: "C", club: VETS_OFF, where: "PG", text: "@Match Time from now on we kick off at 8:15", routes: OPS, want: action("move_game", (f) => f?.newTime === "20:15" && f.everyWeek === true), expect: "move_game, 20:15, every week", why: "the weekly game moved" },
  { group: "C", club: VETS_OFF, where: "PG", text: "@Match Time DM these people", quoted: { text: TAGS_PEOPLE, fromMatchTime: false }, routes: OPS, want: recruit((f) => f?.namedPeople === true), expect: "recruit, named people", why: "named invites" },

  // ── C. Existing behaviour: Sutton FC ──
  { group: "C", club: SUTTON, where: "HQ", text: "Tuesday's game never took place", routes: OPS, want: action("cancel_match", (f) => f?.pastGame === true && /tuesday/i.test(f.matchDay ?? "")), expect: "cancel_match, Tuesday, pastGame", why: "a past game" },
  { group: "C", club: SUTTON, where: "HQ", text: "Bilal washed the bibs, he's free this week", routes: OPS, want: action("fee_waiver", (f) => lc(f?.coveredRefs) === "bilal" && f?.undo !== true), expect: "fee_waiver Bilal", why: "a free place" },
  { group: "C", club: SUTTON, where: "HQ", text: "Amir paid for Faris and Adam", routes: OPS, want: action("bulk_payment", (f) => /amir/i.test(f?.payerRef ?? "") && f?.count === 2 && lc(f?.coveredRefs) === "adam,faris"), expect: "bulk_payment Amir, 2, Faris and Adam", why: "one pays for two" },
  { group: "C", club: SUTTON, where: "HQ", text: "remind me tomorrow at 6 to bring the bibs", routes: OPS, want: action("reminder", (f) => f?.remindAt === "2026-11-18 18:00" && /bibs/i.test(f.note ?? "")), expect: "reminder 2026-11-18 18:00, bring the bibs", why: "a reminder" },
  { group: "C", club: SUTTON, where: "PG", text: "@Match Time send everyone their stats", routes: OPS, want: action("stats_blast"), expect: "stats_blast", why: "stats DMs" },

  // ── C. Existing behaviour: FNF ──
  { group: "C", club: FNF, where: "HQ", text: "Cancel the session", routes: OPS, want: action("cancel_match", (f) => f?.pastGame !== true), expect: "cancel_match", why: "FNF HQ, untagged" },
  { group: "C", club: FNF, where: "HQ", text: "ask Sutton if anyone can play", routes: HQ_ASK, want: partner("Sutton"), expect: "recruit, partners, Sutton", why: "a partner by name" },
  { group: "C", club: FNF, where: "PG", text: "@Match Time ask Friday MT Community if anyone can play tonight", routes: OPS, want: partner("Friday MT Community"), expect: "recruit, partners, Friday MT Community", why: "a partner by name, players' group" },
  { group: "C", club: FNF, where: "PG", text: "@Match Time Sutton'a sor bakalım oynayan var mı", routes: OPS, want: partner("Sutton"), expect: "recruit, partners, Sutton", why: "a partner by name, TR" },
  { group: "C", club: FNF, where: "HQ", text: "@Match Time find me players from partner clubs and the player pool", routes: HQ_ASK, want: recruit((f) => f?.partnerClubs === true && f.pool === true), expect: "recruit, partners and pool", why: "both, named" },
  { group: "C", club: FNF, where: "ANSWER", text: "both", question: OFFER, routes: "any", want: answer("partners+pool"), expect: "partners+pool", why: "both, answering the nobody-left offer" },
  { group: "C", club: FNF, where: "ANSWER", text: "all of them", question: Q_GROUP, routes: "any", want: answer("club+partners+pool"), expect: "club+partners+pool", why: "all, answering where to look" },
  { group: "C", club: FNF, where: "HQ", text: "@Kemal can we ask Sutton group?", routes: "any", want: (f) => f?.toMatchTime === false || f?.action === "other", expect: "toMatchTime false (nothing asked)", why: "asks a person" },
  { group: "C", club: FNF, where: "PG", text: "@Match Time turn off quiet hours now", routes: OPS, want: action("quiet_hours", (f) => f?.quietOff === true), expect: "quiet_hours, off", why: "quiet hours" },
  { group: "C", club: FNF, where: "HQ", text: "@Match Time no football in December", routes: OPS, want: action("season_break", (f) => (f?.breakMonths ?? []).join(",") === "2026-12"), expect: "season_break 2026-12", why: "a break" },
  { group: "C", club: FNF, where: "HQ", text: "@Match Time our pitch is Goals Sutton", routes: OPS, want: action("set_venue", (f) => /goals sutton/i.test(f?.venueName ?? "")), expect: "set_venue Goals Sutton", why: "the pitch" },
  { group: "C", club: { ...FNF, pg: [...FNF.pg, { author: "MatchTime", body: REFUSED }] }, where: "PG", text: "@Match Time added the venue location", routes: OPS, want: action("retry_ask"), expect: "retry_ask", why: "after MatchTime's refusal" },

  // ── C. Existing behaviour: Turkish ──
  { group: "C", club: ERDAL_OFF, where: "PG", text: "@Match Time maçı iptal et", routes: OPS, want: action("cancel_match", (f) => f?.pastGame !== true), expect: "cancel_match", why: "TR cancel" },
  { group: "C", club: ERDAL_OFF, where: "PG", text: "@Match Time sessiz saatleri kapat", routes: OPS, want: action("quiet_hours", (f) => f?.quietOff === true), expect: "quiet_hours, off", why: "TR quiet hours" },
  { group: "C", club: ERDAL_OFF, where: "PG", text: "@Match Time aralıkta maç yok", routes: OPS, want: action("season_break", (f) => (f?.breakMonths ?? []).join(",") === "2026-12"), expect: "season_break 2026-12", why: "TR break" },
  { group: "C", club: ERDAL_OFF, where: "PG", text: "@Match Time 12 ile 16 kişi arası oynuyoruz", routes: OPS, want: range({ min: 12, max: 16 }), expect: "player_numbers 12 to 16", why: "TR range" },
  { group: "C", club: ERDAL_OFF, where: "PG", text: "@Match Time 8'e 8 yapalım", routes: OPS, want: side(8), expect: "switch_format 8 a side", why: "TR size" },
  { group: "C", club: ERDAL_OFF, where: "PG", text: "@Match Time pazartesi maçını 20:15'e al", routes: OPS, want: action("move_game", (f) => f?.game === 1 && f.newTime === "20:15"), expect: "move_game, game 1, 20:15", why: "TR move" },
];

// ── Running a case through the production path ───────────────────────

const tagOf = (body: string) => /@match\s*time/i.test(body);

async function run(c: Case, i: number): Promise<boolean> {
  const id = `os${i}`;
  const reply = c.quoted ? quoteFromPi({ id: null, ...c.quoted }) : null;
  let route: string | null = null;

  if (c.where !== "ANSWER") {
    const message =
      c.where === "HQ"
        ? {
            id,
            authorName: c.club.organiser,
            body: c.text,
            reply,
            organisers: { context: organisersContext({ pending: [], recent: c.club.hq }), senderIsOrganiser: true },
          }
        : {
            id,
            authorName: c.club.organiser,
            body: c.text,
            reply,
            // An organiser of a club with partners is shown their names (analyze/route.ts).
            ...(c.club.partners ? { partnerClubs: c.club.partners } : {}),
          };
    const r = await routeBatch(model, [message], { now: NOW });
    route = r.routes[0]?.route ?? null;
  }

  const history: Hist[] =
    c.where === "HQ" ? c.club.hq.map((h) => ({ author: h.fromMatchTime ? "MatchTime" : "Organiser", body: h.text })) : c.club.pg;
  const lastBotPost =
    c.where === "ANSWER"
      ? c.question ?? null
      : [...history].reverse().find((h) => (h.author ?? "").toLowerCase() === "matchtime")?.body ?? null;
  const ex = await extractForRoute(model, "admin_ops", {
    id,
    body: c.text,
    authorName: c.club.organiser,
    // The admin group's reader always reads a message as to MatchTime
    // (admin-group-understand.ts); the players' group's is the Pi's tag, or
    // a reply to MatchTime; an answer is read untagged (ask-source-group.ts).
    tagged: c.where === "HQ" ? true : c.where === "ANSWER" ? false : tagOf(c.text) || c.quoted?.fromMatchTime === true,
    history: c.where === "ANSWER" ? [] : history,
    lastBotPost,
    reply,
    ...(c.where === "ANSWER" ? {} : { games: gamesToComeLines(c.club.games) }),
    now: NOW,
  });
  const f = ex.facts.kind === "admin" ? ex.facts : null;

  const routeOk = c.routes === "any" || (route !== null && c.routes.includes(route as Route));
  const factsOk = c.want(f);
  const ok = routeOk && factsOk;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${c.group} ${c.where} [${c.club.label}] ${JSON.stringify(c.text)}${c.quoted ? " (a reply)" : ""}\n` +
      `      routed ${c.where === "ANSWER" ? "(no router: an answer)" : route}${routeOk ? "" : `  ROUTER MISS (want ${(c.routes as Route[]).join("|")})`}\n` +
      `      extractor ${shown(f)}${factsOk ? "" : "  EXTRACTOR MISS"}\n` +
      `      want ${c.expect}   (${c.why})`,
  );
  return ok;
}

async function main() {
  const only = process.env.ONLY;
  const cases = CASES.filter((c) => !only || c.text.includes(only));
  const totals = { A: [0, 0], B: [0, 0], C: [0, 0] } as Record<Case["group"], [number, number]>;
  console.log(`\n== No squad limit and the rewritten admin prompt: ${cases.length} cases, each once ==\n`);
  for (const [i, c] of cases.entries()) {
    const ok = await run(c, i);
    totals[c.group][ok ? 0 : 1]++;
  }
  const pass = totals.A[0] + totals.B[0] + totals.C[0];
  const fail = totals.A[1] + totals.B[1] + totals.C[1];
  console.log(
    `\nA. the new action: ${totals.A[0]} passed, ${totals.A[1]} failed` +
      `\nB. must not switch it: ${totals.B[0]} passed, ${totals.B[1]} failed` +
      `\nC. existing behaviour: ${totals.C[0]} passed, ${totals.C[1]} failed` +
      `\n\n${pass} passed, ${fail} failed. Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`,
  );
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  console.log(`Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(1);
});
