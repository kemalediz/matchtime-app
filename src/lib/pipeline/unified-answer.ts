/**
 * THE UNIFIED ANSWER (Kemal, 2026-11-10), behind UNIFIED_ANSWERS (default
 * OFF, `../unified-answers-flag.ts`).
 *
 * Kemal: "any question that is being asked should go to other category and
 * just answered by LLM after looking at all data. this way we can get rid of
 * some of the categories as well and make the code simpler."
 *
 * With the flag on, a tagged question in the players' group, in HQ or in a
 * DM is answered by ONE model call (Haiku 5.5) over ONE context this module
 * writes from the club's data. Four things stay in code, outside the model:
 * the list post, the help, the asker's own stats link (`answer-batch.ts`
 * reads them from the small question extractor), and who has paid, which is
 * only ever written into the ORGANISERS' context here.
 *
 * WHAT KEEPS IT HONEST, as for the open answer (`open-answer.ts`) it grew
 * out of, in order of strength:
 *
 *   1. WHAT IT IS GIVEN. The context is filtered by AUDIENCE here, in code:
 *        players' group  the squad and bench by name (counts only when the
 *                        organisers post the list), results, the stats
 *                        tables (top of each list), the club's setup; never
 *                        payments, never who has rated unless the asker is an
 *                        admin;
 *        organisers (HQ) all of that with names, plus the payment counts of
 *                        the last settled match and who has rated;
 *        a DM            the players' facts with names (as the DM answer has
 *                        always shown them), plus the asker's OWN stats and
 *                        OWN payments, which the caller writes; never another
 *                        player's money.
 *      Never seeds, phone numbers, DM contents, another club. Phone numbers
 *      are scrubbed from every line. What the model is not told it cannot
 *      leak.
 *   2. WHAT IT MAY SAY. Every number and every member it names must be in
 *      the context (`stats-grounding.ts`, the same check).
 *   3. WHAT HAPPENS WHEN IT FAILS. Never throws; a failed call or a refused
 *      reply is `rejected`, and the caller keeps today's fallback line.
 *
 * It changes nothing: no database access, returns a string, and the prompt
 * says it may never claim to have done anything.
 */
import { extractJson, HAIKU_CALL, type ModelCall, type PipelineModel } from "./llm";
import { groundingCheck, membersNamed } from "./stats-grounding";
import { ELO_TOP_MIN_MATCHES_SHOWN, GROUP_LIST_CAP, GROUP_RATINGS_MIN_GAMES, TEAM_OF_SEASON_MIN_GAMES } from "./stats-answer";
import { lastMomContextLines, type LastMom } from "./last-mom";
import { MR_RELIABLE_MIN_AVG, MR_RELIABLE_MIN_GAMES } from "../mr-reliable";
import { dayLabel, monthYearLabel } from "../i18n/dates";
import { t } from "../i18n/t";
import { namesByStatus, printedNames, safeName } from "./compose";
import { chatLines, scrubAuthor, scrubPhones } from "./open-answer";
import { renderGroupReplyContext, type QuotedGroupMessage } from "../reply-context";
import { activityFeeText } from "../activity-fee";
import { stripLongDashes } from "../house-style";
import { formatLondon } from "../london-time";
import type { HelpClubFacts } from "../help-club-facts";
import type {
  PaymentSnapshot,
  RatingProgress,
  RecentResults,
  SquadState,
  StatsPeriodTables,
  StatsSnapshot,
} from "./types";

