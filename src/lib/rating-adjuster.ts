/**
 * THE RATING ADJUSTER: a margin on each player's rating for ONE match,
 * read from the week of group chat before it (Phase 4, 2026-04-21;
 * prompt rewritten 2026-10-20).
 *
 * The balancer (snake draft + hill climb) picks the teams from ratings.
 * This adds what the ratings cannot know: who is ill, injured or rusty
 * for this match, or on a run of good games. Its output is a delta per
 * player, and team selection itself stays deterministic.
 *
 * Design principles (agreed with Kemal 2026-04-21):
 *   - Delta is clamped to [-1, +1] here (MAX_DELTA), whatever the model
 *     says. It was [-2, +2] until 2026-11-10, when Kemal found 2 harsh
 *     on a 1 to 10 scale.
 *   - The model never picks teams. It only suggests rating tweaks.
 *   - Every decision is persisted to RatingAdjustment with its reason,
 *     so an admin can see why a player's rating moved for a match.
 *   - It never blocks team generation: any failure returns no
 *     adjustments and the balancer runs on the base ratings.
 *
 * 2026-10-20 rewrite: the model returns ONLY the players the chat gives
 * a reason about (code fills everyone else with zero, so the audit table
 * still has one row per player), through structured output on the
 * pipeline's model (`PipelineModel`), rather than JSON asked for in
 * prose and echoed back for every player. The prompt is given the match's
 * own day and time, and each chat line's, instead of assuming "tonight",
 * and states the rating scale. The paid check is
 * `scripts/live-check-rating-adjuster.ts`.
 *
 * 2026-11-10 rewrite of the size guidance (Kemal): the cap is 1 either
 * way, with the sizes stated once (tired or rusty about 0.5; ill, injured
 * or back after weeks out about 1; a standout run +0.5, exceptional +1),
 * and "Not a reason" now names the attendance talk that was being read as
 * form before the 2026-10-20 rewrite: a late addition, a replacement or a
 * backup, offering to sit out, asking for a replacement. Old and new text:
 * `MDs/prompt-change-rating-adjuster-cap-1-2026-11-10.md`.
 */

import { anthropicModel, extractJson, HAIKU_CALL, type ModelCall, type PipelineModel } from "@/lib/pipeline/llm";
import { formatLondon } from "./london-time";
import { stripLongDashes } from "./house-style";

/**
 * THE SHIPPED MODEL: Haiku 5.5, adaptive thinking at medium (2026-10-20).
 * Paid check, `scripts/live-check-rating-adjuster.ts`, five fixture weeks
 * (46 players) once each: the live prompt on Sonnet 5 44/46 (two players
 * marked down for a wife's illness and a healed toe), the new prompt on
 * Sonnet 5 and on Haiku 5.5 46/46 each, Haiku with no empty answer at
 * about a sixteenth of the live cost per call.
 */
export const RATING_ADJUSTER_CALL: ModelCall = HAIKU_CALL;
/** The most the adjuster moves a rating for one match, either way. */
export const MAX_DELTA = 1;
const MIN_CONFIDENCE = 0.3;
const HISTORY_DAYS = 7;
const MAX_HISTORY_MESSAGES = 300;
/** The answer is a handful of short entries; the rest is room for Haiku's
 *  thinking, which shares the budget. Fixed: it no longer grows with the
 *  roster, because players with nothing to say are not echoed back. */
const MAX_TOKENS = 2_048;

/** The reason stored for a player the chat gave no reason about. */
export const NO_SIGNAL_REASON = "No reason in the chat for this match";

export const RATING_ADJUSTER_SYSTEM = `You help balance the teams for one match. MatchTime splits the confirmed players into two even teams by their ratings (1 to 10, from the ratings team-mates gave them over many matches), which already say how good each player is. Your job is what the ratings cannot know: whether the week's chat means a player will play better or worse than usual in THIS match.

You are given the match's day and time, the confirmed players with their ratings, and the group's chat from the week before the match, oldest first, each line with its day and time.

Return "adjustments": one entry for each player the chat gives you a reason about, and nobody else. Players you leave out keep their rating.
- playerId: the player's id, exactly as listed.
- reason: one short line on why, quoting the chat where you can. Under 120 characters, no dashes.
- delta: what to add to their rating for this match only, from -1 to 1: negative if they will probably play worse than usual, positive if better, sized as below.
- confidence: from 0 to 1, how sure you are the chat means this for this match. If it is under 0.3, leave the player out instead.

What counts and what it is worth, read against the match's day and time:
- Tired, hungover or a bit rusty for the match: about -0.5.
- Ill or injured for the match, or back after weeks without playing: about -1.
- A standout run just before this match (goals, Man of the Match, team-mates saying they were the best player): +0.5, or +1 if it was clearly exceptional.
- Not a reason: a problem they later say has cleared up; an opinion about who is better in general (the ratings already hold that); banter and idioms; someone else's illness; being a late addition, a replacement or a backup; offering to sit out; asking for a replacement or being unsure whether they can come (that is attendance, not form); and simply saying they are in.
- "Tonight" or "tomorrow" in a message means the day it was written, which is not always the match day.
- The chat may be in English or Turkish. Never give a reason the chat does not.

Examples:
- "bit tired after a long shift but I'm in" / "işten yorgun çıktım ama varım": delta -0.5
- "my back's killing me but I'll play" / "belim tutuldu ama gelirim": delta -1
- "haven't kicked a ball since the summer" / "yazdan beri top oynamadım": delta -1
- "Jack scored twice last week" / "Kerem geçen hafta 2 gol attı": Jack / Kerem delta +0.5
- "Jack got four last week, unstoppable" / "Kerem geçen hafta 4 attı, durdurulamazdı": Jack / Kerem delta +1
- "knee's fine now" after a knee injury / "dizim düzeldi": not a reason
- "Jack is the best player here" / "buradaki en iyi oyuncu Kerem": not a reason
- "can anyone take my place tonight?" / "yerime gelebilecek var mı?": not a reason
- "if nobody shows I'll step in" / "kimse gelmezse ben gelirim": not a reason
- "in" / "varım": not a reason`;

