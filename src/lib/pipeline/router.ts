/**
 * STAGE 1 — THE ROUTER.
 *
 * One cheap call per batch. One route per message id. Banter exits here
 * and costs nothing further: 68.6% of real traffic (1,200 of the 1,748
 * bodied production messages re-extracted 2026-09-11; 69.1% of all
 * 1,776 rows) is `noise`, and under the
 * mega-prompt every one of those cost ~160 output tokens for the model
 * to conclude that a laughing emoji is a laughing emoji (§4.2).
 *
 * What this file actually sends a message to `none` at is **63.6%** of
 * traffic, measured over the same 1,748 — the gap between that and
 * 69.1% is banter that still buys an extractor call, and
 * `MDs/router-accuracy-2026-09-11.md` §1.3 is where it is priced.
 *
 * §11.1 CALLS ROUTER MISCLASSIFICATION THE BIGGEST RISK IN THE DESIGN,
 * and a genuine regression: a message routed `none` disappears with no
 * write, no reply, no reaction and no signal.
 *
 * ⚠️ ITS COMPARISON DIED ON 2026-09-06, AND THE RISK GOT WORSE. That
 * sentence used to end "…where today's mega-call at least emits
 * something for every message". §10 step 8 deleted `analyzeBatch`, the
 * 19,850-token `SYSTEM_PROMPT` and `executeVerdict`. There is no
 * mega-call and nothing that emits something for every message: a route
 * this file gets wrong is not double-checked by a second decider,
 * because there is no second decider. Every containment below is now
 * load-bearing on its own rather than as a belt beside braces, and the
 * fourth one (the nightly `none`-bucket sweep) is the ONLY remaining
 * thing that ever looks at a `none` again. See `pipeline/gate.ts`, which
 * carries the full argument.
 *
 * Three of the four containments live in this file:
 *
 *   1. BIAS TOWARD ACTION. In the prompt, and again in the parser: a
 *      missing id becomes `unsure` (which reaches an extractor), never
 *      `none`. A false positive costs ~$0.002. A false negative costs a
 *      player their slot.
 *   2. A DETERMINISTIC FLOOR. `routeFloor` force-routes bare IN/OUT/+1
 *      whatever the model says. ⚠️ §11.1 corrects its own first draft
 *      here: the old regex fast path CANNOT serve as this floor, because
 *      it was deleted on 2026-04-21 and `handlers.ts:7-10` records that
 *      "Kemal explicitly asked for this". So the floor is BUILT NEW and
 *      kept deliberately tiny, and reintroducing one at all is a product
 *      decision that needs his sign-off before step 5 ships.
 *   3. FAIL OPEN, NOT CLOSED. Router error → everything routes to
 *      `unsure`, i.e. the attendance extractor (§11.4). Expensive,
 *      correct, self-limiting.
 *
 *      THIS ONE ONLY BECAME TRUE IN §10 STEP 8, and the comment at line
 *      ~362 claimed it for months before it was. `unsure` was NOT an
 *      engine route until step 8, so a router outage sent the whole
 *      batch to the mega-prompt rather than to any extractor — and once
 *      the mega-prompt went, that would have been silence for every
 *      message in the batch, a bare "IN" included. Adding `unsure` to
 *      `gate.ts`'s `ENGINE_ROUTES` is what finally made this sentence
 *      describe the code, and `__tests__/gate.test.ts` pins it as its
 *      own case so removing it again reads as "router-failure handling
 *      broke".
 *
 * The fourth containment — shadowing the `none` bucket forever — belongs
 * to the harness, not here.
 *
 * A FIFTH, WHICH §11.1 DID NOT ANTICIPATE AND THE DATA FOUND:
 *
 *   5. THE OPEN-QUESTION CONTEXT. Shadowing the `none` bucket is what
 *      turned this up: over 1,695 real messages, exactly two are an
 *      attendance write the gate would have lost, and both are a bare
 *      `👍` answering a slot MatchTime had left open (PR #42). The floor
 *      cannot reach them — a `👍` pattern would fire on every thumbs-up
 *      in the group, which is the floor becoming a classifier again — so
 *      the trigger is a DATABASE ROW instead of the message text: while
 *      MatchTime has an open, unanswered question, a `none` route is not
 *      trusted. Same one-directional shape as the floor, different
 *      trigger. See `awaiting-answer.ts`.
 */
import {
  describeQuestion,
  type AwaitingQuestion,
  type StatsClarification,
} from "./awaiting-answer";
import {
  anthropicModel,
  degradation,
  extractJson,
  ROUTER_MODEL,
  type ModelRequest,
  type PipelineModel,
} from "./llm";
import { HAIKU_EFFORT } from "../models";
import { nowLine, quotedLines, type ContextMessage } from "../reply-context";
import type { Degradation, Route, RoutedMessage } from "./types";
import { ORGANISER_ONLY_ROUTES } from "./types";
import { isAiBudgetExceeded, withAttendanceOverflow } from "../ai-budget-context";


