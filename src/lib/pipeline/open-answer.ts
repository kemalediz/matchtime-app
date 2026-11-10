/**
 * THE OPEN ANSWER (Kemal, 2026-11-10): a tagged question that fits none of
 * MatchTime's set answers is still answered.
 *
 * Kemal: "All I'm asking for is a category where nothing fits in, but still
 * MatchTime uses the LLM to understand the question based on the messages
 * that have been going on in the group, and try to answer that message
 * within the context." The bucket is the question extractor's existing
 * `other` topic ("anything else"); no new topic, action or special case.
 * Until today `other` was owned by nobody: the asker got the not-understood
 * line (players' group, `tagged-silence.ts`) or HQ's one line.
 *
 * ONE model call answers THE MESSAGE from a CONTEXT this module writes. The
 * same three things keep it honest as keep the generic stats answer honest
 * (`stats-generic.ts`), in order of strength:
 *
 *   1. WHAT IT IS GIVEN. `buildOpenAnswerContext` writes only what the set
 *      answers would already say to this audience: the upcoming match and
 *      its squad and bench (no names in the players' group of a club whose
 *      organisers announce the list, nothing at all when the club keeps no
 *      squad), the club's setup (the `club` answer's facts), the last
 *      result, the stats tables exactly as the generic stats answer sees
 *      them (top of each list, no other player's nemesis, no seed), the
 *      count of games recorded, and the chat of THIS group over the last
 *      7 days with each line's day and time (`week-chat.ts`, Kemal
 *      2026-11-10; the players' group never sees HQ's, nor HQ the
 *      players'). Never payments, who has rated, who has a phone number,
 *      DMs, or another club. Phone numbers are scrubbed from the chat;
 *      a club whose organisers post the list is told MatchTime names
 *      nobody in the squad even when the chat shows the list. What the
 *      model is not told it
 *      cannot leak.
 *   2. WHAT IT MAY SAY. Every number and every member it names must be in
 *      that context (`stats-grounding.ts`, the same check), so an invented
 *      figure or a phone number is refused.
 *   3. WHAT HAPPENS WHEN IT FAILS. Never throws; a failed call or a refused
 *      reply is `rejected`, the composer says nothing, `answer-batch.ts`
 *      disowns the message, and the asker gets exactly today's line.
 *
 * IT CHANGES NOTHING, structurally: this module has no database access and
 * returns a string; the engine emits a speech intent and no write
 * (`__tests__/zero-writes.test.ts` scans this directory), and the prompt
 * says it may never claim to have done anything.
 *
 * The call is Haiku 5.5 through the pipeline's `PipelineModel` (stubbed in
 * tests, metered in the batch's cost line), capped at
 * `HAIKU_SHORT_ANSWER_MAX_TOKENS`. The paid check is
 * `scripts/live-check-open-answer.ts`.
 */
import { extractJson, HAIKU_CALL, type ModelCall, type PipelineModel } from "./llm";
import { HAIKU_SHORT_ANSWER_MAX_TOKENS } from "../models";
import { buildGenericStatsContext } from "./stats-generic";
import { groundingCheck } from "./stats-grounding";
import { namesByStatus, printedNames, safeName } from "./compose";
import { renderGroupReplyContext, type QuotedGroupMessage } from "../reply-context";
import { activityFeeText } from "../activity-fee";
import { stripLongDashes } from "../house-style";
import { formatLondon } from "../london-time";
import { WEEK_CHAT_MAX_LINES } from "../week-chat-window";
import type { SquadState, StatsSnapshot } from "./types";

