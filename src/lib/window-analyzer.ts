/**
 * Window-based shadow analyzer (2026-05-29).
 *
 * Why this exists — context:
 *   The live `/api/whatsapp/analyze` route forces Claude to emit a
 *   structured verdict per message in the batch (intent +
 *   registerAttendance + registerFor + …), then runs server-side
 *   regex safety-nets to "fix" verdicts the LLM may have got wrong.
 *   That bandaid layer is itself the source of recurring incidents
 *   (Kemal dropped from his own squad 2026-05-28; Mojib not dropped
 *   2026-05-26; Erdal/Najib before that). Every fix loosens or
 *   tightens a regex and the next case finds a new gap.
 *
 *   This module takes the SAME window the live analyzer sees (fresh
 *   batch + history + match context) and asks Claude for ONE
 *   coherent state diff for the whole window — no per-message
 *   verdicts to conflict, no safety nets to override.
 *
 * Shadow only (for now):
 *   This module never writes to attendance. Its output is persisted to
 *   the `WindowVerdict` table so the /admin/shadow dashboard can show
 *   it side-by-side with the live analyzer's per-message verdicts.
 *   After a week of comparison data we decide: cut over, hybrid, or
 *   scrap.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { BatchInputHistory, BatchInputMessage } from "./message-analyzer";
import { db } from "./db";
import { format as formatDate } from "date-fns";

export type WindowStateChangeAction =
  | "drop"
  | "add"
  | "bench"
  | "swap"
  | "score"
  | "no_change";

export interface WindowStateChange {
  action: WindowStateChangeAction;
  /** Human-readable name as the LLM saw it in the chat. Server-side
   *  resolution against memberships happens later (when we cut over);
   *  for shadow we just persist the name. */
  targetName: string;
  /** Resolved User.id if the live analyzer already mapped this person
   *  (we pre-resolve from the batch's authorUserId hints). */
  targetUserId?: string;
  /** For "swap" — the other player. */
  swapWithName?: string;
  /** For "score" — the match outcome. */
  scoreRed?: number;
  scoreYellow?: number;
  /** LLM's one-line justification — what about the window made this
   *  change correct. */
  reason: string;
}

export interface WindowReaction {
  waMessageId: string;
  emoji: string;
  /** Why this ack — usually just "in-confirmation", "ack-out", "ack-info". */
  kind: string;
}

export interface WindowVerdict {
  /** One sentence: what happened in this window. Goes to the dashboard
   *  so we can scan correctness at a glance. */
  windowSummary: string;
  /** Every change the squad should reflect after this window. EMPTY
   *  when the window had no state-relevant content. NOT per-message. */
  stateChanges: WindowStateChange[];
  /** Per-message emoji reactions. Keep minimal — only when an ack adds
   *  value (e.g. ✅ for an IN, 👋 for an OUT). Skip for chitchat. */
  reactions: WindowReaction[];
  /** One group reply for the whole window. Null when no reply is
   *  warranted (chitchat, silent ack). The live analyzer emits replies
   *  per-message which often produces 3-4 contiguous bot posts; one
   *  consolidated reply reads better. */
  groupReply: string | null;
}

export interface WindowAnalyzerInput {
  /** Same as analyzeBatch's input — the messages flushed by the Pi. */
  messages: BatchInputMessage[];
  /** Same as analyzeBatch's history — chat preceding this batch for
   *  context. */
  history: BatchInputHistory[];
  /** Compact match context block. Built by the live analyzer; we
   *  reuse the exact same string so both paths see the same world. */
  matchContext: string;
}

export interface WindowAnalyzerResult {
  verdict: WindowVerdict;
  modelMs: number;
  costUsd: number | null;
  /** SHA-256 of the sorted waMessageIds in the batch. Used for dedupe
   *  + matching to live AnalyzedMessage rows on the dashboard. */
  batchHash: string;
}

