/**
 * THE CLUB'S STYLE OF PLAY (slice L5b, 2026-10-24). PURE.
 *
 * `Organisation.playStyle`: "casual" | "competitive" | "mixed"
 * (`vocab.ts` PLAY_STYLES), or NULL, when a pool offer simply has no style
 * line (approved spec, "Offer"). Set on /admin/settings by an owner or admin
 * (app/actions/play-style.ts). The setting is shown only while the club may
 * ask the pool: to every other club it would describe nothing.
 */
import { isOneOf, PLAY_STYLES, type PlayStyle } from "./vocab";

export function parsePlayStyle(v: unknown): { ok: true; value: PlayStyle | null } | { ok: false } {
  if (v === null || v === undefined || v === "") return { ok: true, value: null };
  return isOneOf(PLAY_STYLES, v) ? { ok: true, value: v } : { ok: false };
}

export function playStyleShown(org: { featurePlayerPool: boolean } | null | undefined): boolean {
  return org?.featurePlayerPool === true;
}
