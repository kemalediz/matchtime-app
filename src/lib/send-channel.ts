/**
 * WHICH NUMBER EACH OUTGOING MESSAGE USES (WhatsApp Cloud API plan, PR C1).
 * Plan: MDs/whatsapp-cloud-api-plan-2026-11-04.md, sections 0, 3, 5.1, 5.8.
 *
 * Kemal (4 Nov 2026): keep Baileys on the Pi ("baileys", the club number)
 * for the club groups, HQ and DMs to people who added MatchTime. Move to
 * the official WhatsApp Business Platform ("cloud", the official number)
 * the first contact with people who do not know us yet, plus sign-up and
 * login codes. One ban of the club number takes down every club at once,
 * and reports from strangers are the main ban trigger.
 *
 * ── ONE PLACE DECIDES ──────────────────────────────────────────────────
 * This file is the only reader of the flags, and `channelFor` is the only
 * function that picks a channel (`send-channel-source-guard.test.ts`).
 * Pure: type imports only, no database, no network, no clock.
 *
 * ── FLAGS, ALL OFF BY DEFAULT (plan 5.8) ───────────────────────────────
 *   CLOUD_API_ENABLED   the master switch. Off unless 1, true, on or yes.
 *                       Off: every message and every wa.me link uses the
 *                       club number, exactly as before the plan.
 *   CLOUD_API_PURPOSES  comma list of FIRST_CONTACT_PURPOSES switched on,
 *                       so each flow moves alone. Club number purposes and
 *                       unknown names in the list are ignored.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────
 *   1. Master off: baileys.
 *   2. A club number purpose: baileys, whatever is listed.
 *   3. An answer purpose with `replyTo` known: the channel he last wrote
 *      on, so the answer lands in the chat he is looking at, inside its
 *      window, for free (listed or not: the reply cannot go anywhere else).
 *   4. A first contact purpose that is listed: cloud.
 *   5. Anything else: baileys.
 *
 * A BotJob (club DMs, HQ, group posts) never asks: it is always the club
 * number. Only PlatformJob purposes can move.
 *
 * ── DECIDED (plan section 6, 4 Nov 2026) ───────────────────────────────
 *   Partner asks and the one-off partner pool invite stay on the club
 *   number. Codes, and only codes, fall back to the club number when the
 *   official number is down (`fallbackWhenCloudDown`). A template Meta has
 *   not approved keeps its flow on the club number: its purpose stays out
 *   of CLOUD_API_PURPOSES until it is approved.
 */
import type { OwnerDmPurpose, PlatformDmPurpose } from "./platform-jobs";

export type SendChannel = "baileys" | "cloud";
export type ChannelPurpose = PlatformDmPurpose | OwnerDmPurpose;
type Env = Record<string, string | undefined>;

/** Never move: organisers, members, billing contacts and Kemal. */
export const CLUB_NUMBER_PURPOSES = [
  "connect-reply",
  "organiser-decision",
  "billing",
  "setup-learned",
  "setup-ask",
  "setup-admin-code",
  "setup-reminder",
  "setup-removed",
  "setup-owner-live",
  // Decided (section 6, item 7): a partner club's player is a member of a
  // MatchTime club, so his one-off pool invite stays on the club number.
  "pool-partner-invite",
  "owner-approval",
  "owner-ack",
  "owner-setup-stuck",
  "owner-pool-report",
  "owner-pool-review",
  "owner-intro",
] as const satisfies readonly ChannelPurpose[];

/** We write first (a code, a pool message, an invitation, a friend's
 *  later news): the official number once its purpose is listed. */
export const FIRST_CONTACT_PURPOSES = [
  "otp",
  // When he joined on the web with no message (plan 3.2): the joined
  // template. When he wrote first it is an answer (below).
  "pool-welcome",
  "pool-details-ask",
  "pool-offer",
  "pool-placed",
  "pool-paused",
  "pool-removed",
  "club-invite-ask",
  "club-invite-link",
  "club-invite-closed",
  "friend-removed",
  "friend-out",
] as const satisfies readonly ChannelPurpose[];

/** Answers to his own DM: they go back on the channel he wrote on. */
export const ANSWER_PURPOSES = [
  "pool-welcome",
  "pool-code-reply",
  "pool-reply",
  "friend-booked",
  "friend-not-booked",
  "setup-reply",
] as const satisfies readonly ChannelPurpose[];

/** Every wa.me link MatchTime hands out, by the door it opens. */
export const WA_LINK_KINDS = [
  // The pool's doors (/play, /play/f, the member's pool step): the official
  // number once the pool sign-up flow (`pool-welcome`) is listed.
  "pool-signup",
  "friend-signup",
  "member-pool-join",
  // The club doors: always the club number. Self-join's next step is
  // adding THAT number to his group; partner asks are decided (section 6).
  "club-connect",
  "partner-ask",
] as const;
export type WaLinkKind = (typeof WA_LINK_KINDS)[number];

const POOL_LINK_KINDS: readonly WaLinkKind[] = ["pool-signup", "friend-signup", "member-pool-join"];

const has = (list: readonly string[], value: string) => list.includes(value);

/** The master switch: off unless explicitly on. */
export function cloudApiEnabled(env: Env = process.env): boolean {
  return /^(1|true|on|yes)$/i.test((env.CLOUD_API_ENABLED ?? "").trim());
}

/** The first contact purposes switched on, read from CLOUD_API_PURPOSES. */
export function cloudPurposesFrom(env: Env = process.env): Set<string> {
  const out = new Set<string>();
  for (const raw of (env.CLOUD_API_PURPOSES ?? "").split(",")) {
    const p = raw.trim();
    if (p && has(FIRST_CONTACT_PURPOSES, p)) out.add(p);
  }
  return out;
}

/** The one decision: which number sends this message. */
export function channelFor(args: {
  purpose: ChannelPurpose | string;
  /** The channel he last wrote on, when this message answers his DM. */
  replyTo?: SendChannel | null;
  env?: Env;
}): SendChannel {
  const env = args.env ?? process.env;
  const { purpose, replyTo } = args;
  if (!cloudApiEnabled(env)) return "baileys";
  if (has(CLUB_NUMBER_PURPOSES, purpose)) return "baileys";
  if (has(ANSWER_PURPOSES, purpose) && (replyTo === "baileys" || replyTo === "cloud")) return replyTo;
  if (has(FIRST_CONTACT_PURPOSES, purpose) && cloudPurposesFrom(env).has(purpose)) return "cloud";
  return "baileys";
}

/** Which number a wa.me link points at. The pool's doors move with the
 *  pool sign-up flow; the club doors never move. */
export function waLinkChannelFor(kind: WaLinkKind, env: Env = process.env): SendChannel {
  if (!POOL_LINK_KINDS.includes(kind)) return "baileys";
  return channelFor({ purpose: "pool-welcome", env });
}

/**
 * The official number is down (or refused the send): which channel may
 * carry the message instead. Decided (section 6, item 5): codes only, since
 * the person asked for the code. Everything else: null, no fallback, so a
 * stranger is never put back on the club number.
 */
export function fallbackWhenCloudDown(purpose: ChannelPurpose | string): SendChannel | null {
  return purpose === "otp" ? "baileys" : null;
}
