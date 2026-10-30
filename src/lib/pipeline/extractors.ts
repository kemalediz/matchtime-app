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
 *
 * And rewritten whole again the same day (Friday MT Community, "find me
 * players feom partner clubs and player pool": two places, a field for
 * one, so "unsaid"): `playersFrom` is now the LIST of places named, empty
 * when none, with "everywhere" as all three, the examples regrouped by one
 * place, several places and none, and the answers "both" and "all".
 * 10,540 to 11,257 characters. Paid check: scripts/live-check-ask-both.ts,
 * then one pass of ask-source, hq-pool, partner-ask-words, admin-group,
 * players-cancel, hq-outward, hq-cancel, free-places and the recruit and
 * ask-source live sims.
 *
 * And again the same day (Kemal: every admin feature also works by
 * WhatsApp; MT Test 15:40 UTC, "@Match Time added the venue location" was
 * read "other" and got "I can't change that by message"): two actions,
 * `set_venue` (the pitch named, or picked from MatchTime's list, with
 * `venueName` and `venueChoice`) and `retry_ask` (try the last request
 * again, or what stopped it is fixed), each defined once beside the others,
 * their fields once, and their examples grouped as the pitch, the answer to
 * MatchTime's list, and trying again, EN and TR. The intro now says the
 * context also tells what a short answer answers. 11,257 to 13,391
 * characters. Paid check: scripts/live-check-admin-retry-venue.ts, then
 * one pass of every suite above.
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
// ATTENDANCE, 2026-10-28: BEING FREE TO PLAY IS THE BENCH. FNF, Seb, to a
// full squad: "I'm free to play this Friday if there's any drop outs" was
// read as `basis: availability` and held; 38 minutes later his "@Match Time
// In" benched him. Kemal: people who say they are free or available for a
// match go on the bench. Rewritten as a whole, not appended to: `basis` is
// retired, being free to play is defined once (in THE CLAIMS, polarity,
// contingent) as the sender's offer to fill a gap, a new "Not about
// anyone's place" group says what "free" alone never is (the fee, a
// question, a return date, the past), and a third party said to be free is
// an offer of them, contingent, held by the engine. 14,217 to 14,967
// characters. Live results in the PR (scripts/live-check-attendance-
// extractor.ts, F* cases).
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
Return one claim for each person the message speaks about as a player in the club's match: joining, leaving, the bench, a maybe, or being free to play. A message that says none of that about anyone returns an empty claims array. Being free means free for the match: free, around or available to play, on its own or with "if you need me" or "if someone drops". The word alone settles nothing: free of the fee, free for a drink, a question asking who is free, and news of where someone will be with no word on playing ("I land Monday", "I will be back Tuesday week") are not about anyone's place.
  subject      "sender" for the person who typed it, "other" for anyone else
  personRef    the words used for that person, VERBATIM. Never invent or expand a name. "" for the sender. A relationship followed by a name is the name: "my brother Shahrokh" is "Shahrokh". One exception: a "he", "him" or "o" that points at the author of the quoted message is written as that author's name, as the THEY ARE REPLYING TO line gives it; when that line names no one ("a member (not identified)"), keep the words as they are
  personNamed  true when the words identify a particular person: a name, a nickname or an @mention, including a word that may only be a nickname (code checks every name against the squad). false only for a relationship, a quantity or an indefinite: "my brother", "2 of my guys", "someone", "a mate", "another keeper"
  polarity     what the message says that person is doing in the match:
                 "in"     joining, or staying in
                 "out"    leaving or not coming: the person gives up their place, asks for someone to take it, or says they will not or cannot play ("out", "can't make it", "anyone replace me?", "I can drop out", "I'm away that week"). An injury, a knock or tiredness on its own is not "out": someone "taking it easy" is still playing
                 "bench"  the bench, in one of two ways. The message names it explicitly: bench, reserve, sub, backup, spare, standby, waiting list, "yedek" in any form, or 🪑. Or the sender offers themselves to fill a gap, by asking to be called on or by saying they are free to play, and takes no place yet ("ping me if you need one more", "I can play if you're short", "I'm free Friday if you need me"): that is "bench" with contingent true and conditionOn "squad", never "in" and never a maybe. This second way is only ever the sender's own: someone else said to be free is "in". Nothing else is the bench. A message that also asks for the place outright is "in": "I'm free Tuesday, put me down"
  contingent   true when the claim depends on something that has not happened yet: "in if my back holds up", "count me in if someone drops", "happy to drop if you find someone". An OFFER to give up a place is contingent with no "if" in it ("I can drop out", "happy to pull out", "I'll make room"): the test is whether the person IS doing it or only COULD. Being free to play is contingent too, with no "if" needed ("I'm free Friday", "my brother is free"): it says they can be called on, not that they are playing. Someone who can play, is coming or can take a place, with no condition, is not contingent: "my cousin Ali can play", "two of my guys can play", "Ali can take my spot" are false. false for a decision already taken ("I'm in", "I'm out", "can't make it"), and for asking for cover: "anyone able to replace me?" says they are leaving, whether or not someone is found. A position is a note, not a condition, so it is false too
  conditionOn  "squad" when the condition is the squad or the team's needs, which includes every offer to fill a gap, to give up a place or to play when free; "self" when it is about the person themselves; otherwise "none"
  tense        "present" now; "future" a commitment or offer about an upcoming match, including a standing one ("count me in whenever you are short") and one with a condition; "past" something that already happened ("I was in last week"); "hypothetical" a counterfactual about something that is not the case ("if I WAS in the team it would not be ruined"). Relayed words keep the tense of what was said, not of the saying: "Najib said he's in" is present
  reported     true when relaying what someone else SAID ("Najib said he's in", "Ali geliyorum dedi"). A plain statement about someone ("Kai can't make it tonight") is not reported
  replaces     ONLY on an "in" claim, and only when the message says this person takes somebody else's place: the words used for that other person, VERBATIM ("Najib", "@Najib", "me"). "" everywhere else
  confidence   0 to 1, how sure you are that the message says this

