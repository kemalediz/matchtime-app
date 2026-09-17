/**
 * THE SCHEDULED-CHASE COMPOSER, and what is left of the analyzer.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE NAME OF THIS FILE IS NOW WRONG (§10 step 8, 2026-09-06)
 * ─────────────────────────────────────────────────────────────────────
 *
 * It was "smart WhatsApp message analysis — the LLM pass that classifies
 * EVERY message from a monitored group", and until today that is what it
 * was: `SYSTEM_PROMPT`, 444 lines and 19,850 measured tokens, plus
 * `analyzeBatch` around one `messages.create`, plus `AnalysisVerdict`
 * and 175 lines coercing the model's JSON into it. 2,245 lines.
 *
 * All of that is deleted. Reactive per-message analysis is now
 * `src/lib/pipeline/` (router → extractors → engine → composer) and its
 * owners; the markers left in place below say which section went where,
 * and `MDs/analyzer-redesign-2026-08-31.md` §3.2 is the full map.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHAT IS LEFT, AND WHY IT IS STILL HERE
 * ─────────────────────────────────────────────────────────────────────
 *
 * ONE live feature and three shared helpers:
 *
 *   composeChaseText / composeChaseFromMatch
 *     The SCHEDULED chase. The bot scheduler decides WHEN (17:00 daily
 *     roll-call, match-day morning, 3-4h before kickoff, 2h pre-kickoff)
 *     and this composes the text. §13 lists it under "what must not
 *     change", so it did not: same `CHASE_SYSTEM_PROMPT`, same
 *     `MODEL`, same 1,024-token cap, same fallback to static copy when
 *     the call fails.
 *
 *     It is a genuinely different problem from the reactive path, which
 *     is why it survived a change that deleted everything around it.
 *     Nothing has HAPPENED. There is no message to understand and no
 *     write to decide — the state is known and the only job is saying it
 *     in a way a group will read. §6.4 reserves exactly that for a
 *     model: "The model keeps exactly one job: tone."
 *
 *   buildMatchContextBlock / buildMatchClockBlock
 *     The cached / uncached halves of the chase's context. The split is
 *     §8.1's bug 1: `kickoffHint` changed every six minutes inside a
 *     1-hour-TTL cache block and cost ~$0.0121 per call in cache writes.
 *     Anything clock-derived belongs in the clock block. If you add a
 *     field here, ask: does it change when the clock moves but the
 *     database does not?
 *
 *   enforceProximity
 *     Rewrites "tonight" when the match is days away, and the
 *     20:30-vs-21:30 BST/UTC slips. Applied to EVERY outgoing reply in
 *     `analyze/route.ts`, whatever composed it — it was never about the
 *     model, only about relative dates being wrong in text.
 *
 *   sanitiseTeamNames
 *     Pure, and `team-generation.ts`'s, not the analyzer's. It clamps a
 *     proposed `[red, yellow]` pair before it reaches `Match.teamLabels`.
 *
 * A rename to `chase-composer.ts` is the obvious follow-up and is
 * deliberately NOT done here: it would touch ~20 import sites in a
 * change that is already deleting the largest artefact in the codebase,
 * and a diff nobody can read is how a deletion hides a mistake.
 */
import Anthropic from "@anthropic-ai/sdk";
import { appendFileSync, readFileSync } from "node:fs";
import { db } from "./db";
import { loadRecentHistory, formatRecentHistoryBlock } from "./match-history";
import { getOrgFeatures } from "./org-features";
import { resolveTeamLabels } from "./team-labels";
import {
  BENCH_PROMPT_MENTION_REACTIONS,
  benchClaimPhrasingExample,
} from "./bench-offer-copy";
import {
  buildFormatSwitchFacts,
  renderFormatSwitchContext,
} from "./format-switch";
import { computeChaseRisk } from "./chase-risk";

// Sonnet (2026-05-19, Kemal): the per-message analyzer makes nuanced
// calls (team-swap vs drop, conditional vs standing, "is X
// confirmed", stats vs roster) that Haiku kept getting wrong. Sonnet
// lifts the floor. Cost is contained: the big system prompt + match
// context are 1h-cached (cheap reads), and MoM/rating-only groups
// short-circuit BEFORE this call (analyze route), so only
// message-scanning groups (Sutton-like) bill Sonnet.
// One-constant change — instantly revertible if spend isn't worth it.
// The "~£10/mo each" that used to end that sentence was struck out on
// 2026-09-01 for the same reason as smart-analysis.ts's "~£2/month":
// it predates the shadow analyzer and the prompt-cache buster. See
// analyzer-redesign-2026-08-31.md §8.2/§8.4 for the modelled numbers,
// and read `WindowVerdict.costUsd` for real ones.
const MODEL = "claude-sonnet-4-5";

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
// against, `pipeline/llm.ts` derives its own 4,096 cap from it, and the
// chase composer below is still a `messages.create` that needs it.
// The chase composer emits ONE short WhatsApp message — a roster post
// with a nudge line, ~100-200 output tokens in practice. 1024 is ~5x
// the realistic worst case (a full 14-player roster plus tentative and
// dropped sections) while keeping the SDK's implied timeout at ~29s.
const CHASE_COMPOSE_MAX_TOKENS = 1_024;