export const OPEN_ANSWER_SYSTEM = `You are MatchTime, the assistant in a football club's WhatsApp groups. Someone tagged you with a message that none of your ready-made answers covers. Write the reply to THAT MESSAGE, using only the CONTEXT you are given.

The CONTEXT is everything you know about this club, and it is true: its members and admins, its setup (who collects the money, the fee, when the teams are made), the upcoming match (the squad and the bench in order, the places left, who fills an open place), the last result, the stats tables, how many games MatchTime has recorded, the group's chat of the last 7 days, oldest first, each line with its day and time and MatchTime's own lines included, and the message being replied to. Read the chat to see what the message is about and to answer what was said in it. What the CONTEXT does not say, you do not know: the weather, the news, other clubs, anything said in private.

Return "answer": the reply MatchTime posts in the group.

The reply:
- answers from the CONTEXT only. Never invent a name, a number, a date or an event. Write every number in digits exactly as the CONTEXT prints it, small ones too ("2", never "two" or "iki"), and never work out a new one.
- says so plainly, in one line, when the CONTEXT does not hold the answer, and then gives what the CONTEXT does hold on the same point, if anything.
- gives a suggestion when one is asked for, clearly as a suggestion and with what it rests on (games played, ratings, the bench order). When MatchTime has recorded only a few games, it says the data is thin. The decision stays with the people.
- changes nothing. You cannot add, drop or move a player, make or change the teams, change a setting, send a message or take a payment from here, so never say you did or will. When the message asks you to do something, say you can't from this message, and when the CONTEXT shows who can, say who.
- never contains a phone number, and says nothing about who has paid or about anyone's private messages.
- is the finished message only, at most 5 short lines of plain WhatsApp text, spoken as MatchTime: no working out, no greeting, no mention of "the CONTEXT", no dashes as punctuation, no slashes between words. The bench is always called "the bench".
- is in the language of the message: English, or Turkish when the message is in Turkish (when it is unclear, the club's language). In Turkish, speak to the group in the plural, with no "abi" or "beyler"; say "yedek" for the bench, "maçın adamı" for Man of the Match and "puan" for a rating; put a name or a number after a colon or in brackets rather than gluing a suffix onto it; write a decimal with a comma.

Examples, English and Turkish:
- "who should come up from the bench?" / "yedekten kim çıksın?", with Ali Kaya then Can Demir on the bench and appearances Ali Kaya 12, Can Demir 3: "A suggestion, by games played: Ali Kaya (12), then Can Demir (3). It's the organisers' call." / "Önerim, oynanan maça göre: Ali Kaya (12), sonra Can Demir (3). Karar organizatörlerin."
- "is it going to rain tonight?" / "bu akşam yağmur var mı?": "I can't see the weather. Kickoff is Fri 20:30 at Goals." / "Hava durumunu göremiyorum. Maç: Cuma 20:30, Goals."
- "what did Sam say about parking?" / "Sam park yeri hakkında ne dedi?": what Sam said, in a few words, when his line is in the chat; otherwise "I can't see Sam saying anything about parking in this week's chat." / "Bu haftaki mesajlarda Sam'in park yeri hakkında bir şey yazdığını göremiyorum."
- "can you book the pitch for next week?" / "gelecek hafta için sahayı ayırır mısın?": "I can't book pitches. The admins (Ali Kaya, Can Demir) can." / "Saha ayıramam. Yöneticiler (Ali Kaya, Can Demir) ayırabilir."`;

/** Haiku 5.5, adaptive thinking at the shared effort, like every Haiku site. */
export const OPEN_ANSWER_CALL: ModelCall = HAIKU_CALL;
/** The hard cap. Haiku's thinking shares it; the answer is a few lines. */
export const OPEN_ANSWER_MAX_TOKENS = HAIKU_SHORT_ANSWER_MAX_TOKENS;
/** The chat lines shown: the group's week, newest 300 (`week-chat.ts`;
 *  Kemal 2026-11-10, "all messages since last 1 week"). */
export const OPEN_ANSWER_CHAT_MAX_LINES = WEEK_CHAT_MAX_LINES;
/** The input budget for the chat, in characters (about 15k tokens at the
 *  measured 2.6 characters a token): past it the OLDEST lines go, so a
 *  week of long posts cannot run the call's cost up. */
export const OPEN_ANSWER_CHAT_MAX_CHARS = 40_000;
/** The members named in the chat's message counts, most first. */
const CHAT_COUNTS_SHOWN = 10;
/** One line's words, at most: a long post is cut, not dropped. */
const CHAT_LINE_MAX_CHARS = 600;

const SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
} as const;