const SYSTEM_PROMPT = `You are MatchTime, the analyzer for a football WhatsApp group. You read a window of recent messages and return ONE coherent state diff for the whole window — not a verdict per message.

You always receive three blocks:
1. MATCH CONTEXT — the current squad (CONFIRMED, BENCH, DROPPED), pending bench-confirmation prompts, open bench-slot offers, alternative formats, and player roster with first names.
2. RECENT HISTORY — chat that preceded the new batch (last hour or so), for context only. Do NOT emit state changes for history-only events.
3. NEW MESSAGES — what just arrived. Apply state changes ONLY for these.

You return JSON only — no prose, no markdown fences, no preamble. The shape:

\`\`\`
{
  "windowSummary": "one sentence",
  "stateChanges": [
    { "action": "drop" | "add" | "bench" | "swap" | "score" | "no_change",
      "targetName": "<player first name as written in chat>",
      "swapWithName"?: "<other player>",
      "scoreRed"?: 0, "scoreYellow"?: 0,
      "reason": "one line on what in the window justifies this" }
  ],
  "reactions": [
    { "waMessageId": "<id>", "emoji": "✅ | 👋 | 🪑 | 👍 | 🙏 | 📣", "kind": "ack-in | ack-out | ack-bench | ack-info" }
  ],
  "groupReply": "<one WhatsApp-friendly message>" | null
}
\`\`\`

CORE RULES (small set on purpose — be smart about edge cases):

R1. The window summary + state changes describe the WHOLE conversation, not message-by-message. If three people say "I'm in", that's three "add" changes in ONE summary, not three batches.

R2. Only emit a stateChange when the WINDOW conclusion is clear. If a message is ambiguous, contradicted later in the window, or just chatter ("@all we need more players", "anyone free?", "great game!"), emit nothing for it. Default to NO action when uncertain. Use the empty stateChanges array freely.

R3. Sender-drops itself ("I can't play") → action "drop", targetName = the sender's first name. Sender asks the group for cover but stays in ("running late but coming", "@everyone we need more players") → NO state change, that's chase nudge / chitchat.

R4. Third-party drops ("Habib can't make it", "replace Ehtisham") → "drop" for the named player. Third-party adds ("bringing Najib", "my dad Faris is in") → "add" for the named player.

R5. Replacement messages "X is ill, can Y take their spot?" → drop X. If Y later confirms ("active", "yes", "ok I'm in"), add Y. If Y doesn't confirm in the window, leave Y alone — don't speculate.

R6. Two confirmed players swapping teams ("swap X with Y" between two CONFIRMED) → action "swap" with swapWithName. NOT a drop.

R7. Score message ("we won 5-3", "final 4-4") from someone who played or an admin → action "score" with scoreRed/scoreYellow mapped to the two team labels in match context order.

R8. groupReply rules: at most ONE message for the whole window. Required for: confirmed drops with replacement context, score acknowledgement, "@MatchTime …" direct asks, squad-now-full announcements. Null for: pure chitchat, single IN/OUT (the react is enough), bench claims (those have their own message path).

R9. Reactions: one ack emoji per actionable message. ✅ = in/confirmed, 👋 = out/dropped, 🪑 = bench, 👍 = generic ack, 📣 = note-for-the-group. Skip reactions on chitchat. Don't react to your own previous bot messages.

R10. NEVER invent a player. targetName must appear in the chat (or its trivial variant — "Eman" / "EMAN" / "eman" same). If unsure who's meant, leave the action out and add a one-line note in windowSummary.

Trust your reading of the conversation. There is no safety net behind you that will "fix" a mistake — what you emit is what would happen. Be deliberate; prefer NO change over a guessed one.`;

function sha256Hex(s: string): string {
  // Web Crypto-free fallback for node: use built-in crypto.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require("node:crypto") as typeof import("node:crypto");
  return crypto.createHash("sha256").update(s).digest("hex");
}

export function computeBatchHash(messages: BatchInputMessage[]): string {
  const ids = messages.map((m) => m.waMessageId).sort();
  return sha256Hex(ids.join("\n"));
}

/** Sonnet 4.5 list prices, USD per million tokens.
 *  Source: anthropic.com/pricing as of 2026-05-29. */
const SONNET_INPUT_PER_MTOK = 3.0;
const SONNET_OUTPUT_PER_MTOK = 15.0;

function costFromUsage(input: number, output: number): number {
  return (input / 1_000_000) * SONNET_INPUT_PER_MTOK + (output / 1_000_000) * SONNET_OUTPUT_PER_MTOK;
}

function formatMessagesBlock(msgs: BatchInputMessage[]): string {
  if (msgs.length === 0) return "(empty)";
  return msgs
    .map(
      (m) =>
        `[${m.timestamp.toISOString()}] ${m.authorName ?? "(unknown)"} (${m.waMessageId}): ${m.body}`,
    )
    .join("\n");
}

