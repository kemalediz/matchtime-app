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
import { FORM_SIZES } from "../form-scale";
import { parseUnifiedQuestion, UNIFIED_QUESTION_PROMPT, UNIFIED_QUESTION_SCHEMA } from "./unified-question";
import type {
  PersonKind,
  AdminFacts,
  AttendanceFacts,
  Claim,
  ConditionOn,
  Degradation,
  Facts,
  Polarity,
  Route,
  ScoreFacts,
  SideRequest,
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
 * Teams was rewritten whole again on 2026-10-30 (FNF HQ, 29 Oct): two
 * actions, "restore" (the teams of an earlier sheet the message quotes)
 * and "set" (both sides written out, with `sides`), and `toMatchTime`
 * (asked of MatchTime, or people talking about the teams), each defined
 * once, the examples grouped by what they teach, EN and TR. 4,676 to 6,499
 * characters. Paid check: scripts/live-check-hq-teams-2026-10-30.ts, then
 * one pass of live-check-teams-extractor, live-check-hq-teams-2026-10-29
 * and live-check-admin-group.
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
 *
 * And on 2026-10-31 (MT Test, "@Match Time turn off quiet hours now" was
 * read "other" and got "I can't change that by message"): one action,
 * `quiet_hours`, defined once in the action list, its three fields
 * (`quietOff`, `quietFrom`, `quietTo`) once in the field list, and one
 * example group, EN and TR side by side, with a question and talk about
 * them as "other". Nothing else reworded. 13,528 to 14,818 characters.
 * Paid check: scripts/live-check-quiet-hours.ts, then one pass of the
 * admin extractor's suites.
 */
/*
 * And on 2026-11-03 (the Vets play one down, Kemal: every admin feature by
 * WhatsApp too): one action, `min_players`, beside quiet hours with the
 * other club settings, its two fields (`minPlayers`, `fullTeams`) once in
 * the field list, `matchDay` widened to it, and one example group, EN and
 * TR side by side, with a count of who is coming and a question as
 * "other". Sizes and the paid check are in the PR.
 *
 * And later on 2026-11-03 (the Vets play 6, 7 or 8 a side): that setting
 * became `player_numbers`, the fewest AND the most players (`maxPlayers`
 * beside `minPlayers`), and one game switched to another size is its own
 * action, `switch_format` (`size`), including an organiser's yes to
 * MatchTime's own offer. Both share `aSide`: the model reports whether the
 * numbers count one side or everyone, and code doubles, so the model does
 * no arithmetic on them. Each defined once, the examples regrouped (every
 * week, and one game), EN and TR side by side.
 *
 * And on 2026-11-09 (Vets MNF, "@Match Time DM these people"): the recruit
 * section rewritten so `playersFrom` says WHO or from where. One value,
 * "named" (the people tagged in the message, the one it replies to, or the
 * one above), defined once beside the three places and standing alone; the
 * recruit action and the field's own line say "who or from where"; one
 * example group, EN and TR side by side, before the places. The model
 * never names the people: code reads them from WhatsApp's mention data
 * (`named-invite-rules.ts`). 17,980 to 18,839 characters. Old and new side
 * by side, and the paid check: MDs/prompt-change-dm-named-2026-11-09.md.
 *
 * And on 2026-11-10 (Kemal: "@Match Time move Monday's game to 8:15", every
 * admin feature by WhatsApp): one action, `move_game`, beside the other
 * game actions (one game to another time or day of its own week, or the
 * weekly game from now on), its four fields (`game`, `newDay`, `newTime`,
 * `everyWeek`) once beside the other game fields, the context paragraph
 * naming the new GAMES TO COME block (the club's games, numbered, so the
 * model picks a game by its number and code checks it against the same
 * list; never a day read from words), and one example group, EN and TR side
 * by side, with a question and talk about a time as "other". 18,839 to
 * 21,516 characters. Old and new: MDs/prompt-move-game-old.md and
 * MDs/prompt-move-game-new.md; the paid check: scripts/live-check-move-game.ts.
 *
 * And on 2026-11-17, REWRITTEN WHOLE (the Vets: "the main squad will always
 * expand or shrink without any limits and a bench"; review of #623: one
 * game's words must never flip a club setting). One rule stated once before
 * the actions: ONE GAME, OR THE CLUB FROM NOW ON. The actions, the fields
 * and the examples are now grouped the same way (finding players, one game,
 * the club from now on, anything else). A new action, `open_squad` (the
 * squad limit itself, standing and club-wide; its field `openSquadOff`),
 * with one-game wording ("no limit tonight", "anyone can play this week")
 * shown as "other", numbers ("max 14 again", "set the minimum to 10") as
 * `player_numbers`, and "back to full teams" said to be about the fewest,
 * never the squad limit. Every other action's definition, field and example
 * is unchanged in meaning. 21,516 to 23,859 characters. Old and new side by
 * side in PR #623; the paid check is the manager's.
 *
 * The paid check found one regression (2026-11-17): HQ's "no, not Bilal",
 * answering MatchTime's "Make Bilal Ahmed free for Fri 16 Oct? Reply YES.",
 * came back fee_waiver for Bilal. Main had never said how a no to
 * MatchTime's own question reads, and passed by default (12 of 12 on the
 * dev key); open_squad inserted into main's order failed 3 of 12, the
 * rewrite 6 of 16. Now said once, where the context is explained: a short
 * answer takes the question's action only when it agrees or picks; a no or
 * a change of mind asks for nothing ("other"), with one example among the
 * free places (a held-out wording, not the check's). 12 of 12, and 5 runs of
 * scripts/live-check-free-places.ts. 23,859 to 24,238 characters.
 *
 * And `month_coverage` (PR #611, Kemal 2026-11-16: a player added after a
 * month started covered only the games left, even one who paid the whole
 * month), placed in that grouping on 2026-11-18: one action under "Anything
 * else", beside the payments (how much of a month a regular on a monthly
 * list covers, the whole month or the games left; an add part-way through
 * is this too, and so is the answer to MatchTime's own "whole month, or
 * just the games left?"; saying only that somebody paid is not this), one
 * field, `coverage` ("whole", "left", or "" when the words say neither or
 * name two players with different coverages), `coveredRefs` widened to it,
 * and one example group beside the payments, EN and TR side by side.
 * Old and new: MDs/prompt-admin-extractor-old-2026-11-18.txt and -new-.
 *
 * And on 2026-11-23, REWRITTEN WHOLE for SEVERAL ACTIONS (Sutton FC, 14:44:
 * "@Match Time switch to 5aside, then invite local player pool for the
 * remaining slots" switched the game and never asked the pool; the prompt
 * said "THE ACTION, exactly one."). The extractor now reports `actions`,
 * every action the message asks for in the order asked, each with the
 * fields of its own action and `words` (its part of the message, said back
 * only to name a part not done), and `toMatchTime` once for the message.
 * Stated once, where the actions are defined: a request is one action
 * however many places or people it names; who plays, the teams and a score
 * are never listed; a part MatchTime has no action for is "other" in its
 * place. `aSide` is now defined beside `size`, with "5aside" written as one
 * word (a live run read "switch to 5aside" with no a side), and
 * `fee_waiver` says it may be simply stated, with its reason ("Tom's free
 * next Friday, he did the bibs" went 17 of 17 on the old prompt and 16 of 20
 * on the first rewrite; 10 of 10 with this). Its availability exclusion is
 * kept, with a third-person example ("Tom's free Friday if you need one"):
 * review of #629 asked whether narrowing it was needed, and it was not
 * (both readings 5 of 5 on the bibs case; "Tom's free Friday" after "anyone
 * free Friday?" read as availability, its fee counterpart as a free place).
 * One new example group (several actions, a reason and a question left out,
 * one request from two places), EN and TR side by side; every other
 * definition and example unchanged in meaning. `words` is the last field of
 * each action (first, it cost "cancel last Tuesday's match" its day, 0 of
 * 5; last, 5 of 5), and `newTime` names the kickoff GAMES TO COME shows (with
 * `words` last, "move Tuesday's game to 9:30" for a 21:00 game read 09:30 4
 * of 5; the old prompt 21:30 5 of 5, and this 5 of 5). 26,706 to 29,903
 * characters. The paid check:
 * scripts/live-check-several-admin-actions.ts, then one pass of every admin
 * suite (`live-check-open-squad.ts` now also fails a one-action case read as
 * several).
 *
 * The TEAMS extractor, 2026-11-10 (Sutton FC, "@Match Time reduce my
 * strength for this match as I am quite tired." went to the settings
 * page): one action, `form`, defined once beside the others (how a player
 * will play in this match; nothing changes now, the rating adjuster reads
 * the chat when the teams are made), the opening line naming it, and one
 * example group, EN and TR side by side. 6,473 to 7,313 characters. Old and
 * new: MDs/prompt-form-note-2026-11-10.md.
 *
 * Later the same day (Kemal: say the amount so it can be changed): `form`
 * carries who and how much. The action's definition names a change or a
 * cancel of the amount MatchTime stated; one new field, `form` (personRef,
 * delta, reason), defined once beside the others, its sizes read from the
 * one scale the rating adjuster uses (`form-scale.ts` FORM_SIZES, so the
 * two prompts cannot drift); the example group rewritten with the amounts,
 * an amendment and a cancel, EN and TR side by side. 7,313 to 9,394
 * characters. Old and new: MDs/prompt-form-note-amount-2026-11-10.md.
 *
 * TEAMS again on 2026-11-16 (the Vets: "@Match Time generate the teams,
 * put Dan and Craig in separate teams please" came back as a plain
 * generate; the prompt could say "together" and not "apart"): one new
 * field, `apart`, defined once beside `pairings` (each now says what it is
 * and that nobody is moved by name); "generate" and "swap" name people put
 * together or apart; the who-plays-with-whom examples grouped by new teams
 * and the teams as they stand, EN and TR side by side. 9,394 to 10,600
 * characters. Old and new: MDs/prompt-teams-apart-2026-11-16.md; the paid
 * check: scripts/live-check-teams-apart-2026-11-16.ts.
 *
 * The SCORE extractor, rewritten whole on 2026-11-17 (Monday night vets,
 * 16 Nov: "@Match Time bibs 9, no bibs 4" got "can't do that"; the sides
 * were "Red" and "Yellow" in MatchTime's data). It now reads THE GAME
 * (`score-sides.ts`, `gameContextLines`): whether the score is awaited and,
 * per side, MatchTime's name, what this club also calls it and its
 * players. One new field, `teamSides` (which side each name means, from
 * THE GAME only, "unknown" otherwise), defined once; "THE TWO SIDES" says
 * once how people name the sides and what MatchTime asks ("Which team was
 * bibs?", only ever about the winning side's name); one new example group
 * (the club's names unknown, known, a player's team, the answer to the
 * name question), EN and TR side by side. The incident's own words are held
 * out of the examples. A question ("Yellow?", "was it the bibs?") is said
 * once more to name no winner: on the first live pass "Yellow?" came back a
 * winner 2 runs of 3 (0 of 3 on the old prompt), and 0 of 3 after.
 * 4,539 to 6,808 characters. Review of #620: a side the model SAYS never
 * places a name in a report (code places a club's name only from this
 * game's own stored names, and a player's team only by the line-up of the
 * player the extractor names), so `teamSides` gains `player` (as THE GAME
 * lists them) and `side` is defined as what THE GAME places or what an
 * answer to "which team was X?" gives ("same" to a question that said
 * what it was last time included). 6,808 to 7,617 characters. Old and new,
 * and the paid check: MDs/prompt-score-sides-2026-11-17.md,
 * scripts/live-check-score-sides.ts.
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
// ATTENDANCE, 2026-11-23: AN ANSWER TO A MEMBER'S "ARE YOU IN?". Vets MNF:
// Kemal asked Shane "so are you in? :)" and Shane answered "Yeah and you and
// your lad come then it's 8v8 👌"; the extractor returned no claim, so he was
// not signed in. Traced: the question WAS in RECENT CHAT (rebuilt from the
// stored rows), and the same context with a bare "Yeah" read the sender in.
// The prompt defined an answer only to MatchTime (affirmation). Now an
// answer to a member's question about the sender's place is defined once,
// where the context is explained (the sender's claim, whatever remark about
// other people sits beside it); affirmation says it is not one of its own;
// the examples sit in their groups, EN | TR. 17,461 to 19,161 characters.
// Live results in the PR (scripts/live-check-attendance-extractor.ts, Y*
// cases, then one full pass).
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
//
// QUESTION, 2026-10-31: "HELP FRIEND". The friend link (#488) gets its own
// help topic: `feature` gains `friend`, defined once beside availability,
// and one EN | TR example joins the "Help with MatchTime" group. A small
// additive patch, not a rewrite: it adds one value to one field in the
// place every other value is defined, changes no existing definition or
// ruling, and a friend coming to play is never read here (the router sends
// it to attendance). 13,596 to 13,849 characters. Live results in the PR
// (scripts/live-check-help-friend.ts, then one full pass of
// live-check-question-extractor.ts and live-check-help-routing.ts).

// QUESTION, 2026-11-10: SHORT HELP MENUS. Kemal: "why this long menu
// when we say @mt help". Both menus now end "tag me with help and the
// topic", and the admin group's topics are squad, teams, players, game,
// settings and graphics. The `feature` section was rewritten as one list,
// not appended to: each part carries the word the menus use for it
// (English, Turkish), `feature` gains find_players and graphics, schedule
// is "the games themselves" (moving and cancelling one, its size),
// settings takes quiet hours and the fewest and most players, and the
// "Help with MatchTime" examples are regrouped with the menu words, EN | TR
// side by side. 13,849 to 15,222 characters. OLD and NEW in
// MDs/prompt-question-help-topics-{old,new}-2026-11-10.txt; live results in
// the PR (scripts/live-check-help-routing.ts, then one full pass of
// scripts/live-check-question-extractor.ts).

export const EXTRACTOR_PROMPTS: Record<Exclude<ExtractorKind, "none">, string> = {
  attendance: `You read ONE message from a football club's WhatsApp group and report what it says about who is playing in the club's match. You report facts about the words. You never decide what happens next: code does that, from the club's records.

WHAT YOU ARE SHOWN
THE MESSAGE is the one message you report on, with the name of the person who typed it: the sender. Above it, as context only:
  RECENT CHAT            the last few messages before it
  MATCHTIME'S LAST POST  the bot's most recent post in the group
  NOW                    the time at the club
  THEY ARE REPLYING TO   when THE MESSAGE is a WhatsApp reply: the message it quotes, whose it is (MatchTime's or a member's), when, and its words
  CLUB MEMBERS NAMED     members of this club whose names appear in THE MESSAGE, from the club's records. A member the message calls by a nickname the club has on record is shown as that nickname with their name in brackets: "AH (Abdul-Hafeez)"
  MATCHTIME ASKED        MatchTime could not tell who someone in the sender's earlier message was and asked them: that earlier message, quoted. See answersClarification
Use the context to work out what THE MESSAGE refers to: who "he" is, which line a "same" or "ben de" answers (the quoted message, when there is one), and which question a "yes" or "no" answers. A claim made in the context is never reported again: "same" under Ali's "IN" is one claim, the sender's.
An answer says what its question asked. When a member asked the sender whether they are playing, by name, with an @mention or straight after the sender spoke ("@Shane are you in?", "so are you in?", "can you stay in?" | "geliyor musun?", "var mısın?"), and THE MESSAGE answers it, the answer is the sender's own claim, as if they had said it in those words: "yes", "yeah", "yep", "of course" | "evet", "tabii", "olur" is the sender in, "no", "nope" | "hayır" is the sender out, and "maybe" | "belki" is the hedge. The answer keeps that meaning whatever else the message says: a remark beside it about other people or the numbers ("yeah, and if you and your lad come it's 8v8") adds no condition to it and no claim for them, unless it says they are playing. A "yes" to a question that is not about anyone's place ("is it 7v7?"), or one that answers no question in the chat, is no claim. An answer to MatchTime is read in affirmation, below.
A name on the CLUB MEMBERS NAMED line is a person in this club, even when it is also an ordinary word, a short nickname, a team or a well-known phrase: with Glazers listed, "Glazers out" says Glazers is out, and with "AH (Abdul-Hafeez)" listed, "AH IN" says AH is in. Such a claim is about that member, not the sender, and its personRef is the words the message used ("AH"). Read the sentence as you always would: a listed Will in "will you play?" is still the word "will".
The context often shows the squad: a count such as "13/14" or "14/14", a list of names, a bench, the teams. The squad shown is never a reason for any field. Code holds the real squad and places every player, so a plain "in" is "in" when the list looks full and when the sender is already on it.

THE CLAIMS
Return one claim for each person the message speaks about as a player in the club's match: joining, leaving, the bench, a maybe, or being free to play. A message that says none of that about anyone returns an empty claims array. Being free means free for the match: free, around or available to play, on its own or with "if you need me" or "if someone drops". The word alone settles nothing: free of the fee, free for a drink, a question asking who is free, and news of where someone will be with no word on playing ("I land Monday", "I will be back Tuesday week") are not about anyone's place.
  subject      "sender" for the person who typed it, "other" for anyone else
  personRef    the words used for that person, VERBATIM. Never invent or expand a name. "" for the sender. A relationship followed by a name is the name: "my brother Shahrokh" is "Shahrokh". One exception: a "he", "him" or "o" that points at the author of the quoted message is written as that author's name, as the THEY ARE REPLYING TO line gives it; when that line names no one ("a member (not identified)"), keep the words as they are
  personKind   what personRef is, one of: "named" a particular person identified by a name, a nickname or an @mention, including a word that may only be a nickname (code checks every name against the squad), and the sender; "relation" someone described only by their tie to somebody ("my brother", "Amir's cousin", "his mate"); "group" the whole group or a crowd ("everyone", "@all", "the lads", "all of you"); "placeholder" a quantity or an indefinite ("2 of my guys", "someone", "a mate", "another keeper", "+1"). A relation followed by a name is the name, named: "my brother Shahrokh" is Shahrokh.
  polarity     what the message says that person is doing in the match:
                 "in"     joining, or staying in
                 "out"    leaving or not coming: the person gives up their place, asks for someone to take it, or says they will not or cannot play ("out", "can't make it", "anyone replace me?", "I can drop out", "I'm away that week"). An injury, a knock or tiredness on its own is not "out": someone "taking it easy" is still playing
                 "bench"  the bench, in one of two ways. The message names it explicitly: bench, reserve, sub, backup, spare, standby, waiting list, "yedek" in any form, or 🪑. Or the sender offers themselves to fill a gap, by asking to be called on or by saying they are free to play, and takes no place yet ("ping me if you need one more", "I can play if you're short", "I'm free Friday if you need me"): that is "bench" with contingent true and conditionOn "squad", never "in" and never a maybe. This second way is only ever the sender's own: someone else said to be free is "in". Nothing else is the bench. A message that also asks for the place outright is "in": "I'm free Tuesday, put me down"
  benchAsked   true only when polarity is bench because the message itself asks for the bench for that person (it names the bench, a reserve, sub, backup, standby or waiting place, or 🪑); false for an offer to fill a gap, and false whenever polarity is not bench.
  contingent   true when the claim depends on something that has not happened yet: "in if my back holds up", "count me in if someone drops", "happy to drop if you find someone". An OFFER to give up a place is contingent with no "if" in it ("I can drop out", "happy to pull out", "I'll make room"): the test is whether the person IS doing it or only COULD. Being free to play is contingent too, with no "if" needed ("I'm free Friday", "my brother is free"): it says they can be called on, not that they are playing. Someone who can play, is coming or can take a place, with no condition, is not contingent: "my cousin Ali can play", "two of my guys can play", "Ali can take my spot" are false. false for a decision already taken ("I'm in", "I'm out", "can't make it"), and for asking for cover: "anyone able to replace me?" says they are leaving, whether or not someone is found. A position is a note, not a condition, so it is false too
  conditionOn  "squad" when the condition is the squad or the team's needs, which includes every offer to fill a gap, to give up a place or to play when free; "self" when it is about the person themselves; otherwise "none"
  tense        "present" now; "future" a commitment or offer about an upcoming match, including a standing one ("count me in whenever you are short") and one with a condition; "past" something that already happened ("I was in last week"); "hypothetical" a counterfactual about something that is not the case ("if I WAS in the team it would not be ruined"). Relayed words keep the tense of what was said, not of the saying: "Najib said he's in" is present
  reported     true when relaying what someone else SAID ("Najib said he's in", "Ali geliyorum dedi"). A plain statement about someone ("Kai can't make it tonight") is not reported
  replaces     ONLY on an "in" claim, and only when the message says this person takes somebody else's place: the words used for that other person, VERBATIM ("Najib", "@Najib", "me"). "" everywhere else
  confidence   0 to 1, how sure you are that the message says this
  newPlayer    true only on a claim that answers MATCHTIME ASKED by saying the person is someone new; false everywhere else

THE WHOLE MESSAGE
  affirmation  "yes" or "no" when the message is a bare answer to MatchTime ("Confirmed", "yes", "no"): to the MatchTime message it replies to, else to MATCHTIME'S LAST POST. Otherwise "none". Words that state the sender's own place ("in", "varım", "out") are a claim, whatever they answer, and an answer to a member is not an affirmation: when the member asked whether the sender is playing, it is the sender's claim, as WHAT YOU ARE SHOWN says
  sideRequests any of, for what else the message asks for beside its claims:
                 "recruit"   it says how many players are needed, as a number, or whose place needs taking ("we're 4 short, anyone free?", "can someone take my spot?")
                 "chase"     it nudges for more players with no number and no name ("@all we need more players pls")
                 "question"  it also asks MatchTime for something it holds, such as the list, who is in or how many ("@Match Time what's the list?", "how many are we now?"), never a question put to another member ("@Ali can you play?")
                 "teams"     it also asks MatchTime to change the two teams as they stand: swap two players between the teams, move someone to the other team, swap the colours or clear the teams ("@Match Time swap me with Tom"). A swap between the teams is never a claim: both players stay in the squad
  answersClarification  true when there is a MATCHTIME ASKED line and THE MESSAGE only answers it: it says who the person is (a name, "I mean Yoobie", "the first one") or that they are someone new ("new", "a new player", "yeni biri"). The claims are then the EARLIER message's, read as you would have read it, with the person MatchTime asked about written as the answer names them; when the answer says they are new, keep the name as the earlier message wrote it and set newPlayer true. false when there is no such line or THE MESSAGE says something else, and then the claims are THE MESSAGE's own, as always

EXAMPLES
Messages come in English or Turkish, often mixed or misspelt, and carry the same facts either way. Each group teaches one thing, English | Turkish.

The sender's own place: subject sender, contingent false.
  "I'm in", "count me in", "I'm in for next Tuesday" | "varım", "ben varım", "geliyorum", "sayın beni", "var" -> in
  "I'm out", "can't make it", "I'm away that week" | "yokum", "ben yokum", "gelemiyorum", "yok", "bu hafta yokum" -> out
  "@Match Time in", "@Match Time out" -> the sender in, the sender out: the tag addresses MatchTime
  "me too", or "same" replying to a neighbour's "I'm in" | "ben de" after "ben varım" -> the sender's own claim, the same polarity as the line it answers
  A member asked the sender "@Shane are you in?" or "so are you in?", and the sender answers "yes", "yeah", "yep" | "geliyor musun?" answered "evet", "tabii" -> in; "no", "nope" | "hayır" -> out
  "Yeah and you and your lad come then it's 8v8", answering "so are you in?" | "evet, sen de oğlunla gelirsen 8'e 8 oluruz", answering "geliyor musun?" -> the sender in, contingent false, and no claim for "you" or "your lad": what their coming would make is a remark
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
  "yes" answering "is it 7v7 tonight?" | "evet" answering "bu akşam 7'ye 7 mi?" -> no claim: the question is not about a place

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
  "+1", "+2" or "plus one", alone or after the sender's own claim, is a GUEST the sender brings, never the sender: subject other, personRef the token verbatim ("+1"), personKind placeholder, in. "ben de" is the sender; "+1" is not.

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
  "@Match Time I'm out, swap Kai with Ali" | "@Match Time ben yokum, Kai ile Ali'yi değiştir" -> the sender out, plus "teams": Kai and Ali only change team

Hedges: the sender might play and has not decided. Subject sender, in, contingent true, conditionOn "self", tense future. This shape is what gets the person asked again nearer the match; an empty claims array for a hedge is a maybe nobody follows up.
  "maybe", "50/50", "not sure yet", "I'll see" | "belki", "bakarız", "kesin değil", "bakacağım" -> the hedge

A replacement: one person arrives and one leaves, and which way round it runs is the point. Report an "in" claim for the arriving person, with replaces set to the leaving person's words, and an "out" claim for the leaving one. Chatter around it changes nothing.
  "Mojib is replacing Najib", "Mojib in for Najib", "Mojib takes Najib's place", "Najib is out, Mojib is in", "swap Najib for Mojib" | "Mojib, Najib'in yerine geliyor", "Najib yerine Mojib", "Mojib, Najib'in yerini aliyor", "Najib yok, Mojib var" -> Mojib in (replaces "Najib"), Najib out
  "Hi guys, Mojib is replacing Najib on the list. We can change" -> the same two claims
  "Mojib will play in my place" | "benim yerime Mojib oynayacak" -> Mojib in (replaces "me"), the sender out
  "Ali is coming, Mehmet can't make it" -> two ordinary claims, replaces "" on both: nobody said one takes the other's place
IF YOU CANNOT TELL WHICH OF THE TWO IS ARRIVING AND WHICH IS LEAVING, REPORT NO CLAIMS AT ALL. A wrong guess takes a real player out of a real squad; saying nothing costs one message somebody can retype.

Answering MatchTime's question. The MATCHTIME ASKED line quotes the earlier message "@Match Time Abu Ayoub is IN as a guest":
  "Yoobie", "I mean Yoobie" | "Yoobie'yi kastettim" -> answersClarification true, Yoobie in, newPlayer false
  "new", "he's a new player" | "yeni", "yeni biri" -> answersClarification true, Abu Ayoub in, newPlayer true
  "I'm out tonight" | "bu akşam yokum" -> answersClarification false, the sender out: a message of its own

Banter still contains claims. "Zeeshan is out lol vote him out" DOES claim Zeeshan is out: report the claim, and let its confidence say whether it is meant. A claim made as a joke, a tease or a wind-up at somebody's expense gets a confidence of 0.3 or less; the same words said plainly keep their usual confidence.`,

  // The question extractor (2026-11-10, `unified-question.ts`): which of
  // the three fixed posts is asked for (the list, the help, the asker's own
  // stats link), or anything else, which the unified answer answers.
  question: UNIFIED_QUESTION_PROMPT,

  teams: `You read ONE message about the club's two team line-ups, or about how a player will play in the match they are made for, and report what it asks for. You never pick the players: code builds, changes, brings back and clears the line-ups, keeps people together or apart, and checks every name.

THE MESSAGE is the one you report on, with its sender. Above it you may see RECENT CHAT, MATCHTIME'S LAST POST (often the two teams as they stand), NOW (the time at the club), CLUB MEMBERS NAMED (words in the message that are people in the club) and, for a WhatsApp reply, the message it quotes (the THEY ARE REPLYING TO line, often one of MatchTime's earlier team sheets). They tell you who "him", "them", "these" or "the teams" are and which team a player is on now; every field comes from THE MESSAGE.

WHAT YOU RETURN
action, exactly one:
  "show" post the teams as they stand, unchanged.
  "generate" work the line-ups out again: new teams, made, made again or shuffled. This holds even when the same message also asks for new names, puts people together or apart, or says "again", "once more" or "instead".
  "swap" change the teams as they stand and leave everyone else where they are: people change team, go to a named team, end up together or apart, or the two teams swap over, colours included. A message that only says who goes where, or who plays with or apart from whom, without asking for new teams, is "swap".
  "restore" use the teams of the quoted message, an earlier team sheet ("these are the final teams", "use these", "go back to these"). Only when a message is quoted; the names are not written in THE MESSAGE.
  "set" THE MESSAGE itself writes out both teams, names under each side, to be used as the teams.
  "suggest" asks you to recommend changes that make the teams fairer.
  "rename" keep the same two line-ups and change only their NAMES. Swapping the two teams' colours is not a rename: it is "swap" with swapSides.
  "clear" remove the line-ups altogether, so that there are no teams until they are made again ("clear the teams", "delete them").
  "form" tells MatchTime how a player, the sender or another, will play in this match, so the teams are made with it in mind: tired, ill, injured, hungover, rusty or in top form, or asks MatchTime to rate them, or their strength, down or up for this match. It is also a change to the amount MatchTime said it will use for a player, or a cancel of it ("make it -1", "just -0.25 for me", "cancel my adjustment"), answering MatchTime's post that stated it. The teams are not changed now. Only form is filled; every other field stays empty. A message that also asks for new teams is "generate".
includeRefs
  people the message says must play.
moves
  every person who goes to the OTHER team from wherever they are now, when no team is named for them. A swap of two people is both of them; a list of swaps is every name in it.
swaps
  people the message puts on a NAMED team, with that team, RED or YELLOW. When MATCHTIME'S LAST POST lists the two teams, the first one listed is RED and the second YELLOW, whatever they are called.
swapSides
  true when the two whole teams swap over, so that every player changes team: the teams trade places, or trade colours while each line-up stays together ("swap the colours"). moves is then empty. False otherwise.
pairings
  people who must play on the SAME team as each other, one array per group ("me and David on the same team", "Ali and Habib together"). Nobody is moved by name: code decides who goes where.
apart
  people who must play on DIFFERENT teams, one array per group: two people end up on opposite teams, and a bigger group is spread across both ("keep Dan and Craig apart", "separate teams", "not on the same team", "ayrı takımlarda"). Nobody is moved by name: code decides who goes where.
teamNames
  the two team names, in order: the ones the message gives or, when it asks you to pick the names, make up two short names (different, at most 24 characters each, not Red or Yellow, in the language THE MESSAGE is written in). An empty array when the message is not about names.
sides
  for "set" only: the players of the first team written, as red, and of the second, as yellow, each name as written, without numbers, headings, team names or notes such as "out, place open". Both empty for every other action.
form
  for "form" only, one entry for each player the message is about; empty for every other action.
  personRef: the player as the message writes them. A change or a cancel that names nobody is about the player named in the MatchTime post it answers.
  delta: what to add to that player's rating for this match only, from -1 to 1. An amount the message states is that amount ("make it -1", "-0.25", "half a point down" is -0.5), and a cancel ("cancel my adjustment", "no adjustment", "leave my rating") is 0. Otherwise size it from what the message says:
${FORM_SIZES}
- Asked to rate them down or up with no reason and no amount: -0.5 or +0.5.
  reason: two to four words on why, in the message's language ("tired", "bad knee", "yorgun"); empty when the message gives none, as a change of amount usually does.
toMatchTime
  true when THE MESSAGE asks MatchTime to do this: a request or an instruction about the teams, tagged or not ("swap Rafi and Yorel", "keep Dan and Craig apart", "use these"). False when people are only talking about the teams among themselves: an opinion, a question to each other, a description of how the teams look ("Ali and Habib are always on one team", "are we going with these?").

Write every person as the message writes them. When the sender means themselves ("me", "I", "beni", "bana", "ben") write "me". Every field the message says nothing about is empty, or false.

EXAMPLES, English and Turkish (toMatchTime true unless shown)
Seeing the teams:
  "teams?" / "show me the teams" / "takımları göster" -> show
  "show us the teams again without regenerating" -> show
New teams:
  "generate the teams" / "make the teams" / "shuffle them again" / "takımları kur" / "yeniden kur" -> generate
  "generate the teams, Ibrahim is playing" -> generate, includeRefs ["Ibrahim"]
  "generate the teams, you pick some fun names" / "takımları kur, isimleri sen seç" -> generate, teamNames two names you make up
  "generate the teams, call them Lions and Tigers" -> generate, teamNames ["Lions","Tigers"]
New names, same teams:
  "call the teams Lions and Tigers" / "takımların adı Aslanlar ve Kaplanlar olsun" -> rename, teamNames ["Lions","Tigers"] / ["Aslanlar","Kaplanlar"]
Who plays with whom, on new teams:
  "make the teams and put me and David on the same team" / "takımları kur, beni David ile aynı takıma koy" -> generate, pairings [["me","David"]]
  "generate the teams, put Dan and Craig in separate teams please" / "takımları kur, Dan ile Craig ayrı takımlarda olsun" -> generate, apart [["Dan","Craig"]]
  "regenerate the teams, Dan and Craig on different teams" / "takımları yeniden kur, Dan ile Craig aynı takımda olmasın" -> generate, apart [["Dan","Craig"]]
Who plays with whom, on the teams as they stand:
  "Ali and Habib on one team" / "Stick keeper. Ali and Habib on one team" / "Ali ile Habib aynı takımda olsun" -> swap, pairings [["Ali","Habib"]]
  "keep Dan and Craig apart" / "Dan and Craig shouldn't be on the same team" / "Dan ile Craig'i ayır" -> swap, apart [["Dan","Craig"]]
  "split Tom, Ali and Sam between the teams" / "Tom, Ali ve Sam'i takımlara dağıt" -> swap, apart [["Tom","Ali","Sam"]]
Changing the teams as they stand:
  "swap Ali and Can" / "Ali ile Can'ı değiştir" -> swap, moves ["Ali","Can"]
  "swap me with Elvin" / "Elvin ile yer değiştirelim" -> swap, moves ["me","Elvin"]
  "move Tom to the other team" / "Tom'u diğer takıma al" -> swap, moves ["Tom"]
  "swap Rafi and Yorel, Mo and Akram", one pair a line or not / "Rafi ile Yorel, Mo ile Akram yer değiştirsin" -> swap, moves ["Rafi","Yorel","Mo","Akram"]
  "put David in Red" / "David kırmızıya geçsin" -> swap, swaps [{"personRef":"David","team":"RED"}]
The two teams swap over, or swap colours:
  "swap everyone on bibs with non bibs" / "move team 1 over to team 2" / "swap them over", after both teams were listed / "takımların yerini değiştir" -> swap, swapSides true
  "swap the colours" / "renkleri değiştir" -> swap, swapSides true
An earlier set of teams, quoting it:
  "these are the final teams" / "use these" / "go back to these" / "bunları kullan" / "bunlara dönelim" / "son takımlar bunlar" -> restore
Teams written out in the message:
  "Use these:\\nRed\\n1. Ali\\n2. Can\\nYellow\\n1. Tom\\n2. Elvin" / "Bunları kullan:\\nBibs\\nAli\\nCan\\nNon Bibs\\nTom\\nElvin" -> set, sides {"red":["Ali","Can"],"yellow":["Tom","Elvin"]}
No teams at all:
  "clear the teams" / "takımları sil" -> clear
Fairer teams:
  "recommend swaps" / "any swaps to even it up?" / "takımları dengelemek için ne önerirsin?" -> suggest
How a player will play in this match, and the amount MatchTime uses:
  "reduce my strength for this match as I am quite tired" / "bu maç için gücümü düşür, çok yorgunum" -> form, form [{"personRef":"me","delta":-0.5,"reason":"tired"}] / [{"personRef":"me","delta":-0.5,"reason":"yorgun"}]
  "Tom hurt his knee last night, bear it in mind for the teams" / "Ali'nin dizi sakat, takımları kurarken dikkate al" -> form, form [{"personRef":"Tom","delta":-1,"reason":"hurt knee"}] / [{"personRef":"Ali","delta":-1,"reason":"dizi sakat"}]
  "I'm flying today, rate me up" / "bugün formdayım, puanımı yükselt" -> form, form [{"personRef":"me","delta":0.5,"reason":"in form"}] / [{"personRef":"me","delta":0.5,"reason":"formda"}]
  "make it -1", replying to MatchTime's "Noted: -0.5 for Kemal (tired) in Tuesday's game" / "-1 yap", replying to "Not aldım: Salı maçında Kemal için -0,5 (yorgun)" -> form, form [{"personRef":"Kemal","delta":-1,"reason":""}]
  "just -0.25 for me" / "benim için sadece -0,25 olsun" -> form, form [{"personRef":"me","delta":-0.25,"reason":""}]
  "cancel my adjustment" / "puan ayarımı iptal et" -> form, form [{"personRef":"me","delta":0,"reason":""}]
Talk among people, not asked of MatchTime:
  "Ali and Habib are always on the same team lol" / "Ali ile Habib hep aynı takımda" -> swap, pairings [["Ali","Habib"]], toMatchTime false
  "are we going with these teams?" / "bu takımlarla mı gidiyoruz?" -> show, toMatchTime false`,

  score: `You read ONE message from a football group's WhatsApp chat about the result of the group's own match and report what it SAYS. You never decide who won, who a player is, or what gets recorded: code does that.

WHAT YOU ARE SHOWN. THE MESSAGE is the one you report on, with its sender. Above it you may see RECENT CHAT, MATCHTIME'S LAST POST, NOW (the time at the club), the message it quotes when it is a WhatsApp reply (the THEY ARE REPLYING TO line), and THE GAME: the group's latest game, whether MatchTime is waiting for its score, and its two sides, red and yellow, each with the name MatchTime calls it, what this club called it in this game when MatchTime has been told, and the players on it. They tell you what THE MESSAGE answers or disputes and which side a name means; never take a number from them. The group's own match is its latest game: "tonight", "today", "last night", "yesterday", "dün akşam" and "earlier" all mean that latest game.

THE TWO SIDES. People call the sides many things: MatchTime's names ("Red", "Sarılar"), colours, "bibs" and "no bibs", a player's team ("Dan's team"), "we" and "they". A TEAM REFERENCE below is a side as written ("yellows", "Reds", "bibs", "Dan's team"), "us" for the sender's own side ("we", "biz", "kazandık"), "them" for the other side, or "" when not said. When MatchTime cannot tell a side, it asks which team won, or which team a name was ("Which team was bibs: Red or Yellow?"), sometimes saying what that name was last time ("Last time it was Red"); it only ever asks that about the name of the side with the bigger number.

WHAT YOU RETURN
hasScore
true when THE MESSAGE states the two numbers of a result; false when it has none ("yellows won", "wrong way round", "MoM Naim", "red"), and first and second are then 0.
first, second
the two numbers of the final result, in the order written. In a story ("it was 6-6 then it turned to 9-6") the last one.
firstTeam, secondTeam
the team reference written directly beside the first or the second number, with no word about who won or lost. It stays there when THE MESSAGE answers MatchTime's question with a scoreline.
winner
the team reference a word names as the winner: "to" or "for" a team, "won", "wins", "beat", "kazandı", "yendi". A bare team name, the whole message, answering MatchTime's "which team won?" is the winner too. "" otherwise: for a draw, for chat that only mentions a team, and for a question ("Yellow?", "sarılar mı?", "was it the bibs?"), which asks and answers nothing.
loser
the team reference a word names as the loser: "lost", "got beaten", "kaybetti", "yenildi". "" otherwise.
teamSides
one entry for every team reference you return other than "us" and "them", and, when THE MESSAGE answers MatchTime's "which team was X?", one for X. Each has the reference as written (team), a side and a player.
  side: "red" or "yellow" when THE GAME places the name (MatchTime's name for that side, a name this club called it in this game, its colour while MatchTime calls it by its colour), or when THE MESSAGE answers MatchTime's "which team was X?" with a side: "red" alone answering "Which team was bibs?" is bibs red, and "same" or "yes" to a question that said what it was last time is that side. Otherwise "unknown": never guess which side wore the bibs.
  player: the player the reference is named after ("Dan's team", "Dan'in takımı"), written exactly as THE GAME lists them; "" when it names no player listed there. Never choose between two players listed with the same name: give the name as listed.
[] when THE MESSAGE names no side.
momRef
the player named Man of the Match ("MoM", "man of the match", "POTM", "maçın adamı"), as written, or a bare name answering MatchTime's question who it was. "" otherwise; praise alone ("Naim was class") is "".
correction
true only when THE MESSAGE says a result already given for this match was wrong ("no, it was...", "yanlış", "hayır ... olacak"), as when it disputes the result it quotes. A first report is false, even straight after MatchTime asked for the score.
swapped
true when it says the teams are the wrong way round ("other way round", "tam tersi"); correction is then true too.
otherGame
true only when THE MESSAGE is plainly about a game before the latest one ("last week", "geçen ay"); correction is then false.

EXAMPLES, English and Turkish side by side. Fields not shown are "", false or [].
A word names the winner:
  "5-3 to Yellows" / "sarılar 5-3 kazandı" -> hasScore true, first 5, second 3, winner "Yellows" / "sarılar", teamSides [{"team":"Yellows","side":"yellow"}] / [{"team":"sarılar","side":"yellow"}]
  "4-6 to Yellows" -> first 4, second 6, winner "Yellows"
  "it was 6-6 then suddenly it turned to 9-6 to yellows" -> first 9, second 6, winner "yellows"
A team beside a number:
  "Yellow 9 - 6 Red" -> first 9, second 6, firstTeam "Yellow", secondTeam "Red"
  "kırmızı 6 sarı 9" -> first 6, second 9, firstTeam "kırmızı", secondTeam "sarı"
  "Reds 3-5" -> first 3, second 5, firstTeam "Reds", winner ""
  "7-4 yellows", answering MatchTime's "which team won?" -> first 7, second 4, secondTeam "yellows", winner ""
The club's own names for its sides, and a player's team, placed only by THE GAME:
  "bibs 7, no bibs 5" / "yelekliler 7 yeleksizler 5", THE GAME giving neither name -> first 7, second 5, firstTeam "bibs" / "yelekliler", secondTeam "no bibs" / "yeleksizler", teamSides both side "unknown", player ""
  the same, THE GAME saying this club called red "bibs" and yellow "no bibs" in this game -> teamSides [{"team":"bibs","side":"red","player":""},{"team":"no bibs","side":"yellow","player":""}]
  "Sam's team won 6-2" / "Sam'in takımı 6-2 kazandı", THE GAME listing Sam Reed on yellow -> first 6, second 2, winner "Sam's team" / "Sam'in takımı", teamSides [{"team":"Sam's team","side":"yellow","player":"Sam Reed"}] / [{"team":"Sam'in takımı","side":"yellow","player":"Sam Reed"}]
  "Red", the whole message, answering MatchTime's "Which team was bibs?" / "kırmızı", answering "yelekliler hangi takımdı?" -> hasScore false, teamSides [{"team":"bibs","side":"red","player":""}] / [{"team":"yelekliler","side":"red","player":""}]
  "same", answering MatchTime's "Which team was bibs this time? Last time it was Red." / "aynı", answering its Turkish twin -> hasScore false, teamSides [{"team":"bibs","side":"red","player":""}]
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

  admin: `You read ONE message from a football club's chat (the organisers' group, the players' group, or a private message to the bot) and report every action it asks MatchTime, the club's bot, to do, in the order asked, and whether it is spoken to MatchTime at all. You report the words; code decides what happens, one action after the other. Messages are English or Turkish, often mixed.

THE MESSAGE is the one you report on, with its sender and whether they tagged the bot. Above it you may see RECENT CHAT, MATCHTIME'S LAST POST, NOW (the date and time at the club), GAMES TO COME (the club's games still to be played, numbered, soonest first) and, for a WhatsApp reply, the message it quotes (THEY ARE REPLYING TO). The context tells you who "he" or "them" is, who is being spoken to, which game is meant, and what a short answer answers. A short answer to MatchTime's own question takes that question's action only when it agrees or picks one of the options offered; a no or a change of mind ("no, leave it", "hold on, not him", "hayır, kalsın") asks for nothing and is "other", unless it asks for something else instead. The actions and every field come from THE MESSAGE.

ONE GAME, OR THE CLUB FROM NOW ON. Some actions change one game; others change how the club runs every week. A message about one game ("tonight", "this week", "on Monday", "for Friday's game") never changes a club setting. A club setting needs a standing intent: "from now on", "every week", "for this group", or a rule said with no game named.

THE ACTIONS, in the order asked. Most messages ask for one thing, and the list then holds one action. A message that asks for several ("do this, then that", "this and that", "bunu yap, sonra şunu") lists each one, in the order the message asks for them: code does them in that order, so a later action counts what an earlier one changed ("the places left" after a switch are the new size's), and a later action is never dropped because an earlier one is there. Each request is one action, however many places or people it names: finding players from several places is ONE recruit with every place in playersFrom, and what several players on a monthly list cover is ONE month_coverage with all of them in coveredRefs. Who plays (somebody in, out or on the bench), the teams and a score are read elsewhere and are never in this list. A message that asks for nothing at all is one "other": a question, an opinion or a discussion about whether to do something ("should we cancel?", "should Bilal play free?", "shall we try the pool?"); so is a part of a longer message that asks MatchTime for something none of these actions does, in its place in the list.
Finding players:
  "recruit" find players who are not in the squad yet, or invite particular people to play; playersFrom says who or from where. Showing, listing or counting the squad is "other", and so is talking about another club or the player pool.
One game:
  "cancel_match" call off one of the club's games: cancel it, it is not happening, no game. Of a game whose time has gone: it never took place ("it didn't happen", "olmadı").
  "restore_match" put a called-off game back on: it is back on, uncancel it, it goes ahead after all. Of a game whose time has gone: it did take place after all.
  "switch_format" play ONE game with a different number a side, bigger or smaller ("make it 8 aside", "6 a side on Monday"), or a yes to MatchTime's own offer to switch a game ("Shall we go 8-a-side?"). Asking whether to switch, or talking about it, is "other".
  "move_game" change when a game kicks off: ONE game to another time, or to another day of its own week ("move Monday's game to 8:15", "tonight we start at 8"), or the club's weekly game from now on ("from now on we kick off at 8:15", "we play Tuesdays from now on"). A different number a side is "switch_format". Asking what time a game is, or talking about a time, is "other".
  "fee_waiver" give named players a free place, so they owe nothing for a game, or take one back, said as a request or simply stated, often with the reason (he washed the bibs, she booked the pitch). "Free" as in able to play ("I'm free Tuesday", "Tom's free Friday if you need one") is not this.
The club, from now on:
  "season_break" no football for a whole MONTH or more ("no football in December", "aralıkta maç yok"), or the football is back in a month ("we're back in January", "ocakta başlıyoruz"). One game off ("no game Friday", "bu hafta maç yok") is "cancel_match".
  "set_venue" tell MatchTime where the club plays: name its pitch or venue, or pick one of the places MatchTime listed. Asking where the game is, or talking about a pitch, is "other".
  "quiet_hours" switch the club's quiet hours (the night hours MatchTime holds its own messages in) off or on, or set when they start or end. Asking about them, or talking about them, is "other".
  "player_numbers" set how many players the club's game is played with every week: the fewest (MatchTime warns about low numbers only below it), the most (a game may then be made bigger, up to it), or both ("we can play with 12", "we play 12 to 16", "up to 8 a side", "max 14 again", "set the minimum to 10"), or the fewest back to two full sides ("back to full teams"). Saying how many are coming, or asking how many are needed, is "other".
  "open_squad" the squad limit itself, for the whole club from now on: take it away, so everyone who says IN plays every week with no bench and no number a side ("no squad limit from now on", "remove the bench for this group"), or put the limit and the bench back. Only a standing change for the club: words about one game ("no limit tonight", "anyone can play this week") are not this, and any number of players, fewest or most, is "player_numbers". Asking whether there is a limit, or talking about it, is "other".
Anything else:
  "retry_ask" try MatchTime's last request again, or say that what stopped it is now done or fixed, naming nothing new ("done, try again", "added the venue location"). A message that names the place is "set_venue"; one that asks for something again in full ("now ask the pool") is that action.
  "bulk_payment" someone paid for several players.
  "month_coverage" in a club that plays a monthly squad: how much of a month a player on its list covers, the whole month (every game of it) or only the games still to play. Putting somebody on a month part-way through is this too, whether or not it says which ("add Tom, he's paid the whole month", "add Tom to the November list"), and so is an answer to MatchTime's own question "whole month, or just the games left?". Saying only that somebody has paid ("Tom paid for the whole month", "Tom ayın tamamını ödedi") is not this. Asking how much someone covers or owes is "other".
  "reminder" MatchTime is to remind the sender, at a time.
  "stats_blast" MatchTime itself is to send every player their own stats or ratings link. Telling the PLAYERS to do something (rate each other, open their link) is "other".
  "other" anything else.

THE FIELDS. toMatchTime once, for the whole message. For each action, words and the fields of its own action; every other field of that action is "", 0, false or [].
  toMatchTime (the message): true when the message tells or asks MatchTime itself to do something: it tags the bot, replies to MatchTime's own post, answers the question MatchTime just asked, or is an instruction that names and tags nobody else ("ask the group if anyone can play"). False when it speaks to a person or to the others: it tags or names a person to ask them, or asks the others whether to do it or whether they can ("can we ask...?", "should we...?", "you able to find players?").
  words (every action): the part of THE MESSAGE that asks for this action, as written ("switch to 7 aside", "sonra havuza sor"); for a short answer to MatchTime's question, the answer itself.
Finding players:
  playersFrom (recruit): who is to be invited, never guessed: the people tagged, or every place the message means the players are to come from; [] when it says neither (MatchTime then asks).
    "named" the particular people tagged with @ in THE MESSAGE, in the message it replies to, or in the message just above it ("DM these people", "message the people above", "invite them"). Code finds who they are; you only say they are meant. MatchTime invites exactly those people, so "named" stands alone, never beside a place.
    "club" the club's own players (its regulars, the lads, its past players, its players' group: "the group", "the main group").
    "partners" another club, a partner club or the other groups, named or not.
    "pool" the MatchTime player pool, players from outside the club and its partners ("the pool", "someone nearby", "a player from the app").
    "everywhere" or "wherever you can" ("her yerden", "nereden olursa") is the three places. An answer to MatchTime's own question about where to look (MATCHTIME'S LAST POST, or the message replied to) is recruit from the places it picks, however short: "both" is the two places the question offers (of three, the partner clubs and the pool), "all" is every place it offers, and a yes to a question offering one place is that place.
  lookbackMatches (recruit from the club): how many recent matches to draw the club's own players from ("the last 5 matches" is 5, "the last couple of games" is 2); 0 when no number is named.
  clubRef (recruit from partners): the other club's name as written, without a Turkish case ending ("Sutton'a" is "Sutton"); "" when no club is named.
One game:
  matchDay (cancel_match, restore_match, fee_waiver, player_numbers, switch_format): the day named for the game, as written ("tonight", "next Friday", "cuma", "last Tuesday"); "" when none or only "this week".
  pastGame (cancel_match, restore_match): true when the game meant has already been, or should have been, played: it says the game didn't happen or did happen after all, or names a game gone by ("last Tuesday's", "the last match", "yesterday", "dün", "geçen hafta").
  size (switch_format): the number of players said for that game, as written ("8 aside" is 8, "16 players" is 16); for a yes to MatchTime's offer, the number a side the offer names; 0 when none is said.
  aSide (switch_format, player_numbers): true when the numbers count the players on ONE side, however it is written ("8 aside", "5aside", "5-a-side", "6 to 8 a side", "8'e 8", "6 kişilik oynayalım", MatchTime's "8-a-side"); false when they count everyone ("12 players", "16 kişiyle").
  game (move_game): the number of the game meant in GAMES TO COME: the one the message names by its day or date ("Monday's", "the 23rd", "pazartesi"), the first that fits for "tonight", "this week" or "next week", and the first when it names none and every game listed is the same weekly game. For the weekly game from now on, any game of that weekly game. 0 when none is listed, or the games listed are different weekly games and the message names none (MatchTime then asks which). An answer to MatchTime's question which game to move is move_game, with the game the answer picks and the day and time that question names.
  newDay (move_game): the day of the week it moves to, "monday" to "sunday"; "" when the day stays.
  newTime (move_game): the new kickoff as a 24-hour London time "HH:MM". A time with no am or pm is the one nearest that game's own kickoff as GAMES TO COME shows it ("8:15" for a game at 20:30 is "20:15", "8" is "20:00"; it is a morning time only when it says so: "10am" is "10:00"); "" when the time stays.
  everyWeek (move_game): true when it changes the weekly game from now on ("from now on", "every week", "artık", "her hafta", "bundan sonra"); false for one game.
  coveredRefs (fee_waiver, bulk_payment, month_coverage): the people the action is about, one entry each, as written: those given or losing the free place, those paid for, or the player whose month it is. "he" or "him" is the person named, else the author of the quoted message. [] for an answer to MatchTime's question that names nobody.
  undo (fee_waiver): true when it takes a free place back.
The club, from now on:
  breakMonths (season_break): each month with no football, as "YYYY-MM", the next such month from NOW ("December" in October 2026 is "2026-12"; "December and January" is both).
  playMonths (season_break): each month the football is on or back in, as "YYYY-MM" the same way.
  venueName (set_venue): the pitch or venue as named, without a Turkish case ending ("Powerleague Shoreditch'te" is "Powerleague Shoreditch"). For a pick from MatchTime's numbered list of places, the name that list was for.
  venueChoice (set_venue): the number of the place picked from MatchTime's list ("2", "the second one", "ikincisi" is 2); 0 when the message names the place itself.
  quietOff (quiet_hours): true when it switches quiet hours off, so MatchTime posts at any hour; false when it switches them on or sets their times.
  quietFrom (quiet_hours): when they start, as a 24-hour London time "HH:MM" ("10pm" is "22:00", "gece 11" is "23:00"); "" when not said.
  quietTo (quiet_hours): when they end, the same way ("8am" is "08:00", "sabah 9" is "09:00"); "" when not said.
  minPlayers (player_numbers): the fewest players said, as written ("12", "on iki" is 12); 0 when no number is said or it goes back to full sides.
  maxPlayers (player_numbers): the most players said, as written ("up to 16" is 16, "en fazla 8'e 8" is 8); 0 when none is said.
  fullTeams (player_numbers): true when the fewest goes back to two full sides ("back to full teams", "yine tam takım"). This is about the fewest, never about the squad limit.
  openSquadOff (open_squad): true when it puts the squad limit and the bench back ("put the limit back", "bring the bench back"); false when it takes the limit away.
Anything else:
  payerRef (bulk_payment): who paid, as written.
  count (bulk_payment): how many players they paid for.
  coverage (month_coverage): "whole" when the words say the whole month ("the whole month", "the full month", "ayın tamamı"); "left" when they say only the games still to play ("the games left", "the rest of the month", "kalan maçlar"); "" when they say neither, or name two players with different coverages. "He's paid" alone does not say which: "".
  phrase (reminder): the time phrase exactly as written ("tomorrow at 6"), kept as a record.
  remindAt (reminder): when to send it, as a London date and time "YYYY-MM-DD HH:MM", worked out from NOW: the next such time that is still to come ("at 6" means 18:00 unless they say morning; a day with no time is 09:00). "" when the message names no time MatchTime could act on ("later", "soon").
  note (reminder): what to remind about, in their own words ("bring the bibs"); "" when it names nothing.

EXAMPLES, English / Turkish, grouped by what they teach. "-> action, fields" is a list of one action; "; then" starts the next action of the same list. toMatchTime is true unless shown.
Spoken to MatchTime, or to a person:
  "ask the group if anyone can play" / "MatchTime oyuncu grubuna sor" -> recruit, playersFrom ["club"], toMatchTime true
  "@Kemal can we ask Sutton group?" -> recruit, playersFrom ["partners"], clubRef "Sutton", toMatchTime false
  "should we ask the group?" / "gruba soralım mı?" -> other, toMatchTime false
  "shall we try the pool?" / "havuza soralım mı?" -> other, toMatchTime false
  "you able to find players?" / "oyuncu bulabilir misin?" (to another organiser) -> other, toMatchTime false
Several actions in one message, in the order asked (NOW is October 2026 here):
  "@Match Time make it 6 aside, then ask the pool for the places left" / "@Match Time 6'ya 6 yap, sonra boş yerler için havuza sor" -> switch_format, size 6, aSide true; then recruit, playersFrom ["pool"]
  "@Match Time 8 a side on Monday and ask the group for the rest" / "@Match Time pazartesi 8'e 8, eksikleri gruba sor" -> switch_format, size 8, aSide true, matchDay "Monday" / "pazartesi"; then recruit, playersFrom ["club"]
  "@Match Time no football in December, and turn off quiet hours" / "@Match Time aralıkta maç yok, sessiz saatleri de kapat" -> season_break, breakMonths ["2026-12"]; then quiet_hours, quietOff true
  "@Match Time cancel Thursday and order new bibs" / "@Match Time perşembeyi iptal et ve yeni yelek sipariş et" -> cancel_match, matchDay "Thursday" / "perşembe"; then other
  "@Match Time make it 7 aside, we're short tonight" / "@Match Time 7'ye 7 yapalım, bu akşam eksiğiz" -> switch_format, size 7, aSide true (a reason is not an action)
  "@Match Time make it 7 aside, how many do we need now?" / "@Match Time 7'ye 7 yap, şimdi kaç kişi lazım?" -> switch_format, size 7, aSide true (the question is left out)
  "@Match Time make it 7 aside, Zak is in and make the teams" / "@Match Time 7'ye 7 yap, Zak var, takımları kur" -> switch_format, size 7, aSide true (who plays and the teams are read elsewhere)
  "@Match Time ask the group and the pool" / "@Match Time gruba ve havuza sor" -> recruit, playersFrom ["club","pool"] (one request, one action)
Finding players: the people tagged, not a place:
  "@Match Time DM these people", replying to a message that tags people / "@Match Time bu kişilere özelden yaz" -> recruit, playersFrom ["named"]
  "@Match Time DM the people above" / "@Match Time yukarıda etiketlenenlere mesaj at" -> recruit, playersFrom ["named"]
  "@Match Time invite @Ali and @Sam for tonight" / "@Match Time @Ali ve @Sam'i bu akşama davet et" -> recruit, playersFrom ["named"]
Finding players from one place:
  "@Match Time ask the group" / "@Match Time gruba sor" -> recruit, playersFrom ["club"]
  "message the lads from the last 5 matches and invite them" / "son 5 maçta oynayanlara yaz, davet et" -> recruit, playersFrom ["club"], lookbackMatches 5
  "ask the regulars if they can play" / "düzenli gelenlere sor, oynayabilirler mi" -> recruit, playersFrom ["club"]
  "ask Sutton if anyone can play" / "Sutton'a sor bakalım oynayan var mı" -> recruit, playersFrom ["partners"], clubRef "Sutton"
  "@Match Time ask Friday MT Community if anyone can play tonight" -> recruit, playersFrom ["partners"], clubRef "Friday MT Community"
  "search for players from our partner groups" / "diğer gruplara sor, oynayacak biri var mı" -> recruit, playersFrom ["partners"], clubRef ""
  "@Match Time ask the pool for a player" / "@Match Time havuzdan bir oyuncu bul" -> recruit, playersFrom ["pool"]
  "find someone nearby for tonight" / "bu akşam için yakınlardan birini bul" -> recruit, playersFrom ["pool"]
  "get us a player from the app" / "uygulamadan bir oyuncu bulur musun" -> recruit, playersFrom ["pool"]
Finding players from several places, or from none said:
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
One game off, or back on (pastGame false unless shown):
  "Cancel the session" / "maçı iptal et" -> cancel_match, matchDay ""
  "storm, no game Friday" / "bu hafta maç yok" -> cancel_match, matchDay "Friday" / ""
  "it's back on, uncancel Friday" / "maç yapılıyor, iptali geri al" -> restore_match, matchDay "Friday" / ""
  "Tuesday's game never took place" / "salı maçı yapılmadı" -> cancel_match, matchDay "Tuesday" / "salı", pastGame true
  "cancel the last match, we didn't play" / "geçen haftaki maçı iptal et, oynamadık" -> cancel_match, matchDay "" / "geçen hafta", pastGame true
  "Tuesday's game did go ahead after all" / "salı maçı aslında oynandı" -> restore_match, matchDay "Tuesday" / "salı", pastGame true
  "should we cancel Friday?" / "the session should be cancelled anyway" -> other, toMatchTime false
One game a different size:
  "@Match Time make it 8 aside" / "@Match Time 8'e 8 yapalım" -> switch_format, size 8, aSide true
  "@Match Time 6 kişilik oynayalım" / "@Match Time let's play 6 a side" -> switch_format, size 6, aSide true
  "@Match Time make Monday 16 players" / "@Match Time pazartesi 16 kişi oynayalım" -> switch_format, size 16, matchDay "Monday" / "pazartesi"
  "yes" / "evet", replying to MatchTime's "We've got 16 for Monday, 2 on the bench. Shall we go 8-a-side?" -> switch_format, size 8, aSide true
  "shall we go 8 aside?" / "8'e 8 mi oynasak?" (to the others) -> other, toMatchTime false
When a game kicks off (GAMES TO COME here: 1. Monday 16 November 2026 at 20:30 (Monday Vets), 2. Monday 23 November 2026 at 20:30 (Monday Vets)):
  "@Match Time move Monday's game to 8:15" / "@Match Time pazartesi maçını 20:15'e al" -> move_game, game 1, newTime "20:15"
  "@Match Time the game on the 23rd is on Wednesday" / "@Match Time 23'ündeki maç çarşamba" -> move_game, game 2, newDay "wednesday"
  "@Match Time from now on we kick off at 8:15" / "@Match Time artık 20:15'te başlıyoruz" -> move_game, game 1, newTime "20:15", everyWeek true
  "@Match Time we play Tuesdays at 9 from now on" / "@Match Time bundan sonra salı 21:00'de oynuyoruz" -> move_game, game 1, newDay "tuesday", newTime "21:00", everyWeek true
  "the 23rd" / "23'ündeki", answering MatchTime's "Which game shall I move to 20:15: Mon 16 Nov 20:30 or Mon 23 Nov 20:30?" -> move_game, game 2, newTime "20:15"
  "@Match Time what time is kick off?" / "@Match Time maç saat kaçta?" -> other
  "shall we kick off at 8 next week?" / "haftaya 8'de mi başlasak?" (to the others) -> other, toMatchTime false
Free places in a game, and payments:
  "Bilal washed the bibs, he's free this week" -> fee_waiver, coveredRefs ["Bilal"]
  "put Bilal down as free on Friday" / "Ali ve Can cuma günü ödemesin" -> fee_waiver, coveredRefs ["Bilal"] / ["Ali","Can"], matchDay "on Friday" / "cuma günü"
  "Bilal bu akşam ücretsiz oynasın" -> fee_waiver, coveredRefs ["Bilal"], matchDay "bu akşam"
  "scrap that, Tom isn't free, he pays" / "Ali ücretsiz değil, ödesin" -> fee_waiver, coveredRefs ["Tom"] / ["Ali"], undo true
  "should Bilal play free?" -> other, toMatchTime false
  "no, leave it" / "hayır, kalsın", answering MatchTime's "Make Tom free for Friday?" -> other
  "Amir paid for 4 players" -> bulk_payment, payerRef "Amir", count 4
  "Amir paid for Faris and Adam" -> bulk_payment, payerRef "Amir", count 2, coveredRefs ["Faris","Adam"]
How much of the month a player on a monthly list covers:
  "@Match Time add Tom to the November list, he's paid the whole month" / "@Match Time Tom'u Kasım listesine ekle, ayın tamamını ödedi" -> month_coverage, coveredRefs ["Tom"], coverage "whole"
  "@Match Time add Tom for the games left" / "@Match Time Tom'u kalan maçlar için ekle" -> month_coverage, coveredRefs ["Tom"], coverage "left"
  "@Match Time add Tom to the November list, he's paid" / "@Match Time Tom'u Kasım listesine ekle, ödedi" -> month_coverage, coveredRefs ["Tom"], coverage ""
  "@Match Time Dan covers the whole month" / "@Match Time Dan ayın tamamını kapsıyor" -> month_coverage, coveredRefs ["Dan"], coverage "whole"
  "@Match Time Dan only pays for the games left" / "@Match Time Dan sadece kalan maçları ödüyor" -> month_coverage, coveredRefs ["Dan"], coverage "left"
  "@Match Time add Tom for the games left, and Ian covers the whole month" / "@Match Time Tom'u kalan maçlar için ekle, Ian ayın tamamını kapsıyor" -> month_coverage, coveredRefs ["Tom","Ian"], coverage ""
  "whole month" / "ayın tamamı", answering MatchTime's "Tom on the November list: whole month, or just the games left?" -> month_coverage, coveredRefs [], coverage "whole"
  "just the games left" / "sadece kalanlar" answering the same -> month_coverage, coveredRefs [], coverage "left"
  "@Match Time how many games does Dan cover?" / "@Match Time Dan kaç maç ödedi?" -> other
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
The club's quiet hours:
  "@Match Time turn off quiet hours now" / "@Match Time sessiz saatleri kapat" -> quiet_hours, quietOff true
  "@Match Time switch quiet hours back on" / "@Match Time sessiz saatleri tekrar aç" -> quiet_hours
  "@Match Time quiet hours from 22:00 to 8am" / "@Match Time sessiz saatler 22:00 ile 08:00 arası" -> quiet_hours, quietFrom "22:00", quietTo "08:00"
  "@Match Time don't post before 7am" / "@Match Time sabah 7'den önce mesaj atma" -> quiet_hours, quietTo "07:00"
  "@Match Time are quiet hours on?" / "@Match Time sessiz saatler açık mı?" -> other
  "the quiet hours held my message again" / "sessiz saatler yine mesajımı bekletti" -> other, toMatchTime false
How many players the club's game is played with, every week:
  "@Match Time we can play with 12" / "@Match Time 12 kişiyle de oynarız" -> player_numbers, minPlayers 12
  "@Match Time minimum 12 players" / "@Match Time en az 12 kişi" -> player_numbers, minPlayers 12
  "@Match Time set the minimum to 10" / "@Match Time en az 10 kişi olsun" -> player_numbers, minPlayers 10
  "@Match Time we're fine with 12, two down is ok" / "@Match Time 12 kişi de olur, iki eksik oynarız" -> player_numbers, minPlayers 12
  "@Match Time we play 12 to 16" / "@Match Time 12 ile 16 kişi arası oynuyoruz" -> player_numbers, minPlayers 12, maxPlayers 16
  "@Match Time max 14 again" / "@Match Time yine en fazla 14 kişi" -> player_numbers, maxPlayers 14
  "@Match Time 6 to 8 a side" / "@Match Time 6'ya 6 ile 8'e 8 arası" -> player_numbers, minPlayers 6, maxPlayers 8, aSide true
  "@Match Time minimum 8 on Thursday" / "@Match Time perşembe en az 8 kişi" -> player_numbers, minPlayers 8, matchDay "on Thursday" / "perşembe"
  "@Match Time back to full teams" / "@Match Time yine tam takım" -> player_numbers, fullTeams true
  "@Match Time how many do we need?" / "@Match Time kaç kişi lazım?" -> other
  "we're 12 tonight" / "bu akşam 12 kişiyiz" -> other, toMatchTime false
The squad limit, for the whole club from now on:
  "@Match Time no squad limit from now on, everyone who says in plays" / "@Match Time bundan sonra kadro sınırı yok, varım diyen herkes oynar" -> open_squad
  "@Match Time remove the bench for this group, the pitch is big enough for everyone" / "@Match Time bu grupta yedek olmasın, saha herkese yeter" -> open_squad
  "@Match Time put the limit and the bench back" / "@Match Time kadro sınırını ve yedekleri geri getir" -> open_squad, openSquadOff true
  "@Match Time no limit tonight, anyone can come" / "@Match Time bu akşam sınır yok, isteyen gelsin" -> other
  "@Match Time anyone can play this week" / "@Match Time bu hafta herkes oynayabilir" -> other
  "@Match Time is there a limit on numbers?" / "@Match Time kadro sınırı var mı?" -> other
Trying again after MatchTime said it could not do something:
  "@Match Time added the venue location" / "@Match Time tamam ekledim" -> retry_ask
  "done, try again" / "şimdi dene" -> retry_ask
  "@Match Time I've switched the pool on, go ahead" / "@Match Time havuzu açtım, devam et" -> retry_ask
  "@Match Time thanks" / "@Match Time teşekkürler" -> other
Reminders and stats:
  "remind me tomorrow at 6 to bring the bibs" / "yarın 6'da yelekleri getirmeyi hatırlat", NOW Tuesday 20 October 2026 -> reminder, phrase "tomorrow at 6" / "yarın 6'da", remindAt "2026-10-21 18:00", note "bring the bibs" / "yelekleri getirmeyi"
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
          personKind: { type: "string", enum: ["named", "relation", "group", "placeholder"] },
          benchAsked: { type: "boolean" },
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
          // The answer to MatchTime's "who is that?" said this person is
          // new (2026-11-17). false on every other claim.
          newPlayer: { type: "boolean" },
        },
        required: [
          "subject",
          "personRef",
          "personKind",
          "benchAsked",
          "polarity",
          "contingent",
          "conditionOn",
          "tense",
          "reported",
          "replaces",
          "confidence",
          "newPlayer",
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
    sideRequests: { type: "array", items: { type: "string", enum: ["recruit", "chase", "question", "teams"] } },
    // The message answers MatchTime's open "who is that?" (2026-11-17).
    answersClarification: { type: "boolean" },
  },
  required: ["claims", "affirmation", "sideRequests", "answersClarification"],
  additionalProperties: false,
} as const;

const TEAMS_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["show", "generate", "rename", "swap", "suggest", "clear", "restore", "set", "form"] },
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
    // 2026-11-16 (the Vets, "put Dan and Craig in separate teams"): the
    // other half of `pairings`, one group per "these people split up".
    apart: { type: "array", items: { type: "array", items: { type: "string" } } },
    // 2026-10-16: "swap Ali and Can" / "move Tom" name no side, so they
    // cannot be `swaps` (absolute). Each person here goes to the other
    // team from where they stand now.
    moves: { type: "array", items: { type: "string" } },
    // 2026-10-29: "swap everyone on bibs with non bibs", "swap them over".
    // The two whole teams swap over; no names, so not `moves`.
    swapSides: { type: "boolean" },
    // 2026-10-30: a pasted team sheet, "set": each side as written. Code
    // resolves every name and checks the sheet (`checkSheetFacts`).
    sides: {
      type: "object",
      properties: {
        red: { type: "array", items: { type: "string" } },
        yellow: { type: "array", items: { type: "string" } },
      },
      required: ["red", "yellow"],
      additionalProperties: false,
    },
    // 2026-10-30: asked of MatchTime, or people talking among themselves.
    // Read by HQ for an untagged change only; never enough for a build.
    toMatchTime: { type: "boolean" },
    // 2026-11-10: for "form", each player the note is about and the amount
    // (`form-scale.ts`). Code clamps it and decides who may set it.
    form: {
      type: "array",
      items: {
        type: "object",
        properties: {
          personRef: { type: "string" },
          delta: { type: "number" },
          reason: { type: "string" },
        },
        required: ["personRef", "delta", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["action", "includeRefs", "teamNames", "swaps", "moves", "pairings", "apart", "swapSides", "sides", "toMatchTime", "form"],
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
    // 2026-11-17: which side each name means, by THE GAME (`score-sides.ts`).
    // "unknown" is the schema's word for "THE GAME does not place it"; the
    // parser drops those, and code places a name it can itself first.
    teamSides: {
      type: "array",
      items: {
        type: "object",
        properties: {
          team: { type: "string" },
          side: { type: "string", enum: ["red", "yellow", "unknown"] },
          player: { type: "string" },
        },
        required: ["team", "side", "player"],
        additionalProperties: false,
      },
    },
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
    "teamSides",
    "momRef",
    "correction",
    "swapped",
    "otherGame",
  ],
  additionalProperties: false,
} as const;

/** move_game's weekdays, Monday first; index + 1 mod 7 is `Activity.dayOfWeek`
 *  (0 = Sunday). A closed list in the schema: never a day read from words. */
const WEEKDAY_NAMES = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;

/**
 * ONE ACTION of the admin extractor's list (2026-11-23: a message may ask
 * for several, "switch to 5aside, then invite the pool"). Every field of
 * every action, as before; `words` is the part of the message that asks
 * for this one. `toMatchTime` is the message's, once, in `ADMIN_SCHEMA`.
 */
const ADMIN_ACTION_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["bulk_payment", "fee_waiver", "reminder", "recruit", "stats_blast", "cancel_match", "restore_match", "set_venue", "retry_ask", "season_break", "quiet_hours", "player_numbers", "open_squad", "switch_format", "move_game", "month_coverage", "other"],
    },
    // month_coverage (2026-11-16): the whole month, the games left, or
    // neither said ("": MatchTime asks).
    coverage: { type: "string", enum: ["", "whole", "left"] },
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
    remindAt: { type: "string" },
    note: { type: "string" },
    // 0 is the schema's stand-in for null, the same convention
    // `statedCount` uses. A nullable number is rejected by the API.
    lookbackMatches: { type: "number" },
    // recruit: every place the players are to come from (2026-10-28: a
    // list, "partner clubs and the pool"; it was one choice since L10, and
    // S6's `partnerClubs` boolean before that); empty when the words name
    // none. The other club's name as written for "partners" (slice S6).
    // "named" (2026-11-09): the people tagged, not a place; code finds
    // them from WhatsApp's mention data (`named-invite-rules.ts`).
    playersFrom: { type: "array", items: { type: "string", enum: ["named", "club", "partners", "pool"] } },
    clubRef: { type: "string" },
    // set_venue (2026-10-28): the place as named, and the number picked from
    // MatchTime's list of places (0 is the stand-in for "none picked").
    venueName: { type: "string" },
    venueChoice: { type: "number" },
    // quiet_hours (2026-10-31): switch them off, and the London times said
    // ("HH:MM", "" when not said).
    quietOff: { type: "boolean" },
    quietFrom: { type: "string" },
    quietTo: { type: "string" },
    // player_numbers (2026-11-03): the fewest and the most players said
    // (0: none), and back to two full sides. switch_format: the number
    // said for one game. aSide: the numbers count one side, not everyone.
    minPlayers: { type: "number" },
    maxPlayers: { type: "number" },
    fullTeams: { type: "boolean" },
    // open_squad (2026-11-17): true puts a limit and a bench back.
    openSquadOff: { type: "boolean" },
    size: { type: "number" },
    aSide: { type: "boolean" },
    // move_game (2026-11-10): the game's number in GAMES TO COME (0: none
    // said), the weekday it moves to ("": it stays), the new London time
    // ("": it stays), and the weekly game from now on.
    game: { type: "number" },
    newDay: { type: "string", enum: ["", ...WEEKDAY_NAMES] },
    newTime: { type: "string" },
    everyWeek: { type: "boolean" },
    // The part of the message asking for this action, as written: said back
    // only to name a part that was not done. LAST, after every field
    // (2026-11-23, measured: first, the model wrote the whole request out
    // and then left matchDay empty, 0 of 5 on "cancel last Tuesday's match";
    // last, 5 of 5, as the old flat schema's action-first order was).
    words: { type: "string" },
  },
  required: ["action", "payerRef", "count", "coveredRefs", "undo", "matchDay", "pastGame", "phrase", "remindAt", "note", "lookbackMatches", "playersFrom", "clubRef", "venueName", "venueChoice", "breakMonths", "playMonths", "quietOff", "quietFrom", "quietTo", "minPlayers", "maxPlayers", "fullTeams", "openSquadOff", "size", "aSide", "game", "newDay", "newTime", "everyWeek", "coverage", "words"],
  additionalProperties: false,
} as const;