/** What the batch hands the open answer for one message. */
export interface OpenAnswerInput {
  /** The batch's state, with `club` loaded when the read succeeded. */
  state: SquadState;
  /** The stats tables, or null when stats Q&A is off or the read failed. */
  stats: StatsSnapshot | null;
  /** The players' group, or the organisers in HQ (`AnswerAudience`). */
  audience: "players" | "organisers";
  /** False when the batch could not vouch for the upcoming squad (no match,
   *  the route's match and the state's disagree, a format of 0 players). */
  squadKnown: boolean;
  /** The group's chat of the last 7 days, oldest first, MatchTime's lines
   *  as "MatchTime", each with when it was said (`week-chat.ts`). Lines
   *  with no `at` are the extractors' few recent lines, the fallback when
   *  the week could not be read. */
  history: Array<{ author: string | null; body: string; at?: Date | null }>;
  /** Which chat `history` is: the group's week (`week-chat.ts`), or the
   *  extractors' few recent lines when the week could not be read. Absent:
   *  the week when the lines carry their times. */
  chatWindow?: "week" | "recent";
  lastBotPost: string | null;
  /** The message this one is a WhatsApp reply to, whoever wrote it. */
  reply: QuotedGroupMessage | null;
  now: Date;
  /** THE MESSAGE, as the router read it. */
  question: string;
  askerName: string | null;
}

/** A run of nine or more digits, with the spaces, dots, dashes and
 *  brackets people write in phone numbers, and an optional "+" or "@". */
