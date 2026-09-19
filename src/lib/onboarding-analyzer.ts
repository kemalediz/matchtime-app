/**
 * LLM pass for the onboarding wizard.
 *
 * Takes the parsed chat + a list of detected players and asks Claude
 * for three things at once:
 *
 *   1. Per-player POSITION inferred from the conversation
 *      ("Najib saved us in goal again" → GK).
 *   2. Per-player SEED RATING on a 1–10 scale with an evidence quote.
 *   3. Match SCHEDULE (day-of-week, kickoff time, venue) inferred from
 *      repeated mentions ("see you Tuesday 21:30 at Goals").
 *
 * The output is advisory — the admin reviews and overrides on Step 3 of
 * the wizard before anything is committed. We intentionally ask for an
 * evidence quote per player so the admin can sanity-check the LLM.
 *
 * Uses Haiku (fast, cheap) with a 1h ephemeral prompt cache on the
 * system prompt. A year of 14-person chat (~15k messages) fits in one
 * call well under Haiku's context window.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ParsedChat } from "./whatsapp-parser";

// Onboarding is a one-shot per org — a few cents vs pennies difference
// is worth paying for noticeably better player-evidence quality. Using
// Sonnet rather than the Haiku model the live message-analyzer uses.
// `claude-sonnet-4-5` here was inherited from the deleted
// `analyzeBatch`, not chosen (`MDs/llm-spend-september-2026.md` §4).
// Sonnet 5 is newer, 1M context, $2/$10 per MTok against $3/$15.
// The call site sends `thinking: { type: "disabled" }`, which is
// required: Sonnet 5 thinks adaptively when the parameter is omitted
// and Sonnet 4.5 did not.
const MODEL = "claude-sonnet-5";

const SYSTEM_PROMPT = `You are analysing a WhatsApp chat export from a recurring sports group to help the admin onboard to MatchTime.

You will receive:
  - A list of candidate PLAYERS (display names + total message count)
  - A compact slice of RECENT MESSAGES with timestamps and authors
  - The SPORT the group plays (e.g. "Football 7-a-side") and the list of valid positions for that sport

Your job:
  1. For each candidate player, decide their most likely preferred POSITION based on the conversation. Look for "Najib saved us again" (GK), "scored another hat-trick" (FWD), "at the back" (DEF), "in midfield", etc. If the chat has no signal for that player, return position: null (don't guess from first-name stereotypes).
  2. For each candidate player, propose a SEED RATING 1-10 based on how other players refer to them in the chat. Signals: praise ("best in the game", "Man of the Match again"), leadership mentions, complaints ("he scored an own goal"), how often they're named. Default to 6 (neutral) when no signal. Never go above 9 for anyone unless the chat has overwhelming praise, and never below 3.
  3. For each player, provide a one-sentence EVIDENCE QUOTE — a direct or near-direct quote from the chat that supports the position + rating assessment. Admin will read this to sanity-check. If no evidence exists, use the string "No clear signal in chat — defaulting to neutral".
  4. Identify the likely MATCH SCHEDULE: day-of-week (0-6, 0 = Sunday), kickoff time in HH:MM 24h London wall-clock, and the VENUE if the chat repeatedly names one. These come from repeat patterns like "Tuesday 21:30 at Goals". Leave fields null if the chat doesn't establish a pattern.
  5. Identify the likely PAYMENT HOLDER — the person who collects match fees from everyone else. Strongest signals: messages like "send me £7", "paid you back", "£7 each, send to Elvin", "Monzo: <name>", "here's my bank". They're usually mentioned by others asking for bank details / confirming payment. Return the exact player name from the candidate list, or null if unclear.

Output STRICT JSON — nothing else, no prose around it, no markdown fences:

{
  "schedule": {
    "dayOfWeek": <0-6 or null>,
    "time": "HH:MM" or null,
    "venue": "<string>" or null,
    "confidence": 0..1
  },
  "paymentHolder": {
    "name": "<exact name from the candidate list>" or null,
    "evidence": "<short quote showing the fee-collection signal or null>",
    "confidence": 0..1
  },
  "players": [
    {
      "name": "<exact name from the candidate list>",
      "position": "<one of the valid positions>" or null,
      "seedRating": <1-10> or null,
      "evidence": "<short quote or 'No clear signal in chat — defaulting to neutral'>",
      "confidence": 0..1
    }
  ]
}

Rules:
- Return ALL candidate players — use null / neutral defaults when evidence is thin, never omit.
- Position strings MUST match one of the provided valid positions exactly (case-sensitive).
- Evidence quotes MUST be short (under 20 words) and something an admin can search the chat for.
- Confidence <0.3 for a player means "wild guess" — be honest and use null positions / rating=6 in that case.
- Never invent names that aren't in the candidate list. Never invent venues or times that don't appear in the chat.`;

export interface OnboardingAnalysis {
  schedule: {
    dayOfWeek: number | null;
    time: string | null;
    venue: string | null;
    confidence: number;
  };
  paymentHolder: {
    name: string | null;
    evidence: string | null;
    confidence: number;
  };
  players: Array<{
    name: string;
    position: string | null;
    seedRating: number | null;
    evidence: string;
    confidence: number;
  }>;
}

export interface AnalyzeArgs {
  parsed: ParsedChat;
  sportName: string;
  validPositions: string[];
  /** Candidate player names the admin kept after Step 2 of the wizard.
   *  Analysis is scoped to these — saves tokens and prevents advice about
   *  excluded authors. */
  candidateNames: string[];
}