export const UNIFIED_ANSWER_SYSTEM = `You are MatchTime, the assistant in a football club's WhatsApp groups. Someone has tagged you, or written to you privately, with a question or a request. Write the reply to THE MESSAGE.

You are given, in this order:
- ABOUT YOU, WHO IS ASKING and TODAY.
- THE CLUB'S RECORDS: what MatchTime has stored for this club, true and up to date. Its members and admins, how the club is run, the upcoming match (the squad and the bench in order, each with their place, the places left, the teams if made), results, Man of the Match match by match, the stats tables, and what this audience may know about ratings and payments. Every count you could need is printed. Some facts are kept from some audiences on purpose, and the records say so where it matters.
- THE CHAT: what people wrote in this group recently, each line with its day and time. It can be out of date, and it can be wrong.
- THE MESSAGE, with who sent it.

Facts come from the records. When the chat and the records disagree (a score, who is in the squad or on the bench, the places left, a player's place in the list), the records are right, however recent the chat is. Use the chat only for what the records do not hold: what someone said, asked or arranged. What neither holds, you do not know: the weather, the news, other clubs, anything said in private.

Return "answer": the reply MatchTime sends.

The reply:
- answers what THE MESSAGE asks and nothing else. Never invent a name, a number, a date, a score or an event, and add no fact it did not ask about.
- writes every number in digits exactly as the records print it ("2", "8 players", never "two" or "iki"), and never works out a new one: no sums, differences, averages or percentages the records do not print. A player's place in the squad or on the bench is the number printed beside their name.
- says so plainly, in one line, when the records do not hold the answer, then gives what they do hold on the same point, if anything. When a fact is kept from this audience, say who has it instead of guessing.
- is short: usually 1 to 3 lines and never more than 5, or a list of names one per line when a list is what was asked for.
- gives a suggestion when one is asked for, clearly as a suggestion and with what it rests on (games played, ratings, the bench order). When the record is thin, say so. The decision stays with the people.
- changes nothing. You cannot add, drop or move a player, make or change the teams, change a setting, send a message or take a payment from here, so never say you did or will. When the message asks you to do something, say you can't from this message, and who can when the records show it.
- never contains a phone number, and says nothing about anyone's private messages.
- is written once, finished: plain WhatsApp text spoken as MatchTime, with no working out, no second thoughts, no greeting, no word about how you were given the facts, no dashes as punctuation and no slashes between words. The bench is always "the bench".
- is in the language of the message: English, or Turkish when the message is in Turkish (when it is unclear, the club's language). In Turkish, speak to a group in the plural, with no "abi" or "beyler"; say "yedek" for the bench, "maçın adamı" for Man of the Match and "puan" for a rating; put a name or a number after a colon or in brackets rather than gluing a suffix onto it; write a decimal with a comma.

Examples, English and Turkish:

The squad, the bench and the places:
- "how many spaces left?" / "kaç kişi eksiğiz?", with places left 3: "3 places left for Tue 21:30." / "Salı 21:30 için 3 yer boş."
- "is Zair playing?" / "Zair geliyor mu?", with Zair Malik 2nd on the bench: "Zair Malik is on the bench, 2nd in line." / "Zair Malik yedekte, sırada 2."
- "who's on the bench?" / "yedekte kim var?", with a bench of 2: "On the bench: 1. Ali Kaya, 2. Can Demir." / "Yedekte: 1. Ali Kaya, 2. Can Demir."

The records against the chat:
- "what was the score?" / "skor neydi?", with the record Red 5, Yellow 6 and a chat line saying it was 6 to 5: "Fri 6 Nov: Red 5, Yellow 6." / "6 Kasım Cuma: Red 5, Yellow 6."
- "is this the correct time?" / "saat doğru mu?", about the match: "Kickoff is Fri 13 Nov at 20:30, at Goals." / "Maç 13 Kasım Cuma 20:30, Goals."

About you:
- "will we see you there?" / "seni maçta görecek miyiz?": "I'm MatchTime, the club's assistant, not a player, so you won't see me on the pitch. Kickoff is Fri 20:30." / "Ben MatchTime, kulübün asistanıyım, oyuncu değilim; sahada olmayacağım. Maç Cuma 20:30."

Stats, Man of the Match and money:
- "who won Man of the Match last week?" / "geçen haftanın maçın adamı kim?", with the last one on Tue 3 Nov: "Ali Kaya, on Tue 3 Nov, with 5 of the 11 votes." / "Maçın adamı (3 Kasım Salı): Ali Kaya, 5 oy (toplam 11)."
- "top 5 ratings" / "en iyi 5 puan", when nobody has 3 rated matches yet: "Nobody has 3 rated matches yet, so there is no ratings table." / "Henüz kimsenin 3 puanlı maçı yok, puan tablosu oluşmadı."
- "who hasn't paid?" / "kim ödemedi?", in the players' group: "I don't share payments in the group. The collector (Elvin Aliyev) has them." / "Ödemeleri grupta paylaşmıyorum. Toplayan kişide (Elvin Aliyev) var."

Suggestions, requests and what you can't see:
- "who should come up from the bench?" / "yedekten kim çıksın?": "A suggestion, by games played: Ali Kaya (12), then Can Demir (3). It's the organisers' call." / "Önerim, oynanan maça göre: Ali Kaya (12), sonra Can Demir (3). Karar organizatörlerin."
- "can you drop Sam and add Ali?" / "Sam'i çıkarıp Ali'yi ekler misin?": "I can't change the squad from a question. Sam can say OUT, and Ali can say IN." / "Bir sorudan kadroyu değiştiremem. Sam OUT, Ali IN yazabilir."
- "is it going to rain tonight?" / "bu akşam yağmur var mı?": "I can't see the weather. Kickoff is Fri 20:30 at Goals." / "Hava durumunu göremiyorum. Maç: Cuma 20:30, Goals."`;

/** Haiku 5.5, adaptive thinking at the shared effort, like every Haiku site. */
export const UNIFIED_ANSWER_CALL: ModelCall = HAIKU_CALL;
/** Room for a list answer as well as Haiku's thinking. */
export const UNIFIED_ANSWER_MAX_TOKENS = 2_048;

const SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
} as const;

export type UnifiedAudience = "players" | "organisers" | "dm";

/** The ratings each player got in one match, highest average first. */
export interface LastMatchRatings {
  date: Date;
  rows: Array<{ userId: string; name: string; avg: number; count: number }>;
}

/** A period cut of the tables (`loadStatsPeriod`), with its own label. */
export interface UnifiedPeriod {
  label: string;
  tables: StatsPeriodTables;
}

