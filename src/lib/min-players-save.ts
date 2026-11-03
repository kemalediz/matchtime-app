/**
 * THE ONE SAVE FOR A GAME'S MINIMUM PLAYERS (2026-11-03), used by the
 * activities page's server action (which checks the admin first) and by
 * WhatsApp (`min-players-words.ts`, organisers only, checked by the
 * callers). The check is `checkMinPlayers` (min-players.ts): null, or 2 up
 * to the game's places.
 */
import { db } from "./db";
import { checkMinPlayers } from "./min-players";

export type MinPlayersSave =
  | { ok: true; changed: boolean; value: number | null; places: number; activityName: string }
  | { ok: false; error: "not-found" | "not-a-number" | "too-low" | "too-high"; places: number; activityName: string };

export async function saveMinPlayers(p: { activityId: string; value: number | null }): Promise<MinPlayersSave> {
  const activity = await db.activity.findUnique({
    where: { id: p.activityId },
    select: { name: true, minPlayers: true, sport: { select: { playersPerTeam: true } } },
  });
  if (!activity) return { ok: false, error: "not-found", places: 0, activityName: "" };
  const places = activity.sport.playersPerTeam * 2;
  const checked = checkMinPlayers(p.value, places);
  if (!checked.ok) return { ok: false, error: checked.error, places, activityName: activity.name };
  if ((activity.minPlayers ?? null) === checked.value) return { ok: true, changed: false, value: checked.value, places, activityName: activity.name };
  await db.activity.update({ where: { id: p.activityId }, data: { minPlayers: checked.value } });
  return { ok: true, changed: true, value: checked.value, places, activityName: activity.name };
}
