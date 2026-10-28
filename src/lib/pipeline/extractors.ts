/**
 * STAGE 2 — EXTRACTORS. They return FACTS. They never return decisions.
 *
 * This is the heart of "the model extracts, code decides". §6.2:
 *
 *   "Note what is ABSENT: no `intent`, no `registerAttendance`, no
 *    `registerFor`, no `react`, no `reply`, no `reasoning`. There is no
 *    field in which the model can express a decision, and no prose for a
 *    regex to parse."
 *
 * Two consequences fall straight out of that:
 *
 *   • The OUT safety net (`route.ts:1012-1056`) has nothing to do. It
 *     exists only to reconcile `intent` against `registerAttendance`
 *     when the model decides them independently and they disagree —
 *     eleven regexes over the model's English prose. One `polarity`
 *     cannot contradict itself, and there is no prose here at all.
 *   • The bench-demote net (`route.ts:1060-1111`) has nothing to read.
 *     It reverse-engineers a write from `verdict.reply`; the model no
 *     longer writes replies.
 *
 * THE SQUAD STATE IS NOT PASSED, BUT IT CAN STILL BE SEEN: recent chat
 * and MatchTime's last post can show a full squad, so the prompt forbids
 * using either for `polarity` (a "bench" inferred from capacity breaks
 * PR #27's invariant, "a BENCH row means FULL or ASKED, never inferred").
 * Capacity is arithmetic; arithmetic is the engine's job.
 */
import { renderGroupReplyContext, type ContextMessage } from "../reply-context";
import {
  anthropicModel,
  degradation,
  extractJson,
  HAIKU_CALL,
  type ModelCall,
  type ModelRequest,
  type PipelineModel,
} from "./llm";
import { isAiBudgetExceeded } from "../ai-budget-context";
import { parsePeriodFields } from "./stats-period";
import { HELP_BADGES, HELP_FEATURES } from "./types";
import type {
  AdminFacts,
  AttendanceFacts,
  Claim,
  ClaimBasis,
  ConditionOn,
  Degradation,
  Facts,
  Polarity,
  QuestionFacts,
  QuestionTopic,
  Route,
  ScoreFacts,
  SideRequest,
  StatsTable,
  TeamFacts,
  Tense,
} from "./types";

const EXTRACTOR_MAX_TOKENS = 1_024;

/**
 * THE MODEL EACH EXTRACTOR RUNS ON, with its thinking posture (2026-10-20).
 *
 * Every extractor runs on Haiku 5.5. A Sonnet 5 call would turn thinking
 * off (see `ModelRequest.thinking` and `__tests__/thinking-off.test.ts`).
 * Teams, score and admin were rewritten whole on 2026-10-20 and moved to Haiku
 * 5.5 after a paid before/after check on the dev key: the live prompt on
 * Sonnet 5, the new prompt on Sonnet 5 and the new prompt on Haiku 5.5,
 * one pass of every suite that covers them (teams-live, show-teams-live,
 * extract-once-live, live-check-teams-extractor including T5,
 * live-check-score-extractor, hq-score, hq-mom, hq-chatter, admin-group,
 * free-places, corpus writes). Haiku matched or beat the live arm on
 * every case, never returned an empty answer, and costs about a
 * fifteenth per call. Moving one back is one line here.
 *
 * Question followed the same way the same day: rewritten whole, then the
 * live prompt on Sonnet 5, the new prompt on Sonnet 5 and the new prompt
 * on Haiku 5.5 through live-check-question-extractor, hq-questions,
 * reply-to-matchtime, free-places, hq-chatter, corpus answers and the
 * organisers-space spec. Haiku matched or beat the live arm on every
 * question case, at about a twentieth of the cost per call.
 *
 * Attendance was last, after the Sutton FC hamstring OUT
 * (Kieran, 14:49 UTC): rewritten whole and moved to Haiku 5.5 on the same
 * three arms, with `scripts/live-check-attendance-extractor.ts` (the
 * incident, injury cases EN and TR, #343, the 2026-09-09 echo, corpus S12
 * and S25, every shape the prompt reads) and one pass of the corpus,
 * router-regressions, the live attendance sim specs, hq-chatter,
 * free-places and admin-group.
 *
 * Admin was rewritten whole again on 2026-10-24 (local player pool L10):
 * where the players come from is ONE field, `playersFrom` ("club",
 * "partners" or the new "pool", the MatchTime player pool), replacing S6's
 * `partnerClubs` boolean; the pool's examples sit beside the partner
 * clubs', EN and TR. 7,389 to 8,503 characters. One paid pass of
 * live-check-hq-pool (new), hq-outward, partner-ask-words, free-places,
 * hq-cancel, players-cancel, admin-group, hq-questions, hq-chatter and
 * the recruit and HQ organisers-only live sims.
 *
 * Its recruit section was rewritten whole on 2026-10-28 (Kemal: "stricter
 * so MatchTime doesn't misunderstand"): where the players come from is
 * judged from meaning and never guessed, so a request that does not say
 * is a fourth value, "unsaid" (it used to be "club"), and an answer to
 * MatchTime's own "who shall I ask?" is read as recruit from the place it
 * picks. In HQ code asks which is meant (`ask-source-rules.ts`). Sizes and
 * the paid check are in the PR (scripts/live-check-ask-source.ts).
 */
export const EXTRACTOR_CALLS: Record<Exclude<ExtractorKind, "none">, ModelCall> = {
  attendance: HAIKU_CALL,
  question: HAIKU_CALL,
  teams: HAIKU_CALL,
  score: HAIKU_CALL,
  admin: HAIKU_CALL,
};

/**
 * Haiku 5.5 thinks adaptively and its thinking shares `max_tokens`. An
 * extractor's answer is under 250 tokens; measured on the 2026-10-20 arms,
 * the largest thinking-plus-answer was well inside this.
 */
const HAIKU_EXTRACTOR_MAX_TOKENS = 2_048;

function maxTokensFor(call: ModelCall): number {
  return call.model === HAIKU_CALL.model ? HAIKU_EXTRACTOR_MAX_TOKENS : EXTRACTOR_MAX_TOKENS;
}

/**
 * The routes whose extraction is retried once. See the essay in
 * `extractForRoute`.
 *
 * Deliberately spelled out here rather than derived from
 * `gate.ts:ENGINE_ROUTES`, even though the two lists are identical
 * today. They mean different things — that one is "who decides this
 * route", this one is "where is silence expensive enough to pay for a
 * second call" — and a future route could join one without joining the
 * other. `__tests__/extractors.test.ts` asserts both halves by name, so
 * a drift shows up as a named failure rather than as a silent change of
 * policy on the write path.
 */
const RETRYING_ROUTES: readonly Route[] = ["self_att", "other_att", "offer", "unsure"];

/** Which specialist a route reaches. Four routes share the attendance
 *  extractor because they are four ways of saying the same kind of
 *  thing; `unsure` is included because §11.1's asymmetry sends every
 *  doubt to the extractor rather than to silence. */
export type ExtractorKind = "attendance" | "question" | "teams" | "score" | "admin" | "none";

export function extractorFor(route: Route): ExtractorKind {
  switch (route) {
    case "self_att":
    case "other_att":
    case "offer":
    case "unsure":
      return "attendance";
    case "question":
      return "question";
    case "balancer":
      return "teams";
    case "score":
      return "score";
    case "admin_ops":
      return "admin";
    case "none":
    // The organisers' group's own routes have no extractor: code owns
    // them (`admin-group-understand.ts`).
    case "approve":
    case "poster":
    case "team_sheet":
    case "help":
    case "ask_group":
      return "none";
  }
}

// ── Prompts ────────────────────────────────────────────────────────────
//
// QUESTION, 2026-10-28: HELP IS READ HERE, IN EVERY PLACE. The regex help
// reader (`readHelpRequest`, "help" plus a known topic word) is deleted, so
// this prompt is how "@Match Time help", "how do I turn on the player
// pool?" and "havuz nasıl açılır" reach the help, in the players' group,
// HQ and DMs. The how-it-works part was rewritten as one section, not
// appended to: `how_it_works` now names help itself (what it can do, a
// bare "help", whether a part is on and how to switch it, where a setting
// is, what a badge means), `feature` gains schedule, badges, partners,
// pool and settings, a new `badge` field names one badge, and the examples
// are one "Help with MatchTime" group. 11,122 to 13,106 characters. Live
// results in the PR (scripts/live-check-question-extractor.ts).