THE WHOLE MESSAGE
  affirmation  "yes" or "no" when the message is a bare answer to MatchTime ("Confirmed", "yes", "no"): to the MatchTime message it replies to, else to MATCHTIME'S LAST POST. Otherwise "none". Words that state the sender's own place ("in", "varım", "out") are a claim, whatever they answer
  sideRequests any of, for what else the message asks for beside its claims:
                 "recruit"   it says how many players are needed, as a number, or whose place needs taking ("we're 4 short, anyone free?", "can someone take my spot?")
                 "chase"     it nudges for more players with no number and no name ("@all we need more players pls")
                 "question"  it also asks MatchTime for something it holds, such as the list, who is in or how many ("@Match Time what's the list?", "how many are we now?"), never a question put to another member ("@Ali can you play?")

EXAMPLES
Messages come in English or Turkish, often mixed or misspelt, and carry the same facts either way. Each group teaches one thing, English | Turkish.

The sender's own place: subject sender, contingent false.
  "I'm in", "count me in", "I'm in for next Tuesday" | "varım", "ben varım", "geliyorum", "sayın beni", "var" -> in
  "I'm out", "can't make it", "I'm away that week" | "yokum", "ben yokum", "gelemiyorum", "yok", "bu hafta yokum" -> out
  "@Match Time in", "@Match Time out" -> the sender in, the sender out: the tag addresses MatchTime
  "me too", or "same" replying to a neighbour's "I'm in" | "ben de" after "ben varım" -> the sender's own claim, the same polarity as the line it answers
  Other members typing the same "in" or "out" just before does not make the sender's line an echo: it is the sender's own claim
  "I'll go in goal" | "kaleye geçerim" -> the sender in, contingent false: they are playing, and the position is a note
  "in, for bench", "In as a reserve", "put me on standby" | "yedekte kalayım", "yedeğe yaz beni" -> bench
  The chat shows 14/14 with the sender already on the list, and the sender types "in" | "varım" -> polarity in, not bench

The sender's own offers: they COULD and have not yet. Contingent true, conditionOn "squad", tense future.
  To fill a gap, playing themselves: "ping me if you need one more", "I can play if you're short", "count me in if someone drops", "count me in whenever you are short", "I'll be the 14th if you're short", "put me down if you're short" | "eksik olursa ben gelirim", "biri çıkarsa beni yazın", "biri düşerse oynarım" -> the sender bench
  Saying they are free to play, with or without "if you need me": "I'm free to play this Friday if there's any drop outs", "available to play if needed", "I'm free if you need me", "I'm around if you're short", "I'm free Friday", a bare "I'm around" about the match | "cuma boşum, lazım olursa", "müsaitim, gerekirse oynarım", "cuma boşum" -> the sender bench
  To give up a place: "I can drop out", "happy to drop if you find someone", "happy to pull out" | "gerekirse çıkarım", "yerimi verebilirim" -> the sender out

