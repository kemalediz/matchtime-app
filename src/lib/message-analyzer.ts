/**
 * THE SCHEDULED-CHASE COMPOSER, and what is left of the analyzer.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE NAME OF THIS FILE IS NOW WRONG (§10 step 8, 2026-09-06)
 * ─────────────────────────────────────────────────────────────────────
 *
 * It was "smart WhatsApp message analysis — the LLM pass that classifies
 * EVERY message from a monitored group". All of that is deleted.
 * Reactive per-message analysis is now `src/lib/pipeline/` (router →
 * extractors → engine → composer) and its owners; the markers left in
 * place below say which section went where, and
 * `MDs/analyzer-redesign-2026-08-31.md` §3.2 is the full map.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHAT IS LEFT, AND WHY IT IS STILL HERE
 * ─────────────────────────────────────────────────────────────────────
 *
 *   composeChaseText / composeChaseFromMatch
 *     The SCHEDULED chase. The bot scheduler decides WHEN (the 17:00
 *     squad update, the match-day morning, 3 to 4 hours before kickoff,
 *     about 2 hours before) and this reads the squad and builds the post.
 *
 *     REWRITTEN 2026-10-20 (MDs plan "Sonnet 5 prompts: rewrite, then
 *     move to Haiku 5.5", item 6). Code renders the post: the squad list
 *     is `buildSquadRosterBlock`, the format-switch line is the server's
 *     own, and the model writes only the opening line, from facts code
 *     states (`chase-lead.ts`). A line the model gets wrong, or no line
 *     at all, is replaced by the fixed copy of that chase, so the post
 *     always goes out and every number and name in it comes from the
 *     rows. Before this, the model was asked for the whole post (drum
 *     rows, bench block, a verbatim switch line, a guessed "tentative"
 *     line) and the scheduler cut its roster back out when the group had
 *     just seen one.
 *
 *   enforceProximity
 *     Rewrites "tonight" when the match is days away, and the
 *     20:30-vs-21:30 BST/UTC slips. MOVED to `./proximity` (pure) and
 *     re-exported here: `analyze/route.ts` applies it to every outgoing
 *     reply, whatever composed it.
 *
 *   sanitiseTeamNames
 *     Pure, and `team-generation.ts`'s, not the analyzer's. It clamps a
 *     proposed `[red, yellow]` pair before it reaches `Match.teamLabels`.
 *
 * A rename to `chase-composer.ts` is still the obvious follow-up; it
 * would touch ~20 import sites, so it is not done in the same change as
 * a prompt rewrite.
 */
import { db } from "./db";
import { normaliseLang, type Lang } from "./i18n/lang";
import { computeChaseRisk } from "./chase-risk";
import { anthropicModel, extractJson, HAIKU_CALL, type ModelCall, type PipelineModel } from "@/lib/pipeline/llm";
import { withOrgAiBudget } from "./ai-budget";
import { buildSquadRosterBlock } from "./scheduler-copy";
import {
  CHASE_LEAD_SCHEMA,
  CHASE_LEAD_SYSTEM,
  acceptChaseLead,
  assembleChasePost,
  chaseFallbackLead,
  chaseLeadUserTurn,
  chaseSwitchLine,
  type ChaseFacts,
  type ChaseKind,
} from "./chase-lead";
import type { SmallerFormat } from "./format-switch";

export type { ChaseKind } from "./chase-lead";

// ─── max_tokens — READ BEFORE ADDING ANY messages.create CALL ────────
//
// The Anthropic SDK refuses a NON-STREAMING request whose implied
// runtime exceeds 10 minutes, and it does so LOCALLY, before any
// network call is made (`_calculateNonstreamingTimeout` in
// node_modules/@anthropic-ai/sdk/src/client.ts):
//
//     expectedTimeout = 60 * 60 * max_tokens / 128_000   // seconds
//     if (expectedTimeout > 600) throw AnthropicError(
//       "Streaming is required for operations that may take longer
//        than 10 minutes.")
//
// so the SDK's hard limit for a non-streaming call is 21_333. Sonnet
// 4.5's real output ceiling is 64000, which is why that number keeps
// looking correct and keeps being wrong here.
//
// This has bitten three times — 2026-05-26 (analyzeBatch, killed the
// whole analyzer for ~30 min) and twice on 2026-08-31 (composeChaseText
// and the dropped-verdict re-prompt, both of which had NEVER once
// succeeded). Every call site sits inside a try/catch with a fallback,
// so a bad value produces no error and no alert — just permanently
// degraded output. A comment did not stop recurrence, so
// `src/lib/__tests__/max-tokens-ceiling.test.ts` now scans the source
// and fails the build on any value above this ceiling.
//
// Derive every call site's cap from this constant. Do not hand a
// `messages.create` its own literal, and do not switch a call to
// streaming to dodge the limit — none of these calls need minutes of
// runtime.
export const MAX_TOKENS_CEILING = 16_384;