export interface UnifiedAnswerInput {
  audience: UnifiedAudience;
  /** The batch's state, `club` loaded when the read succeeded. */
  state: SquadState;
  /** False when the batch could not vouch for the upcoming squad. */
  squadKnown: boolean;
  /** The tables, or null when stats Q&A is off or the read failed. */
  stats: StatsSnapshot | null;
  /** Shorter spans of the same tables (the last 30 days, this year). */
  periods?: UnifiedPeriod[];
  /** The member whose pairings the tables show (the one the question
   *  names, else the asker), and whether that is the asker. */
  person?: { userId: string; self: boolean } | null;
  /** The club's recent scored results, newest first. */
  results?: RecentResults | null;
  /** The organisers only: the payment counts of the last settled match. */
  payments?: PaymentSnapshot | null;
  /** Who has rated the last match: organisers, or an admin asking. */
  ratingProgress?: RatingProgress | null;
  /** The pool and the partner clubs (`help-club-facts.ts`). */
  clubFacts?: HelpClubFacts | null;
  /** How the club's squad works (`Organisation.squadMode`): a monthly
   *  club's rules go into HOW THE CLUB IS RUN (2026-11-11). Absent: weekly. */
  squadMode?: "weekly" | "monthly";
  /** The organisers only (2026-11-11): the ratings each player got in the
   *  last match that has ratings (`loadLastMatchRatings`). */
  lastMatchRatings?: LastMatchRatings | null;
  /** A monthly club whose month has not started (`month-not-started.ts`):
   *  the squad starts from the month's list, not from who said IN. */
  monthNotStarted?: boolean;
  /** A DM only: the asker's own blocks, already written by the caller
   *  (`unified-dm.ts`: THE ASKER'S OWN STATS and PAYMENTS); in HQ, the
   *  asker's own stats when they ask about themselves (2026-11-11). */
  own?: string[];
  /** A DM only: what MatchTime said to them (`renderReplyContext`). The
   *  group's chat is not shown in a DM. */
  dmChat?: string | null;
  /** The group's chat of the last 7 days, oldest first. */
  history: Array<{ author: string | null; body: string; at?: Date | null }>;
  chatWindow?: "week" | "recent";
  lastBotPost: string | null;
  reply: QuotedGroupMessage | null;
  now: Date;
  question: string;
  askerUserId: string | null;
  askerName: string | null;
  /** The asker is one of the club's organisers, when the caller knows better
   *  than the roster (a DM: an owner, an admin or a superadmin). */
  askerIsAdmin?: boolean;
}

/** PURE. One match's ratings per player, highest average first, ties by
 *  name (`loadLastMatchRatings` reads the averages and counts). */
export function matchRatingsFrom(date: Date, rows: LastMatchRatings["rows"]): LastMatchRatings {
  return { date, rows: [...rows].sort((a, b) => b.avg - a.avg || a.name.localeCompare(b.name)) };
}

const numbered = (names: string[]) => names.map((n, i) => `  ${i + 1}. ${n}`);
const d1 = (x: number) => x.toFixed(1);

/** The monthly squad's rules, as `monthly-week.ts` and
 *  `monthly-week-rules.ts` run them, for HOW THE CLUB IS RUN. */
const MONTHLY_RULES = [
  "- The squad is a MONTHLY squad: the regulars who paid for the month are on the month's list and in every game of the month without saying anything, so nobody needs to confirm.",
  "- A regular who can't make a game says OUT, and their place opens for that game.",
  "- An open place goes to the bench first, then to the pay as you go players: one says IN to take it and pays for that game only.",
  "- The month's list starts from the list the organisers post for the month.",
];

function paymentLines(p: PaymentSnapshot | null | undefined): string[] {
  if (!p) return ["PAYMENTS: not available right now."];
  switch (p.kind) {
    case "not_tracked":
      return ["PAYMENTS: MatchTime does not track payments for this club."];
    case "no_settled_match":
      return ["PAYMENTS: no settled match to report on yet."];
    case "no_signal":
      return [`PAYMENTS for the last match (${p.kickoffLabel}): nothing recorded either way.`];
    case "counted":
      return [
        `PAYMENTS for the last match (${p.kickoffLabel}): ${p.unpaid} of the ${p.chargeable} who owe have not paid yet. MatchTime gives the count only, no names.`,
      ];
  }
}

function ratingLines(r: RatingProgress | null | undefined, names: boolean): string[] {
  if (!r) return [];
  if (!r.ok) return [`WHO HAS RATED THE LAST MATCH: ${r.reason ?? "nothing to check"}`];
  const L = [
    `WHO HAS RATED THE LAST MATCH (${[r.matchName, r.matchWhen].filter(Boolean).join(", ")}): ${r.ratedCount ?? 0} of ${r.confirmed ?? 0} who played have rated${r.momVote !== false ? `, ${r.momCount ?? 0} have voted for Man of the Match` : ""}.`,
  ];
  if (names) {
    L.push(`- Not rated yet: ${r.notRated && r.notRated.length ? r.notRated.join(", ") : "nobody"}`);
    if (r.ratedNoMom && r.ratedNoMom.length) L.push(`- Rated but no Man of the Match vote: ${r.ratedNoMom.join(", ")}`);
  } else {
    L.push("- Who has or has not rated is only shown to the organisers.");
  }
  return L;
}

function periodLines(p: UnifiedPeriod, cap: number): string[] {
  const L = [`STATS, ${p.label.toUpperCase()} (since ${formatLondon(p.tables.since, "EEE d MMM yyyy")}):`];
  const apps = p.tables.appearances.slice(0, GROUP_LIST_CAP);
  L.push(apps.length ? `- Appearances: ${apps.map((r) => `${r.name} ${r.matches}`).join(", ")}` : "- Appearances: none recorded");
  const rat = p.tables.ratings.slice(0, cap);
  L.push(
    rat.length
      ? `- Ratings: ${rat.map((r) => `${r.rank}. ${r.name} ${d1(r.avg)} (${r.games} rated)`).join(", ")}`
      : `- Ratings: nobody has ${GROUP_RATINGS_MIN_GAMES} rated matches in this span`,
  );
  const mom = p.tables.mom.slice(0, GROUP_LIST_CAP);
  if (mom.length) L.push(`- Man of the Match wins: ${mom.map((r) => `${r.name} ${r.wins}`).join(", ")}`);
  return L;
}