export async function analyzeForOnboarding(args: AnalyzeArgs): Promise<OnboardingAnalysis | null> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("[onboarding-analyzer] ANTHROPIC_API_KEY not set");
    return null;
  }
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Compose the chat slice the LLM sees. Cap at ~15k messages to stay
  // safely inside Haiku's context window while preserving recent context.
  const msgs = args.parsed.recentMessages.slice(-15_000);
  const messagesText = msgs
    .map((m) => {
      const ts = m.timestamp.toISOString().slice(0, 16).replace("T", " ");
      const body = m.body.replace(/\s+/g, " ").slice(0, 200);
      return `[${ts}] ${m.author}: ${body}`;
    })
    .join("\n");

  const playersText = args.candidateNames
    .map((n, i) => `${i + 1}. ${n}`)
    .join("\n");

  const userContent = [
    `## Sport\n${args.sportName}`,
    `## Valid positions\n${args.validPositions.join(", ")}`,
    `## Candidate players (${args.candidateNames.length})\n${playersText}`,
    `## Recent messages (${msgs.length})\n${messagesText}`,
  ].join("\n\n");

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 6000,
      // Sonnet 5 runs adaptive thinking unless told not to, and can
      // spend the whole max_tokens budget on it and return no text
      // block at all (measured 2026-09-06, 5 runs of 5; see
      // `ModelRequest.thinking` in pipeline/llm.ts). This call has a
      // cap sized for its OUTPUT, so leaving it adaptive would turn a
      // price change into a silent degradation.
      thinking: { type: "disabled" },
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
    if (!raw) return null;
    return normaliseAnalysis(raw, args);
  } catch (err) {
    console.error("[onboarding-analyzer] Claude call failed:", err);
    return null;
  }
}

function normaliseAnalysis(rawText: string, args: AnalyzeArgs): OnboardingAnalysis | null {
  const cleaned = rawText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  let json: unknown;
  try {
    json = JSON.parse(cleaned);
  } catch {
    // Try to find the first balanced JSON object.
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      json = JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
  if (!json || typeof json !== "object") return null;
  const obj = json as Record<string, unknown>;

  // Schedule.
  const sched = (obj.schedule ?? {}) as Record<string, unknown>;
  const schedule = {
    dayOfWeek:
      typeof sched.dayOfWeek === "number" && sched.dayOfWeek >= 0 && sched.dayOfWeek <= 6
        ? Math.round(sched.dayOfWeek)
        : null,
    time:
      typeof sched.time === "string" && /^\d{2}:\d{2}$/.test(sched.time)
        ? sched.time
        : null,
    venue: typeof sched.venue === "string" && sched.venue.trim() ? sched.venue.trim() : null,
    confidence:
      typeof sched.confidence === "number"
        ? Math.max(0, Math.min(1, sched.confidence))
        : 0,
  };

  // Payment holder — only accept a name that's in the candidate list.
  const ph = (obj.paymentHolder ?? {}) as Record<string, unknown>;
  const phCandidates = new Set(args.candidateNames.map((n) => n.toLowerCase()));
  const phName = typeof ph.name === "string" ? ph.name.trim() : "";
  const paymentHolder = {
    name: phName && phCandidates.has(phName.toLowerCase()) ? phName : null,
    evidence:
      typeof ph.evidence === "string" && ph.evidence.trim() ? ph.evidence.trim().slice(0, 200) : null,
    confidence:
      typeof ph.confidence === "number" ? Math.max(0, Math.min(1, ph.confidence)) : 0,
  };

  // Players.
  const validPositions = new Set(args.validPositions);
  const candidateSet = new Set(args.candidateNames.map((n) => n.toLowerCase()));
  const rawPlayers = Array.isArray(obj.players) ? obj.players : [];
  const players = rawPlayers
    .map((p) => {
      if (!p || typeof p !== "object") return null;
      const po = p as Record<string, unknown>;
      const name = typeof po.name === "string" ? po.name.trim() : "";
      if (!name || !candidateSet.has(name.toLowerCase())) return null;
      const position =
        typeof po.position === "string" && validPositions.has(po.position)
          ? po.position
          : null;
      const seedRating =
        typeof po.seedRating === "number" &&
        po.seedRating >= 1 &&
        po.seedRating <= 10
          ? Math.round(po.seedRating)
          : null;
      const evidence =
        typeof po.evidence === "string" ? po.evidence.slice(0, 200) : "";
      const confidence =
        typeof po.confidence === "number"
          ? Math.max(0, Math.min(1, po.confidence))
          : 0;
      return { name, position, seedRating, evidence, confidence };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null);

  // Ensure every candidate appears — LLM may have dropped some; fill in
  // neutral defaults so the UI doesn't have holes.
  const found = new Set(players.map((p) => p.name.toLowerCase()));
  for (const n of args.candidateNames) {
    if (!found.has(n.toLowerCase())) {
      players.push({
        name: n,
        position: null,
        seedRating: null,
        evidence: "No clear signal in chat — defaulting to neutral",
        confidence: 0,
      });
    }
  }

  return { schedule, paymentHolder, players };
}
