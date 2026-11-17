/**
 * WHAT A CLUB CALLS ITS TWO SIDES (2026-11-17). Pure: no DB, no clock, no
 * model.
 *
 * ── THE INCIDENT ─────────────────────────────────────────────────────
 * Monday night vets, 16 Nov 2026, 22:14. After the game the organiser
 * wrote "@Match Time bibs 9, no bibs 4". The router sent it to admin_ops,
 * the admin extractor read "other", and MatchTime answered "can't do
 * that", twice. He deleted the replies and entered the score by hand.
 * Two facts were missing, and neither is a rule:
 *
 *   1. that the club's game had finished and MatchTime was waiting for its
 *      score (the router saw a tagged message with two numbers in it and
 *      nothing else);
 *   2. what the club calls its sides. In MatchTime's data they were "Red"
 *      and "Yellow" (`Match.teamLabels` was empty); on the pitch they were
 *      the bibs and the no bibs.
 *
 * ── WHAT THIS FILE DOES ──────────────────────────────────────────────
 * It turns those facts into CONTEXT and back:
 *
 *   - `awaitedScoreLine`: the router's line while a finished game has no
 *     score (load-awaiting-answer.ts decides when);
 *   - `gameContextLines`: THE GAME block the score extractor reads: the
 *     two sides by MatchTime's names, what this club also calls each, and
 *     who played on each (so "Dan's team" is the side Dan was on);
 *   - `normaliseScoreFacts`: before the engine reads the facts, a team
 *     reference CODE can place is rewritten as MatchTime's own name for
 *     that side. The engine (`score-teams.ts`) then resolves it as it
 *     always has, and is not touched. Code places a name from three
 *     things only (review of #620): the club's or the match's own team
 *     names (`score-teams.ts`, first), THIS match's own stored names, and
 *     a player's team ("Dan's team") whose player the extractor names and
 *     whose line-up in THE GAME is one side only. Never from an earlier
 *     match's names: the side that wears the bibs changes from week to
 *     week, and a remembered name recorded results the wrong way round
 *     without asking. Never from the side the extractor SAYS a name is;
 *   - `sideQuestion`: when a name still means no side, the name MatchTime
 *     asks about. It is ALWAYS the winning side's name (the one beside the
 *     bigger number, or the one a word says won), so the answer to "Which
 *     team was bibs, Red or Yellow?" is the winner, and the engine's open
 *     "which team won?" question (`score-ask.ts`) reads it unchanged;
 *   - `learnedSideNames`: what the recorded result teaches (bibs had the 9,
 *     Red got the 9: bibs is Red), stored for THAT match only
 *     (`load-side-names.ts`). A player's team is never stored. The next
 *     game asks again, and an earlier game's answer is only a hint in the
 *     question ("Last time it was Red", `hintSide`);
 *   - `sideNamesAfterCorrection`: a corrected result rewrites (the other
 *     way round) or deletes the match's names.
 *
 * No word here is read from a person's message. A stored name is
 * compared with the extractor's team reference by `score-teams.ts`'s own
 * whole-word rule (`nameMatch`), exactly as a side's label is.
 */
import { resolveTeamRef, nameMatch, type TeamSide } from "./score-teams";
import { samePair } from "./score-ask";
import type { ScoreFacts } from "./types";

/** What a club calls each side besides MatchTime's own name for it. */
export interface SideNames {
  red: string[];
  yellow: string[];
}

/** The `SentNotification` kind the names are stored under, one row per
 *  match (`sideNamesKey`), its `text` the JSON (`encodeSideNames`). */
export const SCORE_SIDE_NAMES_KIND = "score-side-names";
export const sideNamesKey = (matchId: string) => `${matchId}:${SCORE_SIDE_NAMES_KIND}`;

/** At most this many names are kept for a side, the newest. */
const NAMES_PER_SIDE = 4;
/** And each name is a short phrase, not a sentence. */
const NAME_MAX = 40;

