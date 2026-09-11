/**
 * THE NEW ANALYZER PIPELINE — shared types.
 *
 * MDs/analyzer-redesign-2026-08-31.md §10 step 2. Four stages:
 *
 *   0. deterministic floor   (regex, §11.1)
 *   1. router                (cheap model, one route per message id, §6.1)
 *   2. extractors            (facts about the TEXT, never decisions, §6.2)
 *   3. decision engine       (pure, deterministic, no I/O, no model, §6.3)
 *   4. composer              (every name and number read from state, §6.4)
 *
 * THE ONE RULE THIS FILE ENFORCES BY SHAPE
 * ----------------------------------------
 * An extractor's output type contains no `intent`, no `registerAttendance`,
 * no `registerFor`, no `react`, no `reply` and no `reasoning`. There is
 * literally no field in which the model can express a decision, and no
 * prose for a regex to parse afterwards. That is what kills 19 of the 54
 * seatbelts (§9): the error class becomes unrepresentable.
 *
 * DRY-RUN. Nothing in this directory writes to the database, sends a
 * WhatsApp message, or queues a notification. The engine returns
 * PROPOSED writes and a PROJECTED next state; the shadow harness
 * persists them for comparison (§10 step 2, "Still zero writes").
 */
// Type-only, and from a module with no Prisma import of its own — see
// `SquadState.payments` and `payment-answer.ts`'s header.
import type { PaymentSnapshot } from "./payment-answer";

export type { PaymentSnapshot };

// ── Stage 1: routes ────────────────────────────────────────────────────

/**
 * §6.1 lists nine routes and then reports a failure the author could not
 * fix: "move Mustafa to the bench, keep Idris in" routed `team_ops` 3/3,
 * because "bench" reads as team-shaped vocabulary. The doc's own remedy
 * is quoted verbatim: *"probably by renaming `team_ops` → `balancer` and
 * adding `lineup_ops`"*.
 *
 * We take half of that. `team_ops` is renamed `balancer`, which removes
 * the vocabulary collision at its source. We deliberately do NOT add
 * `lineup_ops` as a distinct engine route: roster surgery IS an
 * attendance change about someone else, and a second attendance path
 * would double every capacity and authorisation rule that `other_att`
 * already carries. Instead `lineup_ops` is accepted from the model as an
 * ALIAS and normalised to `other_att` (see `normaliseRoute`), so the
 * router still has a natural landing spot for that vocabulary while the
 * engine only ever sees one attendance route.
 */
export type Route =
  /** banter, jokes, memes, links, emoji, off-topic chat */
  | "none"
  /** the SENDER is joining or leaving THIS match themselves */
  | "self_att"
  /** adds, drops, benches, swaps or replaces SOMEONE ELSE */
  | "other_att"
  /** a contingent or tentative commitment by anyone */
  | "offer"
  /** a question the bot could answer */
  | "question"
  /** generate, show, shuffle or rename the two teams */
  | "balancer"
  /** reports a final result */
  | "score"
  /** payment credit, reminder request, other bot admin instruction */
  | "admin_ops"
  /** attendance-shaped but the router genuinely cannot tell */
  | "unsure";

export const ALL_ROUTES: readonly Route[] = [
  "none",
  "self_att",
  "other_att",
  "offer",
  "question",
  "balancer",
  "score",
  "admin_ops",
  "unsure",
];

/**
 * Where a route came from. `floor` outranks `model` (§11.1).
 *
 * `awaiting` is the same idea as `floor` and inherits its one-directional
 * proof — it can only move a message OUT of `none` — but it is gated on a
 * DATABASE ROW (an open `BenchSlotOffer` / `PendingBenchConfirmation` /
 * `TentativeAvailability`) rather than on the text of the message. See
 * `awaiting-answer.ts` for why the two `👍`s PR #42 found need a fact and
 * not a pattern.
 */
export type RouteSource = "floor" | "awaiting" | "model" | "fallback";

export interface RoutedMessage {
  messageId: string;
  route: Route;
  source: RouteSource;
  /**
   * When `source` is `floor`, the route the MODEL gave that the floor
   * replaced. Absent otherwise.
   *
   * Without this, "how often did the floor rescue a message?" is
   * unanswerable, and the obvious proxy — counting `source === "floor"`
   * — is wrong in a way that flatters the floor: it counts every
   * override, including `other_att → self_att`, which changes nothing
   * about whether the message reaches an OWNER at all (this said "the
   * analyzer" until §10 step 8 deleted it; both routes are in
   * `gate.ts`'s `ENGINE_ROUTES`, so the far end is the attendance
   * engine either way). A rescue is specifically
   * `overrodeRoute === "none"`. That mistake was made and
   * caught in the first full recall sweep, where it reported 136
   * rescues against a true count of 0.
   */
  overrodeRoute?: Route;
}

// ── Stage 2: FACTS ─────────────────────────────────────────────────────