let _anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: key });
  return _anthropic;
}

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
export function buildMatchContextBlock(args: {
  orgName: string;
  match: {
    activity: { name: string; venue: string };
    date: Date;
    status: string;
    maxPlayers: number;
    attendances: Array<{ status: string; user: { id: string; name: string | null; phoneNumber?: string | null } }>;
  } | null;
  /** Resolved display labels for the two team slots —
   *  `[redLabel, yellowLabel]`. Injected into the context so the LLM
   *  can map custom team names ("Lions"/"Tigers") onto the canonical
   *  RED/YELLOW enum for teamOverrides and score order. */
  teamLabels?: [string, string];
  /** Every smaller-format activity configured for this org. The LLM
   *  may propose a switch to any of them — admins handle the venue
   *  rebooking the venue and flip the match in the app. */
  alternatives?: Array<{ sportName: string; totalPlayers: number }>;
  /** Open bench-confirmation prompts. The bot tagged these users in
   *  the group with a 👍/👎 prompt when someone dropped, and is
   *  waiting on their decision (NO DM is sent — it's an in-group
   *  @mention). The LLM uses this to interpret subsequent group
   *  messages from those users (an in-group 👍, "yes", "I can do it"
   *  etc.) as a bench-confirmation rather than a generic IN. */
  /** Bench redesign 2026-05-19: open slot(s) offered to the WHOLE
   *  bench. Any current bench player accepting (👍 / IN / yes) claims
   *  it — first wins, nobody eliminated. */
  openBenchSlot?: {
    count: number;
    benchNames: string[];
    replacingNames: string[];
  } | null;
}): string {
  if (!args.match) {
    return `## Organisation\n${args.orgName}\n\n## Current Match\nNo upcoming match within the attendance window.`;
  }
  const m = args.match;
  const confirmed = m.attendances.filter((a) => a.status === "CONFIRMED");
  const bench = m.attendances.filter((a) => a.status === "BENCH");
  const dropped = m.attendances.filter((a) => a.status === "DROPPED");
  const need = Math.max(0, m.maxPlayers - confirmed.length);
  // Derive a BOOLEAN "no number on record" flag from phoneNumber. The
  // raw digits are NEVER emitted — only this boolean ever reaches the
  // LLM context (PII rule, see line ~472). A player counts as "no
  // number" when phoneNumber is null/undefined/empty/whitespace.
  const noPhone = (a: { user: { phoneNumber?: string | null } }): boolean =>
    !a.user.phoneNumber || a.user.phoneNumber.trim() === "";
  const phoneFlag = (a: { user: { phoneNumber?: string | null } }): string =>
    noPhone(a) ? "  📵 no number on record" : "";
  const lines = [
    `## Organisation`,
    args.orgName,
    ``,
    `## Current Match`,
    `Activity: ${m.activity.name}`,
    // Kickoff time, countdown, proximity and roster header are NOT
    // here — they live in buildMatchClockBlock, which callers append
    // to the UNCACHED half of the request. See that function's header.
    `Venue: ${m.activity.venue}`,
    `Status: ${m.status}`,
    ...(args.teamLabels
      ? [
          `Team labels: first team = "${args.teamLabels[0]}" (canonical RED), second team = "${args.teamLabels[1]}" (canonical YELLOW)`,
        ]
      : []),
    `Confirmed: ${confirmed.length}/${m.maxPlayers}${need > 0 ? ` (need ${need} more)` : " ✅ full squad"}`,
    `Bench: ${bench.length}`,
    ``,
    `Confirmed list:`,
    ...confirmed.map((a, i) => `  ${i + 1}. ${a.user.name ?? "(unnamed)"}${phoneFlag(a)}`),
  ];
  if (bench.length) {
    lines.push("", "Bench list:");
    bench.forEach((a, i) => lines.push(`  ${i + 1}. ${a.user.name ?? "(unnamed)"}${phoneFlag(a)}`));
  }
  if (dropped.length) {
    lines.push("", `Dropped: ${dropped.map((a) => a.user.name ?? "(unnamed)").join(", ")}`);
  }
  if (args.openBenchSlot && args.openBenchSlot.count > 0) {
    const o = args.openBenchSlot;
    const repl = o.replacingNames.length
      ? ` (covering for: ${o.replacingNames.join(", ")})`
      : "";
    lines.push(
      "",
      `OPEN BENCH SLOT: ${o.count} slot${o.count === 1 ? "" : "s"} open for this match${repl}.`,
      `Bench (any ONE of these can claim it — first to reply IN or yes wins; nobody is eliminated): ${
        o.benchNames.length ? o.benchNames.join(", ") : "(bench empty)"
      }`,
    );
  }
  // FORMAT SWITCH — every number and every name in this block is
  // computed HERE, in code (src/lib/format-switch.ts). The model used to
  // be asked to do the arithmetic itself and got it catastrophically
  // wrong in production on 2026-08-30 (8 confirmed, "5-a-side (10
  // players) — Najib + Mojib + Mustafa go on the bench" — it subtracted
  // players-per-TEAM instead of the format TOTAL). It now only copies.
  if (args.alternatives && args.alternatives.length > 0) {
    const facts = buildFormatSwitchFacts({
      confirmedNames: confirmed.map((a) => a.user.name ?? "(unnamed)"),
      currentMaxPlayers: m.maxPlayers,
      alternatives: args.alternatives,
    });
    lines.push("", ...renderFormatSwitchContext(facts));
  }
  return lines.join("\n");
}

