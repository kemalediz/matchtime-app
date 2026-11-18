/**
 * WHETHER A CLUB'S SCHEDULED POSTS GO OUT AT ALL, AS ONE WHERE-CLAUSE
 * (review of #608, 2026-11-16).
 *
 * /api/whatsapp/due-posts hands a club's group nothing unless its bot is
 * switched on and (with club fee billing on) it is not billing-paused; a
 * stale Pi still polling gets a 404. The "last Man of the Match" answer must
 * never promise "its result will be posted" for a club whose posts that
 * gate stops, so both read this one clause instead of copying it.
 */
import { billingQuietWhere } from "./club-billing-rules";

/** Spread into an `organisation` where: the clubs whose posts go out. */
export function clubPostsWhere(env: Record<string, string | undefined> = process.env) {
  return { whatsappBotEnabled: true, ...billingQuietWhere(env) };
}