/**
 * ─────────────────────────────────────────────────────────────────────
 * THE ROUTER PROMPT, AND WHAT EVERY EDIT TO IT MUST PROVE
 * ─────────────────────────────────────────────────────────────────────
 *
 * ⚠️ READ THIS BEFORE EDITING A RULE BELOW. The metric with a veto is
 * gold-labelled ATTENDANCE messages routed `none` over the 373-message
 * corpus (`npm run replay:router-attendance`, floor OFF, three live
 * runs). It must stay 0, 0, 0. `MDs/router-accuracy-2026-09-11.md` §3.1
 * is why it is three runs over the WHOLE corpus: a candidate that scored
 * higher overall TRIPLED the attendance it threw away, and a held-out
 * split did not catch it. Run `npm run replay:router-regressions` first;
 * it is cheap and every message in it is one a prompt has already lost.
 *
 * And per `CLAUDE.md`: when the router needs to understand something new,
 * REWRITE this prompt as a whole. Do not append a rule or an example
 * block to the end.
 *
 * ── HOW IT GOT HERE ──────────────────────────────────────────────────
 *
 * 2026-09-11. A 2,501-character prompt reached 83.3% owner accuracy over
 * 1,748 real Sutton FC messages and lost 3, 2 and 4 of the 373
 * attendance messages to `none`. Its replacement reached 93.4% and lost
 * 0, 0, 0; banter escaping `none` fell from 21.5% to 8.1%. The trade
 * said out loud: gold-labelled questions routed `none` rose from 1 to 5
 * of 641, four of them untagged (and `answer-batch` refuses an untagged
 * question anyway).
 *
 * 2026-09-16, Turkish. The bare "var", "yok" and "yokum" were lost 30 of
 * 30 (`MDs/second-group-readiness-erdal-2026-09-16.md` §2). The first
 * cut lost "Zeeshan OUT" in 2 of 3 veto runs, which is why the two-word
 * "Baki OUT" shape is taught explicitly.
 *
 * 2026-09-22, replacements. "Hi guys, Mojib is replacing Najib on the
 * list. We can change", untagged, went to `none` 28 minutes before
 * kickoff; the replacement ruling and its examples exist for it.
 *
 * 2026-09-23, THE REWRITE. After three patches the prompt had grown to
 * eighteen numbered rules, some stating the same thing twice (rules 0,
 * 11a and 15 were one idea), two example blocks split by language, and
 * no idea of what a TAG means. Measured live (single message, floor
 * OFF, three runs each) on the prompt it replaced, short tagged stats
 * asks were thrown away as banter: "@Match Time Zork's chemistry",
 * "@Match Time Mehmet's chemistry" and "@Match Time who's the worst"
 * routed `none` 0 of 3 each, so MatchTime never got to ask "who do you
 * mean?". It is now one document: what is at stake, three questions in
 * a fixed order (a place in the squad first, then the tag, then
 * everything else), each route defined once, each ruling stated once,
 * and the worked examples grouped by what they teach with the Turkish
 * beside the English. The order is the safety argument: a tagged
 * attendance message stops at the first question and never reaches the
 * second.
 *
 * Measured on the rewrite, dev key, floor OFF:
 *   - the three targets 3/3 each (0/3 each before), and seven held-out
 *     shapes of the same kind 21/21 (15/21 before: "@Match Time Idris
 *     chemistry" and "@Match Time Mehmet'in kimyası" were 0/3);
 *   - every stats case from PRs #126 and #129, 48 cases x 3: 144/144,
 *     same as before;
 *   - Turkish bare forms and sentences 30/30, replacements RP1 to RP8
 *     24/24, other attendance 57/57 ("Zeeshan OUT" 9/9 alone), all
 *     unchanged;
 *   - untagged banter controls 66/66 (was 64/66: "£8.6 per person to
 *     Elvin" no longer reads as a payment credit), tagged thanks and
 *     emoji still `none` 9/9;
 *   - `replay:router-regressions` 57/60, identical to the old prompt;
 *   - the veto. The first cut lost 2, 0, 0 of 373: "@Jordan IN" (sent
 *     straight after a message explaining how to say IN) and "I will be
 *     back Tuesday week", once each. The away-or-back ruling and the
 *     "@Kojo IN" and "back after my holiday" examples are what closed
 *     them, and the size trims that paid for them were wording only. The
 *     next prompt read 0, 0, 0 with one fallback route (uncertified;
 *     the harness now names a fallback's message and cause), and its
 *     certifying re-run read 0, 0, 1: a bare "Confirmed", alone in its
 *     batch, routed none. Ten repeats of that batch: none 2/10 on this
 *     prompt, 0/10 on the old one, a real regression. The old prompt's
 *     "return unsure rather than guessing" rule had been carrying it.
 *     The unsure route now says a bare "confirmed" is unsure, never
 *     none: 0/20 after. That fix was verified by the batch repeat and a
 *     non-stats probe re-run, NOT by another full three-run sweep.
 *
 * On the final prompt: the full 118-case probe ran clean (360/360)
 * before the "confirmed" line went in, and the attendance, Turkish,
 * replacement, target, banter and tagged groups (210 calls) ran clean
 * again after it.
 *
 * SIZE. 12,416 characters / 3,289 tokens before, 11,443 / 3,311 after
 * (`count_tokens`, claude-haiku-4-5). Still under Haiku's 4,096-token
 * cacheable minimum, so every token is paid on every call, and it is
 * deliberately not padded over it: the Pi buffers about ten minutes and
 * a five-minute cache entry would expire first
 * (`MDs/llm-spend-september-2026.md`). CORRECTED 2026-10-19: that count
 * was the system prompt alone. The cached prefix includes the schema, and
 * with it the real request was over 4,096 (about 4,246, measured); only a
 * size gate in llm.ts kept the marker off. Every call carries the marker
 * now (`__tests__/cache-threshold.test.ts`).
 *
 * Comments elsewhere that cite "router rule 8" or "rule 15" mean the
 * numbered prompt before this rewrite (3781d2b). Both rulings survive,
 * unnumbered: "ASKING is question; INSTRUCTING is admin_ops" word for
 * word, and "the place wins" for an instruction that carries a setting
 * change and a place.
 *
 * ── 2026-10-16: ONE ROUTER FOR EVERY GROUP ─────────────────────────────
 *
 * Kemal: "There has to be a general module which analyzes the messages
 * coming from multiple groups and then processes accordingly." A club's
 * organisers' (admin) group, HQ, now comes through this same router
 * (`admin-group-understand.ts`), under `ORGANISERS_HEADER` with its
 * context lines (what MatchTime is waiting to hear, the message replied
 * to, recent HQ messages). The prompt was rewritten as one document that
 * covers both groups: one paragraph saying which group a message is from,
 * the same three questions and rulings, and one "IN THE ORGANISERS' GROUP"
 * section with the four routes only HQ has (approve, poster, team_sheet,
 * help) and what differs there. A players' group message's user turn is
 * byte-for-byte what it was, and an HQ-only route on one reads as
 * `unsure` (`parseRouterResponse`). Live check on the dev key, once per
 * case: the HQ set 48/48 on the final prompt; the players' group
 * regressions, veto and recall are in the PR.
 *
 * ── 2026-10-16, LATER: A REPLY TO MATCHTIME IS A TAG ────────────────────
 *
 * FNF: MatchTime posted "the bench is open", a player replied to THAT post
 * "Bench? We do bench now?", and nothing answered: it was not tagged. A
 * players' group message that quotes MatchTime's own post now comes under
 * the same `REPLYING TO MatchTime` line HQ uses (`replyingToLine`), and the
 * prompt's definition of a tag, of `question` (how MatchTime works here)
 * and one place ruling ("asking how the bench works asks for no place")
 * say so where those things are defined. The tag itself is code's
 * (`messageTagsBot`, from the Pi's `quotedFromMatchTime`); the line only
 * lets the model read the reply the way the gate already will.
 *
 * ── 2026-10-16, REWRITTEN: ask_group, AND SHORTER ──────────────────────
 *
 * In FNF's HQ "@Match Time ask in the group if anyone is available" routed
 * admin_ops and was answered "I can't do that from this group". The shared
 * admin extractor read it as `other`, and its `recruit` is the players'
 * group's DM blast, so HQ gets a fifth code-owned route, `ask_group`
 * (`admin-group-ask-group.ts`), defined once beside the other four. With
 * the reply-is-a-tag change above the prompt had reached 4,090 tokens, so
 * it was rewritten as one document rather than added to: every ruling
 * stated once (rulings that repeated a worked example now keep only the
 * example), the tagged-stat ruling folded into question 2, the bare
 * scoreline and question-mark rulings shortened, and a few duplicate
 * examples dropped. A first cut also moved the roster ruling and trimmed
 * the "asking the group for a player" ruling's examples, and the veto
 * sweep lost 5 of 373 attendance messages to none (main: 1 to 2); both
 * went back. 14,326 characters / 4,098 tokens before, 13,683 / 3,922
 * after (`count_tokens`, claude-haiku-4-5, with a one-token message). In
 * HQ, "how do I get you to ...?" is help, said on the help line. The live
 * checks covering every existing behaviour are in the PR.
 */
