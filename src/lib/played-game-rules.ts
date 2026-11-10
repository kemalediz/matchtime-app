/**
 * A TEAM CHANGE AFTER KICKOFF FIXES THE GAME JUST PLAYED (Kemal,
 * 2026-11-10).
 *
 * Mon 9 Nov, Vets, kickoff 20:15: Luca played for CJ on Bibs. Once the game
 * was over (`match-completion.ts` marks it COMPLETED after kickoff plus its
 * length) every WhatsApp team path picked only a game not yet played
 * (`selectRegistrationMatch`), so a change asked in the admin group went to
 * next week's game or got "no teams yet".
 *
 * THE RULE, one decision for every team path in the admin group: on the
 * London day of a game, once it has kicked off, a change to the TEAMS is
 * for that game when
 *
 *   - it is COMPLETED (never CANCELLED) and has teams, and
 *   - it is the latest game of the club that kicked off today, and
 *   - no other game of the club kicks off later the same day (that one
 *     wins, as it always did).
 *
 * Otherwise, and from the next London day, nothing changes: the club's
 * registration match (`registration-match-select.ts`).
 *
 * Only a change to the teams is moved, never a squad edit: "Ben is out" on
 * match night is about the next game and stays there. Which team commands
 * may fix a played game is `teamCommandFixesPlayedGame`; which squad
 * readings are a line-up fix (a replacement for a player on its teams) is
 * `playedGameReplacements`. Both are read from facts (the command the
 * teams extractor made, the members the HQ squad reader and who-is-who
 * placed), never from the words.
 *
 * Pure: no clock, no database.
 */
import { formatLondon } from "./london-time";
import type { TeamCommand } from "./team-proposal-rules";
import type { HqSquadChange } from "./hq-squad-reader-prompt";

export interface PlayedCandidate {
  id: string;
  date: Date;
  status: string;
  /** The game has TeamAssignment rows. */
  hasTeams: boolean;
}

const londonDay = (d: Date) => formatLondon(d, "yyyy-MM-dd");

/**
 * The game just played that a team change is for, or null (the caller
 * then uses the registration match, as before).
 */
export function justPlayedMatch<T extends PlayedCandidate>(matches: readonly T[], now: Date): T | null {
  const today = londonDay(now);
  const todays = matches.filter((m) => m.status !== "CANCELLED" && londonDay(m.date) === today);
  // A game later today still to kick off wins.
  if (todays.some((m) => m.date.getTime() > now.getTime())) return null;
  const latest = [...todays].sort((a, b) => b.date.getTime() - a.date.getTime())[0];
  return latest && latest.status === "COMPLETED" && latest.hasTeams ? latest : null;
}

/**
 * The team commands that may change a played game: showing the teams, a
 * change of who is on which side, a suggested swap (said, not made, as on
 * final teams). New teams, an earlier sheet or a pasted one ask for YES,
 * which is for a game to come: those keep the registration match.
 */
export function teamCommandFixesPlayedGame(command: TeamCommand): boolean {
  return command.kind === "show" || command.kind === "change" || command.kind === "suggest";
}

/** One player in for a player on the played game's teams. `inUserId` null:
 *  nobody in the club, added by `inName` as an organiser's add is. */
export interface PlayedGameFix {
  inUserId: string | null;
  inName: string;
  outUserId: string;
}

export type PlayedGameReading =
  /** Not a line-up fix of the played game: the squad change goes on as before. */
  | { kind: "none" }
  /** A fix, but who-is-who could not place these names: asked, nothing written. */
  | { kind: "unclear"; names: string[] }
  | { kind: "fix"; fixes: PlayedGameFix[] };

/**
 * Is an HQ squad reading ("Luca in for CJ") a fix of the played game's
 * line-up? Only when every arrival takes the place of a player on its
 * teams (`slotHolders`) and the reading says nothing else but those
 * players going out. Any other change in the same message (somebody out,
 * in or to the bench) makes it a squad change for the next game, as
 * before: nothing is split.
 */
export function playedGameReplacements(changes: readonly HqSquadChange[], slotHolders: ReadonlySet<string>): PlayedGameReading {
  const arrivals = changes.filter((c) => c.to === "in" && !!c.replacesUserId && slotHolders.has(c.replacesUserId));
  if (arrivals.length === 0) return { kind: "none" };
  const outs = arrivals.map((a) => a.replacesUserId as string);
  const ins = arrivals.map((a) => a.userId).filter((id): id is string => id !== null);
  if (new Set(outs).size !== outs.length || new Set(ins).size !== ins.length) return { kind: "none" };
  if (arrivals.some((a) => a.userId !== null && outs.includes(a.userId))) return { kind: "none" };
  const rest = changes.filter((c) => !arrivals.includes(c));
  if (!rest.every((c) => c.to === "out" && !c.unclear && c.userId !== null && outs.includes(c.userId))) return { kind: "none" };
  const unclear = arrivals.filter((a) => a.unclear);
  if (unclear.length) return { kind: "unclear", names: unclear.map((a) => a.written || a.name) };
  return { kind: "fix", fixes: arrivals.map((a) => ({ inUserId: a.userId, inName: a.name, outUserId: a.replacesUserId as string })) };
}