Not about anyone's place: no claim.
  "I land Monday", "I will be back Tuesday week" | "pazartesi dönüyorum" -> no claim: where they will be, not whether they play
  "are you free Friday, Ali?", "who's free tonight?" | "Ali cuma boş musun?" -> no claim for anyone: a question
  "is it free this week?", "he plays for free, he did the bibs" | "bu hafta ücretsiz mi?" -> no claim: the fee
  "I was free last week, shame there was no game" | "geçen hafta boştum" -> no claim: it is over
  "Mojib, Habib and Kieran on the same side" | "Mojib ile Habib aynı takımda" -> no claim
  "@Yusuf how fit are you?" | "Yusuf ne kadar formda?" -> no claim

Fitness and injuries: out only when the person says they will not or cannot play, and a hedge when they say they will decide later.
  "I've got a bad hamstring so taking it easy", "knee's a bit dodgy tonight" | "dizim ağrıyor, yavaş oynarım" -> no claim: they are still playing
  "knee's sore, I'll see how it feels on the day and let you know" | "dizim ağrıyor, maç günü bakıp haber veririm" -> the hedge
  "bit sore from Sunday but I'll be there" | "dizim ağrıyor ama gelirim" -> the sender in
  "hamstring's gone, can't make it tonight" | "sakatım, gelemiyorum" -> the sender out
  "got a nasty cold, can someone take my spot?" | "gripim, yerime biri gelebilir mi?" -> the sender out, plus "recruit"

Other people: subject other, personRef as written.
  "Ali is coming too" | "Ali de geliyor" -> Ali in, reported false
  "Ali said he's coming" | "Ali geliyorum dedi" -> Ali in, reported true
  "Mehmet can't come" | "Mehmet gelemiyor" -> Mehmet out
  "he's out" replying to Ali Khan's message | "o yok" -> personRef "Ali Khan", out
  "+1", "+2" or "plus one", alone or after the sender's own claim, is a GUEST the sender brings, never the sender: subject other, personRef the token verbatim ("+1"), personNamed false, in. "ben de" is the sender; "+1" is not.

Offering someone else: the one who would play is another person, even when the sender brings them. One claim, for that person only: subject other, in, never bench: the bench is only ever the sender's own offer. The sender says nothing about their own place, so there is no claim for the sender. contingent is true only when the message states a condition or says the person is free, as for every claim.
  The player is whoever would be on the pitch. "I can play if you're short" is the sender. When the sender would bring, get or ask someone ("I can bring someone if you're short", "I'll get a mate if you need", "I can ask my brother"), the player is that someone, never the sender
  "my cousin can come if needed", "I could bring a mate if we're short", "my brother is free Friday", "Najib is free if we need one" | "gerekirse kardeşim gelir", "bir arkadaşımı getirebilirim", "kardeşim cuma boş, lazım olursa" -> the cousin, the mate, the brother or Najib in (not bench), contingent true, conditionOn "squad"
  "my cousin Ali can play" | "kuzenim Ali de oynar" -> Ali in, contingent false

Several people in one message: one claim each, with any side request.
  "I'm in, and my brother can play too" -> two claims
  "is anyone able to replace me and Habib tonight?" | "bu akşam benim ve Habib'in yerine gelebilecek var mı?" -> the sender out and Habib out, contingent false, plus "recruit"

Several things in one message: the claims, plus what else it asks MatchTime for.
  "Kai is out now. @Match Time what's the list?" | "Kai yok. @Match Time liste ne?" -> Kai out, plus "question"
  "Kai out, @Ali can you play?" | "Kai yok, @Ali gelebilir misin?" -> Kai out, no side request: the question is put to Ali, not MatchTime

Hedges: the sender might play and has not decided. Subject sender, in, contingent true, conditionOn "self", tense future. This shape is what gets the person asked again nearer the match; an empty claims array for a hedge is a maybe nobody follows up.
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

THE MESSAGE is the one you report on, with its sender. Above it you may see RECENT CHAT, MATCHTIME'S LAST POST (often the two teams as they stand), NOW (the time at the club) and, for a WhatsApp reply, the message it quotes (the THEY ARE REPLYING TO line). They tell you who "him", "them", "everyone" or "the teams" are and which team a player is on now; every field comes from THE MESSAGE.

WHAT YOU RETURN
action, exactly one:
  "show" post the teams as they stand, unchanged.
  "generate" work the line-ups out again: new teams, made, made again or shuffled. This holds even when the same message also asks for new names, or says "again", "once more" or "instead".
  "swap" change the teams as they stand and leave everyone else where they are: people change team, go to a named team, end up together, or the two teams swap over. A message that only puts people on a team or together, without asking for new teams, is "swap".
  "suggest" asks you to recommend changes that make the teams fairer.
  "rename" keep the same two line-ups and change only their names.