function formatHistoryBlock(history: BatchInputHistory[]): string {
  if (history.length === 0) return "(none)";
  return history
    .map((h) => `[${h.timestamp.toISOString()}] ${h.authorName ?? "(unknown)"}: ${h.body}`)
    .join("\n");
}

function extractFirstJsonObject(text: string): unknown {
  // Strip ``` fences if present.
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  // Find first { ... } balanced span.
  const start = stripped.indexOf("{");
  if (start === -1) throw new Error("No JSON object in response");
  let depth = 0;
  for (let i = start; i < stripped.length; i++) {
    const c = stripped[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        return JSON.parse(stripped.slice(start, i + 1));
      }
    }
  }
  throw new Error("Unterminated JSON object in response");
}

function coerceVerdict(raw: unknown): WindowVerdict {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Verdict is not an object");
  }
  const r = raw as Record<string, unknown>;
  const summary = typeof r.windowSummary === "string" ? r.windowSummary : "";
  const stateChanges = Array.isArray(r.stateChanges) ? (r.stateChanges as WindowStateChange[]) : [];
  const reactions = Array.isArray(r.reactions) ? (r.reactions as WindowReaction[]) : [];
  const groupReply = typeof r.groupReply === "string" ? r.groupReply : null;
  return { windowSummary: summary, stateChanges, reactions, groupReply };
}

export async function analyzeWindow(
  input: WindowAnalyzerInput,
): Promise<WindowAnalyzerResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const userPrompt = [
    "## MATCH CONTEXT",
    input.matchContext.trim() || "(no upcoming match)",
    "",
    "## RECENT HISTORY",
    formatHistoryBlock(input.history),
    "",
    "## NEW MESSAGES",
    formatMessagesBlock(input.messages),
    "",
    "Return the JSON only.",
  ].join("\n");

  const anthropic = new Anthropic({ apiKey });
  const t0 = Date.now();
  const resp = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });
  const modelMs = Date.now() - t0;

  const textBlock = resp.content.find((c) => c.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text in Claude response");
  }
  const parsed = extractFirstJsonObject(textBlock.text);
  const verdict = coerceVerdict(parsed);

  const inputTok = resp.usage.input_tokens ?? 0;
  const outputTok = resp.usage.output_tokens ?? 0;
  const costUsd = costFromUsage(inputTok, outputTok);

  return {
    verdict,
    modelMs,
    costUsd,
    batchHash: computeBatchHash(input.messages),
  };
}

/** Build a compact match-context string for the shadow. Deliberately
 *  simpler than the live analyzer's matchContext — we want a fair
 *  comparison of LLM reasoning, not to import the kitchen-sink prompt. */
export async function buildShadowMatchContext(orgId: string): Promise<string> {
  const now = new Date();
  const match = await db.match.findFirst({
    where: {
      activity: { orgId },
      status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
      attendanceDeadline: { gt: now },
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
        include: { user: { select: { id: true, name: true } } },
        orderBy: { position: "asc" },
      },
    },
    orderBy: { date: "asc" },
  });

  const memberRows = await db.membership.findMany({
    where: { orgId, leftAt: null },
    include: { user: { select: { name: true } } },
  });
  const memberFirstNames = memberRows
    .map((m) => m.user.name?.split(/\s+/)[0])
    .filter((n): n is string => !!n);

  if (!match) {
    return [
      "No upcoming match.",
      `Active members (first names): ${memberFirstNames.join(", ") || "—"}`,
    ].join("\n");
  }

  const confirmed = match.attendances.filter((a) => a.status === "CONFIRMED");
  const bench = match.attendances.filter((a) => a.status === "BENCH");
  const dropped = match.attendances.filter((a) => a.status === "DROPPED");

  const fmt = (a: { user: { name: string | null } }) => a.user.name ?? "(unnamed)";

  const offers = await db.benchSlotOffer.findMany({
    where: { matchId: match.id, resolvedAt: null },
    select: { id: true, replacingUserId: true },
  });
  const offerReplacingNames = offers
    .map((o) =>
      o.replacingUserId
        ? match.attendances.find((a) => a.userId === o.replacingUserId)?.user.name ?? "—"
        : "—",
    )
    .join(", ");

  const lines: string[] = [];
  lines.push(`Activity: ${match.activity.name} (${match.activity.sport.name})`);
  lines.push(`Date: ${formatDate(match.date, "EEE d MMM HH:mm")} UK (UTC ${match.date.toISOString()})`);
  lines.push(`Venue: ${match.activity.venue ?? "—"}`);
  lines.push(`Max players: ${match.maxPlayers} (${match.activity.sport.playersPerTeam}-a-side)`);
  lines.push(`Squad: ${confirmed.length}/${match.maxPlayers} confirmed, ${bench.length} bench, ${dropped.length} dropped`);
  lines.push("");
  lines.push("CONFIRMED:");
  confirmed.forEach((a, i) => lines.push(`  ${i + 1}. ${fmt(a)}`));
  if (bench.length > 0) {
    lines.push("BENCH:");
    bench.forEach((a, i) => lines.push(`  ${i + 1}. ${fmt(a)}`));
  }
  if (dropped.length > 0) {
    lines.push("DROPPED (last 7d):");
    dropped.forEach((a) => lines.push(`  - ${fmt(a)}`));
  }
  if (offers.length > 0) {
    lines.push(`Open bench-slot offers: ${offers.length} (replacing: ${offerReplacingNames})`);
  }
  lines.push("");
  lines.push(`Active members (first names): ${memberFirstNames.join(", ") || "—"}`);
  return lines.join("\n");
}

