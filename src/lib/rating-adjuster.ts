/**
 * Phase 4 — hybrid LLM team-balancer.
 *
 * Reads the last ~7 days of group chat and proposes per-player rating
 * deltas for tonight's match. Output is fed into the deterministic
 * balancer (snake-draft + hill-climb) so the LLM only contributes
 * "what's the situation tonight" nuance — sick, tentative, rusty, hot
 * streak — while team selection itself stays deterministic and
 * predictable.
 *
 * Design principles (agreed with Kemal 2026-04-21):
 *   - Delta is clamped to [-2, +2]. A hallucination can't dominate.
 *   - LLM never picks teams. It only suggests rating tweaks.
 *   - Every decision is persisted to RatingAdjustment with an evidence
 *     line, so admins can audit "why was Wasim on Yellow tonight?".
 *   - Sonnet 4.5 — accuracy beats cost on a one-shot per match.
 */

import Anthropic from "@anthropic-ai/sdk";
import { MAX_TOKENS_CEILING } from "./message-analyzer";

const MODEL = "claude-sonnet-4-5";
const MAX_DELTA = 2;
const HISTORY_DAYS = 7;
const MAX_HISTORY_MESSAGES = 300;

const SYSTEM_PROMPT = `You are a sports-team-balance assistant. Your job is to read the last week of WhatsApp group chat and propose small per-player rating adjustments for TONIGHT'S match only.

The base rating is the player's medium-term form (seed rating + recent peer ratings + Elo blend). You DO NOT replace it. You suggest a delta in the range [-2, +2] that reflects ONLY temporary conditions for tonight:

  - Player said they're sick / injured / tired but still playing → negative delta
  - Player hasn't played in weeks / mentioned rust → small negative delta
  - Player is on a hot streak / scored multiple goals last match / called "on fire" → small positive delta
  - Player is playing out of position tonight (e.g. usually GK but no GK available) → could go either way
  - Player explicitly said they'll "give it 100%" / "feeling sharp" → small positive delta

Think small. The base rating already captures most of what matters. You're adjusting on the margin for tonight's conditions only.

DO NOT:
  - Adjust based on the player's overall ability — that's in the base rating
  - Adjust based on opinions about long-term form ("Wasim is better than Sait")
  - Adjust by more than ±2 even if you feel strongly
  - Propose deltas for players you have no specific signal about — return delta: 0 with reason "No tonight-specific signal"
  - Invent quotes — every reason must be grounded in the chat you were given

Return STRICT JSON — nothing else, no prose, no markdown fences:

{
  "adjustments": [
    {
      "playerId": "<the exact id from the player list>",
      "delta": <number in [-2, 2]>,
      "reason": "<one short sentence; quote a snippet of chat where possible>",
      "confidence": <0..1>
    }
  ]
}

Rules:
  - Return EVERY player from the input list. Use delta=0, confidence=0, reason="No tonight-specific signal" when the chat says nothing about them.
  - Confidence below 0.3 means "wild guess" — set delta=0 in that case.
  - Reason must be under 120 characters.
  - Never invent a playerId not in the input list.`;

export interface AdjusterPlayer {
  id: string;
  name: string;
  baseRating: number;
}

export interface AdjusterMessage {
  authorName: string | null;
  body: string;
  timestamp: Date;
}

export interface AdjusterInput {
  players: AdjusterPlayer[];
  messages: AdjusterMessage[];
  sportName: string;
  matchDate: Date;
}

export interface RatingAdjustment {
  playerId: string;
  delta: number;
  reason: string;
  confidence: number;
}

/**
 * Run the LLM rating adjuster. Returns a Map keyed by playerId.
 *
 * On any failure (no API key, malformed JSON, network error), returns
 * an empty map — caller falls through to base ratings unchanged. The
 * hybrid balancer must never block team generation; if the LLM is
 * unavailable, the deterministic balancer runs as before.
 */