includeRefs
  people the message says must play.
teamNames
  the two team names, in order: the ones the message gives or, when it asks you to pick the names, make up two short names (different, at most 24 characters each, not Red or Yellow, in the language THE MESSAGE is written in). An empty array when the message is not about names.
moves
  every person who goes to the OTHER team from wherever they are now, when no team is named for them. A swap of two people is both of them; a list of swaps is every name in it.
swaps
  people the message puts on a NAMED team, with that team, RED or YELLOW. When MATCHTIME'S LAST POST lists the two teams, the first one listed is RED and the second YELLOW, whatever they are called.
pairings
  people who must end up on the same team as each other, one array per group.
swapSides
  true when the two whole teams swap over, so that every player changes team; moves is then empty. False otherwise.

Write every person as the message writes them. When the sender means themselves ("me", "I", "beni", "bana", "ben") write "me". Every field the message says nothing about is empty, or false.

EXAMPLES, English and Turkish
Seeing the teams:
  "teams?" / "show me the teams" / "takımları göster" -> show
  "show us the teams again without regenerating" -> show
New teams:
  "generate the teams" / "make the teams" / "shuffle them again" / "takımları kur" / "yeniden kur" -> generate
  "generate the teams, Ibrahim is playing" -> generate, includeRefs ["Ibrahim"]
  "make the teams and put me and David on the same team" -> generate, pairings [["me","David"]]
  "generate the teams, you pick some fun names" / "takımları kur, isimleri sen seç" -> generate, teamNames two names you make up
  "generate the teams, call them Lions and Tigers" -> generate, teamNames ["Lions","Tigers"]
New names, same teams:
  "call the teams Lions and Tigers" / "takımların adı Aslanlar ve Kaplanlar olsun" -> rename, teamNames ["Lions","Tigers"] / ["Aslanlar","Kaplanlar"]
Changing the teams as they stand:
  "swap Ali and Can" / "Ali ile Can'ı değiştir" -> swap, moves ["Ali","Can"]
  "move Tom to the other team" / "Tom'u diğer takıma al" -> swap, moves ["Tom"]
  "swap Rafi and Yorel, Mo and Akram", one pair a line or not / "Rafi ile Yorel, Mo ile Akram yer değiştirsin" -> swap, moves ["Rafi","Yorel","Mo","Akram"]
  "put David in Red" / "David kırmızıya geçsin" -> swap, swaps [{"personRef":"David","team":"RED"}]
  "Ali and Habib on one team" / "put Ali with Habib" / "Ali ile Habib aynı takımda olsun" -> swap, pairings [["Ali","Habib"]]
  "swap everyone on bibs with non bibs" / "move team 1 over to team 2" / "swap them over", after both teams were listed / "takımların yerini değiştir" -> swap, swapSides true
Fairer teams:
  "recommend swaps" / "any swaps to even it up?" / "takımları dengelemek için ne önerirsin?" -> suggest`,

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

  admin: `You read ONE message from a football club's chat (the organisers' group, the players' group, or a private message to the bot) and report what it asks MatchTime, the club's bot, to do, and whether it is spoken to MatchTime at all. You report the words; code decides what happens. Messages are English or Turkish, often mixed.

THE MESSAGE is the one you report on, with its sender and whether they tagged the bot. Above it you may see RECENT CHAT, MATCHTIME'S LAST POST, NOW (the date and time at the club) and, for a WhatsApp reply, the message it quotes (THEY ARE REPLYING TO). The context tells you who "he" or "them" is, who is being spoken to, and what a short answer answers. The action and every field come from THE MESSAGE.

THE ACTION, exactly one. A question, an opinion or a discussion about whether to do something ("should we cancel?", "should Bilal play free?", "shall we try the pool?") is "other".
  "recruit" find players who are not in the squad yet; playersFrom says from where. Showing, listing or counting the squad is "other", and so is talking about another club or the player pool.
  "cancel_match" call off one of the club's games: cancel it, it is not happening, no game. Of a game whose time has gone: it never took place ("it didn't happen", "olmadı").
  "restore_match" put a called-off game back on: it is back on, uncancel it, it goes ahead after all. Of a game whose time has gone: it did take place after all.
  "season_break" no football for a whole MONTH or more ("no football in December", "aralıkta maç yok"), or the football is back in a month ("we're back in January", "ocakta başlıyoruz"). One game off ("no game Friday", "bu hafta maç yok") is "cancel_match".
  "set_venue" tell MatchTime where the club plays: name its pitch or venue, or pick one of the places MatchTime listed. Asking where the game is, or talking about a pitch, is "other".
  "retry_ask" try MatchTime's last request again, or say that what stopped it is now done or fixed, naming nothing new ("done, try again", "added the venue location"). A message that names the place is "set_venue"; one that asks for something again in full ("now ask the pool") is that action.
  "fee_waiver" give named players a free place, so they owe nothing for a game, or take one back. "Free" as in able to play ("I'm free Tuesday") is not this.
  "bulk_payment" someone paid for several players.
  "reminder" MatchTime is to remind the sender, at a time.
  "stats_blast" MatchTime itself is to send every player their own stats or ratings link. Telling the PLAYERS to do something (rate each other, open their link) is "other".
  "other" anything else.