export type Polarity = "in" | "out" | "bench";
export type Tense = "present" | "future" | "past" | "hypothetical";
/** What a contingent claim is contingent ON. §3.2 S15: the standing-offer
 *  vs personal-uncertainty split, whose outcomes are opposites. */
export type ConditionOn = "squad" | "self" | "none";

/**
 * Does the message SETTLE this person's attendance, or only report their
 * availability?
 *
 * The schema gap PR #44 left open, found by the §10 step 6 replay sweep:
 *
 *   2026-06-20, Abid Kazmi, ten days before kickoff, squad 0/14 —
 *   "I will be back Tuesday week". The engine registered him CONFIRMED.
 *
 * Three live runs of the shipped extractor on the real message returned
 * `polarity:"in" · contingent:false · conditionOn:"none" · tense:"future"`
 * — which is the SAME shape "I'm in for next Tuesday" returns. `tense`
 * covers WHEN ("future" is right for both) and `contingent` covers
 * WHETHER-IF (neither is conditional). Nothing in the schema covered
 * WHAT THE MESSAGE DOES, so a travel statement and a commitment were
 * literally indistinguishable and the engine had to guess.
 *
 * That is the same class of gap as the one that produced the Omar Yusuf
 * defect — `conditionOn` had no value for "the condition is about a
 * third party's willingness" — and it gets the same treatment: a field,
 * not a paragraph of prose in the prompt telling the model what to do.
 *
 * - `decision`     the message settles it: "I'm in", "count me in",
 *                  "I'm out", "can't make it", "I'll be there".
 * - `availability` the message reports where the person will be or what
 *                  they can do, and leaves the decision unmade: "I'll be
 *                  back Tuesday week", "I land Monday", "I'm away that
 *                  week", "I'm free after the 5th".
 *
 * The engine reads it asymmetrically, on purpose (§13): being ABLE to
 * play is necessary but never sufficient, so an `availability` claim
 * never gives anyone a squad place; being UNABLE to play settles the
 * question by itself, so an `availability` OUT still frees one.
 */
export type ClaimBasis = "decision" | "availability";

/**
 * One attendance claim the TEXT makes. Every field is a property of the
 * message, checkable by re-reading it. None of them is a decision.
 */
export interface Claim {
  /** Who the claim is about. `sender` = the person who typed it. */
  subject: "sender" | "other";
  /** Verbatim, as written. NEVER invented, never expanded to a full name. */
  personRef: string;
  /** Was an actual personal NAME used? "my brother", "2 of my guys",
   *  "someone" → false. This single boolean is what stops a ghost user
   *  called "Amir's brother" being provisioned into a paid squad (§4.1). */
  personNamed: boolean;
  /** in = joining, out = leaving, bench = EXPLICITLY asked for the bench.
   *  The extractor never infers `bench` from squad capacity; capacity is
   *  the engine's job, so every `bench` here is a stated preference. */
  polarity: Polarity;
  contingent: boolean;
  conditionOn: ConditionOn;
  tense: Tense;
  /** Settles it, or merely reports availability. See `ClaimBasis`. */
  basis: ClaimBasis;
  /** Relaying what someone else said ("Najib said he's in"). */
  reported: boolean;
  confidence: number;
}

/** Something the message ALSO asks for, alongside its claims. A message
 *  is allowed to carry several facts and the pipeline must lose none of
 *  them — today's incident was a regex fast path claiming a two-intent
 *  message and throwing half away. */
export type SideRequest =
  /** "anyone able to replace me?", "can someone cover?" — asks the group
   *  (or the bench) for a replacement. */
  | "recruit"
  /** "@all we need more players" — a nudge, NOT the sender leaving. */
  | "chase";

export interface AttendanceFacts {
  kind: "attendance";
  claims: Claim[];
  /** A bare affirmation/refusal answering something the message itself
   *  does not state ("Confirmed", "yes", "no").
   *
   *  IT IS A POINTER, NOT A FACT ABOUT ATTENDANCE, and it is worth
   *  exactly as much as whatever the ENGINE can resolve it against.
   *  `engine.ts:handleAttendance` knows two such things and tries them
   *  in order: the pending set in MatchTime's own last post (§3.2 S25 —
   *  a known object, so a lookup rather than an inference), and failing
   *  that the ROUTE, because `self_att` is stage 1's typed verdict that
   *  the sender is joining or leaving this match themselves.
   *
   *  ⚠️ An affirmation the engine cannot resolve REGISTERS NOBODY, and
   *  until 2026-09-09 it did worse than that: it returned, discarding
   *  the message whole. Two players typed "In", came back claimless with
   *  `affirmation: "yes"`, and lost their place in a live squad. */
  affirmation: "yes" | "no" | null;
  sideRequests: SideRequest[];
}