const fold = (s: string) => s.toLocaleLowerCase("tr").replace(/\s+/g, " ").trim();
const SELF_OR_THEM = new Set(["us", "them"]);
const isSelfOrThem = (ref: string) => SELF_OR_THEM.has(fold(ref));
const side = (s: TeamSide): keyof SideNames => (s === "RED" ? "red" : "yellow");
const other = (s: TeamSide): TeamSide => (s === "RED" ? "YELLOW" : "RED");
const labelOf = (labels: readonly [string, string], s: TeamSide) => (s === "RED" ? labels[0] : labels[1]);

export const NO_SIDE_NAMES: SideNames = Object.freeze({ red: [], yellow: [] }) as SideNames;

export function hasSideNames(n: SideNames | null | undefined): n is SideNames {
  return !!n && (n.red.length > 0 || n.yellow.length > 0);
}

function cleanNames(v: unknown): string[] | null {
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) return null;
  return (v as string[]).map((x) => x.trim().slice(0, NAME_MAX)).filter(Boolean);
}

/** The stored row's text, read. Anything unreadable is no names. */
export function parseSideNames(text: string | null | undefined): SideNames {
  if (!text) return { red: [], yellow: [] };
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const red = cleanNames(raw?.red);
    const yellow = cleanNames(raw?.yellow);
    if (!red || !yellow) return { red: [], yellow: [] };
    return { red, yellow };
  } catch {
    return { red: [], yellow: [] };
  }
}

export function encodeSideNames(n: SideNames): string {
  return JSON.stringify({ red: n.red, yellow: n.yellow });
}

/**
 * `add` on top of `base`. A name learned for one side leaves the other
 * (the club swapped which side wears the bibs), and a name already there
 * is kept once, as most recently written.
 */
export function mergeSideNames(base: SideNames | null | undefined, add: SideNames): SideNames {
  const out: SideNames = { red: [...(base?.red ?? [])], yellow: [...(base?.yellow ?? [])] };
  for (const key of ["red", "yellow"] as const) {
    for (const raw of add[key]) {
      const name = raw.trim().slice(0, NAME_MAX);
      if (!name) continue;
      out.red = out.red.filter((n) => fold(n) !== fold(name));
      out.yellow = out.yellow.filter((n) => fold(n) !== fold(name));
      out[key].push(name);
    }
  }
  return { red: out.red.slice(-NAMES_PER_SIDE), yellow: out.yellow.slice(-NAMES_PER_SIDE) };
}

/** Which side do the club's stored names say this reference means? The
 *  stronger match wins ("bibs" names "bibs" fully and "no bibs" in part);
 *  a tie, or no match, is no side. */
export function sideByNames(ref: string | null | undefined, names: SideNames | null | undefined): TeamSide | null {
  if (!(ref ?? "").trim() || !names) return null;
  const best = (list: string[]) => Math.max(0, ...list.map((n) => nameMatch(ref, n)));
  const red = best(names.red);
  const yellow = best(names.yellow);
  if (red === yellow) return null;
  return red > yellow ? "RED" : "YELLOW";
}

/** The extractor's entry for this reference, if any. */
function entryFor(ref: string, facts: ScoreFacts) {
  return facts.teamSides?.find((t) => fold(t.team) === fold(ref)) ?? null;
}

/**
 * The side the extractor says an ANSWER gives for a name MatchTime asked
 * about ("red", answering "Which team was bibs?"). Read only for the
 * answer to MatchTime's own question, never to place a name in a report.
 */
function answeredSideOf(ref: string, facts: ScoreFacts): TeamSide | null {
  return entryFor(ref, facts)?.side ?? null;
}

/** THE GAME's line-ups, by display name, as the extractor was shown them. */
export interface Lineups {
  red: string[];
  yellow: string[];
}

/**
 * A player's team, placed by CODE (review of #620, 2): the extractor names
 * the player the reference is named after, exactly as THE GAME lists them;
 * the side is the line-up that player is on. A name on both sides, or on
 * neither, places nothing, and MatchTime asks. The side the extractor said
 * is not read.
 */