/*
 * ── 2026-10-20: A REPLY TO ANYONE CARRIES WHAT IT QUOTES (slice S4) ────
 *
 * A WhatsApp reply in either group now comes under the DM block's
 * "THEY ARE REPLYING TO" lines (`quotedLines`, `reply-context.ts`), WHOEVER
 * wrote the quoted message: "same" replying to Ali's "IN" had no referent
 * when only MatchTime's own posts were shown. The turn opens with NOW. The
 * prompt's reply parts were rewritten as one REPLIES paragraph (what the
 * lines are, read the reply against them, route the reply itself), the tag
 * definition now says a reply to a member is not a tag, the organisers'
 * header no longer lists "the message it replies to" (it is shown under
 * the shared lines), and the reply examples are one group. Nothing else
 * changed. Live checks before and after are in the PR.
 *
 * ── 2026-10-20: ASKING WHEN THE TEAMS COME OUT IS A QUESTION ───────────
 *
 * "@Match Time when will the teams be out?" routed balancer 4 of 20 on
 * main and "@Match Time takımlar ne zaman?" 10 of 13 (dev key, Haiku 5.5),
 * and balancer reaches the extractor that can generate. `question` never
 * named the club's own setup (the question extractor's `club` topic: who
 * runs it, the fee, when the teams come out), and its "how MatchTime works
 * (... the teams)" read as anything about the teams. The definitions were
 * rewritten: question holds "when the teams come out" and "how the teams
 * are picked", balancer is SEEING or MAKING the line-ups, the boundary is
 * one ruling beside "SEE the squad", and the teams examples are one group
 * teaching both sides. The tag line now says the bot's name used to speak
 * to it is a tag (the code's `messageTagsBot` already said so), and HQ's
 * "for the bot only when" includes asking it for something it holds, so
 * "MatchTime yöneticiler kim?" and HQ's "who's on the bench?" are not
 * organisers' chat. 14,550 to 15,352 characters (count_tokens on
 * claude-haiku-5-5 with a one-token message: 5,458 to 5,741).
 *
 * ── 2026-10-21: REWRITTEN AS ONE DOCUMENT, CONTEXT FIRST ──────────────
 *
 * The prompt now opens with WHAT YOU ARE SHOWN: the lines code supplies
 * (NOW, one line per message, the organisers' header, the partner clubs
 * line, then REPLIES), so the facts code already has do the work. Each
 * route is defined once, with its boundary on the same line (a relayed or
 * completed place and the roster under other_att, away-or-back under
 * self_att, talk ABOUT the bot under admin_ops, members asking each other
 * under none, the professional scoreline under score); the rulings that
 * restated a route or question 1 went, and the five that settle a real
 * confusion stayed. The examples are grouped by what they teach, each
 * Turkish line directly after its English twin. The organisers' section no
 * longer says "every sender is an organiser": players are in HQ too
 * (2026-10-20), so `organisersHeader` states whether THIS sender is one,
 * from `AdminGroupInput.organiser`, and the prompt says code decides what
 * each sender may do. Routes and output contract unchanged. Sizes and the
 * live results before and after are in the PR.
 *
 * ── 2026-10-22: CALLING A MATCH OFF, AND HELP ONLY WHEN ASKED ─────────
 *
 * FNF HQ: "Cancel the session" routed admin_ops and got "I can't do that
 * from this group"; then an owner TELLING the others how MatchTime would
 * cancel, with a tag, routed help and got the whole menu. admin_ops now
 * names calling a match off or putting it back on (the admin extractor's
 * cancel_match / restore_match, done by `match-cancel.ts`); help is asking
 * MatchTime, and telling the others about it is none. Both definitions were
 * rewritten where they stand, and the organisers' examples regrouped by
 * what they teach. 15,202 to 15,989 characters.
 *
 * ── 2026-10-28: A GAME THAT NEVER TOOK PLACE ─────────────────────────
 *
 * Sutton FC's Tuesday never happened and MatchTime asked for its score and
 * ratings. "@Match Time Tuesday's game didn't happen" routed question in 2
 * of 3 live tries: it is about a past match, and the ruling on past matches
 * named only asking and reporting a result. That ruling now names the third
 * thing, telling the bot it never took place (admin_ops), and admin_ops says
 * it calls such a game off. Rewritten where they stand; nothing added at
 * the end. Sizes in the PR.
 *
 * ── 2026-10-29: TELLING MATCHTIME TO FIND PLAYERS ─────────────────────
 *
 * The owner's "@Match Time invite players from pool" in the players' group
 * routed offer 5 of 10 and admin_ops 5 of 10 (dev key): admin_ops never
 * named finding players, the pool was nowhere in the prompt, and only the
 * partner clubs line (shown to organisers of clubs with partners) sent an
 * ask to other clubs to admin_ops. Finding new players, from the pool, a
 * partner club or all of them, several places or none named, is now part
 * of admin_ops's definition (the admin extractor's recruit reads where
 * from); the "asking for a player" ruling says WHO is asked decides
 * (the group: offer or other_att; MatchTime: admin_ops); and the examples
 * for both sides are one group. A first draft also told question 1 that
 * finding players settles nobody's place: that pushed real attendance
 * ("Don't pull out", "Slott gone") towards none in the history sweep, so
 * it went; question 1 only ever pushes towards attendance. The partner line's rule folded in, so the line is the names
 * alone. In the organisers' group the same request stays ask_group, now
 * said on that line. Sizes and live results before and after in the PR.
 */
/*
 * ── 2026-10-30: NO STRING PARSING, AND THE FACTS AS LINES ─────────────
 *
 * Kemal: "I don't want any string parsing at all." Three word tests that
 * used to overrule or pre-empt this router are gone: the bare IN/OUT
 * floor (`routeFloor`), the "which team won?" and score-correction
 * vocabularies that forced `score`, and the "who do you mean?" name reader
 * that forced `question`. In their place the turn carries the FACTS code
 * has, as lines above the message (`scoreContextLine`,
 * `clarificationLine`), and the prompt says what each line means where it
 * defines what the model is shown; the score route names answering which
 * team won and correcting a recorded result. The answer gains `to_bot`,
 * the model's reading of whether a message speaks to MatchTime, which the
 * analyze route now treats as a tag in place of the "match time" text
 * match. Nothing appended at the end; the output contract is where it was.
 */