// `ANALYSIS_MAX_TOKENS` and `ANALYSIS_RETRY_MAX_TOKENS` are deleted
// with `analyzeBatch`. `MAX_TOKENS_CEILING` above stays: it is the
// project-wide bound that `max-tokens-ceiling.test.ts` scans the source
// against, and `pipeline/llm.ts` derives its own 4,096 cap from it. The
// chase composer no longer calls `messages.create` itself (2026-10-20):
// it goes through `anthropicModel`, which clamps to that cap.


// ─── THE VERDICT TYPES ARE DELETED (§10 step 8) ──────────────────────
//
//   `AnalysisIntent` (13 intents), `AnalysisVerdict` (15 fields),
//   `BatchInputMessage`, `BatchInputHistory` and `AnalysisBatchInput`.
//
//   `AnalysisVerdict` is the interface §1 calls out by name: the one
//   with `intent` AND `registerAttendance` as separately-hallucinated
//   fields that could disagree, plus a `reasoning` string that five
//   regexes in `route.ts` parsed to decide whether to drop a player
//   from a paid match. "That is not an interface. It is a hope."
//
//   Its successor is `pipeline/types.ts`'s facts schema, and §6.2
//   states the difference exactly: "There is no field in which the
//   model can express a decision, and no prose for a regex to parse."

// ═══════════════════════════════════════════════════════════════════
// `SYSTEM_PROMPT` IS DELETED — 444 LINES, 19,850 MEASURED TOKENS
// ═══════════════════════════════════════════════════════════════════
//
//   The whole point of the redesign, and §10 step 8.
//
//   §3 measured what was actually in it: 29% was extraction guidance
//   the model genuinely needed, and the other 71% — 13,269 tokens —
//   was "code, templates and apology for past mistakes, written in
//   prose and re-sent on every call". 26 reconstructable production
//   incidents, 14 dated references, 5 "Kemal flagged" annotations, 27
//   real players' names used as worked examples, 12 CRITICAL banners,
//   470 shouted words.
//
//   Every section had an owner by the time it was deleted, and §3.2's
//   table is the map: S2 to `interaction-contract.ts`, S8/S9 to
//   `engine.ts` and `promote-authorization.ts`, S11/S15 to the facts
//   schema's `contingent` / `conditionOn`, S13 to `BenchSlotOffer`,
//   S14/S31/S32/S33 to `compose.ts` and `group-copy.ts`, S16 to the
//   question extractor and `answer-batch.ts`, S17 to
//   `score-engine.ts`, S18/S19 to `team-ops-engine.ts` and
//   `answer-batch.ts`, S21/S22 to `admin-ops-engine.ts` and the pure
//   `reminder-time.ts`, S34 to `format-switch.ts`, S24/S25/S35/S36/S37
//   to `engine.ts`.
//
//   §12 named the deliverable, and this is it: "the incident archive
//   stops being a prompt and becomes a test suite." The 27 players'
//   names that the model re-read on every single call are now fixtures
//   in `e2e/corpus/incidents.jsonl`, which runs in CI and produces a
//   number.
//
//   THE REVERT IS `git revert`. There is no flag behind this and there
//   should not be one: a switch whose off position is "nobody handles
//   attendance" is not a revert, and `pipeline/gate.ts` says so at
//   more length.

