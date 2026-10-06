/**
 * WHOSE NUMBER IS WHOSE: mapping a result message's facts onto Red and
 * Yellow (2026-10-07). Pure: no DB, no clock, no model.
 *
 * The score extractor reports what the message says about teams
 * VERBATIM (`ScoreFacts`). This file turns that into `{ red, yellow }`
 * using the club's own team names, or says it cannot.
 *
 * WHY THE MODEL DOES NOT DO THIS. It does not know what this club calls
 * its teams (`team-labels.ts`: a club, or a single match, can rename
 * them), and which side is "Red" is a fact in the database, not in the
 * message. Until 2026-10-06 nobody did it at all: the engine put the
 * first number on Red, and "9-6 to yellows" was recorded Red 9.
 *
 * THE RULE WHEN NOTHING SAYS: ASK. Two different numbers with no team
 * ("10-7") used to be recorded Red first. That is not a convention this
 * product ever told anybody: the bot's own question is "What was the
 * final score?", and of the club's twelve reports before the incident
 * every one with a winner named the team ("5-4 to Yellows"). A guess
 * that is wrong half the time, announced as "recorded", is worse than
 * one short question. A draw needs no team and is never asked about.
 */
import type { ScoreFacts } from "./types";

export type TeamSide = "RED" | "YELLOW";

export type ScoreResolution =
  | { kind: "resolved"; red: number; yellow: number }
  | {
      kind: "ask";
      /** `no_team`: the message names nobody. `unknown_team`: it names
       *  somebody who is neither side (or "we" from a sender who was on
       *  neither). `conflict`: it says two things that cannot both hold. */
      why: "no_team" | "unknown_team" | "conflict";
    };

const other = (t: TeamSide): TeamSide => (t === "RED" ? "YELLOW" : "RED");

/** Lower case, Turkish letters folded to ASCII, everything that is not a
 *  letter or digit removed. "Sarılar" and "SARILAR" and "sarilar" agree. */
function fold(s: string): string {
  return s
    .toLocaleLowerCase("tr")
    .replace(/ı/g, "i")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/** Words people put around a team name that are not part of it. */
const FILLER = /^(the|team|takim)|(team|takim|takimi)$/g;

const SELF = new Set(["us", "we", "our", "ours", "biz", "bizim", "bizimkiler"]);
const THEM = new Set(["them", "they", "their", "theirs", "onlar", "onlarin"]);

/** The colour each side wears, in both languages the product speaks. */
const COLOUR: Record<TeamSide, string[]> = {
  RED: ["red", "kirmizi"],
  YELLOW: ["yellow", "sari"],
};

/** Does `ref` name `name`? Exact, or one is the other plus a short
 *  ending ("yellows", "sarilar", "lion" for "Lions"). Three letters
 *  minimum, so "a" never matches "Arsenal". */
function names(ref: string, name: string): boolean {
  if (!ref || !name) return false;
  if (ref === name) return true;
  if (name.length >= 3 && ref.startsWith(name) && ref.length - name.length <= 4) return true;
  if (ref.length >= 3 && name.startsWith(ref)) return true;
  return false;
}

/**
 * Which side does this reference mean? null when it means neither, or
 * could mean both.
 *
 * Order: the sender's own side ("us" / "them"), then the club's names
 * for its teams, then the colour words. A club's own name wins over a
 * colour, so a club that calls a side "Yellow Submarines" is not
 * second-guessed.
 */
export function resolveTeamRef(
  ref: string | undefined | null,
  labels: readonly [string, string],
  senderTeam: TeamSide | null,
): TeamSide | null {
  const raw = (ref ?? "").trim();
  if (!raw) return null;
  const folded = fold(raw);
  if (SELF.has(folded)) return senderTeam;
  if (THEM.has(folded)) return senderTeam ? other(senderTeam) : null;

  const bare = folded.replace(FILLER, "") || folded;
  const red = fold(labels[0]);
  const yellow = fold(labels[1]);
  const isRed = names(bare, red) || names(folded, red);
  const isYellow = names(bare, yellow) || names(folded, yellow);
  if (isRed !== isYellow) return isRed ? "RED" : "YELLOW";
  if (isRed && isYellow) return null;

  const colourRed = COLOUR.RED.some((c) => names(bare, c));
  const colourYellow = COLOUR.YELLOW.some((c) => names(bare, c));
  if (colourRed !== colourYellow) return colourRed ? "RED" : "YELLOW";
  return null;
}

/**
 * Map the facts onto `{ red, yellow }`.
 *
 * Every statement in the message that names a team is turned into "what
 * would Red's score be if this were true", and the answers must agree.
 * `first` and `second` are taken as given; range checking is the
 * engine's.
 */
export function resolveScoreResult(args: {
  facts: ScoreFacts;
  /** The PLAYED match's display names, [red, yellow]. */
  labels: readonly [string, string];
  /** The sender's side in that match, or null. */
  senderTeam: TeamSide | null;
}): ScoreResolution {
  const { facts, labels, senderTeam } = args;
  const { first, second } = facts;
  // A draw is the same whoever is Red.
  if (first === second) return { kind: "resolved", red: first, yellow: second };

  const hi = Math.max(first, second);
  const lo = Math.min(first, second);
  let named = 0;
  let unknown = 0;
  /** Red's score according to each statement that resolved. */
  const redSays = new Set<number>();

  const consider = (ref: string | undefined, ifRed: number, ifYellow: number) => {
    if (!(ref ?? "").trim()) return;
    named++;
    const side = resolveTeamRef(ref, labels, senderTeam);
    if (!side) {
      unknown++;
      return;
    }
    redSays.add(side === "RED" ? ifRed : ifYellow);
  };

  consider(facts.firstTeam, first, second); // first is this team's
  consider(facts.secondTeam, second, first); // second is this team's
  consider(facts.winner, hi, lo); // this team has the bigger number
  consider(facts.loser, lo, hi); // this team has the smaller number

  if (redSays.size > 1) return { kind: "ask", why: "conflict" };
  if (redSays.size === 1) {
    const red = [...redSays][0];
    return { kind: "resolved", red, yellow: red === first ? second : first };
  }
  return { kind: "ask", why: named === 0 ? "no_team" : unknown > 0 ? "unknown_team" : "no_team" };
}