export const ROUTER_SYSTEM_PROMPT = `You are the front door of MatchTime, the bot that runs a football club's WhatsApp groups: the weekly squad, the two teams, finding players when the club is short, results, payments, reminders and the players' stats. For EVERY message id you are given, return exactly one route: the part of MatchTime that handles the message, or none when it is chat between people and not for the bot.

WHAT YOU ARE SHOWN. Code knows these facts; rely on them rather than guessing.
- NOW: the date and time at the club.
- One line per message, "[m1] Name: text". Route every id; every other line is context.
- An "ORGANISERS' GROUP" header above a message: it was sent in the club's organisers' group, and the header says whether the sender is an organiser, what MatchTime is WAITING to hear and what was said there EARLIER. Without that header a message is from the PLAYERS' GROUP. Everything below applies to both groups; "IN THE ORGANISERS' GROUP" adds what differs there.
- A "PARTNER CLUBS" line above an organiser's message: the names of the club's partner clubs, so a message naming one of them is about that club, not this group.
- A "MATCHTIME IS WAITING to hear ... which team won" or "MATCHTIME HAS RECORDED" line above a message: this sender may answer which team won the scoreline MatchTime asked about, or may correct the result it recorded. The line says what the sender MAY do; route on what the message does.
- A "MATCHTIME ASKED" line above a message: MatchTime could not tell whom the sender's earlier stats question meant and asked them. A reply that names the person, in any words, answers it: question. Anything else they say is routed as usual ("I'm in" is still self_att).

REPLIES. A message that is a WhatsApp reply comes under a "THEY ARE REPLYING TO" line: whose message it quotes (MatchTime's or a member's), when (against NOW), and its words. Read the reply in the light of what it quotes, then route the reply itself. "same", "me too", "ben de", "he", "that" and a bare "no" take their meaning from it.

WHAT IS AT STAKE. A message routed none is gone: nothing is written, nobody replies, and a player who said they are playing loses their place without knowing. Any other wrong route costs a few pence and is caught later. So when in doubt between none and anything else, choose the other route.

HOW TO DECIDE. Route on what a message DOES, not on what it is about. Ask three questions, in this order, and stop at the first yes.

1. Does it settle a place in THIS squad? A message that states, promises, withdraws, offers, swaps, corrects or asks for a place for anybody at all (the sender, a named player, an @mention, a relative, a guest, a phone number) is attendance: self_att, other_att, offer or unsure. The plainest case is a name or an @mention followed by in or out (var or yok in Turkish), even as two bare words: that is other_att, always, whoever sends it. It is a real sign-in and never a demonstration of how to write one, even beside a telling-off, instructions on how to say IN, or a pasted copy of the list. An attendance message is never none, however casually it is worded, whoever it is addressed to, and whatever chat, apology, joke or question mark surrounds it. When it also changes a setting, the place wins. Nothing below overrides this.

2. Does it tag the bot? A tag is "@Match Time", "@MatchTime" or "@MT" anywhere in the message, or the bot's name used to speak to it ("MatchTime who runs this club?"). In the players' group, so is a reply to MatchTime's own message; a reply to a member's message is not. A tagged message is spoken TO the bot, so it is never none because it is short, has no question mark, or is only a name and a word; send it to the owner of what it asks for. A tagged name, stat or table alone is a question; the same words untagged, between members, are none. Only a tagged message that asks for nothing at all (thanks, a laugh, an emoji, a greeting) is none. "Match Time" written without the @ while talking ABOUT the bot to the others ("rate them via the link from Matchtime") is not a tag.

3. Is it for the bot at all? An untagged message can still ask for something the bot holds, give it an instruction, ask for the teams or report our result. Otherwise it is none: banter, jokes, links, emoji, greetings, football chat, and members talking to each other in a way that settles no place and asks the bot for nothing.

THE ROUTES, each defined once.
self_att    the SENDER joins or leaves this match, bench included, or says when they will be away or back ("not this week", "back next month").
other_att   adds, drops, benches, moves, swaps or replaces SOMEONE ELSE in the squad, relays a place already settled ("Ayoub snatched that spot", "Trevell got injured so he had to drop out"), or reposts one list of players: the squad roster, however long or numbered and however it is headed (a date, a venue, "In sha Allah").
offer       a tentative or conditional commitment by anyone ("if you're short", "if my back holds up"), or asking the group for a player when nobody named is leaving.
unsure      about a place, but you cannot tell who or what it does. A bare "confirmed" or "confirm" is unsure, never none: it may be somebody confirming their place. Never use it for plain banter.
question    asks for something the bot holds: the squad and how many are in, the pitch, who has paid, a past result, every stat (ratings, leaderboards, Man of the Match, appearances, Elo, chemistry, reliability, form, best and worst, a player's own stats or wrapped), how the club is run (who the organisers are, who collects the money, the fee, when the teams come out), and how MatchTime works here (the bench, signing in, how the teams are picked). Asking how the bench or the list works asks for no place.
balancer    asks about the TWO team line-ups (red and yellow) themselves: to see them, make them, shuffle or rename them, change them as they stand (swap two players between the teams, move a player to the other team, swap the two teams' colours) or clear them. Swapping between the teams changes nobody's place in the squad, so it is balancer, never attendance, in both groups.
score       reports the final result of this group's own match (our team names, our colours or a bare scoreline), answers which team won or who was its Man of the Match while MatchTime is WAITING for that (a team named alone, "Yellow", "sarılar kazandı"; praise alone answers nothing), or says a recorded result is wrong ("you've got it the wrong way round", "no, 5-7 to Red", "yanlış, sarılar kazandı"). A professional scoreline somebody is watching is none.
admin_ops   tells the bot to do something now: find new players (from the MatchTime player pool, from one partner club or all of them, from several places, or with no place named), credit a payment, set a reminder, send a link, change a setting, call a match off (one still to come, or one that never took place) or put it back on. Talk ABOUT the bot, settings, the pitch or money owed between members, and plans the sender will carry out ("I will change it to 7aside", "matchtime should suggest 5aside"), are none: admin_ops needs somebody telling the BOT to act now.
none        everything else, as in question 3. A member asking another member something that settles nothing is none ("are you injured?", "which two of you can play tomorrow?"); as soon as a message STATES that somebody plays or does not, it is attendance.
approve, poster, team_sheet, help and ask_group exist ONLY in the organisers' group; see that section.

RULINGS. Each one settles a confusion that has really happened in a group.
- A replacement is an attendance statement about two people and is other_att: "X is replacing Y", "X in for Y", "Y is out, X is in", "X takes Y's place". A swap between the two teams is not a replacement: both players stay in the squad and only change team, so it is balancer ("swap me with Elvin", "Raihan ile yer değiştirelim", "put Sam in yellow").
- Asking for a player: WHO is asked decides. A question to the members of this group ("anyone able to replace me?", "anyone else want to join us?", "can we have more INs please?") is attendance, not question, with or without a question mark or a tag: other_att when a named or implied person is leaving, otherwise offer; the ask is often buried in praise, worry or a pitch, and that changes nothing. An instruction to MATCHTIME to go and find, ask, invite or get players (from the player pool, from a partner club by name, from the partner clubs or other groups, or from nowhere named) is admin_ops, even when it ends "if anyone can play".
- ASKING is question; INSTRUCTING is admin_ops. "Amir paid for 4 players" and "remind me on Monday" tell the bot to do something: admin_ops. "Who hasn't paid?" asks for what the bot knows: question.
- Asking to SEE the squad ("who's in?", "list the players") is question. Asking to SEE or MAKE the teams ("teams?", "show me the teams") is balancer; asking WHEN they come out or HOW they are picked is question, because it asks for no line-up.
- A match already played: asking about it ("did we win on tuesday?") is question; reporting its result ("we won 5-3") is score; telling the bot it never took place ("@Match Time Tuesday's game didn't happen", "@Match Time dünkü maç oynanmadı") is admin_ops, because it calls that game off. A question mark alone does not make a question.

IN THE ORGANISERS' GROUP. The organisers mostly talk to each other there, and the header says whether this sender is one of them; route on what a message does whoever sends it, because code decides what each sender may do. Question 1 still comes first and is never none: a message saying a player is in, out, can or cannot play ("Tom out", "put Bilal in", "Shehryar can't make it tonight") changes the squad, other_att, however chatty. Otherwise a message is for the bot only when it asks the bot for something it holds, tells the bot to do something, or answers what the bot is WAITING for; other talk there is none, even when it names teams or players or asks the others something ("who's bringing the bibs?"), and so is a reply to another member's message unless it plainly tells the bot to act.
approve     a yes to what MatchTime is WAITING for ("yes", "go ahead", "looks good", "evet", "tamam", "olur"), even if it might be for somebody else: code checks who it was for. With nothing waiting, it is none.
poster      asks for the squad list as an image or graphic to share.
team_sheet  asks for the teams as an image or graphic to share. A bare "teams" asks to see them: balancer.
help        asks MatchTime what it can do here, or how to get it to do something: there, that is help, not question. Telling the others what MatchTime does or will do asks it nothing, tagged or not: none.
ask_group   tells the bot to find players, from anywhere or with no place named, or to ask the players' group whether anyone can play: there, that is ask_group, not admin_ops. Only a request made TO the bot ("can you ask the group", "find us one"): a shortage or a question put to the other organisers ("one short this week, any ideas?", "anyone got a mate who can play?"), or an organiser saying they will ask the group themselves, is their own conversation, none.

LANGUAGE. Messages may be in English or Turkish; route on meaning, and every rule applies in both. "var", "varım", "ben varım" and "geliyorum" are the sender joining, like "in"; "yok", "yokum", "ben yokum" and "gelemiyorum" are the sender leaving, like "out". "belki", "bakarız", "kesin değil" (maybe, we'll see, not certain) are offer. "X de geliyor" or "X de var" adds X and "X gelemiyor" or "X yok" drops X: other_att. "X, Y'nin yerine geliyor", "Y yerine X" and "Y çıkıyor X giriyor" are replacements.

WORKED EXAMPLES, grouped by what they teach, each Turkish line beside its English twin. Copy the reasoning, not the wording.

The sender's own place:
  "In" -> self_att
  "var" -> self_att
  "varım" -> self_att
  "I'm not playing" -> self_att
  "yok" -> self_att
  "yokum" -> self_att
  "gelemiyorum" -> self_att
  "Bench" -> self_att
  "I can't join due to work n dint bring kit" -> self_att
  "Not this week lads, back after my holiday" -> self_att
  "@Ehtisham Ul Haq in sha Allah I'll play" -> self_att
  "I can play @Kemal, your bot is spamming me" -> self_att
  "@Youssef can you take me off the list" -> self_att
  "ignore my last message, I am in after all" -> self_att

Somebody else's place, however it is addressed:
  "@Kojo IN" -> other_att
  "@Ali var" -> other_att
  "Baki OUT" -> other_att
  "Veli yok" -> other_att
  "@Youssef is IN" -> other_att
  "@Match Time Kojo IN, Aaron IN" -> other_att
  "Talha is coming please add him" -> other_att
  "Ali de geliyor" -> other_att
  "Sam can't make it tonight" -> other_att
  "Mehmet gelemiyor" -> other_att
  "Najib said in as well so we should be at 13 players" -> other_att
  "Add these 2 boys pl" -> other_att
  "Rashad my cousin to add if poss" -> other_att
  "@Kemal can you switch it to 7 a side and put Amir in as the 14th" -> other_att

Replacements and corrections:
  "Hi guys, Mojib is replacing Najib on the list. We can change" -> other_att
  "Mojib, Najib'in yerine geliyor" -> other_att
  "Najib is out, Mojib is in" -> other_att
  "Najib çıkıyor, Mojib giriyor" -> other_att
  "Amir in for Zeeshan" -> other_att
  "Zair takes Abid's place tonight" -> other_att
  "@Match Time move @Aydin from bench to squad to replace @Ehtisham" -> other_att
  "Sorry, I got it wrong, it should be Zair not Baki" -> other_att
  "I'm covering for two people, Ismail and Ozgur" -> other_att

Maybe and if needed:
  "Hey gents, I am in just in case someone drops." -> offer
  "belki" -> offer
  "Lemme know if we need more to make it 14. I can find another" -> offer
  "@Kemal my brother can play if needed" -> offer
  "Will confirm shortly" -> unsure

Asking for a player: the group is attendance, MatchTime is admin_ops:
  "We need one more player guys, anyone interested?" -> offer
  "bir kişi eksik, gelmek isteyen var mı?" -> offer
  "great bunch of lads, same standard as us, come on, one player please" -> offer
  "@Match Time we're one short tonight, who fancies it?" -> offer
  "@Match Time bu akşam bir kişi eksiğiz, kim gelmek ister?" -> offer
  "Hi guys, does anyone wants to take my place for tonight?" -> other_att
  "@all we need one more player otherwise Salman will move to squad from bench" -> other_att
  "@Match Time ask the player pool for one more" -> admin_ops
  "@Match Time oyuncu havuzundan birini çağır" -> admin_ops
  "@Match Time ask Sutton if anyone can play" -> admin_ops
  "@Match Time diğer kulüplere sor" -> admin_ops
  "@Match Time get us players from the partner clubs and the pool" -> admin_ops
  "@Match Time we're short, find us someone" -> admin_ops
  "@Match Time eksiğiz, birini bul" -> admin_ops

A tagged message asks the bot, however short:
  "@Match Time Burak's chemistry" -> question
  "@Match Time Ali'nin kimyası" -> question
  "@Match Time my stats" -> question
  "@Match Time istatistiklerim" -> question
  "@Match Time who's top" -> question
  "@Match Time wrapped" -> question
  "@Match Time cheers 👍" -> none

Replies, read against the message they quote:
  "Bench? We do bench now?" replying to MatchTime's "the bench is open, say IN to go on the bench" -> question
  "yedek ne demek?" replying to that post -> question
  "IN" replying to that post, or to an older squad list of MatchTime's -> self_att
  "same" / "ben de" replying to a member's "IN" -> self_att
  "he's out" replying to Ali's message -> other_att
  "no, it was 7-5 to yellow" / "hayır, 7-5 sarılar" replying to MatchTime's result -> score
  "😂" replying to MatchTime, or "haha same" replying to a member's joke -> none

Questions about the squad, the matches and the club:
  "@Match Time how many players so far?" -> question
  "kaç kişiyiz?" -> question
  "Pitch number ?" -> question
  "Where is my name?" -> question
  "MatchTime who runs this club?" -> question

The two teams: seeing or making them is balancer, asking when or how they are made is question:
  "Teams?" -> balancer
  "@Match Time takımları göster" -> balancer
  "@Match Time regenerate the teams once more" -> balancer
  "@Match Time generate the teams, put me and David together" -> balancer
  "@Match Time swap David and Abid" -> balancer
  "Ali ile Can'ı değiştir" -> balancer
  "@Match Time swap the colours" -> balancer
  "@Match Time clear the teams" -> balancer
  "@Match Time takımları sil" -> balancer
  "@Match Time what time do the teams come out?" -> question
  "@Match Time takımlar saat kaçta açıklanıyor?" -> question

Results:
  "5-3 to Yellows" -> score
  "10-10" -> score
  "Arsenal 2 Spurs 1" -> none

Instructions to the bot:
  "remind me on Tuesday morning at 9am instead please" -> admin_ops
  "@Match Time DM me the link for switching to 7aside" -> admin_ops

Chat between members, not for the bot:
  "Are you injured ?" -> none
  "Are you available to play @Enayem ?" -> none
  "@Youssef @Ehtisham , Talha is coming, right?" -> none
  "Oops, didn't realise @Mojib Jalali is in" -> none
  "I think we are still waiting for the poll result." -> none
  "his chemistry with that ball is zero" -> none
  "Crazy statistics" -> none
  "wait guys sorry by mistake I enabled the tracking of squad in Match Time" -> none
  "hadi be ya 😂😂" -> none
  "dünkü maç efsaneydi" -> none

In the organisers' group:
  "looks good, go" (teams waiting for approval) -> approve
  "tamam onaylıyorum" (teams waiting for approval) -> approve
  "can you do the poster for this week" -> poster
  "send us the team sheet image" -> team_sheet
  "we're one short, can you find us a player" -> ask_group
  "ana gruba sorar mısın, gelebilecek var mı" -> ask_group
  "I'll ask the lads in the group later" -> none
  "the teams look a bit uneven, what do you reckon?" -> none
Calling a match off in the organisers' group, and putting it back on:
  "Cancel the session" -> admin_ops
  "maçı iptal et" -> admin_ops
  "storm, no game Friday" -> admin_ops
  "bu hafta maç yok" -> admin_ops
  "it's back on, uncancel Friday" -> admin_ops
  "maç yapılıyor, iptali geri al" -> admin_ops
  "with this storm the session should be cancelled anyway" -> none
Asking MatchTime what it can do, against telling the others about it:
  "@Match Time what can you do?" -> help
  "neler yapabiliyorsun?" -> help
  "once it's enabled, tag @Match Time here and ask it to cancel, and it will cancel the next match" -> none
  "MatchTime'ı etiketleyip iptal et derseniz maçı iptal eder" -> none

THE ANSWER. For every id give its route and two facts about the message; neither changes the route.
to_bot       true when the message speaks TO MatchTime as question 2 defines it (a tag, the bot's name used to speak to it, or a players' group reply to MatchTime's own message); false when it only talks about MatchTime or does not mention it at all.
pasted_list  true when the message reposts the squad as a list of players, one name a line, numbered or not, the roster other_att defines (often MatchTime's own list copied with a name added); false for anything else, including a sentence that names a few players.
Return JSON only: {"routes":[{"id":"<id>","route":"<route>","to_bot":<true or false>,"pasted_list":<true or false>}]}`;