/**
 * The kickoff DAY in London — "Tue 8 Sept". No time, ever.
 *
 * This used to be `kickoffLocal.split(" at ")[0]` over a single
 * date-AND-time formatter, and that split never fired: en-GB renders
 * weekday+day+month+hour+minute as "Tue 8 Sept, 21:30", the caller
 * stripped the comma, and the ` at ` the split looked for had never
 * existed. `[0]` was therefore the whole string, so every "day label" in
 * this file silently carried the kickoff time — into the roster header
 * ("*Playing Tue 8 Sept 21:30:*") and into `enforceProximity`'s
 * `friendlyDay`, which is how a chase came to read "see you all on Tue 8
 * Sept 21:30 at 21:30". Formatting the two halves separately is the only
 * way this cannot come back.
 */
function londonDayLabel(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(date);
}

/** The kickoff wall-clock in London — "21:30". */
function londonTimeLabel(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

/**
 * The VOLATILE half of the Match Context — kickoff wall-clock time, the
 * countdown, the proximity bucket and the roster header derived from it.
 *
 * Split out of `buildMatchContextBlock` on 2026-08-31. Callers MUST put
 * this in an uncached content block, immediately after the cached Match
 * Context, so the system prompt's references to "proximity=" and
 * "Use roster header:" in the Match Context still resolve.
 *
 * That split promised the values were "byte-for-byte" what the old
 * function emitted, and they were — including its bug. The roster header
 * carried the kickoff time ("*Playing Tue 8 Sept 21:30:*") until
 * 2026-09-06; see `londonDayLabel`. It is a DAY label now.
 *
 * Everything here is recomputed from `Date.now()` on every call, which
 * is precisely why it cannot live in the cached prefix.
 */
export function buildMatchClockBlock(matchDate: Date | null | undefined): string {
  if (!matchDate) return "";
  const hoursToKickoff = (matchDate.getTime() - Date.now()) / (1000 * 60 * 60);
  const daysToKickoff = Math.floor(hoursToKickoff / 24);
  const kickoffHint =
    hoursToKickoff > 0
      ? `${hoursToKickoff.toFixed(1)}h until kickoff`
      : `${Math.abs(hoursToKickoff).toFixed(1)}h since kickoff`;
  // Pre-format the kickoff in London time so the LLM doesn't have to
  // do TZ math and guess at BST/GMT. Format: "Tue 28 Apr at 21:30".
  const dayLabel = londonDayLabel(matchDate);
  const kickoffLocal = `${dayLabel} at ${londonTimeLabel(matchDate)}`;
  // Proximity token drives how the LLM should title the roster block.
  const proximity =
    hoursToKickoff < 0
      ? "past"
      : hoursToKickoff <= 6
      ? "tonight"
      : hoursToKickoff <= 24
      ? "tomorrow"
      : daysToKickoff <= 7
      ? "this-week"
      : "future";
  const rosterHeader = {
    past: "*Squad:*",
    tonight: "*Playing tonight:*",
    tomorrow: "*Playing tomorrow:*",
    "this-week": `*Playing ${dayLabel}:*`,
    future: `*Playing ${dayLabel}:*`,
  }[proximity];
  return [
    `## Current Match — timing (live, part of the Match Context above)`,
    `Kickoff (London): ${kickoffLocal}  (${kickoffHint}, proximity=${proximity})`,
    `Use roster header: ${rosterHeader}`,
  ].join("\n");
}

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

// ─── LLM-composed scheduled chase messages ──────────────────────────
//
// The bot scheduler decides WHEN to chase (17:00 daily roll-call,
// match-day morning 8-9am, 3-4h before kickoff, 2h pre-kickoff). This
// function composes the TEXT for a chase using the same Match Context
// + squad-state reply rules the reactive analyser uses — so the
// scheduled posts get the same rich roster / tentative / dropped
// summary as the reactive ones.
//
// Returns the message text ready to send to WhatsApp. If Claude fails
// for any reason, returns `null` and the scheduler falls back to the
// static text it used to emit.

export type ChaseKind =
  | "daily-in-list" // 17:00, roster + need-X-more
  | "match-day-morning" // match day 8-9am, upbeat nudge
  | "chase-pre-kickoff" // 3-4h before kickoff, sharper call
  | "pre-kickoff-full" // 2h before, final line-up post (may or may not be short)
  | "pre-kickoff-short"; // 2h before, short-squad variant (last-chance plea)

export async function composeChaseText(input: {
  groupId: string;
  kind: ChaseKind;
}): Promise<string | null> {
  const anthropic = getAnthropic();
  if (!anthropic) return null;

  const org = await db.organisation.findFirst({
    where: { whatsappGroupId: input.groupId },
    select: { id: true, name: true, teamLabels: true, language: true },
  });
  if (!org) return null;

  const match = await db.match.findFirst({
    where: {
      activity: { orgId: org.id },
      status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
      attendanceDeadline: { gt: new Date() },
    },
    include: {
      activity: {
        select: {
          name: true,
          venue: true,
          sport: { select: { name: true, playersPerTeam: true, teamLabels: true } },
        },
      },
      attendances: {
        // phoneNumber is selected ONLY to derive a boolean "has a number
        // on record" flag (see buildMatchContextBlock). The raw value is
        // never passed into LLM context or any reply — only the noPhone
        // boolean is. PII rule (line ~472) stays intact.
        include: { user: { select: { id: true, name: true, phoneNumber: true } } },
        orderBy: { position: "asc" },
      },
    },
    orderBy: { date: "asc" },
  });
  if (!match) return null;

  // Reuse the alternatives query from analyzeBatch.
  const alternatives: Array<{ sportName: string; totalPlayers: number }> = [];
  const family = match.activity.sport.name.split(" ")[0];
  const currentPpt = match.activity.sport.playersPerTeam;
  const siblingActivities = await db.activity.findMany({
    where: { orgId: org.id },
    include: { sport: { select: { name: true, playersPerTeam: true } } },
  });
  const seen = new Set<string>();
  for (const a of siblingActivities) {
    if (a.sport.name.split(" ")[0] !== family) continue;
    if (a.sport.playersPerTeam >= currentPpt) continue;
    if (seen.has(a.sport.name)) continue;
    seen.add(a.sport.name);
    alternatives.push({
      sportName: a.sport.name,
      totalPlayers: a.sport.playersPerTeam * 2,
    });
  }
  alternatives.sort((x, y) => y.totalPlayers - x.totalPlayers);

  return composeChaseFromMatch({
    kind: input.kind,
    orgName: org.name,
    match,
    teamLabels: resolveTeamLabels(match, org, match.activity.sport, org.language),
    alternatives,
    logLabel: `group=${input.groupId}`,
  });
}

/** The squad state one chase is composed against. Structural on purpose:
 *  `composeChaseText` passes a Prisma row, the live at-risk harness
 *  (`scripts/chase-at-risk-live.ts`) passes an in-memory object, and
 *  both take the identical path from here on. */
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

/**
 * Everything `composeChaseText` does EXCEPT read the database: build the
 * prompt, call the model, clean and proximity-correct the result.
 *
 * Split out on 2026-09-06 so the at-risk cancellation warning could be
 * validated against the real model in a state production is not
 * currently in (6/14 at ~57h out is deliberately NOT at risk) without
 * writing a single row to a customer's database.
 */
export async function composeChaseFromMatch(input: {
  kind: ChaseKind;
  orgName: string;
  match: ChaseComposeMatch;
  teamLabels?: [string, string];
  alternatives?: Array<{ sportName: string; totalPlayers: number }>;
  /** Identifies the caller in the two BROKEN log lines. */
  logLabel?: string;
}): Promise<string | null> {
  const anthropic = getAnthropic();
  if (!anthropic) return null;
  const { match } = input;
  const label = input.logLabel ?? input.orgName;

  const matchContext = buildMatchContextBlock({
    orgName: input.orgName,
    match,
    teamLabels: input.teamLabels,
    alternatives: input.alternatives,
  });

  // AT RISK — decided HERE, in code, and only ever handed to the model
  // as a finished verdict (src/lib/chase-risk.ts). "Close" and "many
  // missing" are not things a prompt may be left to judge: the answer
  // would flip run to run, and a cancellation warning that appears half
  // the time is worse than one that never appears. Same discipline as
  // the format-switch block above it.
  const risk = computeChaseRisk({
    kickoff: match.date,
    confirmedCount: match.attendances.filter((a) => a.status === "CONFIRMED").length,
    maxPlayers: match.maxPlayers,
  });
  // The 17:00 recap is the only kind that escalates. The pre-kickoff
  // kinds already carry their own urgency in the prompt; stacking a
  // second warning on top would read as panic.
  const atRisk = input.kind === "daily-in-list" && risk.atRisk;

  // Same cache split as analyzeBatch: matchContext is the 1h-cached
  // prefix, the clock block rides with the uncached compose prompt.
  // This call site had the identical cache-buster (it caches the very
  // same matchContext string), so every scheduled chase was paying a
  // cache WRITE for the whole block.
  //
  // The at-risk block goes in the SAME uncached tail, for exactly that
  // reason: it appears and disappears as the clock crosses 48h, so it is
  // volatile content by definition and may never sit in a cached prefix.
  const matchClock = buildMatchClockBlock(match.date);
  const chasePrompt = buildChaseComposePrompt(input.kind, { atRisk });
  const composePrompt = matchClock ? `${matchClock}\n\n${chasePrompt}` : chasePrompt;

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      // See MAX_TOKENS_CEILING at the top of this file. This site
      // shipped 64000 and therefore threw on EVERY invocation since it
      // was written — every scheduled chase used the static fallback.
      max_tokens: CHASE_COMPOSE_MAX_TOKENS,
      system: [
        {
          type: "text",
          text: CHASE_SYSTEM_PROMPT,
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: matchContext,
              cache_control: { type: "ephemeral", ttl: "1h" },
            },
            {
              type: "text",
              text: composePrompt,
            },
          ],
        },
      ],
    });
    // Truncation guard. This text is posted VERBATIM to a customer's
    // WhatsApp group, and it is the only call site here whose output is
    // not JSON (a truncated JSON site fails closed when the parse
    // throws; free text has no such protection). `stop_reason` is the
    // only signal that what we got is a sentence cut off mid-word, so
    // treat it as a failure: the static fallback is strictly better
    // than half a roster post.
    if (response.stop_reason === "max_tokens") {
      console.error(
        `[analyzer] BROKEN: composeChaseText hit the ${CHASE_COMPOSE_MAX_TOKENS}-token ` +
          `cap for kind=${input.kind} ${label} — the composed text was ` +
          `TRUNCATED mid-sentence and has been discarded. The chase will fall back to ` +
          `STATIC text. If this recurs, the cap is too low for this group's roster.`,
      );
      return null;
    }
    const textBlock = response.content.find(
      (b): b is Anthropic.TextBlock => b.type === "text",
    );
    const raw = textBlock?.text?.trim();
    if (!raw) return null;
    // Strip any accidental fences / leading labels.
    const cleaned = raw
      .replace(/^```(?:text|markdown)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    // Defence-in-depth: even with "Use roster header: ..." in the Match
    // Context, the LLM sometimes still writes "*Playing tonight:*" out
    // of habit. Rewrite any "*Playing <anything>:*" header AND any loose
    // "tonight"/"this evening" in the lead text to match the actual
    // proximity. Regex is narrow: it only fires when we're confident
    // the LLM got it wrong.
    return enforceProximity(cleaned, match.date);
  } catch (err) {
    // Degrade LOUDLY. This threw on every invocation for months
    // (max_tokens was 64000, which the SDK refuses) and nobody noticed,
    // because the chase still fired — just with the plain static text
    // instead of the composed roster / tentative / dropped summary.
    console.error(
      `[analyzer] BROKEN: composeChaseText threw for kind=${input.kind} ` +
        `${label} — the chase will fall back to STATIC text, ` +
        `losing the roster/tentative/dropped summary.`,
      err,
    );
    return null;
  }
}

/** YYYY-MM-DD key in London time. Used for calendar-day proximity. */
function londonDateKey(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
  return parts; // en-CA formats as YYYY-MM-DD
}

function computeProximity(date: Date): {
  proximity: "past" | "tonight" | "tomorrow" | "this-week" | "future";
  rosterHeader: string;
  friendlyDay: string; // "tonight" | "tomorrow" | "on Tue 28 Apr"
  /** The same day with no leading preposition — "Tue 28 Apr". What goes
   *  in after a preposition the sentence already has, or before a
   *  possessive. See `replaceRelativeDay`. */
  dayLabel: string;
} {
  const hoursToKickoff = (date.getTime() - Date.now()) / (1000 * 60 * 60);
  // See `londonDayLabel`: the day and the time are formatted separately
  // because the old single-formatter-plus-split produced a "day part"
  // that still had the kickoff time glued to it.
  const dayPart = londonDayLabel(date);

  // Proximity bucket is calendar-day based, not raw hours: "tonight"
  // means the match is later today (London), "tomorrow" means
  // calendar-tomorrow, etc. Hours-only thresholds got it wrong at
  // 14:26 BST on match day (>6h to 21:30 → bucketed as "tomorrow"
  // even though the match was that same evening).
  const todayKey = londonDateKey(new Date());
  const matchDayKey = londonDateKey(date);
  const oneDayLaterKey = londonDateKey(
    new Date(Date.now() + 24 * 60 * 60 * 1000),
  );
  const sevenDaysLaterKey = londonDateKey(
    new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  );
  let proximity: "past" | "tonight" | "tomorrow" | "this-week" | "future";
  if (hoursToKickoff < 0) {
    proximity = "past";
  } else if (matchDayKey === todayKey) {
    proximity = "tonight";
  } else if (matchDayKey === oneDayLaterKey) {
    proximity = "tomorrow";
  } else if (matchDayKey <= sevenDaysLaterKey) {
    proximity = "this-week";
  } else {
    proximity = "future";
  }
  const rosterHeader = {
    past: "*Squad:*",
    tonight: "*Playing tonight:*",
    tomorrow: "*Playing tomorrow:*",
    "this-week": `*Playing ${dayPart}:*`,
    future: `*Playing ${dayPart}:*`,
  }[proximity];
  const friendlyDay = {
    past: `on ${dayPart}`,
    tonight: "tonight",
    tomorrow: "tomorrow",
    "this-week": `on ${dayPart}`,
    future: `on ${dayPart}`,
  }[proximity];
  return { proximity, rosterHeader, friendlyDay, dayLabel: dayPart };
}

/** Prepositions that already supply the "on" in "on Tue 8 Sept". */
const DAY_PREPOSITION = "on|for|at|by|before|after|until|till|from";

/**
 * Swap a relative day word ("tonight", "tomorrow", "this evening") for
 * the real day, WITHOUT breaking the sentence it sits in.
 *
 * The naive `text.replace(/\btonight\b/g, "on Tue 8 Sept")` this
 * replaces produced, in production copy, "we still need 8 players for on
 * Tue 8 Sept's 7-a-side". Two grammatical facts have to be respected:
 *
 *   • a preposition already in the sentence supplies the "on"
 *     — "for tonight" → "for Tue 8 Sept", never "for on Tue 8 Sept";
 *   • a possessive attaches to the day, not to a preposition
 *     — "tonight's game" → "Tue 8 Sept's game".
 *
 * With neither, the day needs its own preposition: "kickoff is tonight"
 * → "kickoff is on Tue 8 Sept".
 */
function replaceRelativeDay(
  text: string,
  word: string,
  dayLabel: string,
  friendlyDay: string,
): string {
  const re = new RegExp(
    `(\\b(?:${DAY_PREPOSITION})\\s+)?\\b${word}\\b(['’]s)?`,
    "gi",
  );
  return text.replace(re, (_m, prep?: string, possessive?: string) => {
    if (possessive) return `${prep ?? ""}${dayLabel}${possessive}`;
    if (prep) return `${prep}${dayLabel}`;
    return friendlyDay;
  });
}

/**
 * Post-process an LLM-composed chase message to guarantee it doesn't
 * say "tonight" when the match is days away (or vice versa).
 *
 *   - Replaces any "*Playing <word>:*" header with the correct one.
 *   - Rewrites loose "tonight"/"this evening" in the lead text to the
 *     friendly day form when proximity isn't tonight. Leaves "tomorrow"
 *     alone unless proximity is further out.
 */
export function enforceProximity(text: string, matchDate: Date): string {
  const { proximity, rosterHeader, friendlyDay, dayLabel } = computeProximity(matchDate);

  // Swap any "*Playing …:*" roster header to the correct one.
  let out = text.replace(/\*Playing [^*\n]+?:\*/gi, rosterHeader);
  // If that didn't match, also try a variant without asterisks (in case
  // the LLM returned plain-text header).
  if (!out.includes(rosterHeader)) {
    out = out.replace(/Playing (tonight|tomorrow|this (?:evening|week))\s*:/i, rosterHeader);
  }

  if (proximity !== "tonight") {
    // Replace "tonight" / "this evening" with friendly-day phrasing
    // ONLY in the lead text (not inside the roster itself, which
    // shouldn't contain either word at this point). `replaceRelativeDay`
    // rather than a bare `String.replace`: the bare version produced
    // "for on Tue 8 Sept's 7-a-side" in production copy.
    out = replaceRelativeDay(out, "tonight", dayLabel, friendlyDay);
    out = replaceRelativeDay(out, "this evening", dayLabel, friendlyDay);
  }
  if (proximity !== "tomorrow" && proximity !== "tonight") {
    out = replaceRelativeDay(out, "tomorrow", dayLabel, friendlyDay);
  }

  // Catch "off-by-1h" mistakes in HH:MM times. The LLM occasionally
  // outputs the UTC offset (20:30) when it should output the London
  // wall-clock (21:30) — usually because it "helpfully" applied the
  // timezone offset itself. Replace the UTC HH:MM with the London one.
  const londonHm = londonTimeLabel(matchDate);
  const utcHm = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(matchDate);
  if (londonHm !== utcHm) {
    // Replace bare "20:30" instances (only when followed by non-digit
    // boundary so we don't mangle other numbers).
    out = out.replace(new RegExp(`\\b${utcHm.replace(":", ":")}\\b`, "g"), londonHm);
  }
  return out;
}

/**
 * Deterministic, server-composed squad+bench status post.
 *
 * MOVED to `./group-copy` (2026-09-01) and re-exported here so every
 * existing import keeps working. It is pure, and this file is not: it
 * imports the Prisma client, which makes the function unreachable from
 * the Playwright worker process and from the new pipeline's composer.
 * §13 lists it under "what must not change" — so it did not change; it
 * moved somewhere it can actually be reused.
 */
export { composeSquadStatusPost } from "./group-copy";

const CHASE_SYSTEM_PROMPT = `You are MatchTime, composing a SCHEDULED group message — not a reply to anyone. The bot's scheduler is firing a chase/announcement at a fixed time because the squad is in a certain state.

Output is PLAIN WhatsApp-ready text (no JSON, no markdown fences). Return only the message body — no preamble like "Here's the message:" and no closing commentary.

Use the same style as the reactive replies: WhatsApp-friendly formatting with *bold* via single asterisks, real line breaks, one or two emoji at most. Ground every name in the Match Context — never invent. Use "Kemal" / "Elvin" first names fine; for ambiguous repeats in the group, use fuller names ("Ibrahim Sahin" when needed to disambiguate).

Every chase message MUST end with a numbered roster block. Use the EXACT header from "Use roster header:" in the Match Context — do NOT invent your own. It'll be one of: "*Playing tonight:*" (same-day / within 6h), "*Playing tomorrow:*", or "*Playing <Weekday DD Mon>:*" for anything further out. Getting this wrong (e.g. saying "tonight" 6 days before the match) confuses the group — always use the pre-computed header. The roster has exactly maxPlayers rows; filled slots use names from the Confirmed list in order; any row above confirmedCount is 🥁 (single drum per row).

BENCH (mandatory, every org): when the Bench list in the Match Context is non-empty, ALWAYS append a bench block straight after the roster: "*Bench (N):*" followed by the bench names as a numbered list, in Match Context order. Never omit the bench when it has players — a benched player scanning the post must see their name. Omit the block entirely when the bench is empty.

NEVER write "tonight", "this evening", "tomorrow" or similar temporal references in the LEAD text unless "proximity=" in the Match Context confirms it. For any proximity other than "tonight"/"tomorrow", refer to the match by its day-and-date (e.g. "Tuesday 7-a-side on Tue 28 Apr at 21:30") rather than a vague relative time.

NEVER stamp the message with the time of day it was sent. No "Quick 5pm update", no "17:00 update", no "Evening update" or "Morning update" as a send-time label. Nobody needs to be told what time the scheduler fired, and the schedule can slip, so a stamp is often simply wrong. This bans the SEND time only. The KICKOFF time is a different thing and several chase types REQUIRE it: keep writing it (e.g. "kickoff 21:30", "21:30 at Sim Arena") whenever the chase type asks for it.

NEVER greet the group with a part of the day either. No "Morning all", no "Afternoon all", no "Evening all", no "Good morning everyone". A greeting is a coarse clock: you are told what state the squad is in, not what hour the post will reach anyone's phone, and a post held up by an outage or a busy DM queue arrives saying "Morning" in the afternoon. Open with the substance instead.

If any player appears in the Dropped list AND the history or chat context suggests they'll still play if nobody replaces them, add a separate line *below* the roster: "Tentative: <Name> (will play if nobody steps in)". Do not put tentative players in a numbered slot.

If an "Alternative formats available" block is in the context AND the squad is short AND kickoff is within 24h AND that format is marked "✅ VIABLE", you MAY append ONE line proposing the switch — and it must be the line the context gives you under "use this EXACT line VERBATIM", copied character-for-character. The server already did the arithmetic: NEVER count the squad, NEVER subtract anything, NEVER choose who goes on the bench. The only names you may describe as benched are the ones after "Bench on switch:" for that format; if it says NOBODY, write no bench clause at all and name nobody. Never propose a format marked "❌ NOT VIABLE".

Tone: the group's tone — casual, terse, no corporate fluff. No emoji soup.`;

/**
 * The at-risk escalation for the 17:00 daily chase.
 *
 * Present ONLY when `computeChaseRisk` says so, and absent BYTE FOR BYTE
 * otherwise — the healthy prompt is 51 weeks of the year and must not
 * change at all. The model is handed the verdict; it never reaches it.
 * See `src/lib/chase-risk.ts` for why that is not negotiable.
 *
 * Lives in the UNCACHED tail of the request (the per-kind compose
 * instruction), never in the 1h-cached Match Context or system prompt —
 * this string appears and disappears as the clock crosses 48h, and a
 * conditional inside a cached prefix would turn every scheduled chase
 * from a $0.30/MTok cache read into a $6/MTok cache write.
 */
const AT_RISK_BLOCK: string[] = [
  "",
  "⚠️ THIS MATCH IS AT RISK. The server decided that — you did not, and you",
  "cannot. Never count the squad yourself, and never write any of what",
  "follows when these lines are absent.",
  "Two extra things belong in the lead, in this order:",
  "1. Push harder than usual. Say how many are still needed (the figure is",
  "   in the Match Context, do not derive your own) and make it easy to say",
  "   yes. Warm and direct, the group's own voice: no corporate",
  "   cheerleading, and no guilt-tripping anyone who has already said",
  "   they're out.",
  "2. Say plainly that the match will have to be called off if we can't find",
  "   the numbers in time. Once, as a fact, not a threat, and never blame a",
  "   person for it.",
  "Whose call that is: the group's, never yours. Write it as",
  "\"we'll have to call it off\", or \"the game's off\". NEVER \"I will cancel",
  "the match\", never \"I'm cancelling this\", and never imply MatchTime is the",
  "one calling it off — MatchTime reports the position, the organiser decides.",
  "If the Match Context also gives you a format-switch line to copy",
  "VERBATIM, put it straight after the call-off line: a switch is the",
  "alternative to calling it off, so the two must read as one thought and",
  "not as a contradiction. Being at risk changes NOTHING about the verbatim",
  "rule — paste that line whole, opening words included. Do not replace its",
  "opening clause with \"Alternatively\" or any other connective, do not fold",
  "it into a sentence of your own, and do not reword it to flow better.",
];

function buildChaseComposePrompt(
  kind: ChaseKind,
  opts?: {
    /** Server-computed verdict from `computeChaseRisk`. `daily-in-list`
     *  only; every other kind ignores it. */
    atRisk?: boolean;
  },
): string {
  const header = "## Chase type";
  switch (kind) {
    case "daily-in-list":
      return [
        header,
        "daily-in-list",
        "",
        "Purpose: quick squad-state recap so the group sees where the numbers are.",
        "Open with a one-liner that sets the scene (e.g. '🗓 Squad update') followed by the lead (who's out / count vs needed). End with the roster block.",
        ...(opts?.atRisk ? AT_RISK_BLOCK : []),
      ].join("\n");
    case "match-day-morning":
      // The wall-clock slot ("8-9am London") and the "☀️ Morning all —"
      // example are both gone, for the same reason daily-in-list lost
      // "17:00 London": whatever sits above the opener instruction is
      // what the model puts in the first line, and the scheduler cannot
      // promise the hour a post actually goes out in. See the
      // no-send-time-stamp rule in CHASE_SYSTEM_PROMPT.
      return [
        header,
        "match-day-morning (match day, while there's still time to fill spots)",
        "",
        "Purpose: upbeat nudge on the day of the match.",
        "Open with a short scene-setting one-liner (e.g. '☀️ Squad update') and lead with how many we still need. End with the roster block.",
      ].join("\n");
    case "chase-pre-kickoff":
      return [
        header,
        "chase-pre-kickoff (3-4 hours before kickoff)",
        "",
        "Purpose: sharper call — the window is closing. Lead should convey urgency without panic. Mention kickoff time. End with the roster block.",
      ].join("\n");
    case "pre-kickoff-full":
      return [
        header,
        "pre-kickoff-full (2 hours before kickoff, squad is FULL)",
        "",
        "Purpose: final check-in — see-you-there vibe. Lead with kickoff time + venue + 'X/Y confirmed' (should be X = maxPlayers). End with the roster block.",
      ].join("\n");
    case "pre-kickoff-short":
      return [
        header,
        "pre-kickoff-short (2 hours before kickoff, squad is SHORT)",
        "",
        "Purpose: last-chance plea — squad still not full and we're 2h out. Lead with kickoff time + venue + count. Explicit 'last chance to jump in' line. If a format switch is viable, propose it. End with the roster block.",
      ].join("\n");
  }
}

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