export const EXTRACTOR_PROMPTS: Record<Exclude<ExtractorKind, "none">, string> = {
  attendance: `You read ONE message from a football club's WhatsApp group and report what it says about who is playing in the club's match. You report facts about the words. You never decide what happens next: code does that, from the club's records.

WHAT YOU ARE SHOWN
THE MESSAGE is the one message you report on, with the name of the person who typed it: the sender. Above it, as context only:
  RECENT CHAT            the last few messages before it
  MATCHTIME'S LAST POST  the bot's most recent post in the group
  NOW                    the time at the club
  THEY ARE REPLYING TO   when THE MESSAGE is a WhatsApp reply: the message it quotes, whose it is (MatchTime's or a member's), when, and its words
  CLUB MEMBERS NAMED     members of this club whose names appear in THE MESSAGE, from the club's records. A member the message calls by a nickname the club has on record is shown as that nickname with their name in brackets: "AH (Abdul-Hafeez)"
Use the context to work out what THE MESSAGE refers to: who "he" is, which line a "same" or "ben de" answers (the quoted message, when there is one), what a bare "yes" agrees to. A claim made in the context is never reported again: "same" under Ali's "IN" is one claim, the sender's.
A name on the CLUB MEMBERS NAMED line is a person in this club, even when it is also an ordinary word, a short nickname, a team or a well-known phrase: with Glazers listed, "Glazers out" says Glazers is out, and with "AH (Abdul-Hafeez)" listed, "AH IN" says AH is in. Such a claim is about that member, not the sender, and its personRef is the words the message used ("AH"). Read the sentence as you always would: a listed Will in "will you play?" is still the word "will".
The context often shows the squad: a count such as "13/14" or "14/14", a list of names, a bench, the teams. The squad shown is never a reason for any field. Code holds the real squad and places every player, so a plain "in" is "in" when the list looks full and when the sender is already on it.

THE CLAIMS
Return one claim for each person the message speaks about as a player in the match: joining, leaving, the bench, a maybe, or only whether they are free. A message that says none of that about anyone returns an empty claims array.
  subject      "sender" for the person who typed it, "other" for anyone else
  personRef    the words used for that person, VERBATIM. Never invent or expand a name. "" for the sender. One exception: a "he", "him" or "o" that points at the author of the quoted message is written as that author's name, as the THEY ARE REPLYING TO line gives it; when that line names no one ("a member (not identified)"), keep the words as they are
  personNamed  true when the words identify a particular person: a name, a nickname or an @mention, including a word that may only be a nickname (code checks every name against the squad). false only for a relationship, a quantity or an indefinite: "my brother", "2 of my guys", "someone", "a mate", "another keeper"
  polarity     what the message says that person is doing in the match:
                 "in"     joining, or staying in
                 "out"    leaving or not coming: the person gives up their place, asks for someone to take it, or says they will not or cannot play ("out", "can't make it", "anyone replace me?", "I can drop out"). An injury, a knock or tiredness on its own is not "out": someone "taking it easy" is still playing
                 "bench"  the bench, in one of two ways. The message names it explicitly: bench, reserve, sub, backup, spare, standby, waiting list, "yedek" in any form, or 🪑. Or the sender offers themselves to fill a gap, to play only if the squad is short or someone drops ("ping me if you need one more", "I can play if you're short"): that is "bench" with contingent true and conditionOn "squad", never "in" and never a maybe. Nothing else is the bench
  contingent   true when the claim depends on something the message states that has not happened yet: "in if my back holds up", "count me in if someone drops", "happy to drop if you find someone". An OFFER to give up a place is contingent with no "if" in it ("I can drop out", "happy to pull out", "I'll make room"): the test is whether the person IS doing it or only COULD. false for a decision already taken ("I'm out", "can't make it"), and for asking for cover: "anyone able to replace me?" says they are leaving, whether or not someone is found. A position is a note, not a condition, so it is false too
  conditionOn  "squad" when the condition is the squad or the team's needs, which includes every offer to fill a gap or to give up a place; "self" when it is about the person themselves; otherwise "none"
  tense        "present" now; "future" a commitment about an upcoming match, including a standing one ("count me in whenever you are short") and one with a condition; "past" something that already happened ("I was in last week"); "hypothetical" a counterfactual about something that is not the case ("if I WAS in the team it would not be ruined"). Relayed words keep the tense of what was said, not of the saying: "Najib said he's in" is present
  basis        what the message does about the place, read from the VERB used about the person:
                 "decision"      the verb acts on the place: it asks for, claims, offers to fill or gives up one ("I'm in", "put me down", "count me in", "add me", "I'll take a spot", "I'll be the 14th", "happy to fill in", "ping me if you need one more", "I'll be there", "I'm out", "can't make it"). A hedge is a decision about the place that has not been made yet, so it is "decision" too
                 "availability"  the verb describes the person's state, whereabouts or ability and leaves the place unanswered ("I'm free", "I'm around", "I'm available", "I land Monday", "I will be back Tuesday week")
               A courtesy after a state verb never promotes availability into a decision: in "I'm free if you need me" or "I'm around if you're short, let me know", the courtesy is goodwill, not an ask for a place. A message with no state verb, only the offer, is a decision. When a message has both, the place verb wins ("I'm free Tuesday, put me down" is a decision). Naming a day settles nothing either way: "I'm in for next Tuesday" is a decision, "I will be back Tuesday week" is not.
                 "I'm free Tuesday if you need me"       -> availability
                 "I'm around if you're short"            -> availability
                 "put me down if you're short"           -> decision
                 "count me as the 14th if you need one"  -> decision
                 "ping me if you need one more"          -> decision
  reported     true when relaying what someone else SAID ("Najib said he's in", "Ali geliyorum dedi"). A plain statement about someone ("Kai can't make it tonight") is not reported
  replaces     ONLY on an "in" claim, and only when the message says this person takes somebody else's place: the words used for that other person, VERBATIM ("Najib", "@Najib", "me"). "" everywhere else
  confidence   0 to 1, how sure you are that the message says this

THE WHOLE MESSAGE
  affirmation  "yes" or "no" when the message is a bare answer to MatchTime ("Confirmed", "yes", "no"): to the MatchTime message it replies to, else to MATCHTIME'S LAST POST. Otherwise "none". Words that state the sender's own place ("in", "varım", "out") are a claim, whatever they answer
  sideRequests any of, for what else the message asks for beside its claims:
                 "recruit"   it says how many players are needed or whose place needs taking ("we're 4 short, anyone free?", "can someone take my spot?")
                 "chase"     it nudges for more players without saying how many or for whom ("@all we need more players pls")
                 "question"  it also asks MatchTime for something it holds, such as the list, who is in or how many ("@Match Time what's the list?", "how many are we now?"), never a question put to another member ("@Ali can you play?")

EXAMPLES
Messages come in English or Turkish, often mixed or misspelt, and carry the same facts either way. Each group teaches one thing, English | Turkish.

The sender's own place: subject sender, decision, contingent false.
  "I'm in", "count me in" | "varım", "ben varım", "geliyorum", "sayın beni", "var" -> in
  "I'm out", "can't make it" | "yokum", "ben yokum", "gelemiyorum", "yok", "bu hafta yokum" -> out
  "@Match Time in", "@Match Time out" -> the sender in, the sender out: the tag addresses MatchTime
  "me too", or "same" replying to a neighbour's "I'm in" | "ben de" after "ben varım" -> the sender's own claim, the same polarity as the line it answers
  Other members typing the same "in" or "out" just before does not make the sender's line an echo: it is the sender's own claim
  "I'll go in goal" | "kaleye geçerim" -> the sender in, contingent false: they are playing, and the position is a note
  "in, for bench", "In as a reserve", "put me on standby" | "yedekte kalayım", "yedeğe yaz beni" -> bench
  The chat shows 14/14 with the sender already on the list, and the sender types "in" | "varım" -> polarity in, not bench

Fitness and injuries: out only when the person says they will not or cannot play.
  "I've got a bad hamstring so taking it easy", "knee's a bit dodgy tonight" | "dizim ağrıyor, yavaş oynarım" -> no claim: they are still playing
  "bit sore from Sunday but I'll be there" | "dizim ağrıyor ama gelirim" -> the sender in
  "hamstring's gone, can't make it tonight" | "sakatım, gelemiyorum" -> the sender out
  "got a nasty cold, can someone take my spot?" | "gripim, yerime biri gelebilir mi?" -> the sender out, plus "recruit"

Talk about players that is not about anyone's place: no claim.
  "Mojib, Habib and Kieran on the same side" | "Mojib ile Habib aynı takımda" -> no claim
  "@Yusuf how fit are you?" | "Yusuf ne kadar formda?" -> no claim

Other people: subject other, personRef as written.
  "Ali is coming too" | "Ali de geliyor" -> Ali in, reported false
  "Ali said he's coming" | "Ali geliyorum dedi" -> Ali in, reported true
  "Mehmet can't come" | "Mehmet gelemiyor" -> Mehmet out
  "he's out" replying to Ali Khan's message | "o yok" -> personRef "Ali Khan", out
  "+1", "+2" or "plus one", alone or after the sender's own claim, is a GUEST the sender brings, never the sender: subject other, personRef the token verbatim ("+1"), personNamed false, in. "ben de" is the sender; "+1" is not.

The sender's own offers: they COULD and have not yet. Contingent true, conditionOn "squad", decision.
  To fill a gap, playing themselves: "ping me if you need one more", "I can play if you're short", "count me in if someone drops", "I'll be the 14th if you're short" | "eksik olursa ben gelirim", "biri çıkarsa beni yazın" -> the sender bench
  To give up a place: "I can drop out", "happy to drop if you find someone", "happy to pull out" | "gerekirse çıkarım", "yerimi verebilirim" -> the sender out

Offering someone else: the one who would play is another person, even when the sender brings them. One claim, for that person only: subject other, in, never bench: the bench is only ever the sender's own offer. The sender says nothing about their own place, so there is no claim for the sender. contingent is true only when the message states a condition, as for every claim.
  The player is whoever would be on the pitch. "I can play if you're short" is the sender. When the sender would bring, get or ask someone ("I can bring someone if you're short", "I'll get a mate if you need", "I can ask my brother"), the player is that someone, never the sender
  "my cousin can come if needed", "I could bring a mate if we're short" | "gerekirse kardeşim gelir", "bir arkadaşımı getirebilirim" -> the cousin, or the mate, in (not bench), contingent true, conditionOn "squad"
  "my cousin Ali can play" | "kuzenim Ali de oynar" -> Ali in, contingent false

Several people in one message: one claim each, with any side request.
  "I'm in, and my brother can play too" -> two claims
  "is anyone able to replace me and Habib tonight?" | "bu akşam benim ve Habib'in yerine gelebilecek var mı?" -> the sender out and Habib out, contingent false, plus "recruit"

Several things in one message: the claims, plus what else it asks MatchTime for.
  "Kai is out now. @Match Time what's the list?" | "Kai yok. @Match Time liste ne?" -> Kai out, plus "question"
  "Kai out, @Ali can you play?" | "Kai yok, @Ali gelebilir misin?" -> Kai out, no side request: the question is put to Ali, not MatchTime

Hedges: the sender might play and has not decided. Subject sender, in, contingent true, conditionOn "self", decision, tense future. This shape is what gets the person asked again nearer the match; an empty claims array for a hedge is a maybe nobody follows up.
  "maybe", "50/50", "not sure yet", "I'll see" | "belki", "bakarız", "kesin değil", "bakacağım" -> the hedge

A replacement: one person arrives and one leaves, and which way round it runs is the point. Report an "in" claim for the arriving person, with replaces set to the leaving person's words, and an "out" claim for the leaving one. Chatter around it changes nothing.
  "Mojib is replacing Najib", "Mojib in for Najib", "Mojib takes Najib's place", "Najib is out, Mojib is in", "swap Najib for Mojib" | "Mojib, Najib'in yerine geliyor", "Najib yerine Mojib", "Mojib, Najib'in yerini aliyor", "Najib yok, Mojib var" -> Mojib in (replaces "Najib"), Najib out
  "Hi guys, Mojib is replacing Najib on the list. We can change" -> the same two claims
  "Mojib will play in my place" | "benim yerime Mojib oynayacak" -> Mojib in (replaces "me"), the sender out
  "Ali is coming, Mehmet can't make it" -> two ordinary claims, replaces "" on both: nobody said one takes the other's place
IF YOU CANNOT TELL WHICH OF THE TWO IS ARRIVING AND WHICH IS LEAVING, REPORT NO CLAIMS AT ALL. A wrong guess takes a real player out of a real squad; saying nothing costs one message somebody can retype.

Banter still contains claims. "Zeeshan is out lol vote him out" DOES claim Zeeshan is out. Report it as written; whether it is a joke is decided elsewhere, with information you do not have.`,

  question: `You read ONE question from a football club's WhatsApp group (the players' group or the organisers' own group) and say which question it is. You never answer it: code reads the club's records and writes every name, date and number the group sees. Fill a field only from what the message says. A field the message does not state gets its empty value; never fill one in from a guess.

WHAT YOU ARE SHOWN
THE MESSAGE is the question, with the name of who sent it. Above it, as context only: RECENT CHAT, MATCHTIME'S LAST POST, NOW (the time at the club) and, when the message is a WhatsApp reply, a THEY ARE REPLYING TO line with the message it quotes and whose it is. Use the context to understand what the message refers to: "list?" under a question about the bench, "still space?" under MatchTime's call for one more player. The topic is what THE MESSAGE asks, never what an earlier message asked. Messages come in English and Turkish, often mixed, misspelt or unpunctuated.

FIELDS

topic
What the asker wants back. Exactly one. A message that asks two things gets the topic whose answer covers both.
  squad            who is playing the upcoming match, as names. "The list" and "the squad" are this list, and it shows the bench too: asking for the list is squad even beside a question about the bench.
  count            how many are in, how many places are left or still needed, whether there is still space or enough players, or a number to check. In Turkish "yer" here is a place in the squad: "yer var mı?" and "hâlâ boş yer var mı?" ask for space, never for the venue.
  bench            who is on the bench, or whether anyone is, when that is all the message asks. "The bench list" and "yedek listesi" are the bench's own list: bench.
  person_status    whether one named person is playing, on the bench or out, including whether MatchTime should put them in the squad or on the bench
  phones           who in the squad has no phone number on record
  fixture          the upcoming match itself: whether it is on, the kick-off time, the venue
  score            results of matches already played: the score or who won, for one match or several
  payments         WHO has or has not paid the match fee, or how many still owe
  rating_progress  who has or has not SUBMITTED ratings or Man of the Match votes for the last match. Telling people to rate, reminding or thanking them asks for nothing: other.
  my_stats         the asker's OWN stats, ratings, form or season summary, asked to see (they are sent privately)
  stats            numbers about players across matches (ratings, appearances, Man of the Match, Elo and the rest): a table, a ranking, another player's numbers, or the asker's own pairings
  options          what to do about being short of players: a smaller format, alternatives
  how_it_works     help with MatchTime itself: what it can do, a bare "help", how one part of it works, whether a part is on here and how to switch it on or off, where a setting is, what a badge means. Asks HOW something works, never for today's names or numbers.
  club             how the club itself is run: who the admins or organisers are, who collects the money, what the fee is, WHEN (what time or day) the teams are made or come out
  other            anything else

personRef
The person the question is about, as the message names them, without a possessive or suffix: "Idris's" and "Idris'in" are "Idris". On a stats question about the asker ("my chemistry", "my nemesis"), "me". "" when it names nobody.

statedCount
A number the message ASSERTS about the squad, for checking: "we're 9/14 right?" is 9. -1 otherwise.

feature
For how_it_works only, the part of MatchTime it asks about. Every other topic is none.
  availability     signing in and out, the squad list, the bench, saying maybe
  teams            how the two teams are made
  mom              Man of the Match
  ratings          player ratings
  reminders        reminders
  payments         the match fee: how to pay it, how it is collected, switching fee collection on
  schedule         changing the schedule: match days, kick-off times, block bookings, cancelling a week, a match's format
  badges           the badges on the stats page and how to earn them
  partners         partner clubs, which lend each other players when one is short
  pool             the MatchTime player pool: players nearby who are asked when the club is short, and playing for other clubs too
  settings         the settings page itself: where a setting is, or the settings in general
  none             MatchTime as a whole ("help", "what can you do?"), or a part not listed

badge
For feature badges only, the one badge the message names: first-game (On the board), ten-games (Regular), ironman (Iron Man), first-mom (Man of the Match), mom-machine (MoM Machine), masterclass (Masterclass), reliable (Mr Reliable), above-field (Above the Curve). none when it names no badge.

The remaining fields describe a LIST. table and listEnd belong to stats only; listSize and period belong to stats and score. Every other topic leaves them empty: table "none", listSize -1, listEnd "top", period "none", periodCount -1, periodUnit "none".

table
The one stats table that answers the question:
  ratings          players' ratings. A bare "leaderboard", "the table", "rankings", "standings", "best players" or "top N" with no other measure named is ratings.
  appearances      who plays, turns up or attends the most. "Most consistent" on its own means turning up.
  mom              Man of the Match awards
  elo              Elo
  team_of_season   the team, XI or line-up of the season
  movers           whose rating or position is improving, climbing or in form
  chemistry        who a player plays best with, their best team-mates, their nemesis or toughest opponent
  mr_reliable      "Mr Reliable" or the most reliable player: the stats page badge for steady, strong ratings, never appearances
  other            a question no single table answers: a win rate, or two or more tables together ("is anyone in both the Elo top ten and the Man of the Match table?")
  none             the question names no measure at all

listSize
How many were asked for, as written. On stats, rows of the table: "top 10" is 10, "top five" is 5. On score, how many results: "the last 5 matches" is 5, "son 3 maç" is 3. -1 when no number is named.

listEnd
"bottom" when the question asks for the worst, the lowest or the foot of a table; otherwise "top".

period
A stretch of time asked about, on stats or score, with periodCount and periodUnit:
  last             a rolling span back from today: "in the last year", "past 3 months", "last month", "son 1 yılda", "geçen ay". periodCount is the number written, 1 when none is. periodUnit is day, week, month or year.
  this             the current calendar week, month or year: "this month", "bu ay", "bu yıl". periodCount -1.
  season           "this season", "the season", "bu sezon". periodCount -1, periodUnit "none".
  all_time         "ever", "all-time", "tüm zamanlar", "bugüne kadar". periodCount -1, periodUnit "none".
  none             no stretch of time stated. "The last 3 matches" counts matches, not time (on score it is listSize 3). A score question about ONE match ("last night", "on Tuesday", "last week", "geçen hafta") is period "none", listSize -1.

EXAMPLES
Each line is a message, English | Turkish, then the fields that are not empty.

The upcoming match:
  "@Match Time who's in?" | "@Match Time kimler var?" -> squad
  "@Match Time what's the list?" | "@Match Time liste ne?" -> squad
  "@Match Time anyone on the bench? show me the list" | "@Match Time yedekte kimse var mı? listeyi atar mısın" -> squad
  "@Match Time who's on the bench?" | "@Match Time yedekte kim var?" -> bench
  "@Match Time how many spots left?" | "@Match Time kaç kişiyiz?" -> count
  "@Match Time any space left?" | "@Match Time boş yer kaldı mı?" -> count
  "@Match Time we're 9/14 right?" | "@Match Time 9/14 değil mi?" -> count, statedCount 9
  "@Match Time is Zair in?" | "@Match Time Zair geliyor mu?" -> person_status, personRef "Zair"
  "@Match Time anyone in the squad without a number?" | "@Match Time kadroda numarası olmayan var mı?" -> phones
  "@Match Time what time is kickoff?" | "@Match Time maç kaçta?" -> fixture
  "@Match Time where are we playing?" | "@Match Time maç nerede?" -> fixture
  "@Match Time we're short, what are our options?" | "@Match Time eksiğiz, ne yapabiliriz?" -> options

Help with MatchTime:
  "@Match Time help" | "@Match Time yardım" -> how_it_works
  "@Match Time what can you do?" | "@Match Time neler yapabiliyorsun?" -> how_it_works
  "Bench? We do bench now?" | "yedek ne demek?" -> how_it_works, feature availability
  "@Match Time how are the teams picked?" | "@Match Time yardım takımlar" -> how_it_works, feature teams
  "@Match Time how do we pay?" | "@Match Time ödemeyi nasıl yapıyoruz?" -> how_it_works, feature payments
  "@Match Time how do I turn off Man of the Match?" | "@Match Time maçın adamı oylamasını nasıl kapatırım?" -> how_it_works, feature mom
  "@Match Time how do I move the kick-off time?" | "@Match Time maç saatini nasıl değiştiririm?" -> how_it_works, feature schedule
  "@Match Time how do I turn on the player pool?" | "@Match Time havuz nasıl açılır?" -> how_it_works, feature pool
  "@Match Time how do partner clubs work?" | "@Match Time partner kulüp nedir?" -> how_it_works, feature partners
  "@Match Time where are the settings?" | "@Match Time ayarlar nerede?" -> how_it_works, feature settings
  "@Match Time help badges" | "@Match Time rozetler nasıl kazanılır?" -> how_it_works, feature badges
  "@Match Time how do I get Mr Reliable?" | "@Match Time yardım rozet demir adam" -> how_it_works, feature badges, badge reliable | ironman

How the club is run:
  "@Match Time who runs this group?" | "@Match Time grubun yöneticisi kim?" -> club
  "@Match Time who do we pay?" | "@Match Time ücreti kime ödüyoruz?" -> club
  "@Match Time how much do we pay each?" | "@Match Time kişi başı ne kadar?" -> club
  "@Match Time what time do the teams come out?" | "@Match Time takımlar saat kaçta çıkıyor?" -> club

Results:
  "@Match Time did we win on tuesday?" | "@Match Time salı kim kazandı?" -> score
  "@Match Time what was the score last week" | "@Match Time geçen hafta skor kaç kaçtı?" -> score
  "@Match Time give us the scores of the last 5 matches" | "@Match Time son 5 maçın skorları" -> score, listSize 5
  "@Match Time results this season" | "@Match Time bu sezonun sonuçları" -> score, period season
  "@Match Time results from the last 2 months" | "@Match Time son 2 ayın sonuçları" -> score, period last, periodCount 2, periodUnit month

After a match:
  "@Match Time who hasn't paid?" | "@Match Time kim ödemedi?" -> payments
  "@Match Time who hasn't rated yet?" | "@Match Time kimler puan vermedi?" -> rating_progress
  "please don't forget to rate the players" | "oyuncuları puanlamayı unutmayın" -> other

Stats:
  "@Match Time my stats" | "@Match Time istatistiklerim" -> my_stats
  "@Match Time what are Wasim's stats" | "@Match Time Ali'nin istatistikleri ne" -> stats, personRef "Wasim" | "Ali"
  "@Match Time leaderboard" | "@Match Time sıralama" -> stats, ratings
  "@Match Time please share the leaderboard of ratings, top 10" | "@Match Time en iyi 10" -> stats, ratings, listSize 10
  "@Match Time who's the worst player" | "@Match Time en kötü oyuncu kim" -> stats, ratings, listEnd bottom
  "@Match Time bottom 5 on elo" | "@Match Time elo'da son 5" -> stats, elo, listSize 5, listEnd bottom
  "@Match Time who's got the most MoMs" | "@Match Time en çok maçın adamı kim" -> stats, mom
  "@Match Time what is the team of the season?" | "@Match Time sezonun takımı ne" -> stats, team_of_season
  "@Match Time who's climbing the most lately?" | "@Match Time son maçlarda en çok kim yükseldi" -> stats, movers
  "@Match Time who is the most Mr. Reliable?" | "@Match Time en güvenilir oyuncu kim?" -> stats, mr_reliable
  "@Match Time who does Wasim play best with" | "@Match Time Idris'in kimyası nasıl" -> stats, chemistry, personRef "Wasim" | "Idris"
  "@Match Time who's my nemesis" | "@Match Time en zorlandığım rakip kim" -> stats, chemistry, personRef "me"
  "@Match Time who has the best win rate" | "@Match Time en yüksek galibiyet oranı kimde" -> stats, other

Periods:
  "@Match Time who has played most matches in the last 1 year?" | "@Match Time son 1 yılda en çok maç oynayan kim?" -> stats, appearances, period last, periodCount 1, periodUnit year
  "@Match Time top 5 ratings in the last month" | "@Match Time geçen ay en iyi 5" -> stats, ratings, listSize 5, period last, periodCount 1, periodUnit month
  "@Match Time most appearances this season" | "@Match Time bu sezon en çok maç oynayanlar" -> stats, appearances, period season
  "@Match Time who played most this month" | "@Match Time bu ay en çok kim oynadı" -> stats, appearances, period this, periodUnit month
  "@Match Time all-time most MoMs" | "@Match Time tüm zamanların en çok maçın adamı kim" -> stats, mom, period all_time`,

  teams: `You read ONE message about the club's two team line-ups and report what it asks for. You never pick the players: code builds and changes the line-ups.

THE MESSAGE is the one you report on, with its sender. Above it you may see RECENT CHAT, MATCHTIME'S LAST POST, NOW (the time at the club) and, for a WhatsApp reply, the message it quotes (the THEY ARE REPLYING TO line). They tell you who "him", "them" or "the teams" are; every field comes from THE MESSAGE.

WHAT YOU RETURN
action, exactly one:
  "show" post the teams that already exist, unchanged.
  "generate" work the line-ups out again. This holds even when the same message also asks for new names, or says "again", "once more" or "instead".
  "rename" keep the same two line-ups and change only their names.
  "swap" move named players between the existing teams and leave everyone else where they are.
includeRefs
  people the message says must play.
teamNames
  the two team names, in order: the ones the message gives or, when it asks you to pick the names, make up two short names (different, at most 24 characters each, not Red or Yellow, in the language THE MESSAGE is written in). An empty array when the message is not about names.
swaps
  people the message puts on a NAMED side, with that side, RED or YELLOW.
moves
  people who go to the OTHER team from wherever they are now, when the message names no side.
pairings
  people who must end up on the same team as each other, one array per group.

Write every person as the message writes them. When the sender means themselves ("me", "I", "beni", "bana", "ben") write "me". Every field the message says nothing about is empty.

EXAMPLES, English and Turkish
  "teams?" / "show me the teams" / "takımları göster" -> show
  "show us the teams again without regenerating" -> show
  "generate the teams" / "make the teams" / "shuffle them again" / "takımları kur" / "yeniden kur" -> generate
  "generate the teams, Ibrahim is playing" -> generate, includeRefs ["Ibrahim"]
  "make the teams and put me and David on the same team" -> generate, pairings [["me","David"]]
  "generate the teams, you pick some fun names" / "takımları kur, isimleri sen seç" -> generate, teamNames two names you make up
  "generate the teams, call them Lions and Tigers" -> generate, teamNames ["Lions","Tigers"]
  "call the teams Lions and Tigers" / "takımların adı Aslanlar ve Kaplanlar olsun" -> rename, teamNames ["Lions","Tigers"] / ["Aslanlar","Kaplanlar"]
  "put David in Red" -> swap, swaps [{"personRef":"David","team":"RED"}]
  "swap Ali and Can" / "Ali ile Can'ı değiştir" -> swap, moves ["Ali","Can"]
  "move Tom to the other team" / "Tom'u diğer takıma al" -> swap, moves ["Tom"]`,

  score: `You read ONE message from a football group's WhatsApp chat about the result of the group's own match and report what it SAYS. You never decide which team is which, who won, who a player is, or what gets recorded: code does that.

THE MESSAGE is the one you report on, with its sender. Above it you may see RECENT CHAT, MATCHTIME'S LAST POST, NOW (the time at the club) and, for a WhatsApp reply, the message it quotes (the THEY ARE REPLYING TO line). They tell you what THE MESSAGE answers or disputes; never take a number, team or name from them. The group's own match is its latest game: "tonight", "today", "last night", "yesterday", "dün akşam" and "earlier" all mean that latest game.

A TEAM REFERENCE below is the team's name as written ("yellows", "Reds", "Sarılar"), "us" for the sender's own side ("we", "biz", "kazandık"), "them" for the other side, or "" when not said. Never work a team out.

WHAT YOU RETURN
hasScore
true when THE MESSAGE states the two numbers of a result; false when it has none ("yellows won", "wrong way round", "MoM Naim"), and first and second are then 0.
first, second
the two numbers of the final result, in the order written. In a story ("it was 6-6 then it turned to 9-6") the last one.
firstTeam, secondTeam
the team written directly beside the first or the second number, with no word about who won or lost. It stays there when THE MESSAGE answers MatchTime's "which team won?" with a scoreline.
winner
the team a word names as the winner: "to" or "for" a team, "won", "wins", "beat", "kazandı", "yendi". A bare team name, the whole message, answering MatchTime's "which team won?" is the winner too. "" otherwise, and for a draw.
loser
the team a word names as the loser: "lost", "got beaten", "kaybetti", "yenildi". "" otherwise.
momRef
the player named Man of the Match ("MoM", "man of the match", "POTM", "maçın adamı"), as written, or a bare name answering MatchTime's question who it was. "" otherwise; praise alone ("Naim was class") is "".
correction
true only when THE MESSAGE says a result already given for this match was wrong ("no, it was...", "yanlış", "hayır ... olacak"), as when it disputes the result it quotes. A first report is false, even straight after MatchTime asked for the score.
swapped
true when it says the teams are the wrong way round ("other way round", "tam tersi"); correction is then true too.
otherGame
true only when THE MESSAGE is plainly about a game before the latest one ("last week", "geçen ay"); correction is then false.

EXAMPLES, English and Turkish
A word names the winner:
  "5-3 to Yellows" / "sarılar 5-3 kazandı" -> hasScore true, first 5, second 3, winner "Yellows" / "sarılar"
  "4-6 to Yellows" -> first 4, second 6, winner "Yellows"
  "it was 6-6 then suddenly it turned to 9-6 to yellows" -> first 9, second 6, winner "yellows"
A team beside a number:
  "Yellow 9 - 6 Red" -> first 9, second 6, firstTeam "Yellow", secondTeam "Red"
  "kırmızı 6 sarı 9" -> first 6, second 9, firstTeam "kırmızı", secondTeam "sarı"
  "Reds 3-5" -> first 3, second 5, firstTeam "Reds", winner ""
  "7-4 yellows", answering MatchTime's "which team won?" -> first 7, second 4, secondTeam "yellows", winner ""
The sender's side:
  "we won 5-3" / "5-3 kazandık" -> first 5, second 3, winner "us"
  "lost 3-5" / "3-5 kaybettik" -> first 3, second 5, loser "us"
  "reds beat us 7-2" -> first 7, second 2, winner "reds", loser "us"
No team, or no numbers:
  "10-7" / "7-7 berabere" -> hasScore true, the two numbers, every team field ""
  "yellows won" / "sarılar kazandı" -> hasScore false, winner "yellows" / "sarılar"
  "Yellow", the whole message, answering MatchTime's "which team won?" -> hasScore false, winner "Yellow"
Man of the Match:
  "Yellow won 7-4, MoM Naim" / "sarı 7-4 kazandı, maçın adamı Naim" -> first 7, second 4, winner "Yellow" / "sarı", momRef "Naim"
  "Naim", answering MatchTime's question who was Man of the Match -> hasScore false, momRef "Naim"
A correction:
  "no Yellow 9 - 6 Red" / "yanlış, kırmızı 6 sarı 9" -> correction true, numbers and teams as above
  "wrong way round, yellows won" / "tam tersi, sarılar kazandı" -> hasScore false, correction true, swapped true, winner "yellows" / "sarılar"
The latest game or an earlier one:
  "Red won 4-2 last night" / "dün akşam kırmızı 4-2 kazandı" -> first 4, second 2, winner "Red" / "kırmızı", otherGame false
  "last week we lost 9-2" / "geçen ay 5-0 yenmiştik" -> loser "us" / winner "us", otherGame true`,

  admin: `You read ONE message from a club's organisers' chat and report two things: what it asks MatchTime, the club's bot, to do, and whether it is spoken to MatchTime at all. You report the words; code decides what happens. Messages may be in English or Turkish.

THE MESSAGE is the one you report on, with its sender and whether they tagged the bot. Above it you may see RECENT CHAT, MATCHTIME'S LAST POST, NOW (the time at the club) and, for a WhatsApp reply, the message it quotes (the THEY ARE REPLYING TO line). They tell you who "he" or "them" is and who is being spoken to; the action and every field come from THE MESSAGE.

THE ACTION, exactly one: what the message asks to be done. A question, an opinion or a discussion about whether to do it ("should we cancel?", "should Bilal play free?", "shall we try the pool?") is "other".
  "bulk_payment" someone paid for several players.
  "fee_waiver" the sender gives named players a free place, so they owe nothing for a game, or takes a free place back. "Free" meaning able to play ("I'm free Tuesday") is not this.
  "cancel_match" the sender calls off the club's game: cancel it, it is not happening, no game.
  "restore_match" the sender puts a called-off game back on: it is back on, uncancel it, it goes ahead after all.
  "reminder" the sender wants MatchTime to remind them, at a time.
  "recruit" find players who are not in the squad yet; playersFrom says where from. Asking to show, list or count the squad is "other", and so is talking or asking about another club or the player pool.
  "stats_blast" MatchTime itself is to send every player their own stats or ratings link. Telling the PLAYERS to do something (rate each other, open the link they already have) is "other".
  "other" anything else.

THE FIELDS. toMatchTime is always filled; fill the others for the action, and every other field is "", 0, false or [].
  toMatchTime true when the message tells or asks MatchTime itself to do something: it tags the bot, it replies to MatchTime's own post, it answers the question MatchTime just asked, or it is an instruction that names and tags nobody else ("ask the group if anyone can play"). False when it speaks to a person or to the others in the chat: it tags or names a person to ask them, or the sender asks the others whether to do it or whether they can ("can we ask...?", "should we...?", "you able to find players?").
  payerRef bulk_payment: who paid, as written.
  count bulk_payment: how many players they paid for.
  coveredRefs the people the action is about, one entry each, as written: for bulk_payment the people paid for, if named; for fee_waiver the people given the free place or losing it. "he" or "him" is the person the message named, else the author of the quoted message when the THEY ARE REPLYING TO line names one.
  undo fee_waiver: true when the message takes a free place back, false when it gives one.
  matchDay fee_waiver, cancel_match, restore_match: the day the message names for the game, as written ("tonight", "next Friday", "cuma"); "" when it names none or only "this week".
  phrase reminder: the time phrase exactly as written ("on Monday", "tomorrow at 6"), never a date.
  note reminder: what to remind them about, in their own words ("bring the bibs"); "" when it names nothing.
  playersFrom recruit: where the message says the players are to come from, judged by what it means, never guessed. Each source is a different thing MatchTime does, so a message that does not say is "unsaid" and MatchTime asks the organiser.
    "club" the club's own players: its regulars, the lads, its past players, or its own players' group ("the group" and "the main group" are this club's players' group).
    "partners" another club: a partner club or the other groups, named or not.
    "pool" the MatchTime player pool: players from outside this club and its partner clubs, found by MatchTime ("the pool", "someone nearby", "a player from the app", "MatchTime's players").
    "unsaid" the message asks for players but does not say from where ("we need 2 players", "find us someone").
    A message answering MatchTime's own question about where to look (MATCHTIME'S LAST POST, or the message it replies to, asks it) is recruit from the place it picks, however short.
  lookbackMatches recruit from the club: how many of the club's recent matches to draw its own players from ("the last 5 matches" -> 5, "the last couple of games" -> 2); 0 when no number is named.
  clubRef recruit from partners: the other club's name as written, without a Turkish case ending ("Sutton'a" -> "Sutton"); "" when the message names no club ("the partner clubs", "the other groups", "another club").

EXAMPLES, English and Turkish side by side, grouped by what they teach. toMatchTime is true in each unless shown.
Who it is spoken to:
  "ask the group if anyone can play" / "MatchTime oyuncu grubuna sor" -> recruit, playersFrom "club", toMatchTime true
  "@Match Time ask the group" / "@Match Time gruba sor" -> recruit, playersFrom "club", toMatchTime true
  "@Kemal can we ask Sutton group?" -> recruit, playersFrom "partners", clubRef "Sutton", toMatchTime false: a question to Kemal
  "should we ask the group?" / "gruba soralım mı?" -> other, toMatchTime false: the sender asks the others
  "you able to find players?" / "oyuncu bulabilir misin?" (to another organiser) -> other, toMatchTime false
Players from the club itself:
  "message the lads from the last 5 matches and invite them" / "son 5 maçta oynayanlara yaz, davet et" -> recruit, playersFrom "club", lookbackMatches 5
  "ask the regulars if they can play" / "düzenli gelenlere sor, oynayabilirler mi" -> recruit, playersFrom "club", lookbackMatches 0
Players asked for, from nowhere said:
  "we need 2 players for Thursday" / "perşembeye 2 kişi lazım" -> recruit, playersFrom "unsaid"
  "@Match Time find us a player for Friday" / "@Match Time cumaya bir oyuncu bul" -> recruit, playersFrom "unsaid"
  "we need more players, can you round some up" / "bize oyuncu bulur musun" -> recruit, playersFrom "unsaid"
Players from another club:
  "ask Sutton if anyone can play" / "Sutton'a sor bakalım oynayan var mı" -> recruit, playersFrom "partners", clubRef "Sutton"
  "@Match Time ask Friday MT Community if anyone can play tonight" -> recruit, playersFrom "partners", clubRef "Friday MT Community"
  "search for players from our partner groups" / "diğer gruplara sor, oynayacak biri var mı" -> recruit, playersFrom "partners", clubRef ""
  "try another club for one more" / "başka bir kulübe sorar mısın" -> recruit, playersFrom "partners", clubRef ""
  "Sutton were great last week" / "Sutton geçen hafta çok iyi oynadı" -> other, toMatchTime false: talk about another club
  "did Sutton ever get back to us?" -> other, toMatchTime false: a question
Players from the MatchTime player pool:
  "@Match Time ask the pool for a player" / "@Match Time havuzdan bir oyuncu bul" -> recruit, playersFrom "pool"
  "find someone nearby for tonight" / "bu akşam için yakınlardan birini bul" -> recruit, playersFrom "pool"
  "get us a player from the app" / "uygulamadan bir oyuncu bulur musun" -> recruit, playersFrom "pool"
  "shall we try the pool?" / "havuza soralım mı?" -> other, toMatchTime false: the sender asks the others
  "the pool lad last week was good" / "geçen haftaki havuz oyuncusu iyiydi" -> other, toMatchTime false: talk about the pool
Answering MatchTime's "Who shall I ask for players: your players' group, your partner clubs, or the MatchTime player pool?":
  "the pool" / "havuza" -> recruit, playersFrom "pool"
  "partners please" / "partner kulüplere" -> recruit, playersFrom "partners", clubRef ""
  "the group" / "gruba sor" -> recruit, playersFrom "club"
  "ask Sutton" / "Sutton'a sor" -> recruit, playersFrom "partners", clubRef "Sutton"
Payments and free places:
  "Amir paid for 4 players" -> bulk_payment, payerRef "Amir", count 4
  "Amir paid for Faris and Adam" -> bulk_payment, payerRef "Amir", count 2, coveredRefs ["Faris","Adam"]
  "Bilal washed the bibs, he's free this week" -> fee_waiver, coveredRefs ["Bilal"], undo false, matchDay ""
  "Ali ve Can cuma günü ödemesin" -> fee_waiver, coveredRefs ["Ali","Can"], undo false, matchDay "cuma günü"
  "put Bilal down as free on Friday" / "Bilal bu akşam ücretsiz oynasın" -> fee_waiver, coveredRefs ["Bilal"], undo false, matchDay "on Friday" / "bu akşam"
  "scrap that, Tom isn't free, he pays" / "Ali ücretsiz değil, ödesin" -> fee_waiver, coveredRefs ["Tom"] / ["Ali"], undo true
  "should Bilal play free?" -> other, toMatchTime false: a discussion
Calling a game off, and putting it back on:
  "Cancel the session" / "maçı iptal et" -> cancel_match, matchDay ""
  "storm, no game Friday" / "bu hafta maç yok" -> cancel_match, matchDay "Friday" / ""
  "it's back on, uncancel Friday" / "maç yapılıyor, iptali geri al" -> restore_match, matchDay "Friday" / ""
  "should we cancel Friday?" / "the session should be cancelled anyway" -> other, toMatchTime false: a question, an opinion
Reminders:
  "remind me tomorrow at 6 to bring the bibs" / "yarın 6'da yelekleri getirmeyi hatırlat" -> reminder, phrase "tomorrow at 6" / "yarın 6'da", note "bring the bibs" / "yelekleri getirmeyi"
Stats links:
  "@Match Time send everyone their stats" / "@Match Time DM the squad their ratings links" -> stats_blast
  "lads don't forget to rate the players via the link MatchTime DM'ed you" -> other, toMatchTime false: it tells the players
  "did everyone get their stats link?" -> other, toMatchTime false: a question
  "@Match Time what are my stats" -> other: one person asking about themselves
`,
};

