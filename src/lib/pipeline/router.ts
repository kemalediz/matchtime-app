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
import { describeQuestion, type AwaitingQuestion } from "./awaiting-answer";
import {
  anthropicModel,
  degradation,
  extractJson,
  ROUTER_MODEL,
  type ModelRequest,
  type PipelineModel,
} from "./llm";
import type { Degradation, Route, RoutedMessage } from "./types";

/**
 * ─────────────────────────────────────────────────────────────────────
 * "SMALL ON PURPOSE: ITS SIZE IS THE ARGUMENT (§6.1)" — THAT WAS WRONG,
 * AND ON 2026-09-11 IT WAS MEASURED
 * ─────────────────────────────────────────────────────────────────────
 *
 * `MDs/router-accuracy-2026-09-11.md` took the 2,501-character prompt
 * that stood here, ran it live over **1,748 real Sutton FC messages in
 * their real analyze batches**, and scored it against 445 hand-labelled
 * bodies. It reached **83.3% owner accuracy**: `admin_ops` fired on six
 * wrong messages for every right one, `balancer` on three, and **21.5%
 * of banter escaped the `none` bucket** and bought an extractor call.
 * Size was never what made it cheap. Being right is what makes it
 * cheap, and it was not right.
 *
 * Re-measured on the same corpus, same model, same batching — one full
 * live sweep per arm, and **three** for the row that matters:
 *
 *              owner acc   att→none (3 runs)  banter escaping  admin_ops P   $/batch
 *   was            83.3%     3, 2, 4 of 373            21.5%         13.4%   $0.00128
 *   this           93.4%     0, 0, 0 of 373             8.1%         82.5%   $0.00317
 *
 * **NOT ONE of 373 real attendance messages in 143 days was called
 * banter, in any of three live runs.** The prompt that shipped lost
 * three per run, and §1.4 names them.
 *
 * ⚠️ READ THIS BEFORE EDITING A RULE BELOW. §3.1's FIRST candidate
 * scored **higher overall** than the one that shipped and **TRIPLED**
 * the attendance it threw away — nine messages against three — because
 * a person-to-person rule swallowed commitments that happened to be
 * addressed to a person. **The held-out 220-message split did not catch
 * it**, because the offending messages were in the train half. So:
 *
 *   1. evaluate on the WHOLE corpus, never on a split;
 *   2. run the attendance slice three times, not once — the metric that
 *      can cost a player their place is the only one with a veto;
 *   3. `npm run replay:router-regressions` first. It is cheap, it is
 *      live, and every message in it is one a prompt has already lost.
 *
 * Rule 0 and rule 11a exist because of that first candidate: 11a's five
 * counter-examples are five real messages it deleted. Rules 10 (the ask
 * buried in praise), 14 (a correction is still attendance), 15 (an
 * instruction to an admin settles a place) and 16 (a score is OUR
 * result, not the one on television) close the four failures the second
 * candidate had left, each of which was byte-identical on every run —
 * a prompt gap, not sampling noise.
 *
 * ── WHAT GOT WORSE, SAID OUT LOUD ────────────────────────────────────
 *
 * Rule 11 buys the drop in banter-escaping-`none` and it is not free.
 * Gold-labelled QUESTIONS routed `none` go from 1 to 5 of 641 labelled
 * messages. Four of the five do not tag the bot, and `answer-batch`
 * refuses an untagged question before it spends anything
 * (`answer-batch.ts:682` filters on `m.tagged`), so those four cost
 * nothing that was ever going to happen. **The fifth does tag the bot**
 * — *"you are hallucinating @Match Time, that was @Ehtisham sharing MoM
 * with Hasan, not @Zair. Please confirm"* — and is now silence where it
 * was an answer. One message in 143 days, `speech` severity in
 * `router-recall.ts`'s own table, against three attendance messages a
 * run at `squad_place`. That is the trade, and it is the one
 * `gate.ts` says to take.
 *
 * One balancer message also moved to attendance (*"me on the red as
 * well, I have my red Arsenal shirt"*), which is a colour preference
 * read as a registration. Visible, one message to undo.
 *
 * IT IS 9,608 CHARACTERS AND IT DOES NOT CACHE. 2,554 tokens on
 * `claude-haiku-4-5`, whose minimum cacheable prefix is 4,096 — probed
 * directly, `cache_creation=0` with a marker attached. That is why §3.3
 * travels with this change: the old `MIN_CACHEABLE_CHARS = 4_000` would
 * have reported `cacheAttempted: true` on every router call from here
 * on and cached nothing. See `llm.ts`. Every token below is paid on
 * every call, knowingly.
 *
 * WHAT THAT COSTS, measured over the same 974 batches rather than
 * modelled: $0.00317 a batch against $0.00128. At the peak month in the
 * history (June, 656 messages ≈ 366 batches) the router goes from
 * $0.47 to $1.16 a month. The attendance extractor's share is flat —
 * 486 attendance routes per 1,748 messages against the old prompt's 492
 * — so the whole of the change is **+$0.69 a month at peak traffic**,
 * and §8.4 of `MDs/analyzer-redesign-2026-08-31.md` is the standing
 * model this sits inside. Latency +0.45 s a batch, against a Pi that
 * buffers for ten minutes.
 */
