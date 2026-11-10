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
import { buildGenericStatsContext } from "./stats-generic";
import { groundingCheck } from "./stats-grounding";
import { namesByStatus, printedNames, safeName } from "./compose";
import { chatLines, scrubAuthor, scrubPhones } from "./open-answer";
import { GROUP_LIST_CAP } from "./stats-answer";
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

export const UNIFIED_ANSWER_SYSTEM = `You are MatchTime, the assistant in a football club's WhatsApp groups. Someone has tagged you, or written to you privately, with a question or a request. Write the reply to THAT MESSAGE, using only the CONTEXT.

The CONTEXT is everything you know, written from the club's records, and it is true: who is asking and where, the club's members and admins, how the club is run, the upcoming match (kickoff, venue, fee, the squad and the bench in order, the places left, the teams if made), recent results, the last Man of the Match, the stats tables, and the chat with each line's day and time. Every count you could need is printed. Some facts are kept from some audiences on purpose, and the CONTEXT says so where it matters. What the CONTEXT does not say, you do not know: the weather, the news, other clubs, anything said in private.

Return "answer": the reply MatchTime sends.

The reply:
- answers what the message asks and nothing else, from the CONTEXT only. Never invent a name, a number, a date, a score or an event, and add no fact the message did not ask about.
- writes every number in digits exactly as the CONTEXT prints it, small ones and the first word of a sentence too ("2", "8 players", never "two", "Eight players" or "iki"), and never works out a new one: no sums, differences, averages or percentages the CONTEXT does not print.
- says so plainly, in one line, when the CONTEXT does not hold the answer, then gives what it does hold on the same point, if anything. When a fact is kept from this audience, say who has it instead of guessing.
- is short: usually 1 to 3 lines and never more than 5, or a list of names one per line when a list is what was asked for.
- gives a suggestion when one is asked for, clearly as a suggestion and with what it rests on (games played, ratings, the bench order). When the record is thin, say so. The decision stays with the people.
- changes nothing. You cannot add, drop or move a player, make or change the teams, change a setting, send a message or take a payment from here, so never say you did or will. When the message asks you to do something, say you can't from this message, and who can when the CONTEXT shows it.
- never contains a phone number, and says nothing about anyone's private messages.
- is written once, finished: plain WhatsApp text spoken as MatchTime, with no working out, no second thoughts or corrections, no greeting, no mention of "the CONTEXT", no dashes as punctuation, no slashes between words. The bench is always "the bench".
- is in the language of the message: English, or Turkish when the message is in Turkish (when it is unclear, the club's language). In Turkish, speak to a group in the plural, with no "abi" or "beyler"; say "yedek" for the bench, "maçın adamı" for Man of the Match and "puan" for a rating; put a name or a number after a colon or in brackets rather than gluing a suffix onto it; write a decimal with a comma.

Examples, English and Turkish:
- "how many spaces left?" / "kaç kişi eksiğiz?", with places left 3: "3 places left for Tue 21:30." / "Salı 21:30 için 3 yer boş."
- "is Zair playing?" / "Zair geliyor mu?", with Zair Malik 2nd on the bench: "Zair Malik is on the bench, 2nd in line." / "Zair Malik yedekte, sırada 2."
- "who won Man of the Match last week?" / "geçen haftanın maçın adamı kim?", with the last one on Tue 3 Nov: "Ali Kaya, on Tue 3 Nov, with 5 of the 11 votes." / "Maçın adamı (3 Kasım Salı): Ali Kaya, 5 oy (toplam 11)."
- "who hasn't paid?" / "kim ödemedi?", in the players' group: "I don't share payments in the group. The collector (Elvin Aliyev) has them." / "Ödemeleri grupta paylaşmıyorum. Toplayan kişide (Elvin Aliyev) var."
- "who should come up from the bench?" / "yedekten kim çıksın?": "A suggestion, by games played: Ali Kaya (12), then Can Demir (3). It's the organisers' call." / "Önerim, oynanan maça göre: Ali Kaya (12), sonra Can Demir (3). Karar organizatörlerin."
- "is it going to rain tonight?" / "bu akşam yağmur var mı?": "I can't see the weather. Kickoff is Fri 20:30 at Goals." / "Hava durumunu göremiyorum. Maç: Cuma 20:30, Goals."
- "can you drop Sam and add Ali?" / "Sam'i çıkarıp Ali'yi ekler misin?": "I can't change the squad from a question. Sam can say OUT, and Ali can say IN." / "Bir sorudan kadroyu değiştiremem. Sam OUT, Ali IN yazabilir."`;

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
  /** A monthly club whose month has not started (`month-not-started.ts`):
   *  the squad starts from the month's list, not from who said IN. */
  monthNotStarted?: boolean;
  /** A DM only: the asker's own blocks, already written by the caller
   *  (`dm-qa.ts`: YOUR STATS, YOUR PAYMENTS). */
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