// ═══════════════════════════════════════════════════════════════════
// `analyzeBatch` AND `ATTENDANCE_OFF_OVERRIDE` ARE DELETED
// ═══════════════════════════════════════════════════════════════════
//
//   §10 step 7: "Retire the mega-prompt when the last route leaves."
//   It has left. `analyzeBatch` was 350 lines around one
//   `messages.create`: the cached prompt blocks, the truncation
//   retry, the dropped-verdict re-prompt, the usage log and six
//   offline-fallback paths.
//
//   `ATTENDANCE_OFF_OVERRIDE` went with it, and its replacement is
//   better than a prompt appendix could be. It was 12 lines of shouted
//   prose appended for orgs with `featureAttendance` off, added after
//   Kemal found MatchTime telling a MoM-only group "0/14 — need 14
//   players" (2026-06-08). It worked by ASKING the model not to. Every
//   owner now reads the org's features out of its own `SquadState`
//   load and owns nothing when its feature is off, so the behaviour is
//   refused before the write instead of discouraged before the
//   reading. §9 files that under "tenancy": "`ATTENDANCE_OFF_OVERRIDE`
//   becomes a router/engine capability filter instead of a 12-line
//   prompt appendix."

// ─── The scheduled chase ────────────────────────────────────────────

/**
 * THE SHIPPED MODEL: Haiku 5.5, adaptive thinking at medium (2026-10-20).
 * Paid check, `scripts/chase-at-risk-live.ts`, 12 fixture posts (English
 * and Turkish, every kind) once each: the live prompt on Sonnet 5 9/12
 * ("Yarın" for a match that evening, hours to kickoff worked out by the
 * model), the new prompt on Sonnet 5 and on Haiku 5.5 12/12 each, Haiku
 * at about a fiftieth of the live cost per call and a faster p50.
 */
export const CHASE_COMPOSER_CALL: ModelCall = HAIKU_CALL;

/** The lead is one short line; the rest is room for Haiku's thinking,
 *  which shares the budget. */
const CHASE_LEAD_MAX_TOKENS = 2_048;

/** The squad state one chase is composed against. Structural on purpose:
 *  `composeChaseText` passes a Prisma row, the live harness
 *  (`scripts/chase-at-risk-live.ts`) an in-memory object, and both take
 *  the identical path from here on. */
export interface ChaseComposeMatch {
  date: Date;
  status: string;
  maxPlayers: number;
  activity: { name: string; venue: string };
  attendances: Array<{
    status: string;
    user: { id: string; name: string | null; phoneNumber?: string | null };
  }>;
}

export interface ChasePost {
  /** The post, ready to send. */
  text: string;
  /** The opening line as posted. */
  lead: string;
  /** False when the model's line was missing or could not be posted and
   *  the fixed line of this chase went out instead. */
  fromModel: boolean;
}

/**
 * The chase post for the match the scheduler is chasing.
 *
 * Null only when there is nothing to chase (no org, no such match); the
 * scheduler then sends its own static copy. A model that fails, is over
 * the club's daily AI cap, or writes a line that breaks a fact still
 * yields a post: the fixed line over the same squad list.
 */
export async function composeChaseText(input: {
  groupId: string;
  kind: ChaseKind;
  /** The match being chased. The scheduler always passes it; without it
   *  (the production dry run) the next match with an open deadline. */
  matchId?: string;
  /** The scheduler's clock (the e2e suite pins it); the wall clock when absent. */
  now?: Date;
  /** False when the group was shown this exact squad in the last three
   *  hours (`roster-shown.ts`): the post is the line alone. */
  withRoster?: boolean;
  /** HARNESS ONLY (`scripts/dryrun-pipeline.ts LANG=tr`): compose in this
   *  language instead of the org's column. Production never passes it. */
  langOverride?: Lang | string | null;
}): Promise<string | null> {
  const now = input.now ?? new Date();
  const org = await db.organisation.findFirst({
    where: { whatsappGroupId: input.groupId },
    select: { id: true, language: true },
  });
  if (!org) return null;

  const match = await db.match.findFirst({
    where: input.matchId
      ? { id: input.matchId, activity: { orgId: org.id } }
      : {
          activity: { orgId: org.id },
          status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
          attendanceDeadline: { gt: now },
        },
    include: {
      activity: {
        select: { name: true, venue: true, sport: { select: { name: true, playersPerTeam: true } } },
      },
      attendances: {
        where: { status: { in: ["CONFIRMED", "BENCH"] } },
        include: { user: { select: { id: true, name: true } } },
        orderBy: { position: "asc" },
      },
    },
    orderBy: { date: "asc" },
  });
  if (!match) return null;

  // The smaller formats this club has set up, largest first (the
  // format-switch line proposes the first one the squad would fill).
  const family = match.activity.sport.name.split(" ")[0];
  const currentPpt = match.activity.sport.playersPerTeam;
  const siblings = await db.activity.findMany({
    where: { orgId: org.id },
    include: { sport: { select: { name: true, playersPerTeam: true } } },
  });
  const seen = new Set<string>();
  const alternatives: SmallerFormat[] = [];
  for (const a of siblings) {
    if (a.sport.name.split(" ")[0] !== family || a.sport.playersPerTeam >= currentPpt || seen.has(a.sport.name)) continue;
    seen.add(a.sport.name);
    alternatives.push({ sportName: a.sport.name, totalPlayers: a.sport.playersPerTeam * 2 });
  }
  alternatives.sort((x, y) => y.totalPlayers - x.totalPlayers);

  // Spent from this club (the daily AI cap, lib/ai-budget.ts). At the cap
  // the call is refused and the fixed line goes out instead.
  const post = await withOrgAiBudget(org.id, () =>
    composeChaseFromMatch({
      kind: input.kind,
      match,
      alternatives,
      lang: normaliseLang(input.langOverride ?? org.language),
      now,
      withRoster: input.withRoster,
      logLabel: `group=${input.groupId}`,
    }),
  );
  return post.text;
}