export const ROUTER_SYSTEM_PROMPT = `You classify WhatsApp messages from a football club group. For EVERY message id you are given, return exactly one route.

0. READ THIS FIRST, AND LET NOTHING BELOW OVERRIDE IT. If a message states, promises, withdraws, offers or asks for a PLACE IN THIS SQUAD for anybody at all — the sender, a named player, an @mention, a relative, a friend, a guest, a phone number — it is an attendance route (self_att, other_att, offer or unsure) and it must NEVER be none. A message the group would read as "one more person is playing" or "one fewer person is playing" is attendance, however casually it is worded and whoever it is addressed to.

none        banter, jokes, memes, links, emoji, greetings, off-topic chat
self_att    the SENDER is joining or leaving THIS match themselves
other_att   the message adds, drops, benches, swaps or replaces SOMEONE ELSE
offer       a contingent or tentative commitment by anyone ("if you're short", "if my back holds up")
question    a question the bot could answer
balancer    asks the bot to generate, show, shuffle or rename the two teams
score       reports a final result
admin_ops   payment credit, reminder request, other bot admin instruction
unsure      attendance-shaped but you genuinely cannot tell

Rules:
1. Route on what a message DOES, not what it is about. "Great game last night" is none.
2. A completed join stated about someone else IS other_att ("Ayoub snatched that spot").
3. A relayed commitment IS other_att ("Najib said in as well").
4. Moving, benching or swapping a NAMED PLAYER is other_att, never balancer. ONE list of players, however long or numbered, is a reposted squad roster and is other_att; balancer is only about the TWO team line-ups.
4a. Asking to SEE who is playing — "who's in?", "show me the squad", "list the players", "who's playing tonight?" — is question. It asks for the ONE squad list the bot already holds. balancer is only for the TWO team line-ups (red and yellow), so "show me the teams" is balancer and "show me the squad" is not.
5. An @mention of a person with in or out is other_att.
6. A question mark does not make a message a question. If it also states that someone is joining or leaving ("can anyone replace me tonight?"), route the attendance. question is only for a message that ASKS FOR information the bot holds and states no change.
7. When in doubt between none and anything else, choose the other route.
8. ASKING is question; INSTRUCTING is admin_ops. "Amir paid for 4 players" and "remind me on Monday" tell the bot to do something and are admin_ops. "Who hasn't paid?", "has everyone paid for last week?" and "any payments outstanding?" ask for something the bot already knows and are question.
9. A question about a match that has ALREADY BEEN PLAYED is question, not none: "what was the score?", "did we win on tuesday?", "how did we get on last night?", "who's played the most this season?". Reporting a result ("we won 5-3") is still score.
10. ASKING THE GROUP FOR A PLAYER IS ATTENDANCE, NOT question. "anyone able to replace me?", "is anyone available to take my dad's place?", "we need one more player, anyone interested?", "@all we need more players", "can we have more INs please?" all ask PEOPLE to fill a gap in this squad. Route them other_att when they name or imply a specific person leaving, otherwise offer. A question mark does not make them question. question is only for information the BOT already holds. THE ASK IS OFTEN BURIED: praise, reassurance, an apology or a pitch wrapped around it changes nothing — "great bunch of lads, same standard as us, come on, one player please" is a chase, not banter.
11. A MESSAGE ONE MEMBER SENDS TO ANOTHER, WHICH STATES NO CHANGE TO THIS SQUAD AND ASKS THE BOT FOR NOTHING IT HOLDS, IS none: "are you injured?", "are you available to play @Enayem?", "@Amir you are coming, right?", "which two of you can play tomorrow?". These ASK; they settle nothing.
11a. ⚠️ RULE 11 NEVER OVERRIDES RULE 0. Being addressed to a person, or speaking on someone else's behalf, does NOT make a stated commitment banter. "@Ehtisham in sha Allah I'll play", "Talha is coming please add him", "@Kemal my brother can play if needed", "add these 2 boys pl", "Rashad my cousin to add if poss", "I can play @Kemal, your bot is spamming me" all STATE that somebody will play. Every one is attendance.
12. admin_ops IS AN INSTRUCTION ADDRESSED TO THE BOT. Talk ABOUT the bot, about settings, about the pitch, about money owed between members, or plans the sender is going to carry out themselves ("I will change it to 7aside", "please add Talha to this group", "matchtime should suggest 5aside") is none. If nobody is telling the BOT to do something now, it is not admin_ops.
13. WHEN A MESSAGE IS ATTENDANCE-SHAPED BUT YOU CANNOT TELL WHAT IT DOES, RETURN unsure RATHER THAN GUESSING BETWEEN self_att AND other_att. unsure is a real route with a real handler; it is not a failure. Never use unsure for a message that is plainly banter — that is none.
14. A CORRECTION IS STILL ATTENDANCE, AND THE APOLOGY AROUND IT IS NOT BANTER. "oops, sorry, I got the name wrong — it should be Zair not Baki", "ignore my last message, I am in after all", "I meant Thursday not Tuesday" all fix WHO IS PLAYING and are attendance. So is standing in for more than one person: "I am covering for two people, Ismail and Ozgur" adds two players and is other_att.
15. AN INSTRUCTION TO AN ADMIN OR TO ANOTHER MEMBER TO ADD OR DROP SOMEBODY IS ATTENDANCE, NOT none. Rule 11 is about members ASKING each other things that settle nothing. "@Kemal please put Amir in as the 14th", "@Youssef can you take me off the list", "@Kemal switch it to 7 a side and include Amir" all SETTLE a place, so they are other_att (or self_att about the sender) even when they also ask for a setting to be changed. Where one message carries both a setting change and a place, the place wins.
16. score IS THE RESULT OF THIS GROUP'S OWN MATCH. A scoreline about a professional or international fixture somebody is watching — "Arsenal 2 Spurs 1", "Brazil 1 France 1" — is football chat and is none. Our own results are reported with our team names, our colours or a bare scoreline ("5-3 to Yellows", "10-10").

Worked examples from this group. Copy the reasoning, not the wording.

  "In"                                                        -> self_att
  "Yep in"                                                    -> self_att
  "Bench"                                                     -> self_att
  "I'm not playing"                                           -> self_att
  "I can't join due to work n dint bring kit"                 -> self_att
  "Hey gents, I am in just in case someone drops."            -> offer
  "Lemme know if we need more to make it 14. I can find another" -> offer
  "Will confirm shortly"                                      -> unsure
  "@Youssef is IN"                                            -> other_att
  "@Match Time Kojo IN, Aaron IN"                             -> other_att
  "Najib said in as well so we should be at 13 players"       -> other_att
  "Trevell got injured today so he had to drop out"           -> other_att
  "@Match Time move @Aydin from bench to squad to replace @Ehtisham" -> other_att
  "@Match Time swap David and Abid"                           -> other_att
  "Hi guys, does anyone wants to take my place for tonight?"  -> other_att
  "We need one more player guys, anyone interested?"          -> offer
  "@all we need one more player otherwise Salman will move to squad from bench" -> other_att
  "@Match Time how many players so far?"                      -> question
  "Pitch number ?"                                            -> question
  "Where is my name?"                                         -> question
  "@Match Time who has got the most MoM so far?"              -> question
  "@Match Time what is the current squad status?"             -> question
  "Teams?"                                                    -> balancer
  "@Match Time regenerate the teams once more"                -> balancer
  "@Match Time generate the teams, put me and David together" -> balancer
  "5-3 to Yellows"                                            -> score
  "10-10"                                                     -> score
  "remind me on Tuesday morning at 9am instead please"        -> admin_ops
  "@Match Time DM me the link for switching to 7aside"        -> admin_ops
  "Are you injured ?"                                         -> none
  "Are you available to play @Enayem ?"                       -> none
  "@Youssef @Ehtisham , Talha is coming, right?"              -> none
  "Oops, didn't realise @Mojib Jalali is in"                  -> none
  "I think we are still waiting for the poll result."         -> none
  "Get the rating done"                                       -> none
  "Eid Mubarak everyone"                                      -> none
  "Crazy statistics"                                          -> none
  "wait guys sorry by mistake I enabled the tracking of squad in Match Time" -> none
  "Are we adding them to the group?"                          -> none
  "great bunch of lads, same standard as us, come on — one player please" -> offer
  "Sorry, I got it wrong — it should be Zair not Baki"        -> other_att
  "I'm covering for two people, Ismail and Ozgur"             -> other_att
  "@Kemal can you switch it to 7 a side and put Amir in as the 14th" -> other_att
  "Arsenal 2 Spurs 1"                                         -> none

Return JSON only: {"routes":[{"id":"<id>","route":"<route>"}]}`;

