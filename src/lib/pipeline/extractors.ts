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
  basis        what the message DOES about the person's place. "decision" it says they are playing or not playing: "I'm in", "count me in", "I'm out", "can't make it", "I'll be there". "availability" it reports where they will be or what they can do, and leaves the question unanswered: "I will be back Tuesday week", "I land Monday", "I'm away that week", "I'm free after the 5th", "I'm around if you need me". The test is whether someone reading the message alone would know the person's answer, or only their circumstances. "I'm in for next Tuesday" names a day and is still a decision; "I will be back Tuesday week" names a day and is not
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

  topic        "squad" who is playing / show the list
               "bench" who is on the bench
               "count" how many are in, including a stated number to check ("we're 9/14 right?")
               "person_status" whether a specific named person is playing
               "phones" who has a phone number on record
               "stats" form, appearances, most consistent, man of the match
               "options" what to do about being short (smaller format, alternatives)
               "other" anything else
  personRef    the person the question is about, verbatim, or "" when it names nobody
  statedCount  a number the message ASSERTS about the squad, or -1 when it asserts none`,

  teams: `You read ONE message about the two team line-ups and report what it asks for. You never pick the teams.

  action       "show" re-post the teams that already exist
               "generate" work out new teams
               "rename" change the team names
               "swap" move named players between the two teams
  includeRefs  names the message says to include, verbatim
  teamNames    the two new names, in order, or an empty array
  swaps        for "swap": each named person and the team they should be on ("RED" or "YELLOW")`,

  score: `You read ONE message reporting a football result and return the two numbers, in the order the teams are named in the message. first = the first team mentioned, second = the other. Nothing else.`,

  admin: `You read ONE instruction to the bot and report what it says.

  action       "bulk_payment" someone paid for several players
               "reminder" the sender wants to be reminded
               "other"
  payerRef     for bulk_payment: who paid, verbatim. "" when not applicable
  count        for bulk_payment: how many players they paid for. 0 when not applicable
  coveredRefs  for bulk_payment: the specific people covered, verbatim, if named
  phrase       for reminder: the time phrase EXACTLY as written ("on Monday", "tomorrow at 6"). Do not convert it to a date. "" when not applicable`,
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
      enum: ["squad", "bench", "count", "person_status", "phones", "stats", "options", "other"],
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
  },
  required: ["action", "includeRefs", "teamNames", "swaps"],
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
    action: { type: "string", enum: ["bulk_payment", "reminder", "other"] },
    payerRef: { type: "string" },
    count: { type: "number" },
    coveredRefs: { type: "array", items: { type: "string" } },
    phrase: { type: "string" },
  },
  required: ["action", "payerRef", "count", "coveredRefs", "phrase"],
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
      if (!["bulk_payment", "reminder", "other"].includes(action)) {
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

  const context: string[] = [];
  if (msg.history.length > 0) {
    context.push("RECENT CHAT (context only, never extract from it):");
    for (const h of msg.history.slice(-8)) {
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
  };

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
    // §11.4: on extractor failure, fail CLOSED — but say so. The
    // existing partial-response admin DM is the surface for this, and
    // under the new design it matches a typed error rather than
    // prefix-matching free-text `reasoning`, which is what it always
    // wanted to be.
    return {
      facts: { kind: "none" },
      degradations: [
        degradation("extractor", msg.id, `${kind} extractor failed: ${(err as Error).message}`),
      ],
    };
  }
}

export function defaultExtractorModel(): PipelineModel {
  return anthropicModel();
}