/**
 * `fixture` was ADDED on 2026-09-06, and the reason is a measurement
 * rather than a hunch.
 *
 * Twelve tagged questions were replayed through the live pipeline
 * against the real Sutton squad. The router caught 12/12; seven produced
 * no answer, and FOUR of those seven were the same shape:
 *
 *   "@Match Time what time is kickoff"      → topic `other`
 *   "@Match Time where are we playing"      → topic `other`
 *   "@Match Time are we playing tuesday?"   → topic `other`
 *   "@Match Time is the game still on"      → topic `other`
 *
 * `other` reaches `engine.ts`'s `default:` branch, which degrades — an
 * operator note and not one word to the group. So the most ordinary
 * question a Sunday-league group asks was silence, while the mega-prompt
 * it was replacing still answered it, in its own words: *"Asking about
 * squad numbers, venue, kickoff time … 21:30 at <venue>"*
 * (`message-analyzer.ts:455-457`, as it stood before §10 step 8 deleted
 * it).
 *
 * PAST TENSE ON PURPOSE. That comparison is what made adding `fixture`
 * a REQUIREMENT of step 8 rather than an improvement: the moment the
 * mega-prompt went, "what time is kickoff?" would have been answered by
 * nobody at all. There is no path left that answers a `fixture` question
 * except this topic.
 *
 * `state.kickoffLabel` and `state.venue` are already loaded and already
 * pre-formatted for exactly this. Nothing new is read; a topic that had
 * nowhere to go now has one.
 */
export type QuestionTopic =
  | "squad"
  | "bench"
  | "count"
  | "person_status"
  | "phones"
  /** is the match on, when does it kick off, where is it played */
  | "fixture"
  /**
   * THE RESULT OF THE MATCH THAT WAS PLAYED — "what was the score?",
   * "did we win on tuesday?", "how did we get on last night?".
   *
   * Added 2026-09-09. The data was already there: `completedMatch`
   * carries `redScore`, `yellowScore` and `status`, loaded for the
   * score-REPORTING route. Reading it back cost a topic and a composer
   * branch.
   *
   * ── THE AMBIGUOUS PHRASING, SETTLED BY MEASUREMENT ─────────────────
   * "whats the score situation" is a real message from the group and it
   * can be read two ways: the RESULT of the last match, or "how are we
   * doing for numbers". It was NOT settled by argument. Ten live runs
   * against the real Sutton squad with only the old nine topics
   * available: `count` 8/10, `other` 2/10 — not one drift toward a
   * result reading, and `count` produced "We're 6/14 for Tue 21:30,
   * need 8 more 🙏". Ten more with `score` on the menu, so the model
   * had somewhere else to go: `count` again.
   *
   * So the model is CONSISTENT, and this topic follows it rather than
   * overriding it. "Score situation" means the tally. That also matches
   * the English: a Sunday-league group asks "what's the score" about a
   * result and "what's the score SITUATION" about where things stand,
   * and it is the phrasing on the harness's Q3, which has expected
   * `count` since the case was written.
   *
   * The four UNAMBIGUOUS result phrasings are Q25-Q28 and they are what
   * this topic is for.
   */
  | "score"
  /**
   * WHO HAS NOT PAID for the last match — money, and the only topic in
   * this list that reads something `loadSquadState` does not load.
   *
   * It is the one question on the 2026-09-06 list where being WRONG
   * costs a person something rather than costing MatchTime credibility,
   * so it is also the one with three refusals to its one answer. The
   * whole decision — which org flag gates it, why the answer names
   * nobody, and why the last match must be COMPLETED — is in
   * `payment-answer.ts`'s header, not repeated here.
   *
   * "payments", not "unpaid": the extractor is classifying a SUBJECT,
   * and "has everyone paid for last week" is the same subject asked from
   * the other side.
   */
  | "payments"
  | "stats"
  | "options"
  | "other";

export interface QuestionFacts {
  kind: "question";
  topic: QuestionTopic;
  /** Who the question is about, verbatim, when it names anyone. */
  personRef: string | null;
  /** A number the message ASSERTS about the squad ("we're 9/14 right?").
   *  §3.2 S24: the engine compares it to the database. */
  statedCount: number | null;
}

export interface TeamFacts {
  kind: "teams";
  /** show = re-post what exists. generate = run the balancer. §3.2 S19:
   *  "show the teams again" once destroyed an admin's manual swap. */
  action: "show" | "generate" | "rename" | "swap";
  includeRefs: string[];
  teamNames: [string, string] | null;
  swaps: Array<{ personRef: string; team: "RED" | "YELLOW" }>;
  /**
   * "put me and Kemal on the same team" — a PAIRING, added 2026-09-06.
   *
   * A separate field and not a `swaps` entry, because the two say
   * different things. `swaps` is ABSOLUTE ("David on Red"); a pairing is
   * RELATIVE ("these people together") and names no colour at all. The
   * measured production corpus carries this shape twice in 23 generate
   * requests, and before this field existed the only way to express it
   * was to make the model invent a colour — exactly the class of
   * model-authored fact §6.4 exists to remove.
   *
   * Each element is one group of verbatim person references that must
   * end up on the same side. `engine.ts` resolves a group onto ONE
   * colour, and says out loud there that the colour is arbitrary:
   * `generateTeamsForMatch` takes an absolute team per player and has no
   * notion of "together", so the constraint is preserved by pinning the
   * whole group to the same side rather than by a new balancer concept.
   */
  pairings: string[][];
}

