/**
 * THE ONBOARDING READING: a club's WhatsApp chat, read once at set-up.
 *
 * From the chat and the names of its players it proposes three things:
 * the regular game (day, kickoff, venue), the person who collects the
 * fees, and for each player the chat talks about, a position and a
 * starting rating with the quote behind them. Everything is advisory:
 * the admin reviews and overrides it before anything is saved.
 *
 * THE MODEL: Haiku 5.5 through `pipeline/llm.ts`, adaptive thinking at
 * medium (2026-10-21; `HAIKU_CALL`), after a whole rewrite of the prompt.
 * It was Sonnet 5 with thinking off. Paid check:
 * `scripts/live-check-onboarding-analyzer.ts`.
 *
 * WHAT THE REWRITE CHANGED IN MEANING: a player the chat says nothing
 * about is left out of the answer instead of being given a 6, and the
 * code fills them in with no suggestion. A blank rating is the club's
 * "no opinion yet" state (actions/onboarding.ts, the wizard's commit),
 * so a 6 the chat never gave was a made-up opinion.
 *
 * One call per org, so the system prompt is NOT cached (2026-10-19): a
 * 1-hour cache write bills 2x input and nothing reads it back within the
 * hour. A year of 14-person chat (~15k messages) fits in one call well
 * under the model's context window.
 */

import type { ParsedChat } from "./whatsapp-parser";
import { anthropicModel, extractJson, HAIKU_CALL, type ModelCall, type PipelineModel } from "@/lib/pipeline/llm";
import { stripLongDashes } from "./house-style";

export const ONBOARDING_ANALYZER_CALL: ModelCall = HAIKU_CALL;
/** The pipeline's ceiling. The answer is a page of JSON at most (players
 *  with no signal are left out); the rest is room for Haiku's thinking,
 *  which shares the budget. A cut-off answer throws and reads as null. */
const MAX_TOKENS = 4_096;

export const ONBOARDING_ANALYZER_SYSTEM = `You help a sports group set itself up on MatchTime by reading its WhatsApp chat. The group's admin checks everything you propose before anything is saved, so leave a field empty rather than guess.

You are given the SPORT, its POSITIONS, the PLAYERS (use their names exactly as listed) and the CHAT, oldest first, each line with its weekday, date, time and author. The chat may be in English, Turkish or both.

Return three things.

"schedule": the group's regular game, when the chat shows one (the same day and time named more than once, or "same time next week").
- day: the weekday, in English ("Thursday"). "" if there is no regular day.
- time: the kickoff as HH:MM, 24-hour ("8pm" is "20:00", "21.30" is "21:30"). "" if there is no regular time.
- venue: the place, as the chat names it ("Goals Sutton"). "" if it is never named.
- confidence: 0 to 1, how sure you are that this is the regular game.

"paymentHolder": the one person who collects the match fees.
- name: from PLAYERS. They ask for the money ("£7 each, send to me"), share bank details, or others say they paid them ("paid Elvin"). "" if the chat does not show one person collecting.
- evidence: the chat's words that show it, under 20 words. "" when name is "".
- confidence: 0 to 1.

"players": one entry for each player the chat says something about as a player, and nobody else. Players you leave out are shown to the admin with no suggestion.
- name: from PLAYERS.
- position: one of POSITIONS, when the chat shows where they play: "unreal in goal" is the goalkeeper, "solid at the back" a defender, "ran the midfield" a midfielder, and the one scoring the goals ("another hat-trick", "scored 4") a forward. "" when it does not. Never guess from a name.
- seedRating: 1 to 10, how good team-mates say they are. Praise, goals, "man of the match" and "best player" raise it; complaints and mistakes lower it. Keep to 3 to 9 unless the chat is overwhelming. 0 when the chat says nothing about how good they are.
- evidence: the chat's words behind it, under 20 words, close enough that the admin can search the chat for them.
- confidence: 0 to 1, how sure you are.

Saying "in", turning up, paying or chatting says nothing about a player. Never use a name, a time or a place the chat does not contain.

Examples (English / Turkish):
- "Najib saved us again, unreal in goal" / "Kerem yine kalede devleşti": the goalkeeper, rating 8
- "Talha hat-trick, a machine up front" / "Burak 3 gol attı, forvette durdurulamaz": forward, 8
- "Khalid solid at the back" / "Emre defansta duvar gibiydi": defender, 7
- "Omar kept giving the ball away" / "Ali sürekli top kaybetti": position "", rating 4
- "Thursday 8pm Goals Sutton, usual spot" / "Cuma 21:00 Halısaha Arena, her zamanki saha": Thursday 20:00 Goals Sutton / Friday 21:00 Halısaha Arena
- Elvin: "£7 each, send to me" / Mert: "kişi başı 150 TL, IBAN'ıma atın": paymentHolder Elvin / Mert
- "in" / "varım": nothing about the player`;

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The answer's shape. Built per call: the position must be one of the
 *  sport's. "" and 0 stand for empty, because the API rejects a
 *  nullable type at request time (see pipeline/extractors.ts). */