export function sideByPlayer(ref: string, facts: ScoreFacts, lineups: Lineups | null | undefined): TeamSide | null {
  const player = (entryFor(ref, facts)?.player ?? "").trim();
  if (!player || !lineups) return null;
  const on = (list: string[]) => list.some((n) => fold(n) === fold(player));
  const red = on(lineups.red);
  const yellow = on(lineups.yellow);
  if (red === yellow) return null;
  return red ? "RED" : "YELLOW";
}

/** Does the extractor say this reference is named after a player? */
function namesAPlayer(ref: string, facts: ScoreFacts): boolean {
  return !!(entryFor(ref, facts)?.player ?? "").trim();
}

export interface SideContext {
  /** The played match's names, [red, yellow]. */
  labels: readonly [string, string];
  /** What this club called each side IN THIS MATCH (its own stored
   *  names). Never an earlier match's: those are only a hint. */
  names: SideNames | null | undefined;
  /** The sender's side in the played match, or null. */
  senderTeam: TeamSide | null;
  /** THE GAME's line-ups, for a player's team. */
  lineups?: Lineups | null;
}

/**
 * The facts with every team reference code can place (this match's own
 * names, a player's team by its line-up) rewritten as MatchTime's own name
 * for that side, so the engine resolves it. A reference the code already
 * resolves (a side's name or colour) and "us" / "them" are left as
 * written: the engine knows the sender's side.
 *
 * `asked`: the names MatchTime asked about for this match's open question
 * (`sideQuestion`). A message with no numbers and no winner or loser that
 * places one of them ("Red", answering "Which team was bibs?") gets the
 * winner it means: the asked name is always the winning side's.
 */
export function normaliseScoreFacts(
  facts: ScoreFacts,
  ctx: SideContext & { asked?: { name: string; other?: string; noStore?: string[] } | null },
): { facts: ScoreFacts; mapped: string[] } {
  const out: ScoreFacts = { ...facts };
  const mapped: string[] = [];
  for (const field of ["firstTeam", "secondTeam", "winner", "loser"] as const) {
    const ref = (out[field] ?? "").trim();
    if (!ref || isSelfOrThem(ref)) continue;
    if (resolveTeamRef(ref, ctx.labels, ctx.senderTeam)) continue;
    const byNames = sideByNames(ref, ctx.names);
    const s = byNames ?? sideByPlayer(ref, facts, ctx.lineups);
    if (!s) continue;
    out[field] = labelOf(ctx.labels, s);
    mapped.push(
      `${field} "${ref}" is ${labelOf(ctx.labels, s)} (${byNames ? "this game's own name for it" : `the line-up ${entryFor(ref, facts)?.player} is on`})`,
    );
  }
  const asked = ctx.asked;
  if (asked && out.first === null && !(out.winner ?? "").trim() && !(out.loser ?? "").trim()) {
    const named = answeredSideOf(asked.name, facts);
    const placedOther = asked.other ? answeredSideOf(asked.other, facts) : null;
    const winner = named ?? (placedOther ? other(placedOther) : null);
    if (winner) {
      out.winner = labelOf(ctx.labels, winner);
      mapped.push(`answers which side "${asked.name}" was: ${labelOf(ctx.labels, winner)}`);
    }
  }
  return { facts: out, mapped };
}

/** A reference that is a name and means no side yet. */
function unplaced(ref: string | undefined, ctx: SideContext, facts: ScoreFacts): string | null {
  const r = (ref ?? "").trim();
  if (!r || isSelfOrThem(r)) return null;
  if (resolveTeamRef(r, ctx.labels, ctx.senderTeam)) return null;
  if (sideByNames(r, ctx.names)) return null;
  if (sideByPlayer(r, facts, ctx.lineups)) return null;
  return r;
}