const ADMIN_SCHEMA = {
  type: "object",
  properties: {
    // Every action the message asks for, in the order asked (2026-11-23).
    actions: { type: "array", items: ADMIN_ACTION_SCHEMA },
    // Who the message is spoken to (2026-10-22): MatchTime, or a person or
    // the others. Code lets nothing leave HQ untagged unless it is MatchTime.
    toMatchTime: { type: "boolean" },
  },
  required: ["actions", "toMatchTime"],
  additionalProperties: false,
} as const;

const SCHEMAS: Record<Exclude<ExtractorKind, "none">, Record<string, unknown>> = {
  attendance: ATTENDANCE_SCHEMA as unknown as Record<string, unknown>,
  question: UNIFIED_QUESTION_SCHEMA as unknown as Record<string, unknown>,
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
/** A whole number from 1: what a stated count must be to be carried. */
function wholeFrom1(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

function bool(v: unknown, fallback = false): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/** One side of a "set" sheet, names trimmed, blanks dropped. */
function sideOf(sides: unknown, key: "red" | "yellow"): string[] {
  const list = sides && typeof sides === "object" ? (sides as Record<string, unknown>)[key] : null;
  return Array.isArray(list) ? list.map((n) => str(n).trim()).filter(Boolean) : [];
}

/** Groups of names (`pairings`, `apart`): trimmed, blanks dropped, and a
 *  group of fewer than two dropped, since it constrains nobody. */
function groupsOf(v: unknown): string[][] {
  return (Array.isArray(v) ? v : [])
    .map((g) => (Array.isArray(g) ? g.map((n) => str(n).trim()).filter(Boolean) : []))
    .filter((g) => g.length >= 2);
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
        // The extractor states the kind of person (2026-10-30); an older
        // stub that only sends `personNamed` maps onto it.
        const kindRaw = str(r.personKind).toLowerCase();
        const kind: PersonKind = (["named", "relation", "group", "placeholder"] as const).includes(kindRaw as PersonKind)
          ? (kindRaw as PersonKind)
          : bool(r.personNamed)
            ? "named"
            : "placeholder";
        claims.push({
          subject,
          personRef: str(r.personRef),
          personNamed: kind === "named",
          personKind: kind,
          benchAsked: polarity === "bench" && bool(r.benchAsked),
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
          // Only a named other person can be new; kept below only on an
          // answer to MatchTime's question.
          ...(bool(r.newPlayer) && subject === "other" && kind === "named" ? { newPlayer: true } : {}),
        });
      }
      // newPlayer means something only on an answer to MatchTime's "who
      // is that?" (2026-11-17): anywhere else it is model drift, dropped.
      const answersClarification = raw.answersClarification === true;
      if (!answersClarification) for (const c of claims) delete c.newPlayer;
      // "none" is the schema's stand-in for null (see ATTENDANCE_SCHEMA).
      const affRaw = str(raw.affirmation).toLowerCase();
      const affirmation = affRaw === "yes" ? "yes" : affRaw === "no" ? "no" : null;
      const sideRequests: SideRequest[] = (
        Array.isArray(raw.sideRequests) ? raw.sideRequests : []
      )
        .map((s) => str(s).toLowerCase())
        .filter((s): s is SideRequest => s === "recruit" || s === "chase" || s === "question" || s === "teams");
      const facts: AttendanceFacts = {
        kind: "attendance",
        claims,
        affirmation,
        sideRequests,
        ...(answersClarification ? { answersClarification: true } : {}),
      };
      return { facts, degradations };
    }

    case "question": {
      const { facts, problems } = parseUnifiedQuestion(raw);
      for (const p of problems) bad(p);
      return { facts, degradations };
    }

    case "teams": {
      const action = str(raw.action).toLowerCase();
      if (!["show", "generate", "rename", "swap", "suggest", "clear", "restore", "set", "form"].includes(action)) {
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
        pairings: groupsOf(raw.pairings),
        // The same for a group kept apart (2026-11-16): one person alone
        // is kept apart from nobody.
        apart: groupsOf(raw.apart),
        sides: { red: sideOf(raw.sides, "red"), yellow: sideOf(raw.sides, "yellow") },
        toMatchTime: raw.toMatchTime === true,
        // For "form" only. An entry with no player or no numeric amount is
        // dropped: it is acknowledged like talk about somebody else, never
        // stored as a guess (the clamp is `form-note-rules.ts`).
        form:
          action !== "form"
            ? []
            : (Array.isArray(raw.form) ? (raw.form as Array<Record<string, unknown>>) : [])
                .map((f) => ({
                  personRef: str(f?.personRef).trim(),
                  delta: typeof f?.delta === "number" && Number.isFinite(f.delta) ? f.delta : Number.NaN,
                  reason: str(f?.reason).trim().slice(0, 200),
                }))
                .filter((f) => f.personRef && Number.isFinite(f.delta)),
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
      // Per name (2026-11-17; review of #620): the player it is named
      // after, as THE GAME lists them, and the side an ANSWER gives.
      // "unknown" or a drifted side is no side; an entry with neither a
      // side nor a player, or no name, is dropped. Code decides what each
      // may place (`score-sides.ts`).
      const teamSides = (Array.isArray(raw.teamSides) ? raw.teamSides : [])
        .map((e) => (e && typeof e === "object" ? (e as Record<string, unknown>) : {}))
        .map((e): { team: string; side?: "RED" | "YELLOW"; player?: string } => {
          const sd = str(e.side).toLowerCase();
          const player = team(e.player);
          return {
            team: team(e.team) ?? "",
            ...(sd === "red" ? { side: "RED" as const } : sd === "yellow" ? { side: "YELLOW" as const } : {}),
            ...(player ? { player } : {}),
          };
        })
        .filter((e) => !!e.team && (!!e.side || !!e.player));
      if (teamSides.length > 0) facts.teamSides = teamSides;
      const momRef = team(raw.momRef);
      if (momRef) facts.momRef = momRef;
      if (raw.correction === true) facts.correction = true;
      if (raw.swapped === true) facts.swapped = true;
      if (raw.otherGame === true) facts.otherGame = true;
      return { facts, degradations };
    }

    case "admin": {
      // SEVERAL ACTIONS (2026-11-23, Sutton FC): `actions` lists every action
      // the message asks for, in the order asked; `toMatchTime` is the
      // message's, once. The flat shape (one action's fields at the top,
      // which stubs and recorded answers carry) reads as a list of one.
      const toMatchTime = raw.toMatchTime === true;
      const listed = Array.isArray(raw.actions);
      const rows = listed ? (raw.actions as unknown[]) : [raw];
      if (listed && rows.length === 0) {
        return { facts: { kind: "admin", action: "other", ...(toMatchTime ? { toMatchTime: true } : {}) }, degradations };
      }
      // Nothing the model listed is dropped silently (review of #629): an
      // action the schema does not allow, beside real ones, and every action
      // past the fourth, stay in their place as "other" with their words, so
      // code names them as not done.
      const asOther = (row: Record<string, unknown>): AdminFacts => ({
        kind: "admin",
        action: "other",
        ...(typeof row.words === "string" && row.words.trim() ? { words: row.words.trim() } : {}),
        ...(toMatchTime ? { toMatchTime: true } : {}),
      });
      const steps: AdminFacts[] = [];
      let read = 0;
      for (const row of rows) {
        if (typeof row !== "object" || row === null) {
          bad("dropped an admin action that is not an object");
          continue;
        }
        const step = adminStepFacts(row as Record<string, unknown>, toMatchTime, bad);
        if (step) read++;
        steps.push(step ?? asOther(row as Record<string, unknown>));
      }
      // Nothing the schema allows (only unknown actions): nothing read, as before.
      if (read === 0) return { facts: { kind: "none" }, degradations };
      // Only "other"s are one "other".
      if (steps.every((s) => s.action === "other")) return { facts: steps[0], degradations };
      if (steps.length > ADMIN_MAX_ACTIONS) bad(`${steps.length} admin actions read; the first ${ADMIN_MAX_ACTIONS} are carried out, the rest named as not done`);
      const kept = steps.map((s, i) => (i < ADMIN_MAX_ACTIONS ? s : asOther({ words: s.words })));
      const [first, ...rest] = kept;
      return { facts: rest.length > 0 ? { ...first, then: rest } : first, degradations };
    }
  }
}