/** One decided Man of the Match, on one line. */
function momLine(m: LastMom): string {
  const who = m.winners.map((w) => w.name).join(" and ");
  if (m.pickedByOrganisers) return `  ${dayLabel("en", m.date)}: ${who}, picked by the organisers`;
  const shared = m.winners.length > 1 ? ` (shared, ${m.winners[0].votes} votes each)` : "";
  return `  ${dayLabel("en", m.date)}: ${who}${shared || `, ${m.winners[0].votes} of ${m.totalVotes} votes`}`;
}

/**
 * PURE. THE STATS, by audience. The players' group and a DM see the top of
 * each list (`GROUP_LIST_CAP`), never the bottom: a rating outside the top
 * is on the stats page, not said here. The organisers see the whole ratings
 * table, the rating of every player in the squad and on the bench, any
 * player's rating, and the ratings each player got in the last match.
 */
function statsLines(input: UnifiedAnswerInput, s: StatsSnapshot, squadIds: Array<{ userId: string; where: string }>): string[] {
  const organisers = input.audience === "organisers";
  const cap = organisers ? Number.MAX_SAFE_INTEGER : GROUP_LIST_CAP;
  const L: string[] = [
    "STATS (every completed game MatchTime has recorded). MatchTime records appearances, results, ratings, Man of the Match and Elo; it does not record goals or assists.",
  ];
  const ratings = s.ratings.slice(0, cap);
  if (ratings.length === 0) {
    L.push(`CLUB RATINGS: nobody has ${GROUP_RATINGS_MIN_GAMES} rated matches yet, so nobody is in the ratings table. A player needs ${GROUP_RATINGS_MIN_GAMES} rated matches to be in it.`);
  } else {
    L.push(
      `CLUB RATINGS (${organisers ? "the whole table" : `top ${GROUP_LIST_CAP}`}, players with ${GROUP_RATINGS_MIN_GAMES}+ rated matches; the average of the ratings team-mates gave them):`,
    );
    for (const r of ratings) L.push(`${r.rank}. ${r.name}: ${d1(r.avg)} from ${r.games} rated matches`);
  }
  if (organisers && squadIds.length) {
    const byId = new Map(s.ratings.map((r) => [r.userId, r]));
    const rated = squadIds.filter((x) => byId.has(x.userId)).sort((a, b) => byId.get(a.userId)!.rank - byId.get(b.userId)!.rank);
    const unrated = squadIds.filter((x) => !byId.has(x.userId));
    L.push(
      "",
      `CLUB RATINGS OF THE SQUAD AND BENCH for the upcoming match, highest first (${GROUP_RATINGS_MIN_GAMES}+ rated matches):`,
      rated.length ? rated.map((x) => `${byId.get(x.userId)!.name} ${d1(byId.get(x.userId)!.avg)} (${x.where})`).join(", ") : "nobody in the squad or on the bench has a club rating yet",
    );
    if (unrated.length) L.push(`No club rating yet: ${unrated.map((x) => x.where === "bench" ? `${nameIn(input, x.userId)} (bench)` : nameIn(input, x.userId)).join(", ")}`);
  } else if (squadIds.length && ratings.length) {
    // The players see the top of the table only: of the squad and the
    // bench, who is in it ("the 4 highest rated on the list").
    const byId = new Map(ratings.map((r) => [r.userId, r]));
    const top = squadIds.filter((x) => byId.has(x.userId)).sort((a, b) => byId.get(a.userId)!.rank - byId.get(b.userId)!.rank);
    L.push(
      "",
      `SQUAD AND BENCH PLAYERS IN THE TOP ${GROUP_LIST_CAP} OF THE RATINGS TABLE, highest first: ${top.length ? top.map((x) => `${byId.get(x.userId)!.name} ${d1(byId.get(x.userId)!.avg)} (${x.where})`).join(", ") : "none"}. The other squad and bench players' ratings are not shared ${input.audience === "dm" ? "here" : "in the group"}.`,
    );
  }
  if (s.appearances.length) {
    const start = s.recordsStart.matches;
    L.push("", `APPEARANCES (top ${GROUP_LIST_CAP}, completed matches played${start ? `, every match since ${monthYearLabel("en", start)}` : ""}):`);
    s.appearances.slice(0, GROUP_LIST_CAP).forEach((r, i) => L.push(`${i + 1}. ${r.name}: ${r.matches} matches`));
  }
  if (s.mom.length) {
    L.push("", `MAN OF THE MATCH WINS (top ${GROUP_LIST_CAP}):`);
    s.mom.slice(0, GROUP_LIST_CAP).forEach((r, i) => L.push(`${i + 1}. ${r.name}: ${r.wins}`));
  }
  if (s.elo.length) {
    L.push("", `ELO (top ${GROUP_LIST_CAP}, ${ELO_TOP_MIN_MATCHES_SHOWN}+ matches played):`);
    s.elo.slice(0, GROUP_LIST_CAP).forEach((r, i) => L.push(`${i + 1}. ${r.name}: ${r.rating} from ${r.matches} matches`));
  }
  if (s.teamOfSeason && s.teamOfSeason.slots.length) {
    L.push("", `TEAM OF THE SEASON (${s.teamOfSeason.sportName}, best average rating per position, ${TEAM_OF_SEASON_MIN_GAMES}+ rated matches):`);
    s.teamOfSeason.slots.forEach((x) => L.push(`- ${x.name}${x.position && x.position !== "ANY" ? ` (${x.position})` : ""}: ${d1(x.avg)} from ${x.games} rated matches`));
  }
  if (s.mrReliable.length) {
    L.push("", `MR RELIABLE BADGE HOLDERS (average ${d1(MR_RELIABLE_MIN_AVG)}+, little variation, ${MR_RELIABLE_MIN_GAMES}+ rated matches; most consistent first):`);
    s.mrReliable.slice(0, GROUP_LIST_CAP).forEach((r, i) => L.push(`${i + 1}. ${r.name}: ${d1(r.avg)} average from ${r.games} rated matches`));
  }
  // Man of the Match, match by match (2026-11-11): "the last 3 weeks' MoMs".
  const recent = s.lastMom?.recent ?? [];
  if (recent.length) {
    L.push("", "MAN OF THE MATCH, MATCH BY MATCH (every decided one MatchTime has, newest first):", ...recent.map(momLine));
  }
  const last = lastMomContextLines(s.lastMom);
  if (last.length) L.push("", ...last);

  if (input.person) {
    const member = input.state.roster.find((m) => m.userId === input.person!.userId);
    const name = member?.name ?? s.chemistry[input.person.userId]?.name ?? null;
    if (name) {
      L.push("", `THE PLAYER THE QUESTION IS ABOUT: ${name}`);
      const r = s.ratings.slice(0, cap).find((x) => x.userId === input.person!.userId);
      L.push(
        r
          ? `- club rating: ${d1(r.avg)} from ${r.games} rated matches, no. ${r.rank}`
          : organisers
            ? `- club rating: none yet (fewer than ${GROUP_RATINGS_MIN_GAMES} rated matches)`
            : "- club rating: not in the top of the table, so not shared here",
      );
      const mom = s.mom.find((x) => x.userId === input.person!.userId);
      if (mom) L.push(`- Man of the Match wins: ${mom.wins}`);
      const apps = s.appearances.slice(0, organisers ? undefined : GROUP_LIST_CAP).find((x) => x.userId === input.person!.userId);
      if (apps) L.push(`- appearances: ${apps.matches}`);
      const c = s.chemistry[input.person.userId];
      if (c?.bestByWinRate) {
        const b = c.bestByWinRate;
        L.push(`- best team-mate by win rate: ${b.name}, ${b.wins} wins in ${b.gamesTogether} matches together (${Math.round(b.winRate * 100)}%)`);
      }
      if (c?.bestByRating) L.push(`- best team-mate by rating: ${c.bestByRating.name}, ${d1(c.bestByRating.myAvgWith)} average alongside them`);
      if (c?.nemesis && input.person.self) L.push(`- nemesis: ${c.nemesis.name}, won ${c.nemesis.wins} of ${c.nemesis.gamesAgainst} against them`);
    }
  }

  for (const p of input.periods ?? []) L.push("", ...periodLines(p, cap));
  if (typeof s.completedMatches === "number") L.push("", `Completed games MatchTime has recorded for this club: ${s.completedMatches}`);
  L.push(`The full tables are on the stats page: ${s.fullTableUrl}`);

  if (organisers) {
    const lm = input.lastMatchRatings;
    if (lm && lm.rows.length) {
      L.push(
        "",
        `RATINGS EACH PLAYER GOT IN THE LAST RATED MATCH (${dayLabel("en", lm.date)}), the average of their team-mates' ratings, highest first:`,
        lm.rows.map((r) => `${r.name} ${d1(r.avg)} (${r.count} ${r.count === 1 ? "rating" : "ratings"})`).join(", "),
      );
    } else if (lm) {
      L.push("", "RATINGS EACH PLAYER GOT IN THE LAST RATED MATCH: no match has ratings yet.");
    }
  } else {
    L.push("", "The ratings each player got in one match are shown to the organisers only.");
  }
  return L;
}