// ── Schemas ────────────────────────────────────────────────────────────

export const ATTENDANCE_SCHEMA = {
  type: "object",
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: {
          subject: { type: "string", enum: ["sender", "other"] },
          personRef: { type: "string" },
          personNamed: { type: "boolean" },
          polarity: { type: "string", enum: ["in", "out", "bench"] },
          contingent: { type: "boolean" },
          conditionOn: { type: "string", enum: ["squad", "self", "none"] },
          tense: { type: "string", enum: ["present", "future", "past", "hypothetical"] },
          basis: { type: "string", enum: ["decision", "availability"] },
          reported: { type: "boolean" },
          // "" rather than a nullable string, the same convention
          // `affirmation` and `statedCount` already use here: the API
          // rejects a nullable type outright, at request time.
          replaces: { type: "string" },
          confidence: { type: "number" },
        },
        required: [
          "subject",
          "personRef",
          "personNamed",
          "polarity",
          "contingent",
          "conditionOn",
          "tense",
          "basis",
          "reported",
          "replaces",
          "confidence",
        ],
        additionalProperties: false,
      },
    },
    // "none" rather than a nullable enum: the API rejects
    // `{type: ["string","null"], enum: ["yes","no",null]}` outright
    // ("Enum value 'yes' does not match declared type"), and it rejects
    // it at request time, which the dry run surfaced as a loud
    // degradation on the very first live case. The parser maps "none"
    // back to null so the fact type stays honest.
    affirmation: { type: "string", enum: ["yes", "no", "none"] },
    sideRequests: { type: "array", items: { type: "string", enum: ["recruit", "chase", "question"] } },
  },
  required: ["claims", "affirmation", "sideRequests"],
  additionalProperties: false,
} as const;