THE FIELDS. Fill toMatchTime always and the others for the action; every other field is "", 0, false or [].
  toMatchTime (always): true when the message tells or asks MatchTime itself to do something: it tags the bot, replies to MatchTime's own post, answers the question MatchTime just asked, or is an instruction that names and tags nobody else ("ask the group if anyone can play"). False when it speaks to a person or to the others: it tags or names a person to ask them, or asks the others whether to do it or whether they can ("can we ask...?", "should we...?", "you able to find players?").
  playersFrom (recruit): every place the message means the players are to come from, never guessed; [] when it names none (MatchTime then asks).
    "club" the club's own players (its regulars, the lads, its past players, its players' group: "the group", "the main group").
    "partners" another club, a partner club or the other groups, named or not.
    "pool" the MatchTime player pool, players from outside the club and its partners ("the pool", "someone nearby", "a player from the app").
    "everywhere" or "wherever you can" ("her yerden", "nereden olursa") is all three. An answer to MatchTime's own question about where to look (MATCHTIME'S LAST POST, or the message replied to) is recruit from the places it picks, however short: "both" is the two places the question offers (of three, the partner clubs and the pool), "all" is every place it offers, and a yes to a question offering one place is that place.
  lookbackMatches (recruit from the club): how many recent matches to draw the club's own players from ("the last 5 matches" is 5, "the last couple of games" is 2); 0 when no number is named.
  clubRef (recruit from partners): the other club's name as written, without a Turkish case ending ("Sutton'a" is "Sutton"); "" when no club is named.
  matchDay (cancel_match, restore_match, fee_waiver): the day named for the game, as written ("tonight", "next Friday", "cuma", "last Tuesday"); "" when none or only "this week".
  pastGame (cancel_match, restore_match): true when the game meant has already been, or should have been, played: it says the game didn't happen or did happen after all, or names a game gone by ("last Tuesday's", "the last match", "yesterday", "dün", "geçen hafta").
  breakMonths (season_break): each month with no football, as "YYYY-MM", the next such month from NOW ("December" in October 2026 is "2026-12"; "December and January" is both).
  playMonths (season_break): each month the football is on or back in, as "YYYY-MM" the same way.
  venueName (set_venue): the pitch or venue as named, without a Turkish case ending ("Powerleague Shoreditch'te" is "Powerleague Shoreditch"). For a pick from MatchTime's numbered list of places, the name that list was for.
  venueChoice (set_venue): the number of the place picked from MatchTime's list ("2", "the second one", "ikincisi" is 2); 0 when the message names the place itself.
  coveredRefs (fee_waiver, bulk_payment): the people the action is about, one entry each, as written: those given or losing the free place, or those paid for. "he" or "him" is the person named, else the author of the quoted message.
  undo (fee_waiver): true when it takes a free place back.
  payerRef (bulk_payment): who paid, as written.
  count (bulk_payment): how many players they paid for.
  phrase (reminder): the time phrase exactly as written ("tomorrow at 6"), never a date.
  note (reminder): what to remind about, in their own words ("bring the bibs"); "" when it names nothing.

EXAMPLES, English / Turkish, grouped by what they teach. toMatchTime is true unless shown.
Spoken to MatchTime, or to a person:
  "ask the group if anyone can play" / "MatchTime oyuncu grubuna sor" -> recruit, playersFrom ["club"], toMatchTime true
  "@Kemal can we ask Sutton group?" -> recruit, playersFrom ["partners"], clubRef "Sutton", toMatchTime false
  "should we ask the group?" / "gruba soralım mı?" -> other, toMatchTime false
  "shall we try the pool?" / "havuza soralım mı?" -> other, toMatchTime false
  "you able to find players?" / "oyuncu bulabilir misin?" (to another organiser) -> other, toMatchTime false
