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
import { messageTagsBot } from "../interaction-contract";
import {
  clarificationSubject,
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
import type { AttendanceFacts, Claim, Degradation, Route, RoutedMessage } from "./types";
import { ORGANISER_ONLY_ROUTES } from "./types";
import { isAiBudgetExceeded } from "../ai-budget-context";

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
 */
export const ROUTER_SYSTEM_PROMPT = `You are the front door of MatchTime, the bot that runs a football club's WhatsApp groups: the weekly squad, the two teams, results, payments, reminders and the players' stats. For EVERY message id you are given, return exactly one route: the part of MatchTime that handles the message, or none when it is chat between people and not for the bot.

WHAT YOU ARE SHOWN. Code knows these facts; rely on them rather than guessing.
- NOW: the date and time at the club.
- One line per message, "[m1] Name: text". Route every id; every other line is context.
- An "ORGANISERS' GROUP" header above a message: it was sent in the club's organisers' group, and the header says whether the sender is an organiser, what MatchTime is WAITING to hear and what was said there EARLIER. Without that header a message is from the PLAYERS' GROUP. Everything below applies to both groups; "IN THE ORGANISERS' GROUP" adds what differs there.
- A "PARTNER CLUBS" line: the club's partner clubs, and the one thing they change.

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
balancer    asks to SEE or MAKE the TWO team line-ups (red and yellow): show, generate, shuffle or rename them.
score       reports the final result of this group's own match (our team names, our colours or a bare scoreline), or answers who was its Man of the Match while MatchTime is WAITING for that (praise alone answers nothing). A professional scoreline somebody is watching is none.
admin_ops   tells the bot to do something now: credit a payment, set a reminder, send a link, change a setting, call a match off (one still to come, or one that never took place) or put it back on. Talk ABOUT the bot, settings, the pitch or money owed between members, and plans the sender will carry out ("I will change it to 7aside", "matchtime should suggest 5aside"), are none: admin_ops needs somebody telling the BOT to act now.
none        everything else, as in question 3. A member asking another member something that settles nothing is none ("are you injured?", "which two of you can play tomorrow?"); as soon as a message STATES that somebody plays or does not, it is attendance.
approve, poster, team_sheet, help and ask_group exist ONLY in the organisers' group; see that section.

RULINGS. Each one settles a confusion that has really happened in a group.
- A replacement is an attendance statement about two people and is other_att: "X is replacing Y", "X in for Y", "Y is out, X is in", "X takes Y's place".
- Asking the group for a player is attendance, not question, question mark or not: "anyone able to replace me?", "anyone else want to join us?", "can we have more INs please?". It is other_att when a named or implied person is leaving, otherwise offer. The ask is often buried in praise, worry or a pitch, and that changes nothing.
- ASKING is question; INSTRUCTING is admin_ops. "Amir paid for 4 players" and "remind me on Monday" tell the bot to do something: admin_ops. "Who hasn't paid?" asks for what the bot knows: question.
- Asking to SEE the squad ("who's in?", "list the players") is question. Asking to SEE or MAKE the teams ("teams?", "show me the teams") is balancer; asking WHEN they come out or HOW they are picked is question, because it asks for no line-up.
- A match already played: asking about it ("did we win on tuesday?") is question; reporting its result ("we won 5-3") is score; telling the bot it never took place ("@Match Time Tuesday's game didn't happen", "@Match Time dünkü maç oynanmadı") is admin_ops, because it calls that game off. A question mark alone does not make a question.

IN THE ORGANISERS' GROUP. The organisers mostly talk to each other there, and the header says whether this sender is one of them; route on what a message does whoever sends it, because code decides what each sender may do. Question 1 still comes first and is never none: a message saying a player is in, out, can or cannot play ("Tom out", "put Bilal in", "Shehryar can't make it tonight") changes the squad, other_att, however chatty. Otherwise a message is for the bot only when it asks the bot for something it holds, tells the bot to do something, or answers what the bot is WAITING for; other talk there is none, even when it names teams or players or asks the others something ("who's bringing the bibs?"), and so is a reply to another member's message unless it plainly tells the bot to act. Moving or swapping players between the two teams is balancer there, not attendance, because nobody joins or leaves: "swap Ali and Can", "move Tom to the other team", "put Sam in yellow".
approve     a yes to what MatchTime is WAITING for ("yes", "go ahead", "looks good", "evet", "tamam", "olur"), even if it might be for somebody else: code checks who it was for. With nothing waiting, it is none.
poster      asks for the squad list as an image or graphic to share.
team_sheet  asks for the teams as an image or graphic to share. A bare "teams" asks to see them: balancer.
help        asks MatchTime what it can do here, or how to get it to do something: there, that is help, not question. Telling the others what MatchTime does or will do asks it nothing, tagged or not: none.
ask_group   tells the bot to find a player, or to ask the players' group whether anyone can play. Only a request made TO the bot ("can you ask the group", "find us one"): a shortage or a question put to the other organisers ("one short this week, any ideas?", "anyone got a mate who can play?"), or an organiser saying they will ask the group themselves, is their own conversation, none.

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

Replacements, swaps and corrections:
  "Hi guys, Mojib is replacing Najib on the list. We can change" -> other_att
  "Mojib, Najib'in yerine geliyor" -> other_att
  "Najib is out, Mojib is in" -> other_att
  "Najib çıkıyor, Mojib giriyor" -> other_att
  "Amir in for Zeeshan" -> other_att
  "Zair takes Abid's place tonight" -> other_att
  "@Match Time move @Aydin from bench to squad to replace @Ehtisham" -> other_att
  "@Match Time swap David and Abid" -> other_att
  "Sorry, I got it wrong, it should be Zair not Baki" -> other_att
  "I'm covering for two people, Ismail and Ozgur" -> other_att

Maybe, if needed, and asking the group for a player:
  "Hey gents, I am in just in case someone drops." -> offer
  "belki" -> offer
  "Lemme know if we need more to make it 14. I can find another" -> offer
  "@Kemal my brother can play if needed" -> offer
  "We need one more player guys, anyone interested?" -> offer
  "great bunch of lads, same standard as us, come on, one player please" -> offer
  "Hi guys, does anyone wants to take my place for tonight?" -> other_att
  "@all we need one more player otherwise Salman will move to squad from bench" -> other_att
  "Will confirm shortly" -> unsure

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
  "Ali ile Can'ı değiştir" -> balancer
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

Return JSON only: {"routes":[{"id":"<id>","route":"<route>"}]}`;

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

/**
 * THE DETERMINISTIC FLOOR. Twenty lines, anchored at both ends, and it
 * only ever claims a message that is ENTIRELY a bare self-attendance
 * token. "Zeeshan is out 😂" and "I was in last week" must not match, so
 * everything except the token, optional punctuation and an emoji is a
 * disqualifier.
 */
const FLOOR_IN = /^(?:i\s*'?a?m|i\s+am|im)?\s*(?:in|innn+)\b/i;
const FLOOR_OUT = /^(?:i\s*'?a?m|i\s+am|im)?\s*(?:out|can'?t\s+make\s+it)\b/i;
/**
 * THE SAME FLOOR IN TURKISH (2026-09-16, Erdal's group). "var" / "varım"
 * / "ben varım" is a bare "in"; "yok" / "yokum" / "ben yokum" /
 * "gelemiyorum" is a bare "out". `MDs/second-group-readiness-erdal-
 * 2026-09-16.md` §2 measured the router losing all three bare forms
 * 30 of 30 — silently, `none`, no write, no react — which is the exact
 * failure this floor exists for. Vocabulary only: the flag, the tail
 * rule and the one-way property are untouched.
 *
 * NOT `\b`: JavaScript's `\b` is ASCII-only, so `var\b` matches INSIDE
 * "varım" (ı is not a `\w`), and the loop below would then reject the
 * tail "ım" and call "varım" a sentence. The end of a Turkish token is
 * "not followed by a letter" instead. `[ıi]` because the dotless ı is
 * typed as a plain i from an English keyboard, and `/i` folds I to i.
 */
const FLOOR_IN_TR = /^(?:ben\s+)?(?:var[ıi]m|var)(?!\p{L})/iu;
const FLOOR_OUT_TR = /^(?:ben\s+)?(?:yokum|yok|gelemiyorum)(?!\p{L})/iu;
/**
 * ⚠️ "+1" IS NOT IN THE FLOOR, deliberately.
 *
 * The first cut force-routed it `self_att`, which is the wrong subject:
 * "+1" offers a GUEST, not the sender. The self extractor would then
 * produce a sender claim, the guest would be lost, and PR #29's
 * name-ask — the whole point of which is that an unnamed guest gets a
 * question rather than a ghost user — would be bypassed on the single
 * most common way to offer one. `guest-name-ask.ts` already classifies
 * `+N` as a placeholder guest, so the rest of the codebase agrees.
 * The router decides this one.
 */
/**
 * ONE CHARACTER OF AN EMOJI SEQUENCE (2026-09-24). The pictograph itself
 * plus everything a sequence is built from: skin tones, regional
 * indicators (flags), U+200D (the ZWJ in "🤷‍♂️", a format character),
 * U+FE0F (the variation selector in "✌️", a nonspacing mark, so `\p{S}`
 * alone missed both), the keycap U+20E3 and the tag characters of the
 * subdivision flags ("🏴󠁧󠁢󠁥󠁮󠁧󠁿"). NOT `\p{Emoji_Component}`: that property
 * includes the digits 0-9, and "in 20" is a sentence.
 */
const EMOJI_CHAR =
  "\\p{Extended_Pictographic}\\p{Emoji_Modifier}\\p{Regional_Indicator}\\u200D\\uFE0F\\u20E3\\u{E0020}-\\u{E007F}";
const EMOJI_RUN = new RegExp(`[${EMOJI_CHAR}]+`, "gu");

/** Anything left after the token that is not punctuation or an emoji
 *  means this is a sentence, not a bare declaration. */
const FLOOR_TAIL = new RegExp(`^[\\s\\p{P}\\p{S}${EMOJI_CHAR}]*$`, "u");

/**
 * The MENTION half of the floor: `@Someone in`, `@Zair Malik out`.
 *
 * Same shape as the bare self-attendance floor — a subject and a token,
 * nothing else — one route along. It exists because the live corpus
 * caught `@Ehtisham Ul Haq In` routed `none`, which is §11.1's failure
 * exactly: a real third-party registration gone with no write, no reply
 * and no signal.
 *
 * A mention of the BOT is never a player. Without that check
 * "@Match Time in" would try to register a member called "Match Time",
 * which is the ghost-user class of bug one layer up.
 */
const MENTION_TOKEN = new RegExp(`^@[\\p{L}\\d._'${EMOJI_CHAR}-]+`, "u");
/** A capitalised word after a mention is part of the mentioned display
 *  name ("@Ehtisham Ul Haq") — the Pi expands a mention to the display
 *  name. A lower-case word is the sentence starting, and ends the
 *  subject. An emoji is part of a name too, attached ("Jesse👑") or as a
 *  word of its own ("@Jesse 👑 IN"): it is never the sentence starting. */
const NAME_WORD = new RegExp(
  `^[${EMOJI_CHAR}]*(?:\\p{Lu}[\\p{L}'-]*)?[${EMOJI_CHAR}]*$`,
  "u",
);

export function routeFloor(body: string): Route | null {
  return parseFloor(body)?.route ?? null;
}

/**
 * What the floor read: the route, which way, and (for a mention) whose
 * names. One parser behind both `routeFloor` and `floorAttendanceFacts`,
 * so the two can never disagree about which messages are bare.
 */
interface FloorReading {
  route: "self_att" | "other_att";
  polarity: "in" | "out";
  /** The mentioned display names, verbatim, for `other_att`. */
  names: string[];
}

function parseFloor(body: string): FloorReading | null {
  const t = (body ?? "").trim();
  if (!t) return null;

  if (t.startsWith("@")) {
    // Never the bot. `messageTagsBot` is this project's one definition
    // of "this message tags MatchTime"; it is reused, not re-derived.
    if (messageTagsBot({ body: t })) return null;
    let rest = t;
    const names: string[] = [];
    for (;;) {
      const m = MENTION_TOKEN.exec(rest);
      if (!m) break;
      const words = [m[0].slice(1)];
      rest = rest.slice(m[0].length).trimStart();
      // Consume the rest of the mentioned display name.
      for (;;) {
        const word = rest.split(/\s+/)[0] ?? "";
        if (!word || !NAME_WORD.test(word) || isFloorToken(word)) break;
        words.push(word);
        rest = rest.slice(word.length).trimStart();
      }
      names.push(words.join(" "));
    }
    if (names.length === 0) return null;
    const polarity = bareDeclaration(rest);
    return polarity ? { route: "other_att", polarity, names } : null;
  }

  const polarity = bareDeclaration(t);
  return polarity ? { route: "self_att", polarity, names: [] } : null;
}

/**
 * THE FACTS A BARE DECLARATION STATES, READ WITHOUT A MODEL (2026-09-29).
 *
 * For the daily AI cap. Below the cap the floor only ROUTES a message and
 * the attendance extractor still reads it; at the cap there is no
 * extractor, and a bare "in" must still put the player in the squad. So
 * the floor states what it already proved about the text, as `Facts`,
 * and the engine decides exactly as it would on the extractor's answer.
 *
 * It claims no more than the floor does: ONLY a message that is entirely
 * a bare IN/OUT token (with optional mentions, punctuation and emoji).
 * "in if we get 10", "who's in?" and "in, bringing my brother" are null,
 * and at the cap they are simply not handled rather than guessed at.
 * Every field is what the words say: present tense, not contingent, a
 * decision, not reported, and a mention is a named person.
 */
export function floorAttendanceFacts(body: string): AttendanceFacts | null {
  const f = parseFloor(body);
  if (!f) return null;
  const claim = (subject: "sender" | "other", personRef: string): Claim => ({
    subject,
    personRef,
    personNamed: subject === "other",
    polarity: f.polarity,
    contingent: false,
    conditionOn: "none",
    tense: "present",
    basis: "decision",
    reported: false,
    confidence: 1,
    replaces: "",
  });
  return {
    kind: "attendance",
    claims: f.route === "self_att" ? [claim("sender", "")] : f.names.map((n) => claim("other", n)),
    affirmation: null,
    sideRequests: [],
  };
}

/** Is this single word one of the bare tokens the floor recognises? */
function isFloorToken(word: string): boolean {
  return /^(?:in|out|var|var[ıi]m|yok|yokum|gelemiyorum)$/iu.test(word.replace(/[^\p{L}]/gu, ""));
}

/** Is the whole of `t` a bare IN/OUT declaration and nothing else? Which
 *  way, or null. The length cap bounds the WORDS, so a run of emoji after
 *  "IN" never pushes a bare declaration over it. */
function bareDeclaration(t: string): "in" | "out" | null {
  if (!t || t.replace(EMOJI_RUN, "").length > 24) return null;
  for (const [re, polarity] of [
    [FLOOR_IN, "in"],
    [FLOOR_OUT, "out"],
    [FLOOR_IN_TR, "in"],
    [FLOOR_OUT_TR, "out"],
  ] as const) {
    const m = re.exec(t);
    if (!m) continue;
    return FLOOR_TAIL.test(t.slice(m[0].length)) ? polarity : null;
  }
  return null;
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
 */
export function partnerClubsLine(names: string[]): string {
  return `PARTNER CLUBS of this club: ${names.join(", ")}. A message naming one of them, or the partner clubs, other clubs or other groups, and telling the bot to ask them for a player, is admin_ops. Any other message, asking this group for a player included, is routed as if this line were not here.`;
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
    if (m.organisers) return [organisersHeader(m.organisers.senderIsOrganiser), ...m.organisers.context, ...reply, line].join("\n");
    const partners = m.partnerClubs && m.partnerClubs.length > 0 ? [partnerClubsLine(m.partnerClubs)] : [];
    return [...partners, ...reply, line].join("\n");
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

  try {
    const parsed = extractJson(text) as { routes?: Array<{ id?: unknown; route?: unknown }> };
    const rows = Array.isArray(parsed?.routes) ? parsed.routes : [];
    for (const row of rows) {
      const id = typeof row?.id === "string" ? cleanId(row.id) : null;
      const route = typeof row?.route === "string" ? normaliseRoute(row.route) : null;
      if (!id) continue;
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
    if (route) return { messageId: id, route, source: "model" as const };
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
   * Apply the deterministic floor. DEFAULT TRUE, which is PR #37's
   * behaviour and what the dry-run pipeline still gets.
   *
   * §10 step 5 ships the floor behind its own flag, default off, for
   * two reasons: §11.1 says reintroducing one at all is a product
   * decision needing Kemal's sign-off, and the router's TRUE recall is
   * only measurable with the floor out of the way. So the gate passes
   * this explicitly rather than the floor being unconditional.
   *
   * Note what turning it off cannot do: the floor only ever returns
   * `self_att` or `other_att`, never `none` (proved in
   * `__tests__/gate.test.ts`), so its override below can only move a
   * message OUT of `none`. Disabling it can therefore only lose
   * analysis, never cause it — and enabling it can only add.
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
   * MESSAGES THAT ANSWER MATCHTIME'S OPEN "WHICH TEAM WON?" (2026-10-07,
   * `score-ask.ts`). Decided by the CALLER, deterministically, from who
   * sent each message, whether it tags the bot and how long ago the
   * question was asked (`isScoreAnswer`); the router is only told the
   * ids. Each goes to `score` whatever the model called it, AND when the
   * model was not asked or did not answer: a failed router call must not
   * lose the answer to a question the bot itself asked. Empty almost
   * always.
   */
  scoreAnswerIds?: ReadonlySet<string>;
  /**
   * MESSAGES THAT ARE A TAGGED CORRECTION OF A RECORDED RESULT, by a
   * fixed vocabulary (`isScoreCorrectionText`, `score-ask.ts`), decided
   * by the caller before the router runs. The one approved live run had
   * the model send "@Match Time other way round" to `unsure` and
   * "@Match Time yanlış, kırmızı 6 sarı 9" to `other_att`; both go to
   * `score` here, on every path, like `scoreAnswerIds`.
   */
  scoreCorrectionIds?: ReadonlySet<string>;
  /**
   * The club is at its daily AI cap: route with the floor alone and make
   * no model call. See `ai-budget.ts`.
   */
  capped?: boolean;
  /** The time the turn's NOW line states (club time). Defaults to now. */
  now?: Date;
}

/**
 * The answers to MatchTime's open "which team won?" go to `score`.
 * Applied to EVERY way a batch can be routed (model, floor, fallback,
 * capped), because which messages qualify was decided before the router
 * ran and does not depend on it. See `RouteBatchOptions.scoreAnswerIds`.
 */
function withScoreAnswers(
  routes: RoutedMessage[],
  opts: RouteBatchOptions,
  degradations: Degradation[],
): RoutedMessage[] {
  const answers = opts.scoreAnswerIds;
  const corrections = opts.scoreCorrectionIds;
  if (!answers?.size && !corrections?.size) return routes;
  return routes.map((r) => {
    const isAnswer = !!answers?.has(r.messageId);
    const isCorrection = !!corrections?.has(r.messageId);
    if (r.route === "score" || !(isAnswer || isCorrection)) return r;
    degradations.push(
      degradation(
        "router",
        r.messageId,
        isAnswer
          ? `MatchTime asked which team won a scoreline and this answers it; ${r.route} → score so the ` +
              `answer reaches the question it answers`
          : `a tagged score correction of a recorded result, by its words; ${r.route} → score so it ` +
              `reaches the score route and not the attendance extractor`,
      ),
    );
    return {
      ...r,
      route: "score" as const,
      source: "awaiting" as const,
      overrodeRoute: r.overrodeRoute ?? r.route,
    };
  });
}

/** The routes a batch gets when the model may not be asked: the floor's
 *  reading where it has one, `none` (source `capped`) everywhere else. */
function cappedRoutes(messages: RouterMessage[], floor: Map<string, Route>, why: string): RouterResult {
  const degradations: Degradation[] = [];
  const routes: RoutedMessage[] = messages.map((m) => {
    const f = floor.get(m.id);
    if (f) return { messageId: m.id, route: f, source: "floor" as const };
    degradations.push(degradation("router", m.id, `${why}; not handled`));
    return { messageId: m.id, route: "none" as const, source: "capped" as const };
  });
  return { routes, degradations };
}

export async function routeBatch(
  model: PipelineModel,
  messages: RouterMessage[],
  opts: RouteBatchOptions = {},
): Promise<RouterResult> {
  // Whatever happened inside (the model answered, the floor did, the
  // call failed, the club is at its cap), the answers to MatchTime's
  // own open question go to `score`. One place, after every return.
  const res = await routeBatchInner(model, messages, opts);
  const degradations = [...res.degradations];
  return { ...res, routes: withScoreAnswers(res.routes, opts, degradations), degradations };
}

async function routeBatchInner(
  model: PipelineModel,
  messages: RouterMessage[],
  opts: RouteBatchOptions,
): Promise<RouterResult> {
  if (messages.length === 0) return { routes: [], degradations: [] };

  const floorEnabled = opts.floor ?? true;
  const floor = new Map<string, Route>();
  const floorAll = new Map<string, Route>();
  for (const m of messages) {
    const f = routeFloor(m.body);
    if (!f) continue;
    floorAll.set(m.id, f);
    if (floorEnabled) floor.set(m.id, f);
  }

  // ── AT THE DAILY AI CAP (2026-09-29) ───────────────────────────────
  //
  // No model call at all. The floor routes what it can read, whatever
  // `ROUTER_GATE_FLOOR_ENABLED` says, because at the cap it is the ONLY
  // reader left; everything else is `none`. NOT `unsure`, which is what a
  // failed router call gets below: `unsure` goes to the attendance
  // extractor, which is another model call the cap has just refused. No
  // open-question or clarification rescue either, for the same reason.
  if (opts.capped) return cappedRoutes(messages, floorAll, "the club is at its daily AI cap");

  // Every message hit the floor: there is nothing left to ask about, so
  // the batch costs nothing at all.
  if (floor.size === messages.length) {
    return {
      routes: messages.map((m) => ({
        messageId: m.id,
        route: floor.get(m.id)!,
        source: "floor" as const,
      })),
      degradations: [],
    };
  }

  const ids = messages.map((m) => m.id);
  // The model is shown, and answers with, m1, m2, ... never the WhatsApp
  // ids (`shortRouterIds`). Mapped back to the real ids right after parsing.
  const shortIds = shortRouterIds(messages.length);
  const realOf = new Map(shortIds.map((s, i) => [s, ids[i]]));
  const user = renderRouterTurn(
    messages.map((m, i) => ({ ...m, id: shortIds[i] })),
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
            },
            required: ["id", "route"],
            additionalProperties: false,
          },
        },
      },
      required: ["routes"],
      additionalProperties: false,
    },
  };

  let result: RouterResult;
  let usage: RouterResult["usage"];
  try {
    const resp = await model.complete(req);
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
    // The cap was reached between the up-front check and this call (a
    // concurrent request spent the rest): the same as `opts.capped`.
    if (isAiBudgetExceeded(err)) {
      return cappedRoutes(messages, floorAll, "the router call was refused by the daily AI cap");
    }
    // §11.4: on router failure, route EVERYTHING to the attendance
    // extractor. Expensive, correct, and self-limiting because batches
    // are small. The alternative — routing everything to `none` — is
    // the silent failure this whole design exists to remove.
    //
    // THIS COMMENT WAS NOT TRUE UNTIL §10 STEP 8. `unsure` was not an
    // engine route, so the batch went to the mega-prompt instead of to
    // any extractor. Step 8 added it to `gate.ts`'s `ENGINE_ROUTES`, so
    // the sentence above now describes what happens; without that one
    // line, a router outage after the deletion would have meant total
    // silence for the whole batch. Do not remove `unsure` from that list
    // without reading this.
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

  // The floor OVERRIDES the model, in both directions.
  const floored = result.routes.map((r) => {
    const f = floor.get(r.messageId);
    if (!f || f === r.route) return r;
    result.degradations.push(
      degradation(
        "router",
        r.messageId,
        `the floor overrode the router: ${r.route} → ${f} (bare self-attendance)`,
      ),
    );
    // `overrodeRoute` is what makes a RESCUE distinguishable from a
    // mere relabel. Only `overrodeRoute === "none"` is the seatbelt
    // actually firing; `other_att → self_att` changes nothing about
    // whether the message reaches an owner at all (it used to say
    // "whether the analyzer sees the message" — same channel, and since
    // §10 step 8 the thing on the far end of it is the attendance
    // engine, since both routes are in `ENGINE_ROUTES`).
    return { ...r, route: f, source: "floor" as const, overrodeRoute: r.route };
  });

  // ── WHILE MATCHTIME IS WAITING FOR AN ANSWER, `none` IS NOT TRUSTED ──
  //
  // The gap PR #42 measured and would not turn the gate on without: two
  // of 1,695 real messages are an attendance write the gate would lose,
  // and both are a bare `👍` answering a slot MatchTime had left open.
  //
  // Note what this is NOT. It reads nothing out of the message — no
  // token list, no emoji, no length. It reads a ROW. So it cannot fire
  // on a thumbs-up in a group MatchTime has asked nothing of, which is
  // where 99% of them live, and a `👍` pattern in the floor could not
  // make that distinction at all (§11.1's "the floor becoming a
  // classifier again").
  //
  // Structurally it is the floor's one-directional override with a
  // different trigger: it only ever rewrites `none`, so it can add an
  // extractor call and can never remove one. (It used to say "an
  // analyzer call"; §10 step 8 deleted the analyzer, and `unsure` joined
  // `gate.ts`'s `ENGINE_ROUTES` in the same change — WITHOUT which this
  // rescue would, after step 8, have rescued a message into silence.)
  // `overrodeRoute` is set for the same reason it is on the floor — so
  // "how often did this actually rescue something?" is a query and not a
  // guess.
  //
  // A `fallback` route is left alone: the batch is already going to the
  // extractor and relabelling it would hide a router failure.
  const awaiting = opts.awaiting ?? null;
  const routes = !awaiting
    ? floored
    : floored.map((r) => {
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

  // ── AND WHILE MATCHTIME IS WAITING FOR A NAME FROM ONE PERSON ──────
  //
  // The same override, narrowed twice (2026-09-23). It fires only for
  // the person the clarification was put to, and only on a reply that
  // reads as a name (`clarificationSubject`: "Idris", "I mean Mojib").
  // It moves the message to `question`, the route whose owner holds the
  // original question, from wherever the model put it: a bare "Idris"
  // read as an attendance claim is the dangerous misreading here, not
  // the harmless one. A `fallback` route is still left alone.
  const clarifications = opts.clarifications ?? [];
  const byId = new Map(messages.map((m) => [m.id, m]));
  const finalRoutes =
    clarifications.length === 0
      ? routes
      : routes.map((r) => {
          if (r.route === "question" || r.source === "fallback") return r;
          const m = byId.get(r.messageId);
          if (!m) return r;
          const c = clarifications.find((q) => !!q.askerName && q.askerName === m.authorName);
          if (!c || clarificationSubject(m.body) === null) return r;
          result.degradations.push(
            degradation(
              "router",
              r.messageId,
              `MatchTime asked ${c.askerName} who they meant (stats clarification ${c.id}); ` +
                `${r.route} → question so the answer reaches the question it answers`,
            ),
          );
          return {
            ...r,
            route: "question" as const,
            source: "awaiting" as const,
            overrodeRoute: r.overrodeRoute ?? r.route,
          };
        });

  return { routes: finalRoutes, degradations: result.degradations, usage };
}

/** Convenience for callers that do not inject a model. */
export function defaultRouterModel(): PipelineModel {
  return anthropicModel();
}