/**
 * Everything `composeChaseText` does EXCEPT read the database: state the
 * facts, ask the model for the opening line, check it, and build the post.
 * `deps.model` is for the paid harness's arms; production passes nothing.
 */
export async function composeChaseFromMatch(
  input: {
    kind: ChaseKind;
    match: ChaseComposeMatch;
    alternatives?: SmallerFormat[];
    /** The group's language (`Organisation.language`); English when absent. */
    lang?: Lang | string | null;
    now?: Date;
    /** Default true. */
    withRoster?: boolean;
    /** Identifies the caller in the log lines. */
    logLabel?: string;
  },
  deps?: { model?: PipelineModel },
): Promise<ChasePost> {
  const { match } = input;
  const now = input.now ?? new Date();
  const lang = normaliseLang(input.lang);
  const confirmed = match.attendances.filter((a) => a.status === "CONFIRMED").map((a) => a.user);
  const bench = match.attendances.filter((a) => a.status === "BENCH").map((a) => a.user);
  const risk = computeChaseRisk({ kickoff: match.date, confirmedCount: confirmed.length, maxPlayers: match.maxPlayers, now });

  const facts: ChaseFacts = {
    kind: input.kind,
    lang,
    activityName: match.activity.name,
    venue: match.activity.venue,
    kickoff: match.date,
    now,
    confirmed: confirmed.length,
    maxPlayers: match.maxPlayers,
    bench: bench.length,
    // The 17:00 update is the only post that escalates: the pre-kickoff
    // posts carry their own urgency, and a second warning reads as panic.
    // The server decides (chase-risk.ts); the model is told.
    atRisk: input.kind === "daily-in-list" && risk.atRisk,
  };

  let lead: string | null = null;
  const model = deps?.model ?? (process.env.ANTHROPIC_API_KEY ? anthropicModel() : null);
  if (model) {
    try {
      const resp = await model.complete({
        ...CHASE_COMPOSER_CALL,
        system: CHASE_LEAD_SYSTEM,
        user: chaseLeadUserTurn(facts),
        maxTokens: CHASE_LEAD_MAX_TOKENS,
        schema: CHASE_LEAD_SCHEMA as unknown as Record<string, unknown>,
        label: "chase-composer",
      });
      const raw = (extractJson(resp.text) as { lead?: unknown } | null)?.lead;
      lead = typeof raw === "string" ? acceptChaseLead(raw, facts) : null;
      if (!lead) {
        console.error(
          `[chase] the model's line for kind=${input.kind} ${input.logLabel ?? ""} broke a fact or was empty; ` +
            `posting the fixed line instead.`,
        );
      }
    } catch (err) {
      // Degrade LOUDLY: the post still goes out, with the fixed line.
      console.error(`[chase] the model call failed for kind=${input.kind} ${input.logLabel ?? ""}; posting the fixed line.`, err);
    }
  }
  const fromModel = lead !== null;
  const finalLead = lead ?? chaseFallbackLead(facts);
  const switchLine = chaseSwitchLine({
    confirmedNames: confirmed.map((u) => u.name ?? "?"),
    maxPlayers: match.maxPlayers,
    alternatives: input.alternatives ?? [],
    lang,
    hoursToKickoff: risk.hoursToKickoff,
  });
  const rosterBlock =
    input.withRoster === false ? null : buildSquadRosterBlock({ confirmed, bench, maxPlayers: match.maxPlayers, lang });
  return { text: assembleChasePost({ lead: finalLead, switchLine, rosterBlock }), lead: finalLead, fromModel };
}