const QUESTION_SCHEMA = {
  type: "object",
  properties: {
    topic: {
      type: "string",
      enum: [
        "squad",
        "bench",
        "count",
        "person_status",
        "phones",
        "fixture",
        "payments",
        "score",
        "rating_progress",
        "my_stats",
        "stats",
        "options",
        "how_it_works",
        "club",
        "other",
      ],
    },
    personRef: { type: "string" },
    statedCount: { type: "number" },
    // "none" and -1 are the stand-ins for null, as for `statedCount`:
    // the API rejects a nullable type at request time.
    table: {
      type: "string",
      enum: ["ratings", "appearances", "mom", "elo", "team_of_season", "movers", "chemistry", "mr_reliable", "other", "none"],
    },
    listSize: { type: "number" },
    listEnd: { type: "string", enum: ["top", "bottom"] },
    // The period (2026-09-23). Three flat fields rather than an object,
    // with "none" and -1 as the null stand-ins, like the fields above.
    period: { type: "string", enum: ["none", "last", "this", "season", "all_time"] },
    periodCount: { type: "number" },
    periodUnit: { type: "string", enum: ["none", "day", "week", "month", "year"] },
    // 2026-10-16: for `how_it_works` only, the help topic it asks about.
    feature: { type: "string", enum: [...HELP_FEATURES, "none"] },
    // 2026-10-28: for `feature: "badges"` only, the one badge it names.
    badge: { type: "string", enum: [...HELP_BADGES, "none"] },
  },
  required: ["topic", "personRef", "statedCount", "table", "listSize", "listEnd", "period", "periodCount", "periodUnit", "feature", "badge"],
  additionalProperties: false,
} as const;