export interface ScoreFacts {
  kind: "score";
  /** In the order the two teams appear in the match context. */
  first: number;
  second: number;
}

export interface AdminFacts {
  kind: "admin";
  /**
   * `recruit` was added by §10 step 7 part 2, and it was the one admin
   * action the mega-prompt could still do that nothing else could.
   *
   * "@Match Time message all players who played in the last 5 matches
   * and invite them" routes `admin_ops` and used to come back as
   * `other`, i.e. `admin action "other" has no deterministic handler` —
   * so the ONLY thing in the system that recognised a recruit ask on
   * this route was `verdict.recruitRequest` on the 19,850-token prompt
   * (`route.ts:1548` → `inviteRecentPlayers`). A route cannot leave the
   * mega-prompt while one of its real phrasings only works there.
   *
   * §10 step 8 then deleted the prompt, so this field is no longer the
   * second of two recognisers: it is the ONLY one. Remove it and an
   * admin's recruit ask falls to `other`, which nothing owns — silence
   * plus an operator note.
   *
   * `stats_blast` was added on 2026-09-10, for the same reason one layer
   * along: it was the LAST bulk-DM command still classified by a regex.
   * `analyze/route.ts:737` recognised it with three keyword tests ANDed
   * together, and on 2026-09-10 an owner's reminder to his players
   * ("…rate the players via the link from Matchtime DM'ed to you. the
   * more accurate ratings…") satisfied all three from three unrelated
   * fragments and queued 69 mass DMs. The regex is deleted; this field
   * is now the only recogniser, and `lib/stats-blast.ts` carries the
   * argument.
   */
  action: "bulk_payment" | "reminder" | "recruit" | "stats_blast" | "other";
  /** bulk_payment */
  payerRef?: string;
  count?: number;
  coveredRefs?: string[];
  /** reminder — the PHRASE as written ("on Monday", "tomorrow at 6").
   *  §3.2 S22: calendar arithmetic is `date-fns-tz`'s job, not the
   *  model's. The extractor hands back the words. */
  phrase?: string;
  /** reminder — what the nudge should say, in the sender's own words
   *  ("bring the bibs"). Absent when the message only names a time. */
  note?: string;
  /**
   * recruit — how many recent matches the message asks to draw from
   * ("the last 5 matches"). A FACT ABOUT THE TEXT: absent when the
   * message names no number, and clamped to `[1, RECRUIT_LOOKBACK_MAX]`
   * by the engine before it can reach a mass DM.
   */
  lookbackMatches?: number;
}

export interface NoFacts {
  kind: "none";
}

export type Facts =
  | AttendanceFacts
  | QuestionFacts
  | TeamFacts
  | ScoreFacts
  | AdminFacts
  | NoFacts;

// ── The world the engine decides against ───────────────────────────────

export type AttStatus = "CONFIRMED" | "BENCH" | "DROPPED";

export interface Member {
  userId: string;
  name: string;
  isAdmin: boolean;
  hasPhone: boolean;
}

export interface AttendanceRow {
  userId: string;
  status: AttStatus;
  position: number;
}

export interface BenchOffer {
  id: string;
  /** Whose vacated slot this offer is for. */
  replacingUserId: string | null;
  /** Who the offer was broadcast to (the bench at the time). */
  offeredToUserIds: string[];
}

/**
 * Everything the engine is allowed to know. Loaded once per batch by
 * `load-state.ts` (the only I/O in this directory) and then never
 * re-read: the engine is a pure function of this value.
 */