/** MOVED to `./proximity` (2026-10-20), pure; re-exported for every
 *  existing import. */
export { enforceProximity } from "./proximity";

/**
 * The house style for a model-composed message: no em or en dashes in
 * any language, and (Turkish) markdown `**bold**` turned into WhatsApp
 * `*bold*`. MOVED to `./house-style` (2026-10-06), which is pure, and
 * re-exported here so every existing import keeps working.
 */
export { applyHouseStyle } from "./house-style";

/**
 * Deterministic, server-composed squad+bench status post. MOVED to
 * `./group-copy` (2026-09-01) and re-exported here so every existing
 * import keeps working.
 */
export { composeSquadStatusPost } from "./group-copy";

// `stubbedVerdictsForTest` is deleted with `analyzeBatch` (§10 step
// 8). The e2e suite's stub seam is now `MT_TEST_ROUTER_STUB_FILE` and
// `pipeline/extractor-stub.ts`, which stub FACTS rather than verdicts
// — a stub that cannot express a decision, for a model that is no
// longer asked for one.

// `logAnalyzerUsage` and `offlineVerdict` are deleted with
// `analyzeBatch` (§10 step 8). Per-call token accounting now lives in
// `pipeline/llm.ts`, which reports `costUsd` per stage rather than one
// number for a call that did twelve jobs.

/**
 * Sanitise an LLM-proposed pair of fun team names into a safe
 * `[redName, yellowName]` tuple, or `null` when the input is unusable.
 *
 * Exported so it can be unit-tested and reused by the team-generation
 * builder before persisting to `Match.teamLabels`.
 *
 * Rules:
 *   - must be an array of exactly length 2, each element a string
 *   - each is trimmed and capped at 24 chars
 *   - rejected (→ null) if either is empty after trim, the two are
 *     case-insensitively identical, or either is purely punctuation /
 *     contains control characters
 */
export function sanitiseTeamNames(input: unknown): [string, string] | null {
  if (!Array.isArray(input) || input.length !== 2) return null;
  const [a, b] = input;
  if (typeof a !== "string" || typeof b !== "string") return null;
  // Reject anything with control characters (incl. newlines/tabs).
  // Checked by char code so the source stays free of literal control bytes.
  const hasControl = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x20 || c === 0x7f) return true;
    }
    return false;
  };
  if (hasControl(a) || hasControl(b)) return null;
  const red = a.trim().slice(0, 24);
  const yellow = b.trim().slice(0, 24);
  if (!red || !yellow) return null;
  // Purely punctuation / no letter-or-number → reject.
  const hasAlnum = (s: string) => /[\p{L}\p{N}]/u.test(s);
  if (!hasAlnum(red) || !hasAlnum(yellow)) return null;
  if (red.toLowerCase() === yellow.toLowerCase()) return null;
  return [red, yellow];
}


// ─── `normaliseVerdict` IS DELETED (§10 step 8) ──────────────────────
//
//   175 lines of hand-rolled coercion over one model's JSON: string
//   "null" to null, a bare string where an array was promised, a
//   number that arrived as text, an intent outside the enum, a
//   confidence outside [0,1], `registerFor` entries missing an
//   `action`. §6.2 predicted its end in one sentence — "enforced with
//   `output_config: {format: {type: 'json_schema', schema}}`, so
//   `safeParseJson`'s fence-stripping and most of `normaliseVerdict`'s
//   120 lines of hand-rolled coercion disappear" — and the pipeline's
//   extractors do exactly that: a strict JSON schema per route, so a
//   field cannot arrive in a shape nobody expected.
//
//   `safeParseJson` and `normaliseBatch` went with it. So did
//   `offlineVerdict`, whose six reasoning strings the partial-response
//   net used to prefix-match — the typed successor is
//   `lib/operator-note.ts`.

// ─── `analyzeMessage` IS DELETED (§10 step 8) ────────────────────────
//
//   A single-message back-compat shim over `analyzeBatch`, described
//   in its own comment as "used by early scripts and as a fallback".
//   It had ZERO callers anywhere in `src/`, `e2e/` or `scripts/` when
//   it was removed — grep for it and the only hits were its own
//   definition. It goes with the batch it wrapped.