const TEAMS_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["show", "generate", "rename", "swap"] },
    includeRefs: { type: "array", items: { type: "string" } },
    teamNames: { type: "array", items: { type: "string" } },
    swaps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          personRef: { type: "string" },
          team: { type: "string", enum: ["RED", "YELLOW"] },
        },
        required: ["personRef", "team"],
        additionalProperties: false,
      },
    },
    // An array OF arrays: one group per "these people together". A flat
    // list could not tell "A with B, C with D" from "A, B, C and D all
    // together", and those are different line-ups.
    pairings: { type: "array", items: { type: "array", items: { type: "string" } } },
    // 2026-10-16: "swap Ali and Can" / "move Tom" name no side, so they
    // cannot be `swaps` (absolute). Each person here goes to the other
    // team from where they stand now.
    moves: { type: "array", items: { type: "string" } },
  },
  required: ["action", "includeRefs", "teamNames", "swaps", "moves", "pairings"],
  additionalProperties: false,
} as const;

// Team-aware since 2026-10-07 (see `ScoreFacts`). The four team fields
// are VERBATIM text, or "us" / "them", or "": "" is the schema's
// stand-in for "not said", as elsewhere in this file, because the API
// rejects a nullable type at request time. `hasScore` is how the model
// says "this message has no numbers" (a nullable number is rejected the
// same way): the parser turns `false` into nulls, so a numberless
// message can never arrive as 0-0. No field admits a decision: which
// side is Red, and whether a lone team name is enough, are code's
// (`score-teams.ts`).
const SCORE_SCHEMA = {
  type: "object",
  properties: {
    hasScore: { type: "boolean" },
    first: { type: "number" },
    second: { type: "number" },
    firstTeam: { type: "string" },
    secondTeam: { type: "string" },
    winner: { type: "string" },
    loser: { type: "string" },
    // 2026-10-18: the Man of the Match the message names, verbatim, or "".
    // Read only where the organisers pick it (mom-chooser.ts).
    momRef: { type: "string" },
    correction: { type: "boolean" },
    swapped: { type: "boolean" },
    otherGame: { type: "boolean" },
  },
  required: [
    "hasScore",
    "first",
    "second",
    "firstTeam",
    "secondTeam",
    "winner",
    "loser",
    "momRef",
    "correction",
    "swapped",
    "otherGame",
  ],
  additionalProperties: false,
} as const;