/** Has today's shadow spend exceeded the cap? Reads
 *  SHADOW_DAILY_USD_CAP (default $5/day). */
async function shadowCapReached(): Promise<boolean> {
  const capStr = process.env.SHADOW_DAILY_USD_CAP;
  const cap = capStr ? Number(capStr) : 5;
  if (!isFinite(cap) || cap <= 0) return true; // 0 = disabled
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const agg = await db.windowVerdict.aggregate({
    where: { createdAt: { gte: dayStart } },
    _sum: { costUsd: true },
  });
  return (agg._sum.costUsd ?? 0) >= cap;
}

/** Single entry point the live analyzer route calls (via after()).
 *  Self-contained: own DB lookups, own Claude call, own persistence.
 *  NEVER throws — errors are logged and swallowed so the live path
 *  is unaffected. */
export async function runShadowAnalysis(opts: {
  orgId: string;
  groupId: string;
  messages: BatchInputMessage[];
  history: BatchInputHistory[];
  /** AnalyzedMessage IDs that the live per-message analyzer wrote for
   *  this same batch. Persisted on the WindowVerdict so the dashboard
   *  can render the two side-by-side. */
  currentVerdictIds: string[];
}): Promise<void> {
  try {
    if (opts.messages.length === 0) return;

    // Dedupe — if a row already exists for this batch hash, don't pay
    // for a second Claude call (Pi catch-up sometimes resends).
    const batchHash = computeBatchHash(opts.messages);
    const existing = await db.windowVerdict.findUnique({
      where: { orgId_batchHash: { orgId: opts.orgId, batchHash } },
      select: { id: true },
    });
    if (existing) {
      console.log(`[shadow] batch ${batchHash.slice(0, 8)} already analyzed, skipping`);
      return;
    }

    if (await shadowCapReached()) {
      console.warn(`[shadow] daily cost cap reached — skipping`);
      return;
    }

    const matchContext = await buildShadowMatchContext(opts.orgId);
    const result = await analyzeWindow({
      messages: opts.messages,
      history: opts.history,
      matchContext,
    });

    const windowStart = opts.messages[0].timestamp;
    const windowEnd = opts.messages[opts.messages.length - 1].timestamp;
    await db.windowVerdict.create({
      data: {
        orgId: opts.orgId,
        windowStart,
        windowEnd,
        batchHash: result.batchHash,
        modelMs: result.modelMs,
        costUsd: result.costUsd,
        verdictJson: result.verdict as never,
        currentVerdictRefs: opts.currentVerdictIds,
      },
    });
    console.log(
      `[shadow] org ${opts.orgId} window ${windowStart.toISOString()}..${windowEnd.toISOString()} ` +
        `→ ${result.verdict.stateChanges.length} changes, ${result.modelMs}ms, $${result.costUsd?.toFixed(4)}`,
    );
  } catch (err) {
    console.error("[shadow] runShadowAnalysis failed:", err);
  }
}