const PHONE_RUN = /[+@]?\(?\d[\d\s().-]{7,}\d/g;
const HIDDEN = "[number hidden]";

/** PURE. Phone numbers out of any text the model is shown. */
function scrubPhones(text: string): string {
  return text.replace(PHONE_RUN, (m) => (m.replace(/\D/g, "").length >= 9 ? HIDDEN : m));
}

function scrubAuthor(author: string | null): string {
  if (!author) return "a member";
  const a = author.trim();
  if (!/\p{L}/u.test(a) || scrubPhones(a) !== a) return "a member";
  return a;
}

/**
 * PURE. The chat as the model reads it: "[Mon 9 Nov 19:33] Ali Kaya: ..."
 * (London), MatchTime's lines as MatchTime, an author that is a phone
 * number or no name as "a member", a long post's later lines indented
 * under it and its words cut at `CHAT_LINE_MAX_CHARS`. The newest
 * `OPEN_ANSWER_CHAT_MAX_LINES` that fit `OPEN_ANSWER_CHAT_MAX_CHARS`.
 */
function chatLines(history: OpenAnswerInput["history"]): Array<{ body: string; line: string; who: string }> {
  const out: Array<{ body: string; line: string; who: string }> = [];
  let chars = 0;
  for (const h of history.slice(-OPEN_ANSWER_CHAT_MAX_LINES).reverse()) {
    const who = (h.author ?? "").toLowerCase() === "matchtime" ? "MatchTime" : scrubAuthor(h.author);
    const words = h.body.trim().length > CHAT_LINE_MAX_CHARS ? `${h.body.trim().slice(0, CHAT_LINE_MAX_CHARS)}...` : h.body.trim();
    const when = h.at ? `[${formatLondon(h.at, "EEE d MMM HH:mm")}] ` : "";
    const line = `  ${when}${who}: ${words.replace(/\n/g, "\n    ")}`;
    if (chars + line.length + 1 > OPEN_ANSWER_CHAT_MAX_CHARS) break;
    chars += line.length + 1;
    out.push({ body: h.body, line, who });
  }
  return out.reverse();
}

const numbered = (names: string[]) => names.map((n, i) => `  ${i + 1}. ${n}`);

/**
 * PURE. The user turn: the CONTEXT, then THE MESSAGE. Built only from what
 * the set answers already show this audience; see the header.
 */
export function buildOpenAnswerContext(input: OpenAnswerInput): { text: string; names: string[] } {
  const { state, audience } = input;
  const L: string[] = [];
  const fallback = "a player";
  const nameOf = printedNames(state);
  const print = (userId: string) => safeName(nameOf.get(userId) ?? "", fallback);

  L.push(`THE CLUB SPEAKS: ${state.features.language === "tr" ? "Turkish" : "English"}`);

  const members = state.roster.map((m) => safeName(m.displayName ?? m.name, "")).filter(Boolean);
  if (members.length) L.push(`MEMBERS (${members.length}): ${members.join(", ")}`);
  const admins = state.roster.filter((m) => m.isAdmin).map((m) => safeName(m.displayName ?? m.name, "")).filter(Boolean);
  L.push(`ADMINS: ${admins.length ? admins.join(", ") : "none on record"}`);

  // THE CLUB'S SETUP: the `club` answer's own facts (compose.ts answer_club).
  const club = state.club;
  if (club) {
    L.push(`MONEY COLLECTOR: ${club.collectorName ? safeName(club.collectorName, "not set") : "not set"}`);
    L.push(
      `MATCH FEE: ${club.feePerPlayer !== null ? `£${activityFeeText(club.feePerPlayer)} a player` : club.feeSplitTotal ? "the pitch cost split between who played" : "not set"}`,
    );
    L.push(`TEAMS ARE MADE: ${club.teamsReady === "off" ? "when an organiser asks" : `at ${club.teamsReady} on match day`}`);
  }

  // THE UPCOMING MATCH. The squad is shown to exactly whom the set answers
  // show it: never when the club keeps none, never when the batch could not
  // vouch for it, and by count only in the players' group of a club whose
  // organisers announce the list (compose.ts, `organisersAnnounce`).
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
    L.push(`Places left: ${Math.max(0, state.maxPlayers - confirmed.length)}`);
    L.push(
      `Who fills an open place: ${state.features.benchPickMode === "organiser" ? "the organisers choose from the bench" : "the first on the bench moves up"}`,
    );
    const hideNames = audience === "players" && state.features.listAnnouncer === "organisers";
    if (hideNames) {
      L.push(`SQUAD: ${confirmed.length} of ${state.maxPlayers}. The organisers post the list, so no squad or bench names are given here, and MatchTime names nobody in the squad or on the bench, even when the chat shows the list.`);
      L.push(`BENCH: ${bench.length} on the bench.`);
    } else {
      L.push(`SQUAD, ${confirmed.length} of ${state.maxPlayers}, in the order they joined:`);
      L.push(...(confirmed.length ? numbered(confirmed) : ["  nobody yet"]));
      L.push("BENCH, in order:");
      L.push(...(bench.length ? numbered(bench) : ["  nobody"]));
      const playing = new Set(state.rows.filter((r) => r.status === "CONFIRMED").map((r) => r.userId));
      const side = (team: "RED" | "YELLOW") =>
        state.teams.filter((x) => x.team === team && playing.has(x.userId)).map((x) => print(x.userId));
      if (state.teams.length > 0) {
        L.push(`TEAMS (made): ${state.teamLabels[0]}: ${side("RED").join(", ")}. ${state.teamLabels[1]}: ${side("YELLOW").join(", ")}.`);
      } else {
        L.push("TEAMS: not made yet.");
      }
    }
  }

  const last = state.completedMatch;
  if (last) {
    const labels = last.teamLabels ?? state.teamLabels;
    L.push(
      last.redScore !== null && last.yellowScore !== null
        ? `LAST MATCH PLAYED: ${last.kickoffLabel}, ${labels[0]} ${last.redScore}, ${labels[1]} ${last.yellowScore}`
        : `LAST MATCH PLAYED: ${last.kickoffLabel}, no score recorded`,
    );
  }

  // THE STATS: exactly what the generic stats answer is given (top of each
  // list, nobody's chemistry), and the record's size so a thin record is
  // said to be thin.
  if (state.features.statsQa && input.stats) {
    const tables = buildGenericStatsContext({
      snapshot: input.stats,
      lang: state.features.language,
      personUserId: null,
      self: false,
      roster: state.roster,
    });
    L.push("", "STATS:", tables.text);
    if (typeof input.stats.completedMatches === "number") {
      L.push(`Completed games MatchTime has recorded for this club: ${input.stats.completedMatches}`);
    }
  }

  // THE CHAT: the group's week, each line with its day and time (London),
  // the message itself left out (the history carries it; it is shown
  // once, last). The newest lines that fit the input budget.
  const recent = chatLines(input.history.filter((h) => !(h.body === input.question)));
  const timed = (input.chatWindow ?? (input.history.some((h) => h.at) ? "week" : "recent")) === "week";
  L.push("");
  if (recent.length) {
    L.push(timed ? "CHAT OF THE LAST 7 DAYS, oldest first (day and time, London):" : "RECENT CHAT (the last few messages only), oldest first:");
    L.push(...recent.map((r) => r.line));
    // Who said the most, counted here so the model never counts a week of
    // lines in its head (the live check, 2026-11-10: it ran out the cap).
    // Members only: not MatchTime, not an author nobody could name.
    if (timed) {
      const said = new Map<string, number>();
      for (const r of recent) if (r.who !== "MatchTime" && r.who !== "a member") said.set(r.who, (said.get(r.who) ?? 0) + 1);
      const top = [...said].sort((a, b) => b[1] - a[1]).slice(0, CHAT_COUNTS_SHOWN);
      if (top.length) L.push(`MESSAGES PER MEMBER IN THIS CHAT, most first: ${top.map(([n, c]) => `${n} ${c}`).join(", ")}`);
    }
  } else {
    L.push(timed ? "CHAT OF THE LAST 7 DAYS: nothing" : "RECENT CHAT: nothing");
  }
  const lastPostInChat = !!input.lastBotPost && recent.some((r) => r.body.trim() === input.lastBotPost!.trim());
  if (input.lastBotPost && !lastPostInChat) L.push(`MATCHTIME'S LAST POST: ${input.lastBotPost}`);
  L.push(renderGroupReplyContext({ now: input.now, quoted: input.reply }));

  L.push("", `THE MESSAGE (from ${scrubAuthor(input.askerName)}):`, input.question.trim());

  const text = scrubPhones(L.join("\n"));
  return { text, names: state.roster.map((m) => m.name).filter((n) => n.trim() && text.includes(n)) };
}