function nameIn(input: UnifiedAnswerInput, userId: string): string {
  return safeName(printedNames(input.state).get(userId) ?? "", "a player");
}

/**
 * PURE. The user turn: ABOUT YOU and the asker, THE CLUB'S RECORDS, THE
 * CHAT, then THE MESSAGE. Every audience rule is applied here; see the
 * header. The records and the chat are under their own headings so the
 * prompt can say which wins (2026-11-11: a correction in the chat reversed
 * a recorded score, and an old list in the chat said 13 places were open
 * in a full squad).
 */
export function buildUnifiedContext(input: UnifiedAnswerInput): { text: string; names: string[] } {
  const { state, audience } = input;
  const L: string[] = [];
  const fallback = "a player";
  const nameOf = printedNames(state);
  const print = (userId: string) => safeName(nameOf.get(userId) ?? "", fallback);
  const asker = input.askerUserId ? state.roster.find((m) => m.userId === input.askerUserId) : undefined;
  const askerIsAdmin = audience === "organisers" || (input.askerIsAdmin ?? !!asker?.isAdmin);
  const where =
    audience === "players"
      ? "in the players' group"
      : audience === "organisers"
        ? "in the organisers' own group (HQ)"
        : "in a private message to MatchTime";

  L.push(
    "ABOUT YOU: You are MatchTime, the club's assistant in its WhatsApp groups and private messages. You are not a person and not a player: you never play, never come to a match, and are never in the squad or on the bench.",
  );
  L.push(
    `WHO IS ASKING: ${scrubAuthor(asker ? (asker.displayName ?? asker.name) : input.askerName)}${asker ? (asker.isAdmin ? ", an admin" : ", a member") : ""}, ${where}`,
  );
  L.push(`THE CLUB SPEAKS: ${state.features.language === "tr" ? "Turkish" : "English"}`);
  L.push(`TODAY: ${formatLondon(input.now, "EEE d MMM yyyy, HH:mm")} (London)`);

  L.push("", "════ THE CLUB'S RECORDS (stored by MatchTime: true and up to date) ════", "");
  const members = state.roster.map((m) => safeName(m.displayName ?? m.name, "")).filter(Boolean);
  if (members.length) L.push(`MEMBERS (${members.length}): ${members.join(", ")}`);
  const admins = state.roster.filter((m) => m.isAdmin).map((m) => safeName(m.displayName ?? m.name, "")).filter(Boolean);
  L.push(`ADMINS: ${admins.length ? admins.join(", ") : "none on record"}`);

  // HOW THE CLUB IS RUN: the club's setup and switches, and a monthly
  // club's rules.
  L.push("", "HOW THE CLUB IS RUN:");
  const club = state.club;
  if (club) {
    L.push(`- Money collector: ${club.collectorName ? safeName(club.collectorName, "not set") : "not set"}`);
    L.push(
      `- Match fee: ${club.feePerPlayer !== null ? `£${activityFeeText(club.feePerPlayer)} a player` : club.feeSplitTotal ? "the pitch cost split between who played" : "not set"}`,
    );
    L.push(`- Teams are made: ${club.teamsReady === "off" ? "when an organiser asks" : `at ${club.teamsReady} on match day`}`);
  }
  L.push(`- Who posts the squad list: ${state.features.listAnnouncer === "organisers" ? "the organisers" : "MatchTime"}`);
  L.push(`- Who fills an open place: ${state.features.benchPickMode === "organiser" ? "the organisers choose from the bench" : "the first on the bench moves up"}`);
  L.push(`- Man of the Match is chosen by: ${state.features.momChosenBy === "organisers" ? "the organisers" : "the players' vote"}`);
  if (input.squadMode === "monthly") L.push(...MONTHLY_RULES);
  if (input.clubFacts) {
    L.push(`- Partner clubs (clubs that lend each other players when short): ${input.clubFacts.partners.active} active`);
    L.push(`- MatchTime player pool (nearby players asked when the club is short): ${input.clubFacts.pool.open ? "on" : "off"}`);
  }
  if (state.smallerFormats.length) {
    L.push(`- Smaller formats the club can play: ${state.smallerFormats.map((f) => `${f.sportName} (${f.totalPlayers} players)`).join(", ")}`);
  }

  // THE UPCOMING MATCH, plus who has no number on record (never the number).
  L.push("");
  const squadIds: Array<{ userId: string; where: string }> = [];
  if (!state.features.attendance) {
    L.push("UPCOMING MATCH: MatchTime does not keep a squad for this club.");
  } else if (!state.matchId) {
    L.push("UPCOMING MATCH: there is no upcoming match scheduled.");
  } else if (!input.squadKnown || state.maxPlayers <= 0) {
    L.push(`UPCOMING MATCH: ${state.matchLabel ?? state.kickoffLabel}${state.venue.trim() ? ` at ${state.venue.trim()}` : ""}. The squad is not available right now.`);
  } else {
    const confirmed = namesByStatus(state, "CONFIRMED", fallback);
    const bench = namesByStatus(state, "BENCH", fallback);
    const perSide = state.maxPlayers % 2 === 0 ? `, ${state.maxPlayers / 2} a side` : "";
    L.push(`UPCOMING MATCH: ${state.matchLabel ?? state.kickoffLabel}${state.venue.trim() ? ` at ${state.venue.trim()}` : ""}, ${state.maxPlayers} players${perSide}`);
    if (state.cancelledMatch) L.push(`- This week's game on ${state.cancelledMatch.dayLabel} is CANCELLED; this is the next one.`);
    if (input.monthNotStarted) {
      L.push("- This club plays a monthly squad, and this month's list has not started yet: the squad comes from the month's list, so the count below is not the squad yet.");
    }
    L.push(`- In the squad: ${confirmed.length} of ${state.maxPlayers}. Places left: ${Math.max(0, state.maxPlayers - confirmed.length)}. On the bench: ${bench.length}.`);
    const hideNames = audience === "players" && state.features.listAnnouncer === "organisers";
    if (hideNames) {
      L.push("- The organisers post the list, so no squad, bench or team names are given here, and MatchTime names nobody in the squad or on the bench, even when the chat shows the list. Counts, results, stats and everything else are answered as usual.");
    } else {
      const ordered = (status: "CONFIRMED" | "BENCH") =>
        state.rows.filter((r) => r.status === status).sort((a, b) => a.position - b.position);
      squadIds.push(...ordered("CONFIRMED").map((r) => ({ userId: r.userId, where: "squad" })), ...ordered("BENCH").map((r) => ({ userId: r.userId, where: "bench" })));
      L.push(`SQUAD (${confirmed.length} of ${state.maxPlayers}), in the order they joined, each with their place:`);
      L.push(...(confirmed.length ? numbered(confirmed) : ["  nobody yet"]));
      L.push(`BENCH (${bench.length}), in order, each with their place:`);
      L.push(...(bench.length ? numbered(bench) : ["  nobody"]));
      const playing = new Set(state.rows.filter((r) => r.status === "CONFIRMED").map((r) => r.userId));
      const side = (team: "RED" | "YELLOW") =>
        state.teams.filter((x) => x.team === team && playing.has(x.userId)).map((x) => print(x.userId));
      L.push(
        state.teams.length > 0
          ? `TEAMS (made): ${state.teamLabels[0]}: ${side("RED").join(", ")}. ${state.teamLabels[1]}: ${side("YELLOW").join(", ")}.`
          : "TEAMS: not made yet.",
      );
      const dropped = state.rows.filter((r) => r.status === "DROPPED").sort((a, b) => a.position - b.position).map((r) => print(r.userId));
      if (dropped.length) L.push(`OUT (said they can't play): ${dropped.join(", ")}`);
      // Who has no number on record: the players' group and HQ as the
      // phones answer always said it; a DM only for an admin (dm-qa.ts).
      if (audience !== "dm" || askerIsAdmin) {
        const byId = new Map(state.roster.map((m) => [m.userId, m]));
        const missing = state.rows
          .filter((r) => r.status === "CONFIRMED" || r.status === "BENCH")
          .sort((a, b) => a.position - b.position)
          .filter((r) => byId.get(r.userId)?.hasPhone === false)
          .map((r) => print(r.userId));
        L.push(`NO PHONE NUMBER ON RECORD (squad and bench): ${missing.length ? missing.join(", ") : "nobody"}`);
      }
    }
  }

  // RESULTS.
  const last = state.completedMatch;
  if (last) {
    const labels = last.teamLabels ?? state.teamLabels;
    L.push(
      "",
      last.redScore !== null && last.yellowScore !== null
        ? `LAST MATCH PLAYED: ${last.kickoffLabel}, ${labels[0]} ${last.redScore}, ${labels[1]} ${last.yellowScore}`
        : `LAST MATCH PLAYED: ${last.kickoffLabel}, no score recorded`,
    );
  }
  if (input.results && input.results.rows.length) {
    L.push(`RECENT RESULTS, newest first (${input.results.rows.length}${input.results.more ? ", older ones not shown" : ""}):`);
    for (const r of input.results.rows) L.push(`  ${r.dayLabel}: ${r.redLabel} ${r.red}, ${r.yellowLabel} ${r.yellow}`);
  } else if (input.results) {
    L.push("RECENT RESULTS: none recorded.");
  }

  // THE STATS, by audience.
  if (state.features.statsQa && input.stats) {
    L.push("", ...statsLines(input, input.stats, squadIds));
  } else if (!state.features.statsQa) {
    L.push("", "STATS: this club has stats answers switched off.");
  }

  // MONEY AND WHO HAS RATED: by audience, here and nowhere else.
  L.push("");
  if (audience === "organisers") {
    L.push(...paymentLines(input.payments));
  } else if (audience === "players") {
    L.push("PAYMENTS: not shared in the players' group. The money collector and the organisers have them.");
  } else {
    L.push("PAYMENTS: only the asker's own payments are known here (the asker's own block below, when present); nobody else's.");
  }
  L.push(...ratingLines(input.ratingProgress, askerIsAdmin));

  for (const block of input.own ?? []) L.push("", block);

  // THE CHAT.
  L.push("");
  if (audience === "dm") {
    L.push("════ THE CHAT: what MatchTime said to them in private ════", input.dmChat ?? "nothing");
  } else {
    const recent = chatLines(input.history.filter((h) => !(h.body === input.question)));
    const timed = (input.chatWindow ?? (input.history.some((h) => h.at) ? "week" : "recent")) === "week";
    L.push(
      timed
        ? "════ THE CHAT: the last 7 days in this group, oldest first (day and time, London). For what the records do not hold; where it disagrees with the records, the records are right. ════"
        : "════ THE CHAT: the last few messages in this group, oldest first. For what the records do not hold; where it disagrees with the records, the records are right. ════",
    );
    if (recent.length) {
      L.push(...recent.map((r) => r.line));
      if (timed) {
        const said = new Map<string, number>();
        for (const r of recent) if (r.who !== "MatchTime" && r.who !== "a member") said.set(r.who, (said.get(r.who) ?? 0) + 1);
        const top = [...said].sort((a, b) => b[1] - a[1]).slice(0, 10);
        if (top.length) L.push(`MESSAGES PER MEMBER IN THIS CHAT, most first: ${top.map(([n, c]) => `${n} ${c}`).join(", ")}`);
      }
    } else {
      L.push("  nothing");
    }
    const lastPostInChat = !!input.lastBotPost && recent.some((r) => r.body.trim() === input.lastBotPost!.trim());
    if (input.lastBotPost && !lastPostInChat) L.push(`MATCHTIME'S LAST POST: ${input.lastBotPost}`);
    L.push(renderGroupReplyContext({ now: input.now, quoted: input.reply }));
  }

  L.push("", `THE MESSAGE (from ${scrubAuthor(input.askerName)}):`, input.question.trim());

  const text = scrubPhones(L.join("\n"));
  // Every name the context prints may be said: the members, and anyone a
  // table, a Man of the Match line or a match's ratings name.
  const names: string[] = [];
  const s = input.stats;
  for (const n of [
    ...state.roster.map((m) => m.name),
    ...(s
      ? [
          ...s.ratings.map((r) => r.name),
          ...s.mom.map((r) => r.name),
          ...s.appearances.map((r) => r.name),
          ...s.elo.map((r) => r.name),
          ...s.mrReliable.map((r) => r.name),
          ...(s.teamOfSeason?.slots.map((x) => x.name) ?? []),
          ...(s.lastMom?.recent ?? []).flatMap((m) => m.tally.map((x) => x.name)),
          ...(s.lastMom?.last?.tally.map((x) => x.name) ?? []),
        ]
      : []),
    ...(input.lastMatchRatings?.rows.map((r) => r.name) ?? []),
  ]) {
    if (n.trim() && text.includes(n) && !names.includes(n)) names.push(n);
  }
  return { text, names };
}