const ADMIN_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["bulk_payment", "fee_waiver", "reminder", "recruit", "stats_blast", "cancel_match", "restore_match", "other"],
    },
    payerRef: { type: "string" },
    count: { type: "number" },
    coveredRefs: { type: "array", items: { type: "string" } },
    // fee_waiver (2026-10-16): taking a free place back, and the day named.
    undo: { type: "boolean" },
    matchDay: { type: "string" },
    phrase: { type: "string" },
    note: { type: "string" },
    // 0 is the schema's stand-in for null, the same convention
    // `statedCount` uses. A nullable number is rejected by the API.
    lookbackMatches: { type: "number" },
    // recruit: where the players are to come from (one choice, L10
    // 2026-10-24: it replaced S6's `partnerClubs` boolean when the
    // MatchTime player pool became a third source), and the other club's
    // name as written for "partners" (slice S6, 2026-10-21). "unsaid"
    // (2026-10-28): players asked for, no source named.
    playersFrom: { type: "string", enum: ["", "club", "partners", "pool", "unsaid"] },
    clubRef: { type: "string" },
    // Who the message is spoken to (2026-10-22): MatchTime, or a person or
    // the others. Code lets nothing leave HQ untagged unless it is MatchTime.
    toMatchTime: { type: "boolean" },
  },
  required: ["action", "payerRef", "count", "coveredRefs", "undo", "matchDay", "phrase", "note", "lookbackMatches", "playersFrom", "clubRef", "toMatchTime"],
  additionalProperties: false,
} as const;

const SCHEMAS: Record<Exclude<ExtractorKind, "none">, Record<string, unknown>> = {
  attendance: ATTENDANCE_SCHEMA as unknown as Record<string, unknown>,
  question: QUESTION_SCHEMA as unknown as Record<string, unknown>,
  teams: TEAMS_SCHEMA as unknown as Record<string, unknown>,
  score: SCORE_SCHEMA as unknown as Record<string, unknown>,
  admin: ADMIN_SCHEMA as unknown as Record<string, unknown>,
};

/** Exposed so a test can assert that no schema admits a decision. */
export function factsSchemaFor(route: Route): Record<string, unknown> | null {
  const kind = extractorFor(route);
  return kind === "none" ? null : SCHEMAS[kind];
}

// ── Parsing ────────────────────────────────────────────────────────────

const POLARITIES: Polarity[] = ["in", "out", "bench"];
const TENSES: Tense[] = ["present", "future", "past", "hypothetical"];
const CONDITIONS: ConditionOn[] = ["squad", "self", "none"];
const BASES: ClaimBasis[] = ["decision", "availability"];
const TOPICS: QuestionTopic[] = [
  "squad",
  "bench",
  "count",
  "person_status",
  "phones",
  "fixture",
  "payments",
  "score",
  // 2026-09-11, and it is a regex coming OUT of the product rather than
  // a topic going in. See `lib/rating-progress-answer.ts`.
  "rating_progress",
  // 2026-09-17, the same kind of change: `STATS_REQUEST` came out of
  // `analyze/route.ts`. See `QuestionTopic`.
  "my_stats",
  "stats",
  "options",
  // 2026-10-16: "Bench? We do bench now?" (FNF). See `QuestionFacts.feature`.
  "how_it_works",
  // 2026-10-16: "MatchTime who are the admins?" (FNF HQ). See `QuestionTopic`.
  "club",
  "other",
];

const STATS_TABLES: StatsTable[] = [
  "ratings",
  "appearances",
  "mom",
  "elo",
  "team_of_season",
  "movers",
  "chemistry",
  "mr_reliable",
  "other",
];

function bool(v: unknown, fallback = false): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function clamp01(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 0;
  return Math.max(0, Math.min(1, n));
}

export interface ParsedFacts {
  facts: Facts;
  degradations: Degradation[];
}

/**
 * Structured output guarantees SHAPE, never SEMANTICS (§11.3). So every
 * field is re-validated here, a drifted enum value DROPS its claim
 * rather than being coerced into a plausible neighbour, and anything the
 * model smuggles in beyond the schema is discarded by construction —
 * the parser builds a new object rather than spreading the input.
 */