Players from one place:
  "@Match Time ask the group" / "@Match Time gruba sor" -> recruit, playersFrom ["club"]
  "message the lads from the last 5 matches and invite them" / "son 5 maçta oynayanlara yaz, davet et" -> recruit, playersFrom ["club"], lookbackMatches 5
  "ask the regulars if they can play" / "düzenli gelenlere sor, oynayabilirler mi" -> recruit, playersFrom ["club"]
  "ask Sutton if anyone can play" / "Sutton'a sor bakalım oynayan var mı" -> recruit, playersFrom ["partners"], clubRef "Sutton"
  "@Match Time ask Friday MT Community if anyone can play tonight" -> recruit, playersFrom ["partners"], clubRef "Friday MT Community"
  "search for players from our partner groups" / "diğer gruplara sor, oynayacak biri var mı" -> recruit, playersFrom ["partners"], clubRef ""
  "@Match Time ask the pool for a player" / "@Match Time havuzdan bir oyuncu bul" -> recruit, playersFrom ["pool"]
  "find someone nearby for tonight" / "bu akşam için yakınlardan birini bul" -> recruit, playersFrom ["pool"]
  "get us a player from the app" / "uygulamadan bir oyuncu bulur musun" -> recruit, playersFrom ["pool"]
Players from several places, or from none said:
  "find me players from partner clubs and the player pool" / "partnerlere ve havuza sor" -> recruit, playersFrom ["partners","pool"]
  "ask Sutton and the pool" / "Sutton'a ve havuza sor" -> recruit, playersFrom ["partners","pool"], clubRef "Sutton"
  "ask the group and our partner clubs" / "gruba ve partner kulüplere sor" -> recruit, playersFrom ["club","partners"]
  "find us players everywhere" / "her yerden oyuncu bul" -> recruit, playersFrom ["club","partners","pool"]
  "we need 2 players for Thursday" / "perşembeye 2 kişi lazım" -> recruit, playersFrom []
  "@Match Time find us a player for Friday" / "@Match Time cumaya bir oyuncu bul" -> recruit, playersFrom []
Answering MatchTime's "Who shall I ask for players: your players' group, your partner clubs, or the MatchTime player pool?":
  "the pool" / "havuza" -> recruit, playersFrom ["pool"]
  "partners please" / "partner kulüplere" -> recruit, playersFrom ["partners"]
  "the group" / "gruba sor" -> recruit, playersFrom ["club"]
  "ask Sutton" / "Sutton'a sor" -> recruit, playersFrom ["partners"], clubRef "Sutton"
  "both" / "ikisine de" -> recruit, playersFrom ["partners","pool"]
  "all of them" / "hepsine" -> recruit, playersFrom ["club","partners","pool"]
Talk about a club or the pool, not a request:
  "Sutton were great last week" / "Sutton geçen hafta çok iyi oynadı" -> other, toMatchTime false
  "did Sutton ever get back to us?" -> other, toMatchTime false
  "the pool lad last week was good" / "geçen haftaki havuz oyuncusu iyiydi" -> other, toMatchTime false
A game off, or back on (pastGame false unless shown):
  "Cancel the session" / "maçı iptal et" -> cancel_match, matchDay ""
  "storm, no game Friday" / "bu hafta maç yok" -> cancel_match, matchDay "Friday" / ""
  "it's back on, uncancel Friday" / "maç yapılıyor, iptali geri al" -> restore_match, matchDay "Friday" / ""
  "Tuesday's game never took place" / "salı maçı yapılmadı" -> cancel_match, matchDay "Tuesday" / "salı", pastGame true
  "cancel the last match, we didn't play" / "geçen haftaki maçı iptal et, oynamadık" -> cancel_match, matchDay "" / "geçen hafta", pastGame true
  "Tuesday's game did go ahead after all" / "salı maçı aslında oynandı" -> restore_match, matchDay "Tuesday" / "salı", pastGame true
  "should we cancel Friday?" / "the session should be cancelled anyway" -> other, toMatchTime false
A month or more off, or back (NOW is October 2026 here):
  "@Match Time no football in December" / "@Match Time aralıkta maç yok" -> season_break, breakMonths ["2026-12"]
  "no games December or January, back in February" / "aralık ve ocakta maç yok, şubatta dönüyoruz" -> season_break, breakMonths ["2026-12","2027-01"], playMonths ["2027-02"]
  "@Match Time we're back mid January" / "@Match Time ocak ortasında dönüyoruz" -> season_break, playMonths ["2027-01"]
  "are we playing in December?" / "aralıkta maç var mı?" -> other
