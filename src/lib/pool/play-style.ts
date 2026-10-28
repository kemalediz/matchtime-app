/**
 * THE CLUB'S STYLE OF PLAY (slice L5b, 2026-10-24). PURE.
 *
 * `Organisation.playStyle`: "casual" | "competitive" | "mixed"
 * (`vocab.ts` PLAY_STYLES), or NULL, when a pool offer simply has no style
 * line (approved spec, "Offer"). Set on /admin/settings by an owner or admin
 * (app/actions/play-style.ts). The setting is shown only while the club may
 * ask the pool (the platform switch and the club's own): to every other
 * club it would describe nothing.
 */
import { poolOffersOpenForClub } from "./flags";
import { isOneOf, PLAY_STYLES, type PlayStyle } from "./vocab";

export function parsePlayStyle(v: unknown): { ok: true; value: PlayStyle | null } | { ok: false } {
  if (v === null || v === undefined || v === "") return { ok: true, value: null };
  return isOneOf(PLAY_STYLES, v) ? { ok: true, value: v } : { ok: false };
}

/** The pool's one rule (`flags.ts` `poolOffersOpenForClub`): the platform
 *  switch, as this request resolved it, AND the club's own flag. */
export function playStyleShown(org: { featurePlayerPool: boolean } | null | undefined, env: Record<string, string | undefined>): boolean {
  return poolOffersOpenForClub(org, env);
}