export function parseFacts(
  kind: Exclude<ExtractorKind, "none">,
  text: string,
  messageId: string,
): ParsedFacts {
  const degradations: Degradation[] = [];
  let raw: Record<string, unknown>;
  try {
    raw = extractJson(text) as Record<string, unknown>;
    if (typeof raw !== "object" || raw === null) throw new Error("not an object");
  } catch (err) {
    return {
      facts: { kind: "none" },
      degradations: [
        degradation(
          "extractor",
          messageId,
          `${kind} extractor output could not be parsed: ${(err as Error).message}`,
        ),
      ],
    };
  }

  const bad = (detail: string) => degradations.push(degradation("extractor", messageId, detail));

  switch (kind) {
    case "attendance": {
      const claims: Claim[] = [];
      const rows = Array.isArray(raw.claims) ? (raw.claims as Array<Record<string, unknown>>) : [];
      for (const r of rows) {
        const polarity = str(r.polarity).toLowerCase() as Polarity;
        if (!POLARITIES.includes(polarity)) {
          bad(`dropped a claim with an unknown polarity "${str(r.polarity)}"`);
          continue;
        }
        const tenseRaw = str(r.tense).toLowerCase() as Tense;
        const tense = TENSES.includes(tenseRaw) ? tenseRaw : "present";
        if (!TENSES.includes(tenseRaw) && str(r.tense)) {
          bad(`unknown tense "${str(r.tense)}" treated as present`);
        }
        const condRaw = str(r.conditionOn).toLowerCase() as ConditionOn;
        const conditionOn = CONDITIONS.includes(condRaw) ? condRaw : "none";
        // `decision` on drift, matching what `tense` and `conditionOn`
        // already do: the fallback is the value that preserves today's
        // behaviour, so an unreadable field can never silently start
        // SUPPRESSING writes the pipeline makes now. Loud when the model
        // sent something, silent when it sent nothing (an older stub).
        const basisRaw = str(r.basis).toLowerCase() as ClaimBasis;
        const basis = BASES.includes(basisRaw) ? basisRaw : "decision";
        if (!BASES.includes(basisRaw) && str(r.basis)) {
          bad(`unknown basis "${str(r.basis)}" treated as decision`);
        }
        const subject = str(r.subject).toLowerCase() === "other" ? "other" : "sender";
        claims.push({
          subject,
          personRef: str(r.personRef),
          personNamed: bool(r.personNamed),
          polarity,
          contingent: bool(r.contingent),
          conditionOn,
          tense,
          basis,
          reported: bool(r.reported),
          // Only ever meaningful on an arrival. A `replaces` on an out
          // or a bench claim is model drift and is dropped here rather
          // than travelling on to be misread: `replacement.ts` reads it
          // only from an `in` claim, and this keeps the FACTS honest for
          // everything else that reads a claim (the `none`-bucket
          // shadow, the dry run, the operator log).
          replaces: polarity === "in" ? str(r.replaces).trim() : "",
          confidence: clamp01(r.confidence),
        });
      }
      // "none" is the schema's stand-in for null (see ATTENDANCE_SCHEMA).
      const affRaw = str(raw.affirmation).toLowerCase();
      const affirmation = affRaw === "yes" ? "yes" : affRaw === "no" ? "no" : null;
      const sideRequests: SideRequest[] = (
        Array.isArray(raw.sideRequests) ? raw.sideRequests : []
      )
        .map((s) => str(s).toLowerCase())
        .filter((s): s is SideRequest => s === "recruit" || s === "chase" || s === "question");
      const facts: AttendanceFacts = { kind: "attendance", claims, affirmation, sideRequests };
      return { facts, degradations };
    }

    case "question": {
      const topicRaw = str(raw.topic).toLowerCase() as QuestionTopic;
      const topic = TOPICS.includes(topicRaw) ? topicRaw : "other";
      if (!TOPICS.includes(topicRaw)) bad(`unknown question topic "${str(raw.topic)}"`);
      const facts: QuestionFacts = {
        kind: "question",
        topic,
        // "" and -1 are the schema's stand-ins for null.
        personRef: typeof raw.personRef === "string" && raw.personRef ? raw.personRef : null,
        statedCount:
          typeof raw.statedCount === "number" &&
          Number.isFinite(raw.statedCount) &&
          raw.statedCount >= 0
            ? raw.statedCount
            : null,
      };
      // The table, the size and the end: for `stats` only, so every other
      // topic's facts keep exactly the shape they had (2026-09-23).
      if (topic === "stats") {
        const tableRaw = str(raw.table).toLowerCase();
        let table: StatsTable | null = null;
        if (STATS_TABLES.includes(tableRaw as StatsTable)) table = tableRaw as StatsTable;
        else if (tableRaw && tableRaw !== "none") bad(`unknown stats table "${str(raw.table)}"; answered as no table`);
        const size =
          typeof raw.listSize === "number" && Number.isFinite(raw.listSize) && raw.listSize >= 1
            ? Math.floor(raw.listSize)
            : null;
        facts.table = table;
        facts.listSize = size;
        facts.listEnd = str(raw.listEnd).toLowerCase() === "bottom" ? "bottom" : "top";
        // The period (2026-09-23): turned into a date by code, later, in
        // `stats-period.ts`. An unreadable one is dropped loudly and the
        // question is answered for the whole record, which it then says.
        const period = parsePeriodFields(raw);
        if (period.problem) bad(period.problem);
        facts.period = period.period;
      } else if (topic === "score") {
        // HOW MANY RESULTS and WHICH PERIOD (2026-09-29), in the same two
        // fields a stats question uses. Both null is the last match,
        // today's answer. No table: a result is not a stats table.
        facts.listSize =
          typeof raw.listSize === "number" && Number.isFinite(raw.listSize) && raw.listSize >= 1
            ? Math.floor(raw.listSize)
            : null;
        const period = parsePeriodFields(raw);
        if (period.problem) bad(period.problem);
        facts.period = period.period;
      } else if (topic === "how_it_works") {
        // Which help topic, or null for MatchTime as a whole (the help
        // menu). An unreadable one is read as the menu, loudly.
        const featureRaw = str(raw.feature).toLowerCase();
        const feature = HELP_FEATURES.find((f) => f === featureRaw) ?? null;
        if (!feature && featureRaw && featureRaw !== "none") bad(`unknown feature "${str(raw.feature)}"; answered with the help menu`);
        facts.feature = feature;
        if (feature === "badges") {
          const badgeRaw = str(raw.badge).toLowerCase();
          const badge = HELP_BADGES.find((b) => b === badgeRaw) ?? null;
          if (!badge && badgeRaw && badgeRaw !== "none") bad(`unknown badge "${str(raw.badge)}"; answered with every badge`);
          facts.badge = badge;
        }
      }
      return { facts, degradations };
    }

    case "teams": {
      const action = str(raw.action).toLowerCase();
      if (!["show", "generate", "rename", "swap"].includes(action)) {
        bad(`unknown team action "${str(raw.action)}"`);
        return { facts: { kind: "none" }, degradations };
      }
      const names = Array.isArray(raw.teamNames) ? raw.teamNames.map(str).filter(Boolean) : [];
      const facts: TeamFacts = {
        kind: "teams",
        action: action as TeamFacts["action"],
        includeRefs: Array.isArray(raw.includeRefs) ? raw.includeRefs.map(str).filter(Boolean) : [],
        teamNames: names.length === 2 ? [names[0], names[1]] : null,
        swaps: (Array.isArray(raw.swaps) ? (raw.swaps as Array<Record<string, unknown>>) : [])
          .map((s) => ({
            personRef: str(s.personRef),
            team: str(s.team).toUpperCase() === "YELLOW" ? ("YELLOW" as const) : ("RED" as const),
          }))
          .filter((s) => s.personRef),
        moves: (Array.isArray(raw.moves) ? (raw.moves as unknown[]) : []).map((m) => str(m).trim()).filter(Boolean),
        // A "pairing" of one person constrains nothing, so a stray
        // single-element group is dropped here rather than pinning
        // somebody to an arbitrary colour on the strength of it.
        pairings: (Array.isArray(raw.pairings) ? (raw.pairings as unknown[]) : [])
          .map((g) => (Array.isArray(g) ? g.map(str).filter(Boolean) : []))
          .filter((g) => g.length >= 2),
      };
      return { facts, degradations };
    }

    case "score": {
      // NO NUMBERS IS NOT 0-0 (review of PR #214, item 3). The model
      // says so with `hasScore: false`, and the facts carry nulls. An
      // older stub with no `hasScore` at all is read by what it sent:
      // two numbers are a score, anything else is none.
      const numeric = typeof raw.first === "number" && typeof raw.second === "number";
      const hasScore = raw.hasScore === false ? false : numeric;
      if (raw.hasScore !== false && !numeric) {
        bad(`score extractor returned non-numeric values`);
        return { facts: { kind: "none" }, degradations };
      }
      // The team fields are optional on the FACTS: "" (not said) is
      // dropped, so "the message named no team" is one shape whether
      // the model sent "" or an older stub sent nothing. Clipped, since
      // they are free text on their way to a trace row.
      const team = (v: unknown): string | undefined => {
        const t = str(v).trim().slice(0, 60);
        return t ? t : undefined;
      };
      const facts: ScoreFacts = {
        kind: "score",
        first: hasScore ? (raw.first as number) : null,
        second: hasScore ? (raw.second as number) : null,
      };
      const firstTeam = team(raw.firstTeam);
      const secondTeam = team(raw.secondTeam);
      const winner = team(raw.winner);
      const loser = team(raw.loser);
      // A position needs a number to be beside.
      if (hasScore && firstTeam) facts.firstTeam = firstTeam;
      if (hasScore && secondTeam) facts.secondTeam = secondTeam;
      if (winner) facts.winner = winner;
      if (loser) facts.loser = loser;
      const momRef = team(raw.momRef);
      if (momRef) facts.momRef = momRef;
      if (raw.correction === true) facts.correction = true;
      if (raw.swapped === true) facts.swapped = true;
      if (raw.otherGame === true) facts.otherGame = true;
      return { facts, degradations };
    }

    case "admin": {
      const action = str(raw.action).toLowerCase();
      if (!["bulk_payment", "fee_waiver", "reminder", "recruit", "stats_blast", "cancel_match", "restore_match", "other"].includes(action)) {
        bad(`unknown admin action "${str(raw.action)}"`);
        return { facts: { kind: "none" }, degradations };
      }
      const clubRef = typeof raw.clubRef === "string" ? raw.clubRef.trim() : "";
      const from = str(raw.playersFrom).toLowerCase();
      const facts: AdminFacts = {
        kind: "admin",
        action: action as AdminFacts["action"],
        ...(typeof raw.payerRef === "string" && raw.payerRef ? { payerRef: raw.payerRef } : {}),
        ...(typeof raw.count === "number" && raw.count > 0 ? { count: raw.count } : {}),
        ...(Array.isArray(raw.coveredRefs)
          ? { coveredRefs: raw.coveredRefs.map(str).filter(Boolean) }
          : {}),
        ...(action === "fee_waiver" && raw.undo === true ? { undo: true } : {}),
        ...(["fee_waiver", "cancel_match", "restore_match"].includes(action) && typeof raw.matchDay === "string" && raw.matchDay.trim()
          ? { matchDay: raw.matchDay.trim() }
          : {}),
        ...(typeof raw.phrase === "string" && raw.phrase ? { phrase: raw.phrase } : {}),
        ...(typeof raw.note === "string" && raw.note ? { note: raw.note } : {}),
        // 0 (the schema's stand-in for "not stated") and anything
        // non-finite are DROPPED rather than carried through as a
        // number, so the engine's `lookbackMatches === undefined` means
        // exactly one thing: use the shipped default of 5.
        ...(typeof raw.lookbackMatches === "number" &&
        Number.isFinite(raw.lookbackMatches) &&
        raw.lookbackMatches > 0
          ? { lookbackMatches: raw.lookbackMatches }
          : {}),
        // Slice S6: another club's players. A club name as written is
        // another club, whatever the source said; both are recruit only.
        ...(action === "recruit" && (from === "partners" || clubRef) ? { partnerClubs: true } : {}),
        ...(action === "recruit" && clubRef ? { clubRef } : {}),
        // L10: the MatchTime player pool. Never with a club named: a club
        // name is another club, so the pool is not asked by a guess.
        ...(action === "recruit" && from === "pool" && !clubRef ? { pool: true } : {}),
        // 2026-10-28 (Kemal, "stricter"): the words asked for players and
        // named no source. Never with a club named (that is another club).
        ...(action === "recruit" && from === "unsaid" && !clubRef ? { sourceUnsaid: true } : {}),
        // Only a clear true: a missing or false value keeps HQ's outward
        // actions closed (`admin-group-understand.ts`).
        ...(raw.toMatchTime === true ? { toMatchTime: true } : {}),
      };
      return { facts, degradations };
    }
  }
}