const ROUTER_MAX_TOKENS = 1_024;

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
/** Anything left after the token that is not punctuation or an emoji
 *  means this is a sentence, not a bare declaration. */
const FLOOR_TAIL = /^[\s\p{P}\p{S}]*$/u;

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
const MENTION_TOKEN = /^@[\p{L}\d._'-]+/u;
/** A capitalised word after a mention is part of the mentioned display
 *  name ("@Ehtisham Ul Haq") — the Pi expands a mention to the display
 *  name. A lower-case word is the sentence starting, and ends the
 *  subject. */
const NAME_WORD = /^\p{Lu}[\p{L}'-]*$/u;

export function routeFloor(body: string): Route | null {
  const t = (body ?? "").trim();
  if (!t) return null;

  if (t.startsWith("@")) {
    // Never the bot. `messageTagsBot` is this project's one definition
    // of "this message tags MatchTime"; it is reused, not re-derived.
    if (messageTagsBot({ body: t })) return null;
    let rest = t;
    let sawMention = false;
    for (;;) {
      const m = MENTION_TOKEN.exec(rest);
      if (!m) break;
      sawMention = true;
      rest = rest.slice(m[0].length).trimStart();
      // Consume the rest of the mentioned display name.
      for (;;) {
        const word = rest.split(/\s+/)[0] ?? "";
        if (!word || !NAME_WORD.test(word) || isFloorToken(word)) break;
        rest = rest.slice(word.length).trimStart();
      }
    }
    if (!sawMention) return null;
    return isBareDeclaration(rest) ? "other_att" : null;
  }

  return isBareDeclaration(t) ? "self_att" : null;
}

/** Is this single word one of the bare tokens the floor recognises? */
function isFloorToken(word: string): boolean {
  return /^(?:in|out)$/i.test(word.replace(/[^\p{L}]/gu, ""));
}

/** Is the whole of `t` a bare IN/OUT/+N declaration and nothing else? */
function isBareDeclaration(t: string): boolean {
  if (!t || t.length > 24) return false;
  for (const re of [FLOOR_IN, FLOOR_OUT]) {
    const m = re.exec(t);
    if (!m) continue;
    return FLOOR_TAIL.test(t.slice(m[0].length));
  }
  return false;
}

export interface RouterMessage {
  id: string;
  authorName: string | null;
  body: string;
}

export interface RouterResult {
  routes: RoutedMessage[];
  degradations: Degradation[];
  usage?: { costUsd: number | null; ms: number; inputTokens: number; outputTokens: number };
}

export function parseRouterResponse(text: string, ids: string[]): RouterResult {
  const degradations: Degradation[] = [];
  const byId = new Map<string, Route>();

  try {
    const parsed = extractJson(text) as { routes?: Array<{ id?: unknown; route?: unknown }> };
    const rows = Array.isArray(parsed?.routes) ? parsed.routes : [];
    for (const row of rows) {
      const id = typeof row?.id === "string" ? row.id : null;
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
}

export async function routeBatch(
  model: PipelineModel,
  messages: RouterMessage[],
  opts: RouteBatchOptions = {},
): Promise<RouterResult> {
  if (messages.length === 0) return { routes: [], degradations: [] };

  const floorEnabled = opts.floor ?? true;
  const floor = new Map<string, Route>();
  if (floorEnabled) {
    for (const m of messages) {
      const f = routeFloor(m.body);
      if (f) floor.set(m.id, f);
    }
  }

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
  const user = messages
    .map((m) => `[${m.id}] ${m.authorName ?? "(unknown)"}: ${m.body}`)
    .join("\n");

  const req: ModelRequest = {
    model: ROUTER_MODEL,
    system: ROUTER_SYSTEM_PROMPT,
    user,
    maxTokens: ROUTER_MAX_TOKENS,
    label: "router",
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
    result = parseRouterResponse(resp.text, ids);
    usage = {
      costUsd: resp.costUsd,
      ms: resp.ms,
      inputTokens: resp.usage.inputTokens + resp.usage.cacheReadTokens,
      outputTokens: resp.usage.outputTokens,
    };
  } catch (err) {
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

  return { routes, degradations: result.degradations, usage };
}

/** Convenience for callers that do not inject a model. */
export function defaultRouterModel(): PipelineModel {
  return anthropicModel();
}