const numbered = (names: string[]) => names.map((n, i) => `  ${i + 1}. ${n}`);
const d1 = (x: number) => x.toFixed(1);

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
  if (!r.ok) return [`RATINGS FOR THE LAST MATCH: ${r.reason ?? "nothing to check"}`];
  const L = [
    `RATINGS FOR THE LAST MATCH (${[r.matchName, r.matchWhen].filter(Boolean).join(", ")}): ${r.ratedCount ?? 0} of ${r.confirmed ?? 0} who played have rated${r.momVote !== false ? `, ${r.momCount ?? 0} have voted for Man of the Match` : ""}.`,
  ];
  if (names) {
    L.push(`- Not rated yet: ${r.notRated && r.notRated.length ? r.notRated.join(", ") : "nobody"}`);
    if (r.ratedNoMom && r.ratedNoMom.length) L.push(`- Rated but no Man of the Match vote: ${r.ratedNoMom.join(", ")}`);
  } else {
    L.push("- Who has or has not rated is only shown to the organisers.");
  }
  return L;
}

function periodLines(p: UnifiedPeriod): string[] {
  const L = [`STATS, ${p.label.toUpperCase()} (since ${formatLondon(p.tables.since, "EEE d MMM yyyy")}):`];
  const apps = p.tables.appearances.slice(0, GROUP_LIST_CAP);
  L.push(apps.length ? `- Appearances: ${apps.map((r) => `${r.name} ${r.matches}`).join(", ")}` : "- Appearances: none recorded");
  const rat = p.tables.ratings.slice(0, GROUP_LIST_CAP);
  if (rat.length) L.push(`- Ratings: ${rat.map((r) => `${r.rank}. ${r.name} ${d1(r.avg)} (${r.games} rated)`).join(", ")}`);
  const mom = p.tables.mom.slice(0, GROUP_LIST_CAP);
  if (mom.length) L.push(`- Man of the Match wins: ${mom.map((r) => `${r.name} ${r.wins}`).join(", ")}`);
  return L;
}

/**
 * PURE. The user turn: the CONTEXT, then THE MESSAGE. Every audience rule
 * is applied here; see the header.
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
    `WHO IS ASKING: ${scrubAuthor(asker ? (asker.displayName ?? asker.name) : input.askerName)}${asker ? (asker.isAdmin ? ", an admin" : ", a member") : ""}, ${where}`,
  );
  L.push(`THE CLUB SPEAKS: ${state.features.language === "tr" ? "Turkish" : "English"}`);
  L.push(`TODAY: ${formatLondon(input.now, "EEE d MMM yyyy, HH:mm")} (London)`);

  const members = state.roster.map((m) => safeName(m.displayName ?? m.name, "")).filter(Boolean);
  if (members.length) L.push(`MEMBERS (${members.length}): ${members.join(", ")}`);
  const admins = state.roster.filter((m) => m.isAdmin).map((m) => safeName(m.displayName ?? m.name, "")).filter(Boolean);
  L.push(`ADMINS: ${admins.length ? admins.join(", ") : "none on record"}`);

  // HOW THE CLUB IS RUN: the `club` answer's facts and the club's switches.
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
  if (input.clubFacts) {
    L.push(`- Partner clubs (clubs that lend each other players when short): ${input.clubFacts.partners.active} active`);
    L.push(`- MatchTime player pool (nearby players asked when the club is short): ${input.clubFacts.pool.open ? "on" : "off"}`);
  }
  if (state.smallerFormats.length) {
    L.push(`- Smaller formats the club can play: ${state.smallerFormats.map((f) => `${f.sportName} (${f.totalPlayers} players)`).join(", ")}`);
  }

  // THE UPCOMING MATCH, as the open answer shows it, plus who has no
  // number on record (never the number itself).
  L.push("");
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
      L.push("- The organisers post the list, so no squad, bench or team names are given here, and MatchTime names nobody in the squad or on the bench, even when the chat shows the list.");
    } else {
      L.push(`SQUAD, in the order they joined:`);
      L.push(...(confirmed.length ? numbered(confirmed) : ["  nobody yet"]));
      L.push("BENCH, in order:");
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

  // THE STATS: the generic stats answer's own block (top of each list, the
  // last Man of the Match, one player's pairings, the nemesis only for the
  // asker), then shorter spans, then the record's size.
  const names: string[] = [];
  if (state.features.statsQa && input.stats) {
    const tables = buildGenericStatsContext({
      snapshot: input.stats,
      lang: state.features.language,
      personUserId: input.person?.userId ?? null,
      self: input.person?.self ?? false,
      roster: state.roster,
    });
    names.push(...tables.grounding.names);
    L.push("", "STATS:", tables.text);
    for (const p of input.periods ?? []) L.push("", ...periodLines(p));
    if (typeof input.stats.completedMatches === "number") {
      L.push("", `Completed games MatchTime has recorded for this club: ${input.stats.completedMatches}`);
    }
    L.push(`The full tables are on the stats page: ${input.stats.fullTableUrl}`);
  } else if (!state.features.statsQa) {
    L.push("", "STATS: this club has stats answers switched off.");
  }

  // MONEY AND RATINGS: by audience, here and nowhere else.
  L.push("");
  if (audience === "organisers") {
    L.push(...paymentLines(input.payments));
  } else if (audience === "players") {
    L.push("PAYMENTS: not shared in the players' group. The money collector and the organisers have them.");
  } else {
    L.push("PAYMENTS: only the asker's own payments are known here (YOUR PAYMENTS below, when present); nobody else's.");
  }
  L.push(...ratingLines(input.ratingProgress, askerIsAdmin));

  for (const block of input.own ?? []) L.push("", block);

  // THE CHAT.
  L.push("");
  if (audience === "dm") {
    L.push("WHAT MATCHTIME SAID TO THEM IN PRIVATE:", input.dmChat ?? "nothing");
  } else {
    const recent = chatLines(input.history.filter((h) => !(h.body === input.question)));
    const timed = (input.chatWindow ?? (input.history.some((h) => h.at) ? "week" : "recent")) === "week";
    if (recent.length) {
      L.push(timed ? "CHAT OF THE LAST 7 DAYS IN THIS GROUP, oldest first (day and time, London):" : "RECENT CHAT IN THIS GROUP (the last few messages only), oldest first:");
      L.push(...recent.map((r) => r.line));
      if (timed) {
        const said = new Map<string, number>();
        for (const r of recent) if (r.who !== "MatchTime" && r.who !== "a member") said.set(r.who, (said.get(r.who) ?? 0) + 1);
        const top = [...said].sort((a, b) => b[1] - a[1]).slice(0, 10);
        if (top.length) L.push(`MESSAGES PER MEMBER IN THIS CHAT, most first: ${top.map(([n, c]) => `${n} ${c}`).join(", ")}`);
      }
    } else {
      L.push(timed ? "CHAT OF THE LAST 7 DAYS IN THIS GROUP: nothing" : "RECENT CHAT IN THIS GROUP: nothing");
    }
    const lastPostInChat = !!input.lastBotPost && recent.some((r) => r.body.trim() === input.lastBotPost!.trim());
    if (input.lastBotPost && !lastPostInChat) L.push(`MATCHTIME'S LAST POST: ${input.lastBotPost}`);
    L.push(renderGroupReplyContext({ now: input.now, quoted: input.reply }));
  }

  L.push("", `THE MESSAGE (from ${scrubAuthor(input.askerName)}):`, input.question.trim());

  const text = scrubPhones(L.join("\n"));
  for (const m of state.roster) if (m.name.trim() && text.includes(m.name) && !names.includes(m.name)) names.push(m.name);
  return { text, names };
}

export type UnifiedAnswerResult = { text: string } | { rejected: string };

/**
 * One grounded answer. NEVER THROWS: a failed call, an unparseable body and
 * a refused reply are all `rejected`, with the reason.
 */