/** The most actions one message is carried out as (2026-11-23). */
export const ADMIN_MAX_ACTIONS = 4;

/**
 * PURE. One action of the admin extractor's list, as facts, or null for an
 * action the schema does not allow (reported). `toMatchTime` is the
 * message's, set on every action.
 */
function adminStepFacts(raw: Record<string, unknown>, toMatchTime: boolean, bad: (detail: string) => void): AdminFacts | null {
  const action = str(raw.action).toLowerCase();
  if (!["bulk_payment", "fee_waiver", "reminder", "recruit", "stats_blast", "cancel_match", "restore_match", "set_venue", "retry_ask", "season_break", "quiet_hours", "player_numbers", "open_squad", "switch_format", "move_game", "month_coverage", "other"].includes(action)) {
    bad(`unknown admin action "${str(raw.action)}"`);
    return null;
  }
  const named = action === "recruit" && playersNamed(raw.playersFrom);
  // The people tagged stand alone (2026-11-09): with "named" in the
  // list, no place and no club is carried, so nothing but those people
  // can be asked or DM'd. The narrower reading wins.
  const clubRef = named ? "" : typeof raw.clubRef === "string" ? raw.clubRef.trim() : "";
  const from = named ? new Set<"club" | "partners" | "pool">() : playersFromOf(raw.playersFrom);
  const facts: AdminFacts = {
    kind: "admin",
    action: action as AdminFacts["action"],
    ...(typeof raw.payerRef === "string" && raw.payerRef ? { payerRef: raw.payerRef } : {}),
    ...(typeof raw.count === "number" && raw.count > 0 ? { count: raw.count } : {}),
    ...(Array.isArray(raw.coveredRefs)
      ? { coveredRefs: raw.coveredRefs.map(str).filter(Boolean) }
      : {}),
    ...(action === "fee_waiver" && raw.undo === true ? { undo: true } : {}),
    ...(["fee_waiver", "cancel_match", "restore_match", "player_numbers", "switch_format"].includes(action) && typeof raw.matchDay === "string" && raw.matchDay.trim()
      ? { matchDay: raw.matchDay.trim() }
      : {}),
    ...(["cancel_match", "restore_match"].includes(action) && raw.pastGame === true ? { pastGame: true } : {}),
    ...(typeof raw.phrase === "string" && raw.phrase ? { phrase: raw.phrase } : {}),
    ...(typeof raw.remindAt === "string" && raw.remindAt.trim() ? { remindAt: raw.remindAt.trim() } : {}),
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
    ...(action === "recruit" && from.size === 0 && !clubRef && !named ? { sourceUnsaid: true } : {}),
    // 2026-11-09: the people tagged in the message, the one it replies
    // to, or the one above ("@Match Time DM these people").
    ...(named ? { namedPeople: true as const } : {}),
    // 2026-10-28: the pitch named, and a pick from MatchTime's list
    // (a whole number from 1). Carried on set_venue only.
    ...(action === "set_venue" && typeof raw.venueName === "string" && raw.venueName.trim() ? { venueName: raw.venueName.trim() } : {}),
    ...(action === "set_venue" && typeof raw.venueChoice === "number" && Number.isInteger(raw.venueChoice) && raw.venueChoice > 0
      ? { venueChoice: raw.venueChoice }
      : {}),
    // quiet_hours (2026-10-31): off only when true, and then no times;
    // the times as written, trimmed, checked by the save core.
    ...(action === "quiet_hours" && raw.quietOff === true ? { quietOff: true as const } : {}),
    ...(action === "quiet_hours" && raw.quietOff !== true && typeof raw.quietFrom === "string" && raw.quietFrom.trim() ? { quietFrom: raw.quietFrom.trim() } : {}),
    ...(action === "quiet_hours" && raw.quietOff !== true && typeof raw.quietTo === "string" && raw.quietTo.trim() ? { quietTo: raw.quietTo.trim() } : {}),
    // open_squad (2026-11-17): a limit back only when true; absent is
    // the limit taken off.
    ...(action === "open_squad" && raw.openSquadOff === true ? { openSquadOff: true as const } : {}),
    // player_numbers (2026-11-03): back to full sides only when true, and
    // then no minimum; whole numbers from 1, checked by the save core.
    ...(action === "player_numbers" && raw.fullTeams === true ? { fullTeams: true as const } : {}),
    ...(action === "player_numbers" && raw.fullTeams !== true && wholeFrom1(raw.minPlayers) ? { minPlayers: raw.minPlayers as number } : {}),
    ...(action === "player_numbers" && wholeFrom1(raw.maxPlayers) ? { maxPlayers: raw.maxPlayers as number } : {}),
    // switch_format: the number said for the one game.
    ...(action === "switch_format" && wholeFrom1(raw.size) ? { size: raw.size as number } : {}),
    ...((action === "player_numbers" || action === "switch_format") && raw.aSide === true ? { aSide: true as const } : {}),
    // move_game (2026-11-10): the game's number (a whole number from 1,
    // checked against the list shown by `game-move-rules.ts`), the
    // weekday from the schema's closed list, the time as written
    // (checked by code), and every week only when true.
    ...(action === "move_game" && wholeFrom1(raw.game) ? { game: raw.game as number } : {}),
    ...(action === "move_game" && typeof raw.newDay === "string" && (WEEKDAY_NAMES as readonly string[]).includes(raw.newDay)
      ? { newDay: ((WEEKDAY_NAMES as readonly string[]).indexOf(raw.newDay) + 1) % 7 }
      : {}),
    ...(action === "move_game" && typeof raw.newTime === "string" && raw.newTime.trim() ? { newTime: raw.newTime.trim() } : {}),
    ...(action === "move_game" && raw.everyWeek === true ? { everyWeek: true as const } : {}),
    // month_coverage (2026-11-16): only the schema's two values; "" or
    // anything else is not said, and MatchTime asks.
    ...(action === "month_coverage" && (raw.coverage === "whole" || raw.coverage === "left") ? { coverage: raw.coverage } : {}),
    // season_break (2026-10-29): only well-formed "YYYY-MM" months.
    ...(action === "season_break" ? { breakMonths: monthKeysOf(raw.breakMonths), playMonths: monthKeysOf(raw.playMonths) } : {}),
    // The words of this action (2026-11-23): said back only to name a
    // part that was not done.
    ...(typeof raw.words === "string" && raw.words.trim() ? { words: raw.words.trim() } : {}),
    // Only a clear true: a missing or false value keeps HQ's outward
    // actions closed (`admin-group-understand.ts`).
    ...(toMatchTime ? { toMatchTime: true } : {}),
  };
  return facts;
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
/** Does `playersFrom` name the people tagged ("named", 2026-11-09)? */
function playersNamed(v: unknown): boolean {
  return Array.isArray(v) && v.some((x) => typeof x === "string" && x.trim().toLowerCase() === "named");
}

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
  /**
   * The attendance extractor only (2026-11-17): the sender's earlier
   * message about who plays, whose person MatchTime asked them about
   * ("Do you mean Yoobie, or is Abu Ayoub a new player?"), shown as the
   * MATCHTIME ASKED line; the extractor then says `answersClarification`
   * and returns that message's claims. Absent otherwise.
   */
  clarifying?: string;
  /**
   * The admin extractor only (2026-11-10, `move_game`): the club's games
   * still to be played, one numbered line each (`gamesToComeLines`,
   * game-move-rules.ts), shown as the GAMES TO COME block. The model names
   * a game by its number; code checks it against the same list. Absent:
   * no block; empty: "none".
   */
  games?: readonly string[];
  /**
   * The score extractor only (2026-11-17, `score-sides.ts`): THE GAME, the
   * club's latest game, whether its score is awaited, and per side
   * MatchTime's name, the club's other names and its players
   * (`gameContextLines`). Absent: no block.
   */
  game?: readonly string[];
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
  if (msg.clarifying && kind === "attendance") {
    context.push(`MATCHTIME ASKED them who someone in their earlier message is: "${msg.clarifying}"`);
  }
  // The admin extractor only (2026-11-10, move_game): the club's games to
  // come, numbered, so the model names a game by its number and code checks
  // it against this same list. Given and empty: said so, so no number is
  // invented.
  if (kind === "admin" && msg.games) {
    if (msg.games.length === 0) context.push("GAMES TO COME: none");
    else context.push(`GAMES TO COME (the club's games still to be played, numbered):\n${msg.games.map((g) => `  ${g}`).join("\n")}`);
  }
  // The score extractor only (2026-11-17): the latest game and its two
  // sides, so a name the club uses ("bibs", "Dan's team") can be placed.
  if (kind === "score" && msg.game && msg.game.length > 0) {
    for (const l of msg.game) context.push(l);
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