export interface SquadState {
  /** The ACTIVE registration match, chosen by `selectRegistrationMatch`.
   *  null = no match to register anyone for, or registration is blocked
   *  because a previous match is still in flight. */
  matchId: string | null;
  /** Format TOTAL across both teams (7-a-side → 14). Never per-team. */
  maxPlayers: number;
  /** Pre-formatted for the composer, so it needs no clock and no
   *  timezone library: "Tue 21:30". */
  kickoffLabel: string;
  venue: string;
  rows: AttendanceRow[];
  roster: Member[];
  openOffers: BenchOffer[];
  teams: Array<{ userId: string; team: "RED" | "YELLOW" }>;
  teamLabels: [string, string];
  /**
   * THE LAST MATCH THAT HAS ACTUALLY BEEN PLAYED — the one a score
   * report and a payment credit are about.
   *
   * WIDENED for §10 step 7 part 2, and the name is now slightly wrong on
   * purpose rather than the selection being quietly wrong. Until this
   * change the loaders asked for `status: "COMPLETED"` only, and
   * `answer-batch.ts`'s header records why that blocked the `score`
   * route: the shipped path selects from
   * `TEAMS_PUBLISHED | TEAMS_GENERATED | COMPLETED` (`route.ts:3474-3479`),
   * because a match only becomes `COMPLETED` when somebody records a
   * score. A real Tuesday night therefore sits at `TEAMS_PUBLISHED` for
   * ever if nobody ever reports one, and a `completedMatch` that only
   * held `COMPLETED` rows would refuse the FIRST score of every match —
   * which is every score that matters.
   *
   * The loaders now pick the most recent match whose KICKOFF PLUS
   * DURATION has passed, in any of those three statuses. `status` and
   * `isHistorical` travel with it so the two consumers can narrow it
   * differently, which they do:
   *
   *   • `score` accepts all three statuses. That is the point.
   *   • a payment credit is owned only when `status === "COMPLETED"` and
   *     `!isHistorical`, which is exactly the shipped selector
   *     (`route.ts:3801-3803`). See `admin-ops-engine-batch.ts`.
   *
   * ONE DELIBERATE NARROWING vs the shipped score path: it filters
   * `redScore: null, yellowScore: null` in SQL and then takes the most
   * recent ENDED row, so it walks BACK past a scored match to an older
   * unscored one. This does not: it takes the most recent ended match
   * whatever its score, and `handleScore` refuses to overwrite a result
   * that is already recorded. Owning less on purpose — a score landing
   * on a match two weeks older than the one the group is talking about
   * is a worse outcome than nobody recording it.
   *
   * (Until §10 step 8 that read "…than the analyzer keeping the
   * message", and the alternative really was a second recorder. It is
   * not any more: `analyzeBatch` is deleted, so "owning less" here means
   * the result is not written at all and an admin is told on the
   * operator DM. The narrowing is still the right call —
   * `route.ts:3462`'s "losing the score entirely is a worse failure
   * mode" is about losing it, not about mis-filing it — but it is now a
   * choice between two losses rather than between a loss and a
   * fallback.)
   */
  completedMatch: {
    id: string;
    /**
     * Pre-formatted kickoff ("Tue 21:30"), same shape as the upcoming
     * match's. The RESULT answer prints it so a reader can tell which
     * night MatchTime is talking about: this field is the most recent
     * ENDED match, and "did we win on tuesday?" asked on a Thursday
     * would otherwise get a confident number about a different game
     * with nothing to say so.
     */
    kickoffLabel: string;
    status: "TEAMS_GENERATED" | "TEAMS_PUBLISHED" | "COMPLETED";
    /** A seeded backfill rather than a match this group played through
     *  MatchTime. Never a payment-credit target. */
    isHistorical: boolean;
    redScore: number | null;
    yellowScore: number | null;
    participantUserIds: string[];
  } | null;
  /** Appearances per user across completed matches, for stats answers
   *  that today cost a whole extra LLM call. */
  appearances: Array<{ userId: string; matches: number }>;
  /**
   * How many days back `appearances` was counted over.
   *
   * CARRIED RATHER THAN ASSUMED, because the composer has to SAY it. The
   * loader's window is 30 days (`load-state.ts`'s `LOOKBACK_DAYS`) and
   * the question people actually ask is "who's been most consistent this
   * SEASON?" — measured live on 2026-09-09, where the answer was three
   * players tied on two appearances each. Counting a month and calling
   * it a season is a quiet wrong answer, and the fix is to name the
   * window in the sentence.
   *
   * It is a FIELD and not a constant in `compose.ts` because that module
   * cannot import `load-state.ts` (Prisma; see its header), so the only
   * two ways to print the number are to carry it or to duplicate it. A
   * duplicated window would drift the day the loader's changes, and the
   * drift would be invisible: a correct-looking sentence about the wrong
   * month.
   */
  appearanceWindowDays: number;
  /** MatchTime's own most recent post in the group, verbatim. A known
   *  object, not a guess: it is how a bare "Confirmed" resolves. */
  lastBotPost: string | null;
  features: {
    attendance: boolean;
    paymentTracking: boolean;
    statsQa: boolean;
    /** The per-org gate `route.ts:3113-3121` maps `reminder_request`
     *  onto. A MoM-and-ratings-only org has it off, and MatchTime must
     *  not queue a reminder DM for one. */
    reminders: boolean;
  };
  /** Smaller formats the org has configured, for the options answer.
   *  Totals across both teams (`playersPerTeam * 2`). */
  smallerFormats: Array<{ sportName: string; totalPlayers: number }>;
  /** Players already asked for a guest's name for this match — the
   *  one-ask-per-player-per-match dedupe key of `guest-name-ask.ts`. */
  guestAskedUserIds: string[];
  /**
   * WHO HAS NOT PAID — and `null` on almost every batch, deliberately.
   *
   * ⚠️ THE ONLY FIELD ON THIS INTERFACE THAT `loadSquadState` DOES NOT
   * FILL. Every other field is loaded on EVERY batch, including the 69%
   * that are banter, so a payment query in the loader would be two more
   * round trips per joke. `answer-batch.ts` loads state, extracts, and
   * only then knows which topics are in the window — so it does one
   * targeted load AFTER extraction and only when a `payments` topic
   * survived ownership, and hands the result down as data.
   *
   * That is why this is a snapshot and not a lazy accessor:
   * `compose.ts` must stay free of Prisma (its header says why — the
   * Playwright worker never loads it), so a function on state that goes
   * to the database is not available at all. Data in, strings out.
   *
   * `null` therefore means NOT LOADED, never "nothing to report" —
   * `PaymentSnapshot` has its own shapes for those. The composer treats
   * a null under an `answer_payments` intent as an operator note and
   * says nothing, which makes `answer-batch.ts` disown the message.
   */
  payments: PaymentSnapshot | null;
}