// ── The call ───────────────────────────────────────────────────────────

export interface ExtractorMessage {
  id: string;
  body: string;
  authorName: string | null;
  tagged: boolean;
  /** Recent chat, for pronoun and reference resolution ONLY. */
  history: Array<{ author: string | null; body: string }>;
  /** MatchTime's own last post, so a bare "Confirmed" has a referent. */
  lastBotPost: string | null;
  /**
   * The message this one is a WhatsApp reply to, whoever wrote it
   * (quoted-reply context, slice S4, 2026-10-20), already narrowed by the
   * caller to the match it acts on (`quoteForMatch`). Shown, with the
   * time now, in the block every reply reader shares
   * (`renderGroupReplyContext`). Absent: the NOW line alone.
   */
  reply?: ContextMessage | null;
  /**
   * The club's members whose names appear in the message, from the roster
   * (`membersNamedIn`, 2026-10-24). Shown as the CLUB MEMBERS NAMED line so
   * a name that is also an ordinary word ("Glazers") is known to be a
   * person. Absent or empty: no line.
   */
  members?: readonly string[];
  /** The time the NOW line states (club time). Defaults to now. */
  now?: Date;
}

export interface ExtractionResult {
  facts: Facts;
  degradations: Degradation[];
  usage?: { costUsd: number | null; ms: number; inputTokens: number; outputTokens: number };
  /**
   * The call was REFUSED by the club's daily AI cap (`ai-budget.ts`) and
   * never made. Not a failure of the model and not retried: a second
   * attempt would be refused the same way. The attendance engine reads
   * this to fall back to the floor's deterministic facts.
   */
  budgetRefused?: boolean;
}

export async function extractForRoute(
  model: PipelineModel,
  route: Route,
  msg: ExtractorMessage,
): Promise<ExtractionResult> {
  const kind = extractorFor(route);
  if (kind === "none") return { facts: { kind: "none" }, degradations: [] };

  // ── THE MESSAGE IS NOT ITS OWN CONTEXT (2026-09-09) ────────────────
  //
  // The Pi records every inbound message into its 15-message history
  // buffer BEFORE it buffers it for the flush (`index.ts`:
  // `recordHistory(...)` then `enqueueForAnalysis(...)`), and reads the
  // whole buffer at flush time. So the `history` that arrives here
  // ALREADY CONTAINS the messages in this batch, and every message was
  // being shown its own text under "RECENT CHAT" and then again under
  // "THE MESSAGE".
  //
  // That duplication is what made a bare "In" non-deterministic. A model
  // shown the same line twice reads the second as an ECHO of the first —
  // an acknowledgement of something already said rather than a fresh
  // claim — and returns `claims: []` with `affirmation: "yes"`.
  // MEASURED, `scripts/measure-claimless.ts`, 20 runs each: with the
  // message present in its own recent chat, "In" comes back claimless
  // 14 of 20 and "in" 11 of 20; with the same context and the echo
  // removed, both are 0 of 20. That is the 2026-09-09 incident, in which
  // Abid and Mojib typed "In" and were silently discarded while Wasim
  // and habib typed "In" one second later and were registered.
  //
  // The block's own header already says what it is for — "context only,
  // never extract from it". The message under extraction is not context;
  // it is the subject. Matching on author AND body, so a DIFFERENT
  // person who happened to type the same word keeps their line: their
  // message is real context, and it is the sender's own duplicate that
  // does the damage.
  const recent = msg.history.filter(
    (h) => !(h.body === msg.body && (h.author ?? null) === (msg.authorName ?? null)),
  );
  const context: string[] = [];
  if (recent.length > 0) {
    context.push("RECENT CHAT (context only, never extract from it):");
    for (const h of recent.slice(-8)) {
      context.push(`  ${h.author ?? "(unknown)"}: ${h.body}`);
    }
  }
  // A reply to MatchTime's last post shows it once, as the post replied to.
  const quotesLastPost =
    !!msg.reply && !msg.reply.author && !!msg.lastBotPost && (msg.reply.text ?? "").trim() === msg.lastBotPost.trim();
  if (msg.lastBotPost && !quotesLastPost) {
    context.push(`MATCHTIME'S LAST POST: ${msg.lastBotPost}`);
  }
  context.push(renderGroupReplyContext({ now: msg.now ?? new Date(), quoted: msg.reply ?? null }));
  if (msg.members && msg.members.length > 0) {
    context.push(`CLUB MEMBERS NAMED: ${msg.members.join(", ")}`);
  }
  context.push("");
  context.push(
    `THE MESSAGE (from ${msg.authorName ?? "(unknown)"}${msg.tagged ? ", who tagged the bot" : ""}):`,
  );
  context.push(msg.body);

  const call = EXTRACTOR_CALLS[kind];
  const req: ModelRequest = {
    // The model and its thinking posture, as one value (`EXTRACTOR_CALLS`).
    // On Sonnet 5 that is THINKING OFF. Measured, not assumed — see
    // `llm.ts`'s `ModelRequest.thinking` and `__tests__/thinking-off.test.ts`.
    // On a self-contradictory message, Sonnet's adaptive thinking spent the
    // whole token budget and returned no JSON at all, 5 runs of 5, against
    // the live club. On Haiku 5.5 it is adaptive at `HAIKU_EFFORT`, which
    // answered that same message with text on every arm (2026-10-20).
    ...call,
    system: EXTRACTOR_PROMPTS[kind],
    user: context.join("\n"),
    maxTokens: maxTokensFor(call),
    schema: SCHEMAS[kind],
    label: `extractor:${kind}`,
  };

  // ── ONE RETRY, AND ONLY WHERE SILENCE COSTS A SLOT (§10 step 8) ────
  //
  // `llm.ts` already raises the SDK's retries from 2 to 4, and its
  // comment says why and what it was relying on:
  //
  //   "§10 step 6 puts these calls on the WRITE path, and the failure
  //    mode of a call that gives up is a player who said IN not being in
  //    the squad… It is the FIRST of two defences:
  //    `attendance-engine-batch.ts` hands a message whose extraction
  //    still failed back to the ANALYZER rather than letting it go
  //    silent."
  //
  // Step 8 deletes the second defence. An extraction that fails now
  // means MatchTime says nothing, for a message the router already
  // decided was attendance-shaped.
  //
  // The SDK's four retries cover the transport class — 408, 409, 429,
  // 5xx — with exponential backoff. They do NOT cover the other half of
  // the failure surface: a response the strict schema rejects, or one
  // `parseFacts` cannot read. That half is non-deterministic in exactly
  // the way a fresh call fixes, and it is the half `TruncatedResponseError`
  // and `extractJson` throw on.
  //
  // So: ONE application-level retry, and only on the four routes that
  // end in an attendance write. §11.1 prices the asymmetry — "a false
  // positive costs one extractor call (~$0.002); a false negative costs
  // a player their slot" — and that asymmetry simply does not hold for
  // a question or a score, where a miss costs one answer and §13's rule
  // applies instead: "a missed add is recoverable in one message."
  // Retrying those would spend latency on the write path's worst minute
  // to buy nothing.
  //
  // NOT TWO retries. Past the second attempt the cause is far more
  // likely the message than the weather, and the honest answer is the
  // operator note rather than a third bill and another two seconds of a
  // ten-minute flush budget.
  const attempts = RETRYING_ROUTES.includes(route) ? 2 : 1;
  const failures: string[] = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const resp = await model.complete(req);
      const parsed = parseFacts(kind, resp.text, msg.id);
      return {
        ...parsed,
        usage: {
          costUsd: resp.costUsd,
          ms: resp.ms,
          inputTokens: resp.usage.inputTokens + resp.usage.cacheReadTokens,
          outputTokens: resp.usage.outputTokens,
        },
      };
    } catch (err) {
      if (isAiBudgetExceeded(err)) {
        return {
          facts: { kind: "none" },
          degradations: [degradation("extractor", msg.id, `${kind} extractor not called: ${(err as Error).message}`)],
          budgetRefused: true,
        };
      }
      failures.push((err as Error).message);
    }
  }

  // §11.4: on extractor failure, fail CLOSED — but say so. Until step 8
  // the surface was the partial-response admin DM matching one of six
  // free-text `reasoning` prefixes; it is now `lib/operator-note.ts`,
  // which selects on the typed fact that nobody owned the message.
  //
  // The wording distinguishes one failure from two. They are different
  // signals about the same minute: once is a message the model found
  // odd, twice in a row is the model having a bad time, and an operator
  // reading a DM at 22:00 acts differently on each.
  return {
    facts: { kind: "none" },
    degradations: [
      degradation(
        "extractor",
        msg.id,
        failures.length > 1
          ? `${kind} extractor failed TWICE: ${failures.join(" | ")}`
          : `${kind} extractor failed: ${failures[0]}`,
      ),
    ],
  };
}

export function defaultExtractorModel(): PipelineModel {
  return anthropicModel();
}
