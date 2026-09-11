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
 * WHAT THE EXTRACTOR IS DELIBERATELY NOT TOLD: the squad state. If it
 * could see that the squad is full it could infer `polarity: "bench"`
 * from capacity, and PR #27's invariant ("a BENCH row means FULL or
 * ASKED, never inferred") would be back inside the model. Capacity is
 * arithmetic; arithmetic is the engine's job.
 */
import { anthropicModel, degradation, extractJson, EXTRACTOR_MODEL, type ModelRequest, type PipelineModel } from "./llm";
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
  TeamFacts,
  Tense,
} from "./types";

const EXTRACTOR_MAX_TOKENS = 1_024;

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
      return "none";
  }
}

// ── Prompts ────────────────────────────────────────────────────────────

export const EXTRACTOR_PROMPTS: Record<Exclude<ExtractorKind, "none">, string> = {
  attendance: `You read ONE message from a football club's WhatsApp group and report what it SAYS about who is playing. You report facts about the text. You never decide what should happen.

For each attendance claim in the message, return:
  subject      "sender" if the claim is about the person who typed it, "other" for anyone else
  personRef    the words used for that person, VERBATIM. Never invent or expand a name. "" for the sender.
  personNamed  true when the words IDENTIFY A PARTICULAR PERSON: a name, a nickname, or an @mention. false ONLY for a relationship, a quantity or an indefinite: "my brother", "2 of my guys", "someone", "a mate", "another keeper"
  polarity     "in" joining, "out" leaving, "bench" only when the bench is EXPLICITLY asked for ("in, for bench"). Never guess "bench" from how full the squad is: you are not told the squad.
  contingent   true if the commitment depends on something ("if you're short", "if my back holds up", "happy to drop if you find someone")
  conditionOn  "squad" if the condition is about the squad or the team's needs, "self" if it is about the person themselves, otherwise "none"
  tense        "present" now, "future" a commitment about an upcoming match INCLUDING a standing one ("count me in whenever you are short"), "past" reporting something that already happened ("I was in last week"), "hypothetical" a counterfactual about something that is not the case ("if I WAS in the team it would not be ruined"). A condition attached to a real future commitment is NOT hypothetical: use future and set contingent
  basis        what the message DOES about the person's place. Read the VERB the message uses about that person, and nothing else:
                 the verb acts on the SQUAD — it asks for, claims, or gives up a place: "I'm in", "put me down", "stick me down", "count me in", "add me", "I'll take a spot", "I'll be the 14th", "count me as the 14th", "consider me as the 14th", "happy to fill in", "I'll be there", "I'm out", "can't make it" -> "decision"
                 the verb acts on the PERSON — it describes their own state, whereabouts or ability, and leaves their place unanswered: "I'm free", "I'm around", "I'm available", "I'm about", "I will be back Tuesday week", "I land Monday", "I'm away that week", "I'm free after the 5th" -> "availability"
               A courtesy on the END of a state description does not promote it into a decision. "if you need me", "if you're short", "if you're stuck", "let me know", "give me a shout" are offers of goodwill, not asks for a place: the person has told you where they will be, not asked to be put in. The verb in front decides; the courtesy behind never does. These four are settled, and they are settled this way:
                 "I'm free Tuesday if you need me"          -> availability, the verb is "I'm free"
                 "I'm around if you're short"               -> availability, the verb is "I'm around"
                 "put me down if you're short"              -> decision, "put me down" asks for the place
                 "count me as the 14th if you need one"     -> decision, "count me as the 14th" claims the place
               When a message carries BOTH, the place verb wins: "I'm free Tuesday, put me down" is a decision.
               Naming a day settles nothing either way: "I'm in for next Tuesday" names a day and is a decision; "I will be back Tuesday week" names a day and is not.
  reported     true when relaying what someone else said ("Najib said he's in")
  confidence   0 to 1

Also return:
  affirmation  "yes" or "no" when the message is a bare answer to MatchTime's own last post ("Confirmed", "yes", "no"), otherwise "none"
  sideRequests any of: "recruit" (asks for a replacement or more players for a specific gap), "chase" (a general nudge for more players that says nothing about the sender's own place)

A message can carry SEVERAL claims and a side request at once. Report all of them. "I'm out, anyone able to replace me?" is one claim plus "recruit". "I'm in, and my brother can play too" is TWO claims.

Asking for cover is NOT a condition. Someone asking whether anyone can replace them, or saying they need covering, is leaving either way: report the out with contingent FALSE, plus the "recruit" side request. Report contingent true ONLY when the message states something the claim itself depends on, in the message: "happy to drop IF you find someone", "in IF my back holds up".

An OFFER to give up a place is contingent even with no "if" in it. "I can drop out", "happy to pull out", "I'll step aside", "I can make room", "happy to drop for X" — the person is offering, not leaving, and the offer depends on it being taken up. Report polarity out with contingent TRUE and conditionOn "squad". Compare: "I'm out", "can't make it", "I won't be there" state a decision already taken — contingent FALSE. The test is whether the message says the sender IS leaving or that they COULD.

Banter still contains claims. "Zeeshan is out lol vote him out" DOES claim Zeeshan is out. Report it as written; whether it is a joke is decided elsewhere with information you do not have.

Report nothing (an empty claims array) only when the message genuinely makes no claim about anyone's attendance.`,

  question: `You read ONE question from a football club's WhatsApp group and classify what it asks for. You never answer it.

  topic        "squad" who is playing — asks for the NAMES ("who's in?", "list the players", "show me the squad", "who's playing tonight?")
               "bench" who is on the bench
               "count" HOW MANY are in, how many more are needed, is that enough — asks for a NUMBER, including a stated one to check ("we're 9/14 right?", "how many spots left?", "do we have enough?")
               "person_status" whether a specific named person is playing
               "phones" who has a phone number on record
               "fixture" the match itself: whether it is on, what time it kicks off, where it is played ("what time is kickoff?", "where are we playing?", "are we playing tuesday?", "is the game still on?", "same place as usual?")
               "payments" who has or has not paid their match fee, how many are still outstanding ("who hasn't paid?", "has everyone paid for last week?", "how many still owe?", "any payments outstanding?"). NOT how much the fee IS — that is "other".
               "score" the RESULT of a match that has already been played ("what was the score?", "did we win on tuesday?", "how did we get on last night?", "what did it finish?")
               "rating_progress" how many people have SUBMITTED their ratings or Man-of-the-Match votes for the match just played, or who has not submitted yet ("who hasn't rated yet?", "how many have rated so far?", "who still needs to pick a MoM?", "any ratings outstanding from tuesday?", "is everyone done rating")
               "stats" how OFTEN someone plays, or how they rate, ACROSS matches — appearances, form over a run of games, most consistent, man of the match. Never the RESULT of a single match: "did we win?" and "what was the score?" are "score", not "stats".
               "options" what to do about being short (smaller format, alternatives)
               "other" anything else
  personRef    the person the question is about, verbatim, or "" when it names nobody
  statedCount  a number the message ASSERTS about the squad, or -1 when it asserts none

"squad" and "count" are the same subject asked two ways, and the answers look nothing alike: "squad" gets a list of names, "count" gets a number. Choose on what the asker wants BACK, not on what the question is about. If it asks WHO, it is "squad"; if it asks HOW MANY, it is "count".

"rating_progress" is about the ACT of rating, not about anybody's numbers, and it is a QUESTION the asker wants answered. If the message tells the PLAYERS to go and rate, thanks them for rating, or remarks on ratings, it is "other" — it asks you for nothing, however many times it says rate, ratings, players or MoM.

  "@Match Time who hasn't rated yet?"                                        -> rating_progress
  "@Match Time how many have picked a MoM so far"                            -> rating_progress
  "please do not forget to rate the players via the link from Matchtime DM'ed to you. the more accurate ratings, the more balanced teams next time" -> other, it instructs the players
  "lads don't forget to rate each other from tuesday"                        -> other, it instructs the players
  "@Match Time who has the best rating this season"                          -> stats, that is a number across matches
  "@Match Time can you remind everyone to rate"                              -> other, that asks for a reminder, not for the tally`,

  teams: `You read ONE message about the two team line-ups and report what it asks for. You never pick the teams.

  action       "show" re-post the teams that already exist, unchanged
               "generate" work out new teams ("generate the teams", "regenerate", "make the teams", "set up the teams again", "come up with an alternative")
               "rename" change the NAMES of the existing teams and leave the line-ups exactly as they are
               "swap" move named players between the two teams, leaving everyone else where they are
  includeRefs  names the message says to include, verbatim
  teamNames    the two names the message SUPPLIES, in order, or an empty array
  swaps        for "swap": each named person and the team they should be on ("RED" or "YELLOW")
  pairings     people the message says must be on the SAME team as each other, verbatim, one array per group ("put me and David on the same team" -> [["me","David"]]). Empty when the message names no such pair.

Choose the action on what would have to CHANGE. If the line-ups have to be worked out again, it is "generate" — even when the message also asks for new names, and even when it says "again", "once more" or "instead". "rename" is ONLY for a message that wants the SAME two line-ups under different names. A message that asks you to invent names while generating is "generate": leave teamNames empty, because it supplies none.

A person the message says to include ("generate the teams, Ibrahim is playing") goes in includeRefs. A person the message puts on a NAMED side ("put David in Red") goes in swaps. A person the message puts WITH somebody rather than on a side goes in pairings. The sender may refer to themselves as "me", "myself" or "I" — keep that word verbatim; do not guess their name.`,

  score: `You read ONE message reporting a football result and return the two numbers, in the order the teams are named in the message. first = the first team mentioned, second = the other. Nothing else.`,

  admin: `You read ONE instruction to the bot and report what it says.

  action       "bulk_payment" someone paid for several players
               "reminder" the sender wants to be reminded, at a time
               "recruit" the sender is asking the bot to CONTACT or INVITE players who are not registered yet — "message the lads from the last few games", "DM everyone who played recently and invite them", "ask the regulars if they can play", "we need more players, can you round some up"
               "stats_blast" the sender is INSTRUCTING YOU to send every player their own stats or ratings link — "send everyone their stats", "DM the squad their ratings", "share the stats links with the lads"
               "other"
  payerRef     for bulk_payment: who paid, verbatim. "" when not applicable
  count        for bulk_payment: how many players they paid for. 0 when not applicable
  coveredRefs  for bulk_payment: the specific people covered, verbatim, if named
  phrase       for reminder: the time phrase EXACTLY as written ("on Monday", "tomorrow at 6"). Do not convert it to a date. "" when not applicable
  note         for reminder: WHAT to remind them about, in their own words ("bring the bibs"). "" when the message names nothing to remember
  lookbackMatches  for recruit: how many recent matches the message says to draw players from ("the last 5 matches" -> 5, "the last couple of games" -> 2). 0 when the message names no number.

"recruit" is about reaching people OUTSIDE the current squad. A message asking to SHOW, LIST or COUNT the players already registered is not recruit — that is "other".

"stats_blast" is a message that tells YOU to send something to every player. Ask who is being told to do the work. If the sender is telling the PLAYERS to do something — to rate each other, to check a link, to click the one they already have, to not forget something — it is "other", however many times it says stats, ratings, players, DM or everyone. A message can be ABOUT the stats links without asking you to send them.

  "@Match Time send everyone their stats"                                      -> stats_blast
  "@Match Time can you DM the squad their ratings links"                       -> stats_blast
  "lads don't forget to rate the players via the link MatchTime DM'ed you"     -> other, it instructs the players
  "the more accurate the ratings, the more balanced the teams"                 -> other, it is a remark
  "did everyone get their stats link?"                                         -> other, it is a question
  "@Match Time what are my stats"                                              -> other, one person asking about themselves`,
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
    sideRequests: { type: "array", items: { type: "string", enum: ["recruit", "chase"] } },
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
        "stats",
        "options",
        "other",
      ],
    },
    personRef: { type: "string" },
    statedCount: { type: "number" },
  },
  required: ["topic", "personRef", "statedCount"],
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
  },
  required: ["action", "includeRefs", "teamNames", "swaps", "pairings"],
  additionalProperties: false,
} as const;