The club's pitch:
  "@Match Time our pitch is Goals Sutton" / "@Match Time sahamız Goals Sutton" -> set_venue, venueName "Goals Sutton"
  "we play at Powerleague Shoreditch now" / "artık Powerleague Shoreditch'te oynuyoruz" -> set_venue, venueName "Powerleague Shoreditch"
  answering MatchTime's "I found more than one place for *Goals Sutton*. Which one is it?" and its list: "2" / "ikincisi" -> set_venue, venueName "Goals Sutton", venueChoice 2; "the first one" / "birincisi" -> venueChoice 1
  "@Match Time where is the game?" / "@Match Time maç nerede?" -> other
  "the pitch at Goals was flooded" / "Goals'un sahası su basmıştı" -> other, toMatchTime false
Trying again after MatchTime said it could not do something:
  "@Match Time added the venue location" / "@Match Time tamam ekledim" -> retry_ask
  "done, try again" / "şimdi dene" -> retry_ask
  "@Match Time I've switched the pool on, go ahead" / "@Match Time havuzu açtım, devam et" -> retry_ask
  "@Match Time thanks" / "@Match Time teşekkürler" -> other
Free places and payments:
  "Bilal washed the bibs, he's free this week" -> fee_waiver, coveredRefs ["Bilal"]
  "put Bilal down as free on Friday" / "Ali ve Can cuma günü ödemesin" -> fee_waiver, coveredRefs ["Bilal"] / ["Ali","Can"], matchDay "on Friday" / "cuma günü"
  "Bilal bu akşam ücretsiz oynasın" -> fee_waiver, coveredRefs ["Bilal"], matchDay "bu akşam"
  "scrap that, Tom isn't free, he pays" / "Ali ücretsiz değil, ödesin" -> fee_waiver, coveredRefs ["Tom"] / ["Ali"], undo true
  "should Bilal play free?" -> other, toMatchTime false
  "Amir paid for 4 players" -> bulk_payment, payerRef "Amir", count 4
  "Amir paid for Faris and Adam" -> bulk_payment, payerRef "Amir", count 2, coveredRefs ["Faris","Adam"]