// ── What the engine hands back ─────────────────────────────────────────

export type ProposedWrite =
  | {
      kind: "attendance";
      userId: string;
      name: string;
      status: AttStatus;
      /** True only when a human ASKED for the bench. Drives the PR #27
       *  invariant: a BENCH row means "full" or "asked", never
       *  "a classifier inferred it". */
      explicitBench: boolean;
      /** Straight from the bench into the squad, skipping the 👍 step.
       *  Authorised by `promote-authorization.ts`, never by a model. */
      promote: boolean;
      sourceMessageId: string;
      reason: string;
    }
  | {
      kind: "open_bench_offer";
      replacingUserId: string;
      offeredToUserIds: string[];
      sourceMessageId: string;
      reason: string;
    }
  | {
      kind: "resolve_bench_offer";
      offerId: string;
      claimedByUserId: string;
      sourceMessageId: string;
      reason: string;
    }
  | {
      /**
       * RUN THE BALANCER AND POST THE LINE-UPS — §10 step 8's carve-out
       * for the club's most-used command. 23 occurrences in 120 days on
       * Sutton FC, more than every question shape combined, so deleting
       * the mega-prompt without an owner for it would have taken the
       * feature with it. The prompt IS deleted now, so this write and
       * `team-ops-engine-batch.ts` are the whole of "generate the
       * teams".
       *
       * ONE write rather than a `generate` plus a handful of
       * `attendance` writes, deliberately. The force-include is
       * capacity-BLIND — "generate the teams including Ibrahim"
       * overrides the format rather than queueing behind it — so it has
       * none of the bench ordering, offer resolution or promotion
       * authorisation `kind: "attendance"` carries, and routing it
       * through that apply layer would silently acquire all of them.
       * `team-ops-engine.ts` applies this, and nothing else does.
       *
       * Every name here is ALREADY RESOLVED. `engine.ts` resolves
       * against `SquadState` so the decision is auditable and pure; the
       * apply layer translates and never re-litigates.
       */
      kind: "generate_teams";
      /** Rows to flip to CONFIRMED before balancing: the resolved user,
       *  the display name for the "_Including …_" prefix, and the
       *  ORIGINAL wording for the `AttendanceEvent` note. */
      forceInclude: Array<{ userId: string; name: string; ref: string }>;
      /** Include references that resolved to nobody. Reported to the
       *  group ("couldn't find … — ignored"), never dropped silently. */
      unmatchedIncludes: string[];
      /** Absolute team pins, from `swaps` AND from resolved pairings. */
      pinned: Array<{ userId: string; name: string; team: "RED" | "YELLOW" }>;
      /** Pin references that resolved to nobody. */
      unmatchedPins: string[];
      /** Per-match display names, when the message supplied both. */
      teamNames: [string, string] | null;
      sourceMessageId: string;
      reason: string;
    }
  | {
      kind: "score";
      matchId: string;
      red: number;
      yellow: number;
      sourceMessageId: string;
      reason: string;
    }
  | {
      kind: "payment_credit";
      payerUserId: string;
      payerName: string;
      count: number;
      coveredUserIds: string[];
      /**
       * Did the message NAME the people covered, or just give a number?
       *
       * The shipped path branches on exactly this (`route.ts:3841-3886`)
       * and the two branches are different writes: named → stamp
       * `Attendance.paidAt` per row and create NO `PaymentCredit`
       * (double-counting is the failure); a bare count → one
       * `PaymentCredit` row. Inferring it from
       * `coveredUserIds.length > 0` would be wrong in the one case that
       * matters — a message that names two people, neither of whom
       * resolves, would silently become an aggregate credit for a number
       * nobody checked. The engine refuses that case outright, and this
       * flag is what lets the apply layer tell the two apart without
       * re-reading the facts.
       */
      namedCovered: boolean;
      sourceMessageId: string;
      reason: string;
    }
  | {
      kind: "reminder";
      userId: string;
      /** The words as written ("on Monday"), kept for the audit trail.
       *  Nothing downstream parses it — `sendAt` is what is queued. */
      phrase: string;
      /**
       * The resolved instant, in UTC. §3.2 S22 gives the calendar
       * arithmetic to `date-fns-tz` and NOT to the model; `resolveReminderPhrase`
       * is where that happens and it is a pure function of
       * `(phrase, now)`. A phrase it cannot resolve produces no write at
       * all, so this is never a guess.
       */
      sendAt: Date;
      /** "Mon 8 Sep at 18:00" — London, rendered once, by the resolver
       *  that knows whether a time of day was actually stated. */
      whenLabel: string;
      /** What the reminder is ABOUT, for the body of the DM. Falls back
       *  to the message itself when the extractor named nothing, which
       *  is always better than an empty nudge. */
      note: string;
      sourceMessageId: string;
      reason: string;
    }
  | {
      /**
       * A DM blast to players from recent matches. NOT applied beside
       * the other writes, and that is the whole point of modelling it —
       * see `admin-ops-engine-batch.ts`'s `recruitRequest` outcome
       * field. The 2026-09-01 incident was the blast running BEFORE the
       * batch's attendance writes landed, so it counted a squad that the
       * same message was about to change and told the owner it was full.
       * The engine decides WHO may ask; the route decides WHEN it fires,
       * which is after everything else in the batch.
       */
      kind: "recruit_blast";
      /** Already clamped to `[1, RECRUIT_LOOKBACK_MAX]` by the engine.
       *  `null` means "use `LOOKBACK_MATCHES`", the shipped default. */
      lookbackMatches: number | null;
      sourceMessageId: string;
      reason: string;
    }
  | {
      /**
       * A personal-stats-link DM to EVERY active member — the widest
       * mass DM in the product (69 people on Sutton FC), and until
       * 2026-09-10 the last one still fired by a regex. Modelled exactly
       * like `recruit_blast` and for the same reason: the engine decides
       * WHO may ask, the route decides WHEN it runs and performs it, and
       * the copy is composed from what actually landed.
       *
       * It carries no parameters at all. There is no lookback and no
       * count for a model to widen: the recipient list is "every active
       * member with a phone", read from the database by the route. The
       * only thing the model contributes is "this message asks for it",
       * and `lib/stats-blast.ts` explains what stands between that and a
       * DM.
       */
      kind: "stats_blast";
      sourceMessageId: string;
      reason: string;
    };

