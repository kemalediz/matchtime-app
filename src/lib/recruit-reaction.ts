/**
 * A 👍 or 👎 on the recruit invite DM (2026-08-31).
 *
 * WHY
 * ---
 * The invite now leads with "reply *IN*, or just tap 👍" (see recruit.ts).
 * Replying was already handled by PR #18. Tapping was not: the reaction
 * arrived, matched no open bench offer, and was dropped. A player who
 * gave us a thumbs-up believed they were in the squad and nothing was
 * recorded — the same silent-failure class as the duplicate-send incident,
 * where the database looked healthy and the humans got the wrong outcome.
 *
 * HOW A REACTION FINDS ITS PLAYER AND ITS MATCH
 * --------------------------------------------
 * Exactly the mechanism the bench offer already uses: WhatsApp gives us
 * the id of the message that was reacted to, and we look up what we sent
 * with that id. The bench offer can do that in one hop because
 * `BenchSlotOffer` has its own `waMessageId` column. A recruit DM has no
 * such home, and no migration was on the table, so the join runs over
 * rows we already write:
 *
 *   reaction.waMessageId
 *     → SentNotification{ kind:"dm", waMessageId }   ← stamped by /ack
 *     → its key, `botjob-<botJobId>`                 ← the dispatch key
 *     → SentNotification{ key:`recruit-dm-job:<botJobId>` }
 *                                                    ← written by the
 *       recruit blast; carries matchId + targetUser, which is the whole
 *       answer
 *     → BotJob{ id }                                 ← orgId + the phone
 *                                                      we actually DMed
 *
 * The link row is what makes this EXACT rather than a guess. Without it
 * we would have to infer "this DM was probably the invite" from the
 * player's phone and the timing, and a 👍 on a payment chase or a Q&A
 * answer would silently register someone for a match. Every broken link
 * in the chain returns null and the reaction is ignored.
 *
 * The link row is inert to every existing reader, deliberately:
 *   - the scheduler's dedupe set loads it (it has a matchId) but the key
 *     can never equal a computed instruction key;
 *   - the outbound circuit breaker counts `kind IN GROUP_DIRECTED_KINDS`
 *     and `recruit-dm-link` is not one;
 *   - the repetition ledger filters on `outbound-text-log`;
 *   - `planAckSideEffects` has no `recruit-dm-job:` branch.
 *
 * ⚠️ OPERATIONAL CAVEAT — see the PR description. This depends on
 * `SentNotification.waMessageId` being non-null, which depends on
 * whatsapp-web.js's `sendMessage()` returning a usable Message. On the Pi
 * today it returns `undefined` (see whatsapp-bot/src/send-result.ts and
 * MDs/whatsapp-layer-independent-audit-2026-08-30.md row 7/8), so bench
 * offers are ALREADY unmappable for the same reason. The reply path is
 * unaffected and is what players will land on until the injected layer is
 * fixed.
 */
import { db } from "./db";

/** What a reaction on an invite DM means. `null` = ignore it. */
export type ReactionAttendance = "in" | "out";

/**
 * Positive reactions. Skin tones are separate codepoint sequences, so
 * each one has to be listed; a player on an Android keyboard with a
 * default tone set is not sending a different answer.
 */
const IN_EMOJI = new Set(["👍", "👍🏻", "👍🏼", "👍🏽", "👍🏾", "👍🏿", "✅"]);

/** Negative reactions. Owner 2026-08-31: saying no must be as easy as
 *  saying yes, so 👎 (and ❌) is a first-class answer, not a no-op the
 *  way it is on a bench offer. */
const OUT_EMOJI = new Set(["👎", "👎🏻", "👎🏼", "👎🏽", "👎🏾", "👎🏿", "❌"]);

/**
 * Emoji → attendance decision. Deliberately an exact allow-list: a ❤️ or
 * a 😂 on the invite is banter, and guessing at it would put people in a
 * squad they never agreed to join.
 */
export function classifyReactionAttendance(emoji: string): ReactionAttendance | null {
  const e = (emoji ?? "").trim();
  if (!e) return null;
  if (IN_EMOJI.has(e)) return "in";
  if (OUT_EMOJI.has(e)) return "out";
  return null;
}

const LINK_PREFIX = "recruit-dm-job:";
const DISPATCH_PREFIX = "botjob-";

/** SentNotification.kind on the link row. Never a real instruction kind,
 *  and deliberately absent from GROUP_DIRECTED_KINDS. */
export const RECRUIT_DM_LINK_KIND = "recruit-dm-link";

/** The link row's key for a dispatched invite BotJob. */
export function recruitDmLinkKey(botJobId: string): string {
  return `${LINK_PREFIX}${botJobId}`;
}

/** Inverse of {@link recruitDmLinkKey}. Null for any other key class. */
export function parseRecruitDmLinkKey(key: string): string | null {
  if (!key.startsWith(LINK_PREFIX)) return null;
  const id = key.slice(LINK_PREFIX.length);
  return id.length > 0 ? id : null;
}

/** The BotJob id behind a `botjob-<id>` dispatch key, or null. */
export function botJobIdFromDispatchKey(key: string): string | null {
  if (!key.startsWith(DISPATCH_PREFIX)) return null;
  const id = key.slice(DISPATCH_PREFIX.length);
  return id.length > 0 ? id : null;
}

export interface RecruitDmReactionTarget {
  matchId: string;
  userId: string;
  orgId: string;
  /** The number we DMed, E.164 without the leading `+`. In a 1-1 chat
   *  this is the only person who can have reacted, which is what lets the
   *  route accept an @lid reactor with no readable phone. */
  phone: string | null;
}

/**
 * Which invite DM was reacted to? Null for every message that is not a
 * recruit invite we sent, which is the overwhelmingly common case.
 *
 * Never throws: a reaction is a nice-to-have and must not 500 the route
 * that also serves bench offers.
 */
export async function resolveRecruitDmReaction(
  waMessageId: string,
): Promise<RecruitDmReactionTarget | null> {
  try {
    if (!waMessageId) return null;

    // `kind` is indexed and every DM dispatch claims with kind "dm", so
    // this stays a small scan even on a busy org.
    const dispatched = await db.sentNotification.findFirst({
      where: { waMessageId, kind: "dm" },
      select: { key: true },
    });
    if (!dispatched) return null;

    const botJobId = botJobIdFromDispatchKey(dispatched.key);
    if (!botJobId) return null;

    const link = await db.sentNotification.findUnique({
      where: { key: recruitDmLinkKey(botJobId) },
      select: { matchId: true, targetUser: true },
    });
    if (!link?.matchId || !link.targetUser) return null;

    const job = await db.botJob.findUnique({
      where: { id: botJobId },
      select: { orgId: true, phone: true },
    });
    if (!job) return null;

    return {
      matchId: link.matchId,
      userId: link.targetUser,
      orgId: job.orgId,
      phone: job.phone ?? null,
    };
  } catch (err) {
    console.error("[recruit-reaction] could not resolve the reacted-to DM:", err);
    return null;
  }
}