// Room for adaptive thinking on top of the routes: one message at medium
// effort used up to 520 output tokens (2026-10-19); a batch of eight needs
// more. Clamped to PIPELINE_MAX_TOKENS_CEILING in llm.ts regardless.
const ROUTER_MAX_TOKENS = 2_048;

const VALID: Record<string, Route> = {
  none: "none",
  self_att: "self_att",
  other_att: "other_att",
  offer: "offer",
  question: "question",
  balancer: "balancer",
  score: "score",
  admin_ops: "admin_ops",
  unsure: "unsure",
  // The organisers' group only (2026-10-16). `parseRouterResponse` reads
  // any of these on a players' group message as `unsure`.
  approve: "approve",
  poster: "poster",
  team_sheet: "team_sheet",
  help: "help",
  ask_group: "ask_group",
  // Aliases. §6.1's unfixed prototype failure was "move Mustafa to the
  // bench" routing `team_ops` 3/3 because "bench" reads as team-shaped
  // vocabulary; the doc's own remedy is to rename it and add a lineup
  // route. `lineup_ops` collapses to `other_att` so the engine never
  // grows a second attendance path with its own capacity rules.
  lineup_ops: "other_att",
  team_ops: "balancer",
};

export function normaliseRoute(raw: string): Route | null {
  return VALID[(raw ?? "").trim().toLowerCase()] ?? null;
}