function analysisSchema(validPositions: string[]): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      schedule: {
        type: "object",
        properties: {
          day: { type: "string", enum: [...DAYS, ""] },
          time: { type: "string" },
          venue: { type: "string" },
          confidence: { type: "number" },
        },
        required: ["day", "time", "venue", "confidence"],
        additionalProperties: false,
      },
      paymentHolder: {
        type: "object",
        properties: {
          name: { type: "string" },
          evidence: { type: "string" },
          confidence: { type: "number" },
        },
        required: ["name", "evidence", "confidence"],
        additionalProperties: false,
      },
      players: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            position: { type: "string", enum: [...validPositions, ""] },
            seedRating: { type: "integer" },
            evidence: { type: "string" },
            confidence: { type: "number" },
          },
          required: ["name", "position", "seedRating", "evidence", "confidence"],
          additionalProperties: false,
        },
      },
    },
    required: ["schedule", "paymentHolder", "players"],
    additionalProperties: false,
  };
}

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

/** PURE. The user turn: the sport, its positions, the players and the
 *  chat, each message on one line with its weekday. */
export function onboardingUserTurn(args: AnalyzeArgs): string {
  // Cap at ~15k messages: a year of a 14-person chat, well inside the
  // model's context window, keeping the most recent.
  const msgs = args.parsed.recentMessages.slice(-15_000);
  const lines = msgs.map((m) => {
    const ts = m.timestamp.toISOString().slice(0, 16).replace("T", " ");
    const body = m.body.replace(/\s+/g, " ").slice(0, 200);
    return `[${DAY_ABBR[m.timestamp.getUTCDay()]} ${ts}] ${m.author}: ${body}`;
  });
  return [
    `SPORT: ${args.sportName}`,
    `POSITIONS: ${args.validPositions.join(", ")}`,
    "",
    `PLAYERS (${args.candidateNames.length}):`,
    ...args.candidateNames.map((n) => `- ${n}`),
    "",
    `CHAT (${msgs.length} messages, oldest first):`,
    ...lines,
  ].join("\n");
}

export async function analyzeForOnboarding(
  args: AnalyzeArgs,
  deps?: { model?: PipelineModel },
): Promise<OnboardingAnalysis | null> {
  if (!deps?.model && !process.env.ANTHROPIC_API_KEY) {
    console.error("[onboarding-analyzer] ANTHROPIC_API_KEY not set");
    return null;
  }
  try {
    const model = deps?.model ?? anthropicModel();
    const resp = await model.complete({
      ...ONBOARDING_ANALYZER_CALL,
      system: ONBOARDING_ANALYZER_SYSTEM,
      user: onboardingUserTurn(args),
      maxTokens: MAX_TOKENS,
      schema: analysisSchema(args.validPositions),
      // Once per club: a 1-hour cache write bills 2x input and nothing
      // reads it back within the hour.
      cache: false,
      label: "onboarding-analyzer",
    });
    const raw = resp.text.trim();
    if (!raw) return null;
    return normaliseAnalysis(raw, args);
  } catch (err) {
    // A failed call, a truncated answer (TruncatedResponseError) or the
    // club's daily AI cap: the wizard carries on with manual defaults.
    console.error("[onboarding-analyzer] model call failed:", err);
    return null;
  }
}

function normaliseAnalysis(rawText: string, args: AnalyzeArgs): OnboardingAnalysis | null {
  let json: unknown;
  try {
    json = extractJson(rawText);
  } catch {
    return null;
  }
  if (!json || typeof json !== "object") return null;
  const obj = json as Record<string, unknown>;

  // Schedule.
  const sched = (obj.schedule ?? {}) as Record<string, unknown>;
  // The weekday by name ("Thursday"); a 0-6 number is still read.
  const dayIdx = typeof sched.day === "string" ? DAYS.indexOf(sched.day) : -1;
  const schedule = {
    dayOfWeek:
      dayIdx >= 0
        ? dayIdx
        : typeof sched.dayOfWeek === "number" && sched.dayOfWeek >= 0 && sched.dayOfWeek <= 6
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
      typeof ph.evidence === "string" && ph.evidence.trim() ? stripLongDashes(ph.evidence.trim().slice(0, 200)) : null,
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
        typeof po.evidence === "string" ? stripLongDashes(po.evidence.slice(0, 200)) : "";
      const confidence =
        typeof po.confidence === "number"
          ? Math.max(0, Math.min(1, po.confidence))
          : 0;
      return { name, position, seedRating, evidence, confidence };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null);

  // Every candidate appears: the model names only the players the chat
  // talks about, and the rest get no suggestion (a blank rating, the
  // club's "no opinion yet"), so the UI has no holes.
  const found = new Set(players.map((p) => p.name.toLowerCase()));
  for (const n of args.candidateNames) {
    if (!found.has(n.toLowerCase())) {
      players.push({
        name: n,
        position: null,
        seedRating: null,
        evidence: "No clear signal in chat, defaulting to neutral",
        confidence: 0,
      });
    }
  }

  return { schedule, paymentHolder, players };
}