/**
 * The name to ask about, from facts already normalised, or null when the
 * engine's own "which team won?" is the right question. Always the
 * WINNING side's name: the one a word says won, else the one beside the
 * bigger number. `other` is the losing side's name, when the message
 * gave one, so the answer teaches both. `noStore`: the asked names that
 * are a player's team ("Dan's team"), which the answer records but which
 * are never stored (review of #620).
 */
export interface AskedNames {
  name: string;
  other?: string;
  noStore?: string[];
}

export function sideQuestion(facts: ScoreFacts, ctx: SideContext): AskedNames | null {
  if (facts.first === null || facts.second === null || facts.first === facts.second) return null;
  const firstIsHigher = facts.first > facts.second;
  const said = (facts.winner ?? "").trim();
  const name = said ? unplaced(said, ctx, facts) : unplaced(firstIsHigher ? facts.firstTeam : facts.secondTeam, ctx, facts);
  if (!name) return null;
  const found =
    unplaced(facts.loser, ctx, facts) ?? unplaced(firstIsHigher ? facts.secondTeam : facts.firstTeam, ctx, facts);
  const otherName = found && fold(found) !== fold(name) ? found : null;
  const noStore = [name, otherName].filter((n): n is string => !!n && namesAPlayer(n, facts));
  return { name, ...(otherName ? { other: otherName } : {}), ...(noStore.length > 0 ? { noStore } : {}) };
}

/** The asked names as stored on the score question's row (`text`). */
export function scoreAskNamesText(asked: AskedNames | null | undefined): string | null {
  if (!asked?.name) return null;
  return JSON.stringify({
    name: asked.name,
    ...(asked.other ? { other: asked.other } : {}),
    ...(asked.noStore && asked.noStore.length > 0 ? { noStore: asked.noStore } : {}),
  });
}

export function parseScoreAskNames(text: string | null | undefined): AskedNames | null {
  if (!text) return null;
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (typeof raw?.name !== "string" || !raw.name.trim()) return null;
    const noStore = cleanNames(raw.noStore) ?? [];
    return {
      name: raw.name,
      ...(typeof raw.other === "string" && raw.other.trim() ? { other: raw.other } : {}),
      ...(noStore.length > 0 ? { noStore } : {}),
    };
  } catch {
    return null;
  }
}

/** An earlier game's side for the asked name: a HINT in the question
 *  ("Last time it was Red"), never a reason to record without asking. */
export function hintSide(name: string, earlier: SideNames | null | undefined): TeamSide | null {
  return sideByNames(name, earlier);
}

/**
 * What a CORRECTED result does to the match's own names (review of #620):
 * the same pair the other way round swaps them; the same winner keeps
 * them; anything else (other numbers and another winner, a draw either
 * side) deletes them, so the next report is asked about.
 */
export function sideNamesAfterCorrection(
  names: SideNames | null | undefined,
  previous: { red: number; yellow: number },
  next: { red: number; yellow: number },
): { kind: "keep" } | { kind: "rewrite"; names: SideNames } | { kind: "delete" } {
  if (!hasSideNames(names)) return { kind: "keep" };
  const winner = (r: { red: number; yellow: number }): TeamSide | null =>
    r.red === r.yellow ? null : r.red > r.yellow ? "RED" : "YELLOW";
  const was = winner(previous);
  const now = winner(next);
  if (was && now && was === now) return { kind: "keep" };
  if (was && now && samePair({ first: previous.red, second: previous.yellow }, { first: next.red, second: next.yellow })) {
    return { kind: "rewrite", names: { red: [...names.yellow], yellow: [...names.red] } };
  }
  return { kind: "delete" };
}

/**
 * What a recorded result teaches about the names MatchTime asked about.
 * The asked name was the winning side's, so it is the side that got the
 * bigger number; `other` is the other side. Only for the scoreline asked
 * about, and never from a draw.
 */