export type UnifiedAnswerResult = { text: string } | { rejected: string };

/**
 * PURE. Does a reply to the players' group of a club whose organisers post
 * the list reproduce the squad list (2026-11-11)? Its context names nobody
 * in the squad, so a reply can only list them by copying a list from the
 * chat. Read against the records, not the words: it names at least two
 * thirds of the squad (and at least 4, or the whole squad when it is
 * smaller), and nobody outside the squad and the bench. A ratings table (which names players who are not in the squad, and
 * at most `GROUP_LIST_CAP` of them) and a count pass.
 */
export function reproducesSquad(reply: string, state: SquadState): boolean {
  const named = membersNamed(reply, state.roster);
  const confirmed = new Set(state.rows.filter((r) => r.status === "CONFIRMED").map((r) => r.userId));
  const onList = new Set(state.rows.filter((r) => r.status === "CONFIRMED" || r.status === "BENCH").map((r) => r.userId));
  const squadNamed = [...named].filter((id) => confirmed.has(id)).length;
  const outside = [...named].filter((id) => !onList.has(id)).length;
  if (confirmed.size < 2 || outside > 0) return false;
  return squadNamed >= Math.max(Math.min(4, confirmed.size), Math.ceil((2 * confirmed.size) / 3));
}

/**
 * One grounded answer, ONE call. NEVER THROWS: a failed call, an
 * unparseable body and a refused reply are all `rejected`, with the reason.
 * A number written as a word is checked as the number it stands for
 * (2026-11-11: "once a place opens" refused a correct bench answer), so
 * there is no second call for it any more.
 */