export interface RouterMessage {
  id: string;
  authorName: string | null;
  body: string;
  /**
   * Set for a message from a club's ORGANISERS' (admin) group, 2026-10-16:
   * the lines shown above it (what MatchTime is waiting to hear, the
   * message it replies to, the last few messages there). Absent for the
   * players' group, whose user turn is byte-for-byte what it always was.
   */
  organisers?: {
    context: string[];
    /**
     * Whether the sender is an owner or admin of the club, as code knows it
     * (`AdminGroupInput.organiser`). Players can be in the organisers'
     * group too (2026-10-20), so the header states this fact instead of
     * assuming it. Absent: the header says nothing about the sender.
     */
    senderIsOrganiser?: boolean;
  };
  /**
   * The club's active partner clubs' names (cross-club ask, slice S6,
   * 2026-10-21): a players' group message from an owner or admin of a
   * club with an active partner is shown `partnerClubsLine`. Ignored for
   * the organisers' group, whose turn is unchanged: there the ask_group
   * route reads the club named (`admin-group-understand.ts`). Absent
   * everywhere else, so those turns are byte for byte what they were.
   */
  partnerClubs?: string[];
  /**
   * The message this one is a WhatsApp reply to, WHOEVER wrote it
   * (quoted-reply context, slice S4, 2026-10-20; replaces the 2026-10-16
   * `quotedMatchTime`, which only ever showed MatchTime's own posts).
   * Resolved by `loadGroupReplyContexts` (`reply-context.ts`) and shown
   * above the message in the DM block's wording (`quotedLines`), in both
   * groups. A reply to MatchTime is still a tag in CODE
   * (`messageTagsBot`, from the Pi's `quotedFromMatchTime`); the lines
   * let the model read the reply against what it quotes. Absent for a
   * message that is not a reply.
   */
  reply?: ContextMessage | null;
  /**
   * MatchTime asked this sender "who do you mean?" about their stats
   * question (`StatsClarification`), and this is that original question,
   * verbatim. Shown as the `clarificationLine` above the message, so the
   * model reads a reply that names somebody as the answer (2026-10-30;
   * replaces the `clarificationSubject` word test). Set by `routeBatch`
   * from `RouteBatchOptions.clarifications`; absent otherwise.
   */
  clarifying?: string;
  /**
   * A score fact about this sender, shown as `scoreContextLine` above the
   * message (2026-10-30): MatchTime is waiting for them to say which team
   * won (`which_team`), or a result is recorded that they may correct
   * (`recorded`). Set by `routeBatch` from `scoreAnswerIds` and
   * `scoreCorrectionIds`.
   */
  score?: "which_team" | "recorded";
}

/** The line above a message carrying a score fact (`RouterMessage.score`). */
export function scoreContextLine(kind: "which_team" | "recorded"): string {
  return kind === "which_team"
    ? "MATCHTIME IS WAITING to hear from this sender which team won the scoreline it asked about."
    : "MATCHTIME HAS RECORDED the latest game's result, and this sender may correct it.";
}

/** The line above a message from somebody MatchTime asked "who do you
 *  mean?" (see `RouterMessage.clarifying`). */
export function clarificationLine(question: string): string {
  return `MATCHTIME ASKED this sender whom they meant in their earlier question: "${question}"`;
}

/**
 * The header an organisers' group message is shown under.
 *
 * FREE PLACES (2026-10-16) are given only in the organisers' group
 * ("Bilal washed the bibs, he's free this week", `fee-waiver.ts`), so the
 * one sentence the router needs for them is HERE, in the HQ user turn, and
 * not in `ROUTER_SYSTEM_PROMPT`. Measured on the dev key: a single
 * free-place sentence in the system prompt, even inside its organisers'
 * section, turned the players' group's "@Match Time Ali is free this week,
 * add him" from other_att (6 of 6 message ids) to admin_ops (5 of 6). Here
 * the players' group's prompt and user turn stay byte for byte what they
 * were, and the system prompt keeps its size (3,922 tokens).
 *
 * Its last sentence is load-bearing too (review round, 2026-10-16): with
 * the free-place sentence alone, HQ's "we need one more, does anyone know
 * someone?" (organisers asking each other, none) went ask_group in 1 of 5
 * tries, and in 4 of 5 under a wording that led with "admin_ops"; with
 * "Nothing else changes: ..." it is none 5 of 5, and "we're short, can you
 * put a message out in the group" stays ask_group 5 of 5.
 *
 */
export function organisersHeader(senderIsOrganiser?: boolean): string {
  const who =
    senderIsOrganiser === true
      ? " The sender is an organiser of the club."
      : senderIsOrganiser === false
        ? " The sender is a member of the club, not an organiser."
        : "";
  return `ORGANISERS' GROUP.${who} Here, saying a named player owes nothing for the match, a free place ("he's free this week, he did the bibs", "no fee for him", "ödemesin"), or taking one back ("he pays after all", "ücretsiz değil"), is admin_ops, tagged or not. Free as in able to play ("he's free, add him") is other_att. Nothing else changes: a shortage or a question put to the other organisers is still none.`;
}

/**
 * The line a players' group message from an owner or admin is shown under
 * when the club has active partner clubs (slice S6, 2026-10-21). CONTEXT,
 * the facts the code has, in the user turn: the router's system prompt is
 * unchanged, and every other players' group turn is byte for byte what it
 * was. Measured on the dev key before it: "@Match Time ask Friday MT
 * Community if anyone can play" routed offer, so it never reached the admin
 * extractor that reads the club's name. Its last sentence is load-bearing
 * (10 runs each, dev key): a shorter line pulled "@Match Time we need one
 * more, anyone?" from offer 10 of 10 to 6 of 10 and "@Match Time we're
 * short, find us a player" to admin_ops 8 of 10; with it, offer 10 of 10
 * for both, and the asks to another club admin_ops 10 of 10. (The
 * organisers' group's turn is unchanged: its ask_group route reads the
 * club named with the admin extractor, `admin-group-understand.ts`.)
 *
 * 2026-10-29: THE LINE IS ONLY THE FACT NOW. Its rule (telling the bot to
 * ask another club is admin_ops, asking this group is not) moved into the
 * system prompt, where telling MatchTime to find players from anywhere
 * (the pool, a partner club, both, or no place named) is defined once
 * under admin_ops and the boundary with asking the group is one ruling.
 * The line keeps only what code knows: the partners' names.
 */
export function partnerClubsLine(names: string[]): string {
  return `PARTNER CLUBS of this club: ${names.join(", ")}.`;
}

/** How much of a quoted message the router is shown: enough to know what
 *  it was, as the 2026-10-16 line showed. The extractors see more. */
export const ROUTER_QUOTE_WORDS_MAX = 300;

