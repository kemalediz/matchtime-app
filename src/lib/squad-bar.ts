/**
 * THE WEB'S SQUAD BAR COLOUR (club summary B1, 2026-11-04). PURE.
 *
 * The dashboard and the match list coloured a squad blue from 75% of its
 * places, a third meaning of "low" beside the scheduler's two (plan D1).
 * It now reads the one definition (squad-short.ts): green when the squad
 * is full, blue when the game is on (at or above its minimum, K1), amber
 * while it is short.
 */
import type { SquadNumbers } from "./squad-short";

export function squadBarColor(n: Pick<SquadNumbers, "placesOpen" | "short">): string {
  if (n.placesOpen === 0) return "bg-green-500";
  return n.short ? "bg-amber-500" : "bg-blue-600";
}