/**
 * What the bot wants to SAY, as structure. The engine never writes copy;
 * the composer renders these against the projected state, so every name
 * and every number in an outgoing message is read from the world after
 * the writes land rather than authored by anyone (§6.4).
 */
export type SpeechIntent =
  /** The one authoritative squad post for the batch (§3.2 S36). */
  | { kind: "squad_status"; messageId: string | null }
  | { kind: "guest_name_ask"; messageId: string; askerName: string | null; body: string }
  | { kind: "answer_bench"; messageId: string }
  | { kind: "answer_count"; messageId: string; statedCount: number | null }
  /**
   * "who's playing / list the players / show me the squad" — the ROSTER,
   * rendered by `composeSquadStatusPost`.
   *
   * Split from `answer_count` on 2026-09-06. Both topics shared one
   * intent, so "list the players" was answered "We're 6/14 for Tue
   * 21:30, need 8 more 🙏" — the right answer to a different question,
   * with not one name in it. It read correctly in production only
   * because `route.ts:2393` swapped the string for the roster post, and
   * §6.4's whole claim is that the composer produces the final words.
   */
  | { kind: "answer_squad"; messageId: string }
  /** kickoff time and venue, and nothing else — see `QuestionTopic`. */
  | { kind: "answer_fixture"; messageId: string }
  | { kind: "answer_person_status"; messageId: string; personRef: string; userId: string | null }
  | { kind: "answer_phones"; messageId: string }
  | { kind: "answer_stats"; messageId: string }
  /**
   * The RESULT of the last match played. Carries no numbers: the
   * composer reads `state.completedMatch` and renders one of three
   * sentences (a result, "nobody reported one", "we haven't played
   * one"). The engine deliberately does not branch on which — see the
   * engine's `case "score"`.
   */
  | { kind: "answer_score"; messageId: string }
  /**
   * How many have not paid for the last settled match. Carries no count
   * and no name: the composer reads `state.payments`, which is a
   * `PaymentSnapshot` and has no field a name could come out of.
   */
  | { kind: "answer_payments"; messageId: string }
  | { kind: "answer_options"; messageId: string }
  | { kind: "teams_post"; messageId: string }
  /**
   * Asked to show the teams when none have been generated.
   *
   * `formatTeamsPost` over two empty arrays renders a team sheet with
   * nobody on it, which the 2026-09-06 sweep produced verbatim. The
   * shipped path already has the right answer for this
   * (`route.ts:3711-3714`, "do NOT auto-generate"); this is that answer,
   * as an intent, so the empty post cannot be composed at all.
   */
  | { kind: "teams_not_generated"; messageId: string }
  | { kind: "score_ack"; messageId: string; red: number; yellow: number }
  | { kind: "payment_ack"; messageId: string; payerName: string; count: number }
  /** `whenLabel` is the RESOLVED time ("Mon 8 Sep at 18:00"). The
   *  composer must never echo the raw phrase back at a player as if it
   *  were a confirmation — "I'll nudge you on Monday" is not a promise
   *  anybody can check, and `route.ts:3986-3992` already says the
   *  resolved label out loud for exactly that reason. */
  | { kind: "reminder_ack"; messageId: string; phrase: string; whenLabel: string | null }
  | { kind: "bench_offer_open"; messageId: string; replacingName: string }
  /** A resolved "Confirmed" whose writes were all idempotent. Saying
   *  nothing there is the silent-no-op failure in miniature. */
  | { kind: "pending_confirmed_ack"; messageId: string; userIds: string[] }
  /** A bench player answered an open offer and the slot had already
   *  gone. Silence there is the 2026-05-19 Karahan shape. */
  | { kind: "bench_claim_too_late"; messageId: string; userId: string }
  /**
   * PART of an instruction was applied and part of it needed a tag
   * MatchTime did not get (2026-09-08, the David incident).
   *
   * `entries` are RESOLVED ROSTER NAMES, never the reference a model
   * produced, and the engine only emits this beside a write it actually
   * proposed: the sentence rides a turn MatchTime is already taking, so
   * it adds no unprompted chatter to an untagged message. A partially
   * applied instruction nobody is told about is §9's signature failure
   * with the volume turned down.
   */
  | {
      kind: "needs_tag_for_rest";
      messageId: string;
      entries: Array<{ name: string; action: "OUT" | "BENCH" }>;
    }
  /** Something failed and the bot says so rather than going quiet. */
  | { kind: "degraded"; messageId: string; reason: string };