/** The user turn: the time now (club time), then each message on its own
 *  line; an organisers' group message under its header and context lines;
 *  a reply under the lines naming the message it quotes (`quotedLines`,
 *  the one wording the DM classifiers and the extractors read too). */
export function renderRouterTurn(messages: RouterMessage[], now: Date = new Date()): string {
  const body = messages.map((m) => {
    const line = `[${m.id}] ${m.authorName ?? "(unknown)"}: ${m.body}`;
    const reply = m.reply ? quotedLines(m.reply, ROUTER_QUOTE_WORDS_MAX) : [];
    if (m.organisers) {
      const score = m.score ? [scoreContextLine(m.score)] : [];
      return [organisersHeader(m.organisers.senderIsOrganiser), ...m.organisers.context, ...score, ...reply, line].join("\n");
    }
    const partners = m.partnerClubs && m.partnerClubs.length > 0 ? [partnerClubsLine(m.partnerClubs)] : [];
    const asked = m.clarifying ? [clarificationLine(m.clarifying)] : [];
    const score = m.score ? [scoreContextLine(m.score)] : [];
    return [...partners, ...asked, ...score, ...reply, line].join("\n");
  });
  return [nowLine(now), ...body].join("\n");
}

export interface RouterResult {
  routes: RoutedMessage[];
  degradations: Degradation[];
  usage?: { costUsd: number | null; ms: number; inputTokens: number; outputTokens: number };
}

/**
 * THE MODEL NEVER SEES A WHATSAPP ID (FNF HQ, 2026-10-17/18). A WhatsApp
 * id is ~80 characters ("false_1203...@g.us_AC59...DA1_8948...@lid"), and
 * the model copying it back miscopied it three times in two days: the
 * turn's square brackets kept, one character changed, "B03" written twice.
 * Each time the route was dropped as an unknown id and the message fell
 * back to `unsure` ("@Match Time what is squad now including bench?" got
 * "I didn't catch that"). So each message in a batch is shown, and
 * answered, as its position: m1, m2, ... and the code maps them back.
 */
export function shortRouterIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `m${i + 1}`);
}

/** An id as the model returned it: the turn's square brackets and spaces trimmed. */
function cleanId(id: string): string {
  return id.trim().replace(/^\[\s*/, "").replace(/\s*\]$/, "");
}

export function parseRouterResponse(text: string, ids: string[], organiserIds: ReadonlySet<string> = new Set()): RouterResult {
  const degradations: Degradation[] = [];
  const byId = new Map<string, Route>();
  /** The model's own reading of who each message speaks to (`to_bot`). */
  const toBot = new Set<string>();
  /** The model's reading that the message reposts the squad list (`pasted_list`). */
  const pastedList = new Set<string>();

  try {
    const parsed = extractJson(text) as { routes?: Array<{ id?: unknown; route?: unknown }> };
    const rows = Array.isArray(parsed?.routes) ? parsed.routes : [];
    for (const row of rows as Array<{ id?: unknown; route?: unknown; to_bot?: unknown; pasted_list?: unknown }>) {
      const id = typeof row?.id === "string" ? cleanId(row.id) : null;
      const route = typeof row?.route === "string" ? normaliseRoute(row.route) : null;
      if (!id) continue;
      if (ids.includes(id) && row.to_bot === true) toBot.add(id);
      if (ids.includes(id) && row.pasted_list === true) pastedList.add(id);
      if (!ids.includes(id)) {
        degradations.push(
          degradation("router", null, `router returned an unknown id "${id}"; dropped`),
        );
        continue;
      }
      if (!route) {
        degradations.push(
          degradation("router", id, `router returned an unknown route "${String(row.route)}"`),
        );
        continue;
      }
      if (route === "help" && !organiserIds.has(id)) {
        // Asking MatchTime what it can do, in the players' group: there it
        // is a how-it-works question, which the question extractor reads
        // (2026-10-28). Never `unsure`: that reaches the attendance reader.
        degradations.push(degradation("router", id, `router gave the organisers' route "help" to a players' group message; question`));
        byId.set(id, "question");
        continue;
      }
      if (ORGANISER_ONLY_ROUTES.includes(route) && !organiserIds.has(id)) {
        // An organisers' group route on a players' group message: the
        // same bias toward action as a missing route.
        degradations.push(degradation("router", id, `router gave the organisers' route "${route}" to a players' group message; unsure`));
        byId.set(id, "unsure");
        continue;
      }
      byId.set(id, route);
    }
  } catch (err) {
    degradations.push(
      degradation("router", null, `router output could not be parsed: ${(err as Error).message}`),
    );
  }

  const routes: RoutedMessage[] = ids.map((id) => {
    const route = byId.get(id);
    if (route) {
      return {
        messageId: id,
        route,
        source: "model" as const,
        ...(toBot.has(id) ? { toBot: true } : {}),
        ...(pastedList.has(id) ? { pastedList: true } : {}),
      };
    }
    // §3.2 S1's incident, and §11.1's asymmetry. A missing route is a
    // coverage hole; filling it with `none` would make that hole look
    // like a decision.
    degradations.push(degradation("router", id, `router returned no route; defaulting to unsure`));
    return { messageId: id, route: "unsure" as const, source: "fallback" as const };
  });

  return { routes, degradations };
}

export interface RouteBatchOptions {
  /**
   * IGNORED. The deterministic floor this switched was removed on
   * 2026-10-30 ("no string parsing"); the field stays only so callers
   * outside the pipeline package (scripts, other packages' tests) compile
   * until they drop it.
   */
  floor?: boolean;
  /**
   * THE QUESTION MATCHTIME IS STILL WAITING FOR AN ANSWER TO, if any.
   *
   * PR #42's release condition: two of 1,695 production messages are an
   * attendance write the gate would have lost, and both are a bare `👍`
   * answering a slot MatchTime had left open. A `👍` pattern in the
   * floor cannot fix that without firing on every thumbs-up in the group
   * — the floor becoming a classifier again. So the fix is CONTEXT: a
   * row saying MatchTime asked something and has not been answered.
   *
   * Loaded deterministically by `loadAwaitingQuestions`; never inferred
   * and never asked of the model. Null (the default) is the entire
   * history bar 18 windows, and with it nothing here changes anything.
   */
  awaiting?: AwaitingQuestion | null;
  /**
   * The "who do you mean?" questions MatchTime has put to individual
   * posters about a stats question (2026-09-23). See the essay at the
   * foot of `awaiting-answer.ts`. Empty or absent, the default, and
   * nothing below changes anything.
   */
  clarifications?: StatsClarification[];
  /**
   * Messages from somebody who may answer MatchTime's open "which team
   * won?" (`isScoreAnswer`, facts only). Shown the `scoreContextLine`
   * "which team won" line; the model routes them (2026-10-30: until then
   * they were forced to `score` by a word test). Empty almost always.
   */
  scoreAnswerIds?: ReadonlySet<string>;
  /**
   * Tagged messages while the latest played match has a recorded result
   * this sender may correct (facts only). Shown the "recorded" line; the
   * model routes them.
   */
  scoreCorrectionIds?: ReadonlySet<string>;
  /**
   * The club is at its daily AI cap (`ai-budget.ts`). The router is still
   * asked, inside `withAttendanceOverflow` (a ceiling of twice the cap),
   * and only its attendance routes are kept: everything else becomes
   * `none` with source `capped`, counted and not handled. Beyond twice the
   * cap nothing is read and every message is `capped`.
   */
  capped?: boolean;
  /** The time the turn's NOW line states (club time). Defaults to now. */
  now?: Date;
}

/** The routes the engine's attendance owner reads; at the cap these are
 *  the only ones still handled. Mirrors `gate.ts`'s `ENGINE_ROUTES`. */
const ATTENDANCE_ROUTES: readonly Route[] = ["self_att", "other_att", "offer", "unsure"];