export function learnedSideNames(
  pending: { first: number; second: number; name?: string; other?: string; noStore?: string[] },
  recorded: { red: number; yellow: number },
): SideNames | null {
  if (!pending.name) return null;
  if (recorded.red === recorded.yellow) return null;
  if (!samePair(pending, { first: recorded.red, second: recorded.yellow })) return null;
  const winner: TeamSide = recorded.red > recorded.yellow ? "RED" : "YELLOW";
  const skip = new Set((pending.noStore ?? []).map(fold));
  const out: SideNames = { red: [], yellow: [] };
  if (!skip.has(fold(pending.name))) out[side(winner)].push(pending.name);
  if (pending.other && !skip.has(fold(pending.other))) out[side(other(winner))].push(pending.other);
  return hasSideNames(out) ? out : null;
}

const quoted = (names: string[]) => names.map((n) => `"${n}"`).join(" or ");

/**
 * THE GAME, for the score extractor: the club's latest game, whether its
 * score is awaited, and per side MatchTime's name, the club's other names
 * and the players on it. Facts only; the prompt says what to do with them.
 *
 * A RECORDED RESULT IS NOT SHOWN. The first cut said "Its result is
 * recorded: Red 9, Yellow 6", and on the live check the model then read
 * "@Match Time it was 9-2 to yellow" as a correction of it, 3 runs of 3
 * (it is a fresh claim, and a tagged message that is not a correction must
 * not change a record: score-live-cases G1). Without the line, 3 of 3
 * right, as on the old prompt.
 */
export function gameContextLines(g: {
  /** When it kicked off, in words ("Mon 16 Nov 20:15"). */
  when: string;
  labels: readonly [string, string];
  names: SideNames | null | undefined;
  players: { red: string[]; yellow: string[] };
  /** The game has no result yet. */
  awaiting: boolean;
}): string[] {
  const state = g.awaiting ? " MatchTime is waiting for its score." : "";
  const line = (key: "red" | "yellow", label: string) => {
    const names = (g.names?.[key] ?? []).filter((n) => fold(n) !== fold(label));
    const parts = [`MatchTime calls it "${label}"`];
    if (names.length > 0) parts.push(`this club called it ${quoted(names)} in this game`);
    parts.push(g.players[key].length > 0 ? `players ${g.players[key].join(", ")}` : "no players on record");
    return `  ${key}: ${parts.join("; ")}`;
  };
  return [
    `THE GAME (the club's latest game, the one a result is about): ${g.when}, finished.${state}`,
    line("red", g.labels[0]),
    line("yellow", g.labels[1]),
  ];
}

/** The router's line while a finished game's score is awaited. */
export function awaitedScoreLine(a: { when: string; labels: readonly [string, string]; names: SideNames | null | undefined }): string {
  const head = `MATCHTIME IS WAITING for the score of the club's last game (${a.when}), which has finished. Its two sides are ${a.labels[0]} and ${a.labels[1]}`;
  const also = alsoCalled(a.labels, a.names);
  return also ? `${head}; ${also}.` : `${head}.`;
}

/** "this club also calls Red "bibs" and Yellow "no bibs"", or null when
 *  the club has no other names. Shared by both groups' waiting lines. */
export function alsoCalled(labels: readonly [string, string], names: SideNames | null | undefined): string | null {
  const also = (["red", "yellow"] as const)
    .map((key, i) => {
      const own = (names?.[key] ?? []).filter((n) => fold(n) !== fold(labels[i]));
      return own.length > 0 ? `${labels[i]} ${quoted(own)}` : null;
    })
    .filter((x): x is string => !!x);
  return also.length > 0 ? `this club also calls ${also.join(" and ")}` : null;
}

/** The two labels with the club's names beside them, for the line that
 *  says a result was recorded: "Red (bibs)". A name that is the label
 *  already adds nothing. */
export function labelsWithSideNames(labels: readonly [string, string], names: SideNames | null | undefined): [string, string] {
  const one = (key: "red" | "yellow", label: string) => {
    const extra = (names?.[key] ?? []).filter((n) => fold(n) !== fold(label));
    return extra.length > 0 ? `${label} (${extra.join(", ")})` : label;
  };
  return [one("red", labels[0]), one("yellow", labels[1])];
}