const SCHEMA = {
  type: "object",
  properties: {
    adjustments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          playerId: { type: "string" },
          reason: { type: "string" },
          delta: { type: "number" },
          confidence: { type: "number" },
        },
        required: ["playerId", "reason", "delta", "confidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["adjustments"],
  additionalProperties: false,
} as const;

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
 * PURE. The user turn: the match, the players and the chat, every time in
 * London wall-clock with its weekday, so the model can tell the match day
 * from the day a message was written.
 */
export function adjusterUserTurn(input: AdjusterInput, messages: AdjusterMessage[]): string {
  return [
    `SPORT: ${input.sportName}`,
    `THE MATCH: ${formatLondon(input.matchDate, "EEEE d MMMM yyyy, HH:mm")}`,
    "",
    "CONFIRMED PLAYERS (rating out of 10):",
    ...input.players.map((p) => `- ${p.name} (id ${p.id}): rating ${p.baseRating.toFixed(1)}`),
    "",
    `CHAT, the ${HISTORY_DAYS} days before the match, oldest first:`,
    ...messages.map(
      (m) => `[${formatLondon(m.timestamp, "EEE d MMM HH:mm")}] ${m.authorName ?? "?"}: ${m.body.replace(/\s+/g, " ").slice(0, 250)}`,
    ),
  ].join("\n");
}

/**
 * Run the rating adjuster. Returns a Map keyed by playerId, one entry per
 * player.
 *
 * On any failure (no API key, a failed call, an unreadable body), returns
 * an empty map: the caller falls through to base ratings unchanged. Team
 * generation must never block on the model.
 */
export async function adjustRatings(
  input: AdjusterInput,
  deps?: { model?: PipelineModel },
): Promise<Map<string, RatingAdjustment>> {
  const empty = new Map<string, RatingAdjustment>();
  if (!deps?.model && !process.env.ANTHROPIC_API_KEY) {
    console.error("[rating-adjuster] ANTHROPIC_API_KEY not set");
    return empty;
  }
  if (input.players.length === 0) return empty;

  const cutoff = new Date(input.matchDate.getTime() - HISTORY_DAYS * 24 * 60 * 60 * 1000);
  const recent = input.messages.filter((m) => m.timestamp >= cutoff).slice(-MAX_HISTORY_MESSAGES);
  // No chat, nothing to read: zero for everyone, still one audit row each.
  if (recent.length === 0) return fillZeros(new Map(), input.players, "No recent chat history");

  try {
    const model = deps?.model ?? anthropicModel();
    const resp = await model.complete({
      ...RATING_ADJUSTER_CALL,
      system: RATING_ADJUSTER_SYSTEM,
      user: adjusterUserTurn(input, recent),
      maxTokens: MAX_TOKENS,
      schema: SCHEMA as unknown as Record<string, unknown>,
      label: "rating-adjuster",
    });
    return normaliseAdjustments(extractJson(resp.text), input.players);
  } catch (err) {
    console.error("[rating-adjuster] model call failed:", err);
    return empty;
  }
}

/** PURE. The model's entries, clamped and checked, plus a zero for every
 *  player it left out. */
function normaliseAdjustments(parsed: unknown, players: AdjusterPlayer[]): Map<string, RatingAdjustment> {
  const out = new Map<string, RatingAdjustment>();
  const ids = new Set(players.map((p) => p.id));
  const arr = (parsed as { adjustments?: unknown })?.adjustments;
  for (const item of Array.isArray(arr) ? arr : []) {
    const r = (item ?? {}) as Record<string, unknown>;
    const playerId = typeof r.playerId === "string" ? r.playerId : null;
    if (!playerId || !ids.has(playerId)) continue;
    const confidence = typeof r.confidence === "number" ? Math.max(0, Math.min(1, r.confidence)) : 0;
    const raw = typeof r.delta === "number" ? Math.max(-MAX_DELTA, Math.min(MAX_DELTA, r.delta)) : 0;
    const delta = confidence < MIN_CONFIDENCE ? 0 : raw;
    const reason =
      typeof r.reason === "string" && r.reason.trim() ? stripLongDashes(r.reason.trim().slice(0, 200)) : NO_SIGNAL_REASON;
    out.set(playerId, { playerId, delta, reason, confidence });
  }
  return fillZeros(out, players, NO_SIGNAL_REASON);
}

function fillZeros(out: Map<string, RatingAdjustment>, players: AdjusterPlayer[], reason: string): Map<string, RatingAdjustment> {
  for (const p of players) {
    if (!out.has(p.id)) out.set(p.id, { playerId: p.id, delta: 0, reason, confidence: 0 });
  }
  return out;
}