export async function answerUnified(
  args: UnifiedAnswerInput & { model: PipelineModel },
): Promise<{ result: UnifiedAnswerResult; costUsd: number; ms: number; called: boolean; inputTokens: number; calls: number }> {
  const ctx = buildUnifiedContext(args);
  let text: string;
  let costUsd = 0;
  let ms = 0;
  let inputTokens = 0;
  try {
    const resp = await args.model.complete({
      ...UNIFIED_ANSWER_CALL,
      system: UNIFIED_ANSWER_SYSTEM,
      user: ctx.text,
      maxTokens: UNIFIED_ANSWER_MAX_TOKENS,
      schema: SCHEMA as unknown as Record<string, unknown>,
      label: "unified-answer",
    });
    costUsd = resp.costUsd ?? 0;
    ms = resp.ms;
    inputTokens = resp.usage.inputTokens + (resp.usage.cacheReadTokens ?? 0) + (resp.usage.cacheWriteTokens ?? 0);
    const raw = extractJson(resp.text) as { answer?: unknown };
    text = typeof raw?.answer === "string" ? raw.answer : "";
  } catch (err) {
    return { result: { rejected: `the unified answer call failed (${(err as Error).message})` }, costUsd, ms, called: true, inputTokens, calls: 1 };
  }
  const lang = args.state.features.language;
  const tidy = stripLongDashes(text, lang).trim();
  const check = groundingCheck({
    reply: tidy,
    question: "",
    grounding: { names: ctx.names, numbers: ctx.text.match(/\d+(?:[.,]\d+)?/g) ?? [] },
    roster: args.state.roster,
    numberWords: "check",
  });
  let result: UnifiedAnswerResult = check.ok ? { text: tidy } : { rejected: `grounding check failed: ${check.why}` };
  // The organisers post the list: a reply that copies the squad from the
  // chat is their line instead. Anything else (a table, a count) stands.
  if ("text" in result && args.audience === "players" && args.state.features.listAnnouncer === "organisers" && reproducesSquad(result.text, args.state)) {
    result = { text: t(lang).oa_list_by_organisers };
  }
  return { result, costUsd, ms, called: true, inputTokens, calls: 1 };
}