Reminders and stats:
  "remind me tomorrow at 6 to bring the bibs" / "yarın 6'da yelekleri getirmeyi hatırlat" -> reminder, phrase "tomorrow at 6" / "yarın 6'da", note "bring the bibs" / "yelekleri getirmeyi"
  "@Match Time send everyone their stats" / "@Match Time DM the squad their ratings links" -> stats_blast
  "lads don't forget to rate the players via the link MatchTime DM'ed you" -> other, toMatchTime false
  "did everyone get their stats link?" -> other, toMatchTime false
  "@Match Time what are my stats" -> other
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
    action: { type: "string", enum: ["show", "generate", "rename", "swap", "suggest"] },
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
    // 2026-10-29: "swap everyone on bibs with non bibs", "swap them over".
    // The two whole teams swap over; no names, so not `moves`.
    swapSides: { type: "boolean" },
  },
  required: ["action", "includeRefs", "teamNames", "swaps", "moves", "pairings", "swapSides"],
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
      enum: ["bulk_payment", "fee_waiver", "reminder", "recruit", "stats_blast", "cancel_match", "restore_match", "set_venue", "retry_ask", "season_break", "other"],
    },
    // season_break (2026-10-29): the months with no football, and the
    // months it is back in, each "YYYY-MM".
    breakMonths: { type: "array", items: { type: "string" } },
    playMonths: { type: "array", items: { type: "string" } },
    payerRef: { type: "string" },
    count: { type: "number" },
    coveredRefs: { type: "array", items: { type: "string" } },
    // fee_waiver (2026-10-16): taking a free place back, and the day named.
    undo: { type: "boolean" },
    matchDay: { type: "string" },
    // cancel_match / restore_match (2026-10-28): a game whose time has gone.
    pastGame: { type: "boolean" },
    phrase: { type: "string" },
    note: { type: "string" },
    // 0 is the schema's stand-in for null, the same convention
    // `statedCount` uses. A nullable number is rejected by the API.
    lookbackMatches: { type: "number" },
    // recruit: every place the players are to come from (2026-10-28: a
    // list, "partner clubs and the pool"; it was one choice since L10, and
    // S6's `partnerClubs` boolean before that); empty when the words name
    // none. The other club's name as written for "partners" (slice S6).
    playersFrom: { type: "array", items: { type: "string", enum: ["club", "partners", "pool"] } },
    clubRef: { type: "string" },
    // set_venue (2026-10-28): the place as named, and the number picked from
    // MatchTime's list of places (0 is the stand-in for "none picked").
    venueName: { type: "string" },
    venueChoice: { type: "number" },
    // Who the message is spoken to (2026-10-22): MatchTime, or a person or
    // the others. Code lets nothing leave HQ untagged unless it is MatchTime.
    toMatchTime: { type: "boolean" },
  },
  required: ["action", "payerRef", "count", "coveredRefs", "undo", "matchDay", "pastGame", "phrase", "note", "lookbackMatches", "playersFrom", "clubRef", "venueName", "venueChoice", "breakMonths", "playMonths", "toMatchTime"],
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
        const subject = str(r.subject).toLowerCase() === "other" ? "other" : "sender";
        claims.push({
          subject,
          personRef: str(r.personRef),
          personNamed: bool(r.personNamed),
          polarity,
          contingent: bool(r.contingent),
          conditionOn,
          tense,
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
      if (!["show", "generate", "rename", "swap", "suggest"].includes(action)) {
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
        swapSides: raw.swapSides === true,
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
      if (!["bulk_payment", "fee_waiver", "reminder", "recruit", "stats_blast", "cancel_match", "restore_match", "set_venue", "retry_ask", "season_break", "other"].includes(action)) {
        bad(`unknown admin action "${str(raw.action)}"`);
        return { facts: { kind: "none" }, degradations };
      }
      const clubRef = typeof raw.clubRef === "string" ? raw.clubRef.trim() : "";
      const from = playersFromOf(raw.playersFrom);
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
        ...(["cancel_match", "restore_match"].includes(action) && raw.pastGame === true ? { pastGame: true } : {}),
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
        ...(action === "recruit" && (from.has("partners") || clubRef) ? { partnerClubs: true } : {}),
        ...(action === "recruit" && clubRef ? { clubRef } : {}),
        // L10: the MatchTime player pool. With a club named, only when the
        // partners are named too ("ask Sutton and the pool"): a club name
        // alone is another club, so the pool is not asked by a guess.
        ...(action === "recruit" && from.has("pool") && (!clubRef || from.has("partners")) ? { pool: true } : {}),
        // 2026-10-28: the club's own players, named (alone or beside
        // another place: "ask the group and the pool", "everywhere").
        ...(action === "recruit" && from.has("club") ? { ownClub: true } : {}),
        // 2026-10-28 (Kemal, "stricter"): the words asked for players and
        // named no place. Never with a club named (that is another club).
        ...(action === "recruit" && from.size === 0 && !clubRef ? { sourceUnsaid: true } : {}),
        // 2026-10-28: the pitch named, and a pick from MatchTime's list
        // (a whole number from 1). Carried on set_venue only.
        ...(action === "set_venue" && typeof raw.venueName === "string" && raw.venueName.trim() ? { venueName: raw.venueName.trim() } : {}),
        ...(action === "set_venue" && typeof raw.venueChoice === "number" && Number.isInteger(raw.venueChoice) && raw.venueChoice > 0
          ? { venueChoice: raw.venueChoice }
          : {}),
        // season_break (2026-10-29): only well-formed "YYYY-MM" months.
        ...(action === "season_break" ? { breakMonths: monthKeysOf(raw.breakMonths), playMonths: monthKeysOf(raw.playMonths) } : {}),
        // Only a clear true: a missing or false value keeps HQ's outward
        // actions closed (`admin-group-understand.ts`).
        ...(raw.toMatchTime === true ? { toMatchTime: true } : {}),
      };
      return { facts, degradations };
    }
  }
}

/** "YYYY-MM" months from the model, deduplicated; anything else dropped. */
function monthKeysOf(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x): x is string => typeof x === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(x.trim())).map((x) => x.trim()))];
}

/**
 * The places `playersFrom` names (2026-10-28: a list). A single string is
 * read too, the shape before the list, which stubs and recorded answers
 * carry, with its meaning then: "unsaid" is no place, and "" or no field
 * at all (on a recruit) was the club's own players. The schema requires the
 * list, so a real answer always has it. Anything else is ignored.
 */
function playersFromOf(v: unknown): Set<"club" | "partners" | "pool"> {
  const items = Array.isArray(v) ? v : v === undefined || v === null ? ["club"] : typeof v === "string" ? [v.trim() === "" ? "club" : v] : [];
  const out = new Set<"club" | "partners" | "pool">();
  for (const item of items) {
    const x = typeof item === "string" ? item.trim().toLowerCase() : "";
    if (x === "club" || x === "partners" || x === "pool") out.add(x);
  }
  return out;
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