/** The one refusal worth a second call: a number written as a word, which
 *  the A/B (2026-11-10) saw in 12 of 237 answers ("Eight players", "two").
 *  The second call is told so; anything else refused is final. */
const NUMBER_WORD_RETRY = "\n\nWRITE EVERY NUMBER IN DIGITS, also at the start of a sentence.";

export async function answerUnified(
  args: UnifiedAnswerInput & { model: PipelineModel },
): Promise<{ result: UnifiedAnswerResult; costUsd: number; ms: number; called: boolean; inputTokens: number; calls: number }> {
  const ctx = buildUnifiedContext(args);
  let costUsd = 0;
  let ms = 0;
  let inputTokens = 0;
  let calls = 0;
  let result: UnifiedAnswerResult = { rejected: "not called" };
  for (const user of [ctx.text, ctx.text + NUMBER_WORD_RETRY]) {
    let text: string;
    calls++;
    try {
      const resp = await args.model.complete({
        ...UNIFIED_ANSWER_CALL,
        system: UNIFIED_ANSWER_SYSTEM,
        user,
        maxTokens: UNIFIED_ANSWER_MAX_TOKENS,
        schema: SCHEMA as unknown as Record<string, unknown>,
        label: "unified-answer",
      });
      costUsd += resp.costUsd ?? 0;
      ms += resp.ms;
      inputTokens += resp.usage.inputTokens + (resp.usage.cacheReadTokens ?? 0) + (resp.usage.cacheWriteTokens ?? 0);
      const raw = extractJson(resp.text) as { answer?: unknown };
      text = typeof raw?.answer === "string" ? raw.answer : "";
    } catch (err) {
      return { result: { rejected: `the unified answer call failed (${(err as Error).message})` }, costUsd, ms, called: true, inputTokens, calls };
    }
    const tidy = stripLongDashes(text, args.state.features.language).trim();
    const check = groundingCheck({
      reply: tidy,
      question: "",
      grounding: { names: ctx.names, numbers: ctx.text.match(/\d+(?:[.,]\d+)?/g) ?? [] },
      roster: args.state.roster,
    });
    result = check.ok ? { text: tidy } : { rejected: `grounding check failed: ${check.why}` };
    if (check.ok || !/number written as a word/.test(check.why)) break;
  }
  return { result, costUsd, ms, called: true, inputTokens, calls };
}