const SCORE_SCHEMA = {
  type: "object",
  properties: { first: { type: "number" }, second: { type: "number" } },
  required: ["first", "second"],
  additionalProperties: false,
} as const;

const ADMIN_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["bulk_payment", "reminder", "recruit", "stats_blast", "other"],
    },
    payerRef: { type: "string" },
    count: { type: "number" },
    coveredRefs: { type: "array", items: { type: "string" } },
    phrase: { type: "string" },
    note: { type: "string" },
    // 0 is the schema's stand-in for null, the same convention
    // `statedCount` uses. A nullable number is rejected by the API.
    lookbackMatches: { type: "number" },
  },
  required: ["action", "payerRef", "count", "coveredRefs", "phrase", "note", "lookbackMatches"],
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
  "stats",
  "options",
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
        .filter((s): s is SideRequest => s === "recruit" || s === "chase");
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
      const first = raw.first;
      const second = raw.second;
      if (typeof first !== "number" || typeof second !== "number") {
        bad(`score extractor returned non-numeric values`);
        return { facts: { kind: "none" }, degradations };
      }
      const facts: ScoreFacts = { kind: "score", first, second };
      return { facts, degradations };
    }

    case "admin": {
      const action = str(raw.action).toLowerCase();
      if (!["bulk_payment", "reminder", "recruit", "stats_blast", "other"].includes(action)) {
        bad(`unknown admin action "${str(raw.action)}"`);
        return { facts: { kind: "none" }, degradations };
      }
      const facts: AdminFacts = {
        kind: "admin",
        action: action as AdminFacts["action"],
        ...(typeof raw.payerRef === "string" && raw.payerRef ? { payerRef: raw.payerRef } : {}),
        ...(typeof raw.count === "number" && raw.count > 0 ? { count: raw.count } : {}),
        ...(Array.isArray(raw.coveredRefs)
          ? { coveredRefs: raw.coveredRefs.map(str).filter(Boolean) }
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
}

export interface ExtractionResult {
  facts: Facts;
  degradations: Degradation[];
  usage?: { costUsd: number | null; ms: number; inputTokens: number; outputTokens: number };
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
  if (msg.lastBotPost) {
    context.push(`MATCHTIME'S LAST POST: ${msg.lastBotPost}`);
  }
  context.push("");
  context.push(
    `THE MESSAGE (from ${msg.authorName ?? "(unknown)"}${msg.tagged ? ", who tagged the bot" : ""}):`,
  );
  context.push(msg.body);

  const req: ModelRequest = {
    model: EXTRACTOR_MODEL,
    system: EXTRACTOR_PROMPTS[kind],
    user: context.join("\n"),
    maxTokens: EXTRACTOR_MAX_TOKENS,
    schema: SCHEMAS[kind],
    label: `extractor:${kind}`,
    // THINKING OFF. Measured, not assumed — see `llm.ts`'s
    // `ModelRequest.thinking` and `__tests__/thinking-off.test.ts`. On a
    // self-contradictory message, adaptive thinking spent the whole
    // token budget and returned no JSON at all, 5 runs of 5, against the
    // live club. An extractor that deliberates would be the
    // mega-prompt's failure mode reappearing one layer down — the prompt
    // is deleted (§10 step 8), the failure mode is not — and §6.2's
    // contract is "FACTS about the text only".
    thinking: "off",
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
