/**
 * A GAME'S FEWEST AND MOST PLAYERS BY WHATSAPP (2026-11-03, Kemal: every
 * admin feature also works by tagging MatchTime). "@Match Time we can play
 * with 12", "@Match Time we play 12 to 16", "@Match Time up to 8 a side",
 * "@Match Time back to full teams".
 *
 * The admin extractor (the model) reads the words into `player_numbers`
 * facts: `minPlayers` and `maxPlayers` (the numbers said, null when not),
 * `fullTeams` (the minimum back to two full sides) and `matchDay` when a
 * day is named. Code picks the game: the club's only active weekly game,
 * or the one on the day named; with several and no day it asks which. Then
 * it saves through the activities page's own core (`savePlayerRange`) and
 * says what was set, and what sizes that allows.
 *
 * Organisers only, with a real tag: the callers check, as for every admin
 * action (`admin-ops-engine-batch.ts`, `admin-group-understand.ts`).
 */
import { db } from "./db";
import { appUrl } from "./app-url";
import { readDayHint } from "./fee-waiver-rules";
import { savePlayerRange } from "./player-range-save";
import { flexFormatCopy } from "./i18n/flex-format";

export interface PlayerRangeWords {
  /** The fewest said, or null when none was. */
  minPlayers: number | null;
  /** The most said, or null when none was. */
  maxPlayers: number | null;
  /** The minimum back to two full sides. */
  fullTeams: boolean;
  /** The day named for the game, as written, or null. */
  matchDay: string | null;
}

export interface PlayerRangeReply {
  outcome:
    | "player-range-set"
    | "player-range-cleared"
    | "player-range-unchanged"
    | "player-range-refused"
    | "player-range-which"
    | "player-range-no-game";
  replyText: string;
}

export interface GameRow {
  id: string;
  name: string;
  dayOfWeek: number;
}

/**
 * PURE. Which game the words mean: the only one, or the one on the day
 * named. "which" when several fit, "none" when none does.
 */
export function pickGame(games: GameRow[], dayPhrase: string | null): { kind: "one"; game: GameRow } | { kind: "which" } | { kind: "none" } {
  if (games.length === 0) return { kind: "none" };
  const hint = readDayHint(dayPhrase);
  if (hint?.kind === "weekday") {
    const onDay = games.filter((g) => g.dayOfWeek === hint.dow);
    if (onDay.length === 1) return { kind: "one", game: onDay[0] };
    if (onDay.length === 0 && games.length === 1) return { kind: "one", game: games[0] };
    return { kind: "which" };
  }
  return games.length === 1 ? { kind: "one", game: games[0] } : { kind: "which" };
}

export async function applyPlayerRangeWords(p: PlayerRangeWords & { orgId: string; lang: string | null }): Promise<PlayerRangeReply> {
  const c = flexFormatCopy(p.lang);
  const url = appUrl("/admin/activities");
  const games = await db.activity.findMany({
    where: { orgId: p.orgId, isActive: true },
    select: { id: true, name: true, dayOfWeek: true },
    orderBy: { createdAt: "asc" },
  });
  const picked = pickGame(games, p.matchDay);
  if (picked.kind === "none") return { outcome: "player-range-no-game", replyText: c.noGame({ url }) };
  if (picked.kind === "which") return { outcome: "player-range-which", replyText: c.whichGame({ names: games.map((g) => g.name), url }) };
  if (!p.fullTeams && p.minPlayers === null && p.maxPlayers === null) return { outcome: "player-range-refused", replyText: c.noNumbers({ url }) };

  const r = await savePlayerRange({
    activityId: picked.game.id,
    // "Back to full teams" clears the minimum; a number said sets it; a
    // side not mentioned is kept as it is.
    ...(p.fullTeams ? { min: null } : p.minPlayers !== null ? { min: p.minPlayers } : {}),
    ...(p.maxPlayers !== null ? { max: p.maxPlayers } : {}),
  });
  if (!r.ok) {
    return {
      outcome: "player-range-refused",
      replyText: c.rangeRefused({ error: r.error === "not-found" ? "not-a-number" : r.error, field: r.field, activityName: r.activityName, places: r.places, ceiling: r.ceiling, url }),
    };
  }
  console.log(
    `[player-range] org=${p.orgId} activity=${picked.game.id} set by WhatsApp: min ${r.minPlayers ?? "full"} max ${r.maxPlayers ?? "own format"}${r.changed ? "" : " (unchanged)"}`,
  );
  if (!r.changed) return { outcome: "player-range-unchanged", replyText: c.rangeUnchanged({ activityName: r.activityName, min: r.min, max: r.max, sides: r.sides }) };
  if (r.minPlayers === null && r.maxPlayers === null) {
    return { outcome: "player-range-cleared", replyText: c.rangeCleared({ activityName: r.activityName, places: r.places, perSide: r.perSide }) };
  }
  return {
    outcome: "player-range-set",
    replyText: c.rangeSet({ activityName: r.activityName, min: r.min, max: r.max, sides: r.sides, up: r.max > r.places }),
  };
}