/** What the batch stores per message (`SquadState.openAnswers`). */
export type OpenAnswerResult = { text: string } | { rejected: string };

/**
 * One grounded answer. NEVER THROWS: a failed call, an unparseable body and
 * a refused reply are all `rejected`, with the reason.
 */
export async function answerOpenQuestion(
  args: OpenAnswerInput & { model: PipelineModel },
): Promise<{ result: OpenAnswerResult; costUsd: number; ms: number; called: boolean }> {
  const ctx = buildOpenAnswerContext(args);
  let text: string;
  let costUsd = 0;
  let ms = 0;
  try {
    const resp = await args.model.complete({
      ...OPEN_ANSWER_CALL,
      system: OPEN_ANSWER_SYSTEM,
      user: ctx.text,
      maxTokens: OPEN_ANSWER_MAX_TOKENS,
      schema: SCHEMA as unknown as Record<string, unknown>,
      label: "open-answer",
    });
    costUsd = resp.costUsd ?? 0;
    ms = resp.ms;
    const raw = extractJson(resp.text) as { answer?: unknown };
    text = typeof raw?.answer === "string" ? raw.answer : "";
  } catch (err) {
    return { result: { rejected: `the open-answer call failed (${(err as Error).message})` }, costUsd, ms, called: true };
  }
  const tidy = stripLongDashes(text, args.state.features.language).trim();
  // Every number and every member named must be in the context: the same
  // check the generic stats answer passes. The context's numbers include
  // the chat's, so a time or a score someone wrote is fine; a phone number
  // never is, because the context has none.
  const check = groundingCheck({
    reply: tidy,
    question: "",
    grounding: { names: ctx.names, numbers: ctx.text.match(/\d+(?:[.,]\d+)?/g) ?? [] },
    roster: args.state.roster,
  });
  return {
    result: check.ok ? { text: tidy } : { rejected: `grounding check failed: ${check.why}` },
    costUsd,
    ms,
    called: true,
  };
}
