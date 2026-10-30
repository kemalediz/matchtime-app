/**
 * UNNAMED-GUEST NAME ASK — pure, no DB, no LLM.
 *
 * WHY THIS FILE EXISTS (production, 2026-08-31)
 * ---------------------------------------------
 * Amir posted in the club's WhatsApp group:
 *
 *     "@Kemal Ediz my brother can play if needed"
 *
 * PR #26 (51b7250) fixed the write: the SUBJECT of a conditional offer
 * decides who gets registered, so Amir is no longer benched for offering
 * somebody else. What it left behind was SILENCE. `bring_guests_vague`
 * sits in ACTIONY_INTENTS, so an untagged one is forced to noise and
 * MatchTime says nothing at all. The club owner had to type
 *
 *     "yes pls, can you share the name?"
 *
 * himself before the guest could be registered. He asked for MatchTime
 * to do the asking.
 *
 * WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
 * ---------------------------------------------
 * This is a QUESTION, never a write. Nobody has been named, so there is
 * nothing to register and the blast radius is one sentence. The reply is
 * composed HERE, by code, from facts the caller reads out of the
 * database — the same direction `src/lib/format-switch.ts` set after the
 * 2026-08-30 format-switch incident, and what
 * MDs/analyzer-redesign-2026-08-31.md argues for: the model classifies,
 * code composes.
 *
 * MatchTime's interaction contract is deliberately conservative — silent
 * on banter, tag-free only for a player's own attendance. Making it
 * SPEAK where it currently stays quiet is the delicate part, so the ask
 * is gated, on FACTS, beyond the extractor having read an unnamed person
 * joining (`personNamed: false`, polarity in):
 *
 *   1. (Until 2026-10-30 a word test, `looksLikeUnnamedGuestOffer`, had to
 *      find a person cue and an availability cue in the text too. "No
 *      string parsing": the extractor's claim is the reading.)
 *   2. The squad must have room (untagged). Soliciting a name for a full
 *      squad promises a slot that does not exist.
 *   3. At most ONE ask per player per match, forever, whatever they say
 *      afterwards. If they never reply with a name, MatchTime drops it.
 *   4. The sender must be resolved to a member, so that dedupe key
 *      exists at all.
 *
 * There is no branch in here that can produce an attendance write: the
 * decision type is `{ask, reason}` and the copy is a string. The caller
 * (src/app/api/whatsapp/analyze/route.ts) makes the whole
 * unnamed-guest-offer branch terminal, so no verdict that reaches it can
 * fall through into an apply path.
 */

import { t } from "./i18n/t";
import type { Lang } from "./i18n/lang";

// ── The gate ───────────────────────────────────────────────────────────

export interface GuestAskInput {
  /** Did the message tag @Match Time? (interaction-contract signal) */
  tagged: boolean;
  /** Did the sender resolve to a real member? Without a userId there is
   *  no per-player dedupe key, so the ask could repeat forever. */
  senderKnown: boolean;
  /** Org tracks attendance at all (MoM-only orgs must stay silent). */
  attendanceOn: boolean;
  /** There is a registration match to add anyone to. */
  hasActiveMatch: boolean;
  /** Confirmed squad size RIGHT NOW (read from the DB, never the model). */
  confirmedCount: number;
  /** Format capacity — Match.maxPlayers, i.e. both teams. */
  maxPlayers: number;
  /** Has this player already been asked for a guest name for THIS match? */
  alreadyAsked: boolean;
}

export interface GuestAskDecision {
  ask: boolean;
  /** Operator-readable why, logged and stored on the AnalyzedMessage. */
  reason: string;
}

/**
 * Should MatchTime ask this sender for their guest's name?
 *
 * Ordered so the reason is the most useful one, and so the cheap
 * structural checks come before the copy-ish ones.
 */
export function shouldAskForGuestName(input: GuestAskInput): GuestAskDecision {
  if (!input.attendanceOn)
    return { ask: false, reason: "attendance not tracked for this org" };
  if (!input.hasActiveMatch)
    return { ask: false, reason: "no active registration match to add a guest to" };
  if (!input.senderKnown)
    return { ask: false, reason: "sender unresolved, no per-player dedupe key" };
  if (input.alreadyAsked)
    return { ask: false, reason: "already asked this player for a guest name for this match" };

  // A tag means the sender addressed MatchTime deliberately. Answering is
  // then the polite thing to do whatever the squad state and however the
  // offer is worded — the seatbelts below exist to stop MT piping up
  // UNPROMPTED, not to stonewall someone who asked.
  if (input.tagged) return { ask: true, reason: "tagged unnamed-guest offer" };

  const room = Math.max(0, input.maxPlayers - input.confirmedCount);
  if (room <= 0)
    return {
      ask: false,
      reason: `squad already full (${input.confirmedCount}/${input.maxPlayers}), no slot to offer a guest`,
    };

  return {
    ask: true,
    reason: `unnamed guest offered with ${room} slot(s) open (${input.confirmedCount}/${input.maxPlayers})`,
  };
}

// ── The copy ───────────────────────────────────────────────────────────

/** A pushname that is really a phone number must never be printed as a
 *  name in the group (same rule as isRawDigitName in the analyze route). */
function firstName(raw: string | null | undefined): string | null {
  const t = (raw ?? "").trim();
  if (!t) return null;
  const first = t.split(/\s+/)[0] ?? "";
  if (!first) return null;
  if (/^[+\d][\d\s()+-]*$/.test(first)) return null; // raw number, not a name
  return first;
}

export interface GuestAskCopyInput {
  /** Sender's display name; only the first token is used. */
  askerName: string | null;
  /** More than one unnamed person was offered: the number of the
   *  extractor's unnamed IN claims, a fact, never the words. */
  plural: boolean;
  /** The group's language; English when absent. */
  lang?: Lang | string | null;
}

/**
 * The ask, composed by CODE. Short, warm, and the next step is the whole
 * point of the sentence.
 *
 * House style: no em dashes, no slashes.
 */
export function renderGuestNameAsk(input: GuestAskCopyInput): string {
  return t(input.lang).guest_name_ask({ firstName: firstName(input.askerName), plural: input.plural });
}

/** SentNotification key: one ask per player per match, forever. */
export function guestNameAskKey(matchId: string, userId: string): string {
  return `guest-name-ask:${matchId}:${userId}`;
}

/** SentNotification kind for the same row. */
export const GUEST_NAME_ASK_KIND = "guest-name-ask";