export type Disposition = "acted" | "noop" | "degraded";

/**
 * EXACTLY ONE per input message id, always. §3.2 S1's incident (Ibrahim
 * and Baki, 2026-05-25) was two clear drops silently omitted from the
 * verdict array; the prompt grew a 272-token VERDICT COVERAGE banner to
 * ask the model not to do it again. Here it is a post-condition asserted
 * in code, and `assertCoverage` throws if it is ever violated.
 */
export interface MessageOutcome {
  messageId: string;
  route: Route;
  disposition: Disposition;
  /** Machine-readable, one per rule that fired. Never prose for a regex
   *  to parse later — these are for humans and for triage queries. */
  reasons: string[];
  writes: ProposedWrite[];
  react: string | null;
}

export interface Degradation {
  stage: "router" | "extractor" | "engine" | "composer" | "state";
  messageId: string | null;
  /** Loud on purpose. Four seatbelts were found dead on 2026-08-31, all
   *  silent, all with comments claiming they worked. */
  detail: string;
}

export interface EngineResult {
  outcomes: MessageOutcome[];
  writes: ProposedWrite[];
  /** The world as it WOULD be after the writes. The composer reads this,
   *  never the model's memory. In dry-run it is the only "database". */
  nextState: SquadState;
  speech: SpeechIntent[];
  degradations: Degradation[];
}

// ── Stage 3 input ──────────────────────────────────────────────────────

export interface EngineMessage {
  id: string;
  body: string;
  /** Resolved sender, or null for an unknown pushname / opaque @lid. */
  senderUserId: string | null;
  senderName: string | null;
  /** Did this message @-mention the bot? The interaction-contract signal. */
  tagged: boolean;
  /**
   * Did it mention the bot EXPLICITLY — the Pi's structured signal, or a
   * literal "@" in front of the name? `messageMentionsBotExplicitly`.
   *
   * ⚠️ A SECOND, STRICTER TAG FIELD, AND IT EXISTS BECAUSE OF ONE
   * MESSAGE. `tagged` is `messageTagsBot`, which counts the bare word
   * "matchtime" ANYWHERE in a body — so the sentence that queued 69 mass
   * DMs on 2026-09-10 ("…the link from Matchtime DM'ed to you…") is
   * `tagged: true`. For an ANSWER that looseness is right and hardened
   * in on purpose; in front of a mass DM it is not a gate at all.
   *
   * ONLY the bulk-DM commands read this. Optional so no caller is forced
   * to learn a field it does not use: when it is absent the engine
   * derives it from the body, which is safe because the Pi rewrites a
   * real bot @-mention into the literal "@Match Time" in the text.
   */
  taggedExplicitly?: boolean;
  route: Route;
  facts: Facts;
  /** Set when a stage above failed for this message. The engine must
   *  surface it, never swallow it. */
  degraded?: string | null;
}

export interface EngineInput {
  messages: EngineMessage[];
  state: SquadState;
  /** Injected so the engine stays pure (no clock). */
  now: Date;
}

// ── The shadow payload ─────────────────────────────────────────────────

/**
 * What the dry run persists to `WindowVerdict.verdictJson`.
 *
 * The first four fields are EXACTLY the 2026-05-29 `WindowVerdict`
 * shape, so `/admin/shadow` renders a v2 row with no change at all. The
 * last two are the detail that shape cannot hold, and are what §10 step
 * 3's go/no-go is actually read from.
 */
export interface WindowShapedVerdict {
  windowSummary: string;
  stateChanges: Array<{
    action: "drop" | "add" | "bench";
    targetName: string;
    targetUserId: string;
    reason: string;
  }>;
  reactions: Array<{ waMessageId: string; emoji: string; kind: string }>;
  groupReply: string | null;
  pipeline: "dryrun-v2";
  proposal: Record<string, unknown>;
}
