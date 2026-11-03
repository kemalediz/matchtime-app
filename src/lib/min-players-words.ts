/**
 * MINIMUM PLAYERS BY WHATSAPP (2026-11-03, Kemal: every admin feature also
 * works by tagging MatchTime). "@Match Time we can play with 12",
 * "@Match Time minimum 12 players", "@Match Time back to full teams".
 *
 * The admin extractor (the model) reads the words into `min_players`
 * facts: `minPlayers` (the number said) or `fullTeams` (back to two full
 * sides), and `matchDay` when a day is named. Code picks the game: the
 * club's only active weekly game, or the one on the day named; with
 * several and no day it asks which. Then it saves through the activities
 * page's own core (`saveMinPlayers`) and says what was set.
 *
 * Organisers only, with a real tag: the callers check, as for every admin
 * action (`admin-ops-engine-batch.ts`, `admin-group-understand.ts`).
 */
import { db } from "./db";
import { appUrl } from "./app-url";
import { readDayHint } from "./fee-waiver-rules";
import { saveMinPlayers } from "./min-players-save";
import { minPlayersCopy } from "./i18n/min-players";

export interface MinPlayersWords {
  /** The number said, or null when none was. */
  minPlayers: number | null;
  /** Back to two full sides. */
  fullTeams: boolean;
  /** The day named for the game, as written, or null. */
  matchDay: string | null;
}

export interface MinPlayersReply {
  outcome: "min-players-set" | "min-players-cleared" | "min-players-unchanged" | "min-players-refused" | "min-players-which" | "min-players-no-game";
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

export async function applyMinPlayersWords(p: MinPlayersWords & { orgId: string; lang: string | null }): Promise<MinPlayersReply> {
  const c = minPlayersCopy(p.lang);
  const url = appUrl("/admin/activities");
  const games = await db.activity.findMany({
    where: { orgId: p.orgId, isActive: true },
    select: { id: true, name: true, dayOfWeek: true },
    orderBy: { createdAt: "asc" },
  });
  const picked = pickGame(games, p.matchDay);
  if (picked.kind === "none") return { outcome: "min-players-no-game", replyText: c.noGame({ url }) };
  if (picked.kind === "which") return { outcome: "min-players-which", replyText: c.whichGame({ names: games.map((g) => g.name), url }) };
  if (!p.fullTeams && p.minPlayers === null) return { outcome: "min-players-refused", replyText: c.noNumber({ url }) };

  const r = await saveMinPlayers({ activityId: picked.game.id, value: p.fullTeams ? null : p.minPlayers });
  if (!r.ok) {
    const replyText =
      r.error === "too-high" ? c.tooHigh({ activityName: r.activityName, places: r.places }) : r.error === "too-low" ? c.tooLow : c.noNumber({ url });
    return { outcome: "min-players-refused", replyText };
  }
  console.log(`[min-players] org=${p.orgId} activity=${picked.game.id} set by WhatsApp: ${r.value ?? "full sides"}${r.changed ? "" : " (unchanged)"}`);
  if (r.value === null) {
    return r.changed
      ? { outcome: "min-players-cleared", replyText: c.cleared({ activityName: r.activityName, full: r.places }) }
      : { outcome: "min-players-unchanged", replyText: c.alreadyFull({ activityName: r.activityName, full: r.places }) };
  }
  return r.changed
    ? { outcome: "min-players-set", replyText: c.set({ activityName: r.activityName, minimum: r.value, places: r.places }) }
    : { outcome: "min-players-unchanged", replyText: c.alreadySet({ activityName: r.activityName, minimum: r.value }) };
}