/** Every message `none` with source `capped`: nothing was read. */
function cappedRoutes(messages: RouterMessage[], why: string): RouterResult {
  return {
    routes: messages.map((m) => ({ messageId: m.id, route: "none" as const, source: "capped" as const })),
    degradations: messages.map((m) => degradation("router", m.id, `${why}; not read`)),
  };
}

/**
 * AT THE CAP ONLY ATTENDANCE IS HANDLED (2026-10-30). The router read the
 * message (inside `withAttendanceOverflow`); a route the attendance engine
 * owns stands, and the model's own `none` stays a model `none` (banter is
 * not a message the cap cost anybody). Every other route becomes `none`
 * with source `capped`: the analyze route counts those on the owner's
 * dashboard and gives the first tagged one the day's polite line.
 */
function attendanceOnly(routes: RoutedMessage[], degradations: Degradation[]): RoutedMessage[] {
  return routes.map((r) => {
    if (r.route === "none" || ATTENDANCE_ROUTES.includes(r.route)) return r;
    degradations.push(degradation("router", r.messageId, `${r.route} at the daily AI cap; not handled`));
    return { ...r, route: "none" as const, source: "capped" as const, overrodeRoute: r.route };
  });
}

export async function routeBatch(
  model: PipelineModel,
  messages: RouterMessage[],
  opts: RouteBatchOptions = {},
): Promise<RouterResult> {
  return routeBatchInner(model, messages, opts);
}

async function routeBatchInner(
  model: PipelineModel,
  messages: RouterMessage[],
  opts: RouteBatchOptions,
): Promise<RouterResult> {
  if (messages.length === 0) return { routes: [], degradations: [] };

  const ids = messages.map((m) => m.id);
  // The model is shown, and answers with, m1, m2, ... never the WhatsApp
  // ids (`shortRouterIds`). Mapped back to the real ids right after parsing.
  const shortIds = shortRouterIds(messages.length);
  const realOf = new Map(shortIds.map((s, i) => [s, ids[i]]));
  // The sender MatchTime asked "who do you mean?" sees that question above
  // their message (`clarificationLine`); the model decides whether the
  // message answers it. Matched on the sender, a fact.
  const clarifyingFor = (m: RouterMessage) =>
    (opts.clarifications ?? []).find((q) => !!q.askerName && q.askerName === m.authorName)?.questionBody;
  const scoreFact = (m: RouterMessage): RouterMessage["score"] =>
    opts.scoreAnswerIds?.has(m.id) ? "which_team" : opts.scoreCorrectionIds?.has(m.id) ? "recorded" : undefined;
  const user = renderRouterTurn(
    messages.map((m, i) => {
      const q = clarifyingFor(m);
      const score = scoreFact(m);
      return { ...m, id: shortIds[i], ...(q ? { clarifying: q } : {}), ...(score ? { score } : {}) };
    }),
    opts.now ?? new Date(),
  );

  const req: ModelRequest = {
    model: ROUTER_MODEL,
    system: ROUTER_SYSTEM_PROMPT,
    user,
    maxTokens: ROUTER_MAX_TOKENS,
    // Haiku 5.5 is more accurate here thinking than not (HAIKU_EFFORT).
    thinking: { effort: HAIKU_EFFORT },
    label: "router",
    shortIds: Object.fromEntries(realOf),
    schema: {
      type: "object",
      properties: {
        routes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              route: { type: "string", enum: Object.keys(VALID) },
              to_bot: { type: "boolean" },
              pasted_list: { type: "boolean" },
            },
            required: ["id", "route", "to_bot", "pasted_list"],
            additionalProperties: false,
          },
        },
      },
      required: ["routes"],
      additionalProperties: false,
    },
  };

  // ── THE DAILY AI CAP (2026-09-29; no floor since 2026-10-30) ─────────
  //
  // At the cap, known up front (`opts.capped`) or found when this call is
  // refused (a concurrent request spent the rest), the router is still
  // asked, inside `withAttendanceOverflow`: a ceiling of twice the cap.
  // Only its attendance routes are then kept (`attendanceOnly`). Beyond
  // twice the cap nothing is read and every message is `capped`. No regex
  // reads a message in its place.
  let atCap = opts.capped === true;
  const ask = () => (atCap ? withAttendanceOverflow(() => model.complete(req)) : model.complete(req));

  let result: RouterResult;
  let usage: RouterResult["usage"];
  try {
    let resp;
    try {
      resp = await ask();
    } catch (err) {
      if (!isAiBudgetExceeded(err) || atCap) throw err;
      atCap = true;
      resp = await ask();
    }
    const parsed = parseRouterResponse(resp.text, shortIds, new Set(shortIds.filter((_, i) => messages[i].organisers)));
    const real = (id: string | null) => (id === null ? null : (realOf.get(id) ?? id));
    result = {
      routes: parsed.routes.map((r) => ({ ...r, messageId: real(r.messageId)! })),
      degradations: parsed.degradations.map((d) => ({ ...d, messageId: real(d.messageId) })),
    };
    usage = {
      costUsd: resp.costUsd,
      ms: resp.ms,
      inputTokens: resp.usage.inputTokens + resp.usage.cacheReadTokens,
      outputTokens: resp.usage.outputTokens,
    };
  } catch (err) {
    if (isAiBudgetExceeded(err)) {
      return cappedRoutes(messages, "the club is past twice its daily AI cap");
    }
    // §11.4: on router failure, route EVERYTHING to the attendance
    // extractor. Expensive, correct, and self-limiting because batches
    // are small. The alternative — routing everything to `none` — is
    // the silent failure this whole design exists to remove. (`unsure`
    // is an engine route, `gate.ts`'s `ENGINE_ROUTES`; do not remove it
    // from that list without reading this.) At the cap the extractor is
    // read inside the same overflow ceiling.
    result = {
      routes: ids.map((id) => ({ messageId: id, route: "unsure" as const, source: "fallback" as const })),
      degradations: [
        degradation(
          "router",
          null,
          `router call failed (${(err as Error).message}); routing the whole batch to the extractor`,
        ),
      ],
    };
  }

  // ── WHILE MATCHTIME IS WAITING FOR AN ANSWER, `none` IS NOT TRUSTED ──
  //
  // The gap PR #42 measured: two of 1,695 real messages are an attendance
  // write the gate would lose, and both are a bare `👍` answering a slot
  // MatchTime had left open. This reads nothing out of the message; it
  // reads a ROW (`awaiting-answer.ts`), so it cannot fire on a thumbs-up in
  // a group MatchTime has asked nothing of. It only ever rewrites `none`,
  // so it can add an extractor call and never remove one. A `fallback`
  // route is left alone: the batch is already going to the extractor.
  const awaiting = opts.awaiting ?? null;
  const routes = !awaiting
    ? result.routes
    : result.routes.map((r) => {
        if (r.route !== "none" || r.source === "fallback") return r;
        result.degradations.push(
          degradation(
            "router",
            r.messageId,
            `MatchTime is still waiting for an answer (${describeQuestion(awaiting)}); ` +
              `none → unsure so the attendance engine still sees it`,
          ),
        );
        return { ...r, route: "unsure" as const, source: "awaiting" as const, overrodeRoute: "none" as const };
      });

  // A reply to MatchTime's "who do you mean?" is routed by the model, which
  // is shown the open question above the message (`clarificationLine`).
  // Until 2026-10-30 code moved such a reply to `question` whenever a word
  // test (`clarificationSubject`) called it a name; that test is gone.
  const finalRoutes = routes;

  const out = atCap ? attendanceOnly(finalRoutes, result.degradations) : finalRoutes;
  return { routes: out, degradations: result.degradations, usage };
}

/** Convenience for callers that do not inject a model. */
export function defaultRouterModel(): PipelineModel {
  return anthropicModel();
}