export async function adjustRatings(
  input: AdjusterInput,
): Promise<Map<string, RatingAdjustment>> {
  const empty = new Map<string, RatingAdjustment>();
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("[rating-adjuster] ANTHROPIC_API_KEY not set");
    return empty;
  }
  if (input.players.length === 0) return empty;

  const cutoff = new Date(input.matchDate.getTime() - HISTORY_DAYS * 24 * 60 * 60 * 1000);
  const recentMessages = input.messages
    .filter((m) => m.timestamp >= cutoff)
    .slice(-MAX_HISTORY_MESSAGES);

  if (recentMessages.length === 0) {
    // No chat history → nothing to adjust on. Return zero-deltas for
    // every player so callers can still persist an audit row.
    for (const p of input.players) {
      empty.set(p.id, {
        playerId: p.id,
        delta: 0,
        reason: "No recent chat history",
        confidence: 0,
      });
    }
    return empty;
  }

  const playersBlock = input.players
    .map(
      (p) =>
        `  - id: ${p.id} | name: ${p.name} | baseRating: ${p.baseRating.toFixed(2)}`,
    )
    .join("\n");

  const messagesBlock = recentMessages
    .map((m) => {
      const ts = m.timestamp.toISOString().slice(0, 16).replace("T", " ");
      const body = m.body.replace(/\s+/g, " ").slice(0, 250);
      return `[${ts}] ${m.authorName ?? "?"}: ${body}`;
    })
    .join("\n");

  const userContent = [
    `## Sport\n${input.sportName}`,
    `## Match kickoff\n${input.matchDate.toISOString()}`,
    `## Confirmed players for tonight\n${playersBlock}`,
    `## Recent chat (last ${HISTORY_DAYS} days, oldest first)\n${messagesBlock}`,
  ].join("\n\n");

  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: MODEL,
      // Clamped: an unbounded expression can drift past the SDK's
      // non-streaming limit with no warning (see MAX_TOKENS_CEILING in
      // message-analyzer.ts). No realistic roster gets near this, but
      // "no call site picks its own unbounded number" is the rule.
      max_tokens: Math.min(MAX_TOKENS_CEILING, 200 + 80 * input.players.length),
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
      messages: [{ role: "user", content: userContent }],
    });
    const textBlock = response.content.find(
      (b): b is Anthropic.TextBlock => b.type === "text",
    );
    const raw = textBlock?.text?.trim();
    if (!raw) return empty;
    return normaliseAdjustments(raw, input.players);
  } catch (err) {
    console.error("[rating-adjuster] Claude call failed:", err);
    return empty;
  }
}

function normaliseAdjustments(
  rawText: string,
  players: AdjusterPlayer[],
): Map<string, RatingAdjustment> {
  const out = new Map<string, RatingAdjustment>();
  const playerIds = new Set(players.map((p) => p.id));

  const cleaned = rawText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return out;
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      return out;
    }
  }

  if (!parsed || typeof parsed !== "object") return out;
  const obj = parsed as Record<string, unknown>;
  const arr = Array.isArray(obj.adjustments) ? obj.adjustments : [];

  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const playerId = typeof r.playerId === "string" ? r.playerId : null;
    if (!playerId || !playerIds.has(playerId)) continue;

    let delta = typeof r.delta === "number" ? r.delta : 0;
    delta = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, delta));

    const confidence =
      typeof r.confidence === "number" ? Math.max(0, Math.min(1, r.confidence)) : 0;

    if (confidence < 0.3) delta = 0;

    const reason =
      typeof r.reason === "string" && r.reason.trim()
        ? r.reason.trim().slice(0, 200)
        : "No tonight-specific signal";

    out.set(playerId, { playerId, delta, reason, confidence });
  }

  // Fill any player the LLM dropped with a zero-delta row so the audit
  // table has a complete picture per match.
  for (const p of players) {
    if (!out.has(p.id)) {
      out.set(p.id, {
        playerId: p.id,
        delta: 0,
        reason: "No tonight-specific signal",
        confidence: 0,
      });
    }
  }

  return out;
}
