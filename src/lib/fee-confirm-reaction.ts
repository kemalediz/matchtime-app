/**
 * A ✅ or 👍 REACTION on the money collector's fee confirm prompt counts
 * exactly as replying "yes" to it (Sutton FC, 2026-10-21).
 *
 * WHY
 * ---
 * The prompt says "Reply *✅* (or "yes") to send everyone their pay link".
 * At 00:47 UTC Kemal reacted ✅ to it instead of typing it. The Pi
 * forwarded the reaction (`true_447525334985@c.us_3EB01CA3A67CC8AC4CE8FD`)
 * and /api/whatsapp/reaction answered `ignored: "no-open-offer"`: it only
 * knew bench offers and recruit invites. The fee stayed pending, the links
 * never went out, and the players asked how to pay.
 *
 * HOW A REACTION FINDS ITS PROMPT
 * -------------------------------
 * By the id WhatsApp gives us for the reacted-to message, never by words:
 *
 *   reaction.waMessageId
 *     → SentNotification{ kind:"dm", waMessageId }   ← stamped by /ack
 *     → its key, `botjob-<botJobId>`                 ← the dispatch key
 *     → BotJob{ id, aboutKey:"<matchId>:fee-confirm" }
 *                                                    ← queued by dm-reply
 *                                                      with the prompt
 *
 * THE GATES, in order (every one fails to "do nothing"):
 *   1. it is a fee confirm prompt (else null: the route falls through);
 *   2. the emoji is ✅ or 👍;
 *   3. the reactor is the person the prompt was DMed to (a 1-1 chat has
 *      only them and MatchTime, and the Pi drops our own reactions, so an
 *      @lid reactor with no readable phone is them);
 *   4. that person is the club's collector today;
 *   5. it is the LATEST prompt for the match (a newer amount supersedes);
 *   6. `confirmCollectorFeeByReaction`: an amount is still pending, and
 *      the typed yes's compare-and-set release claims the match once.
 */
import { db } from "./db";
import { e164Digits } from "./phone";
import { REPLY_PRIORITY } from "./dm-reply-priority";
import { confirmCollectorFeeByReaction } from "./payment-flow";
import type { CollectorReplyResult } from "./payment-flow";

const ABOUT_SUFFIX = ":fee-confirm";
const DISPATCH_PREFIX = "botjob-";

/** `BotJob.aboutKey` of the fee confirm prompt for a match. */
export function feeConfirmAboutKey(matchId: string): string {
  return `${matchId}${ABOUT_SUFFIX}`;
}

/** The yes reactions. Exact, skin tones listed: a ❤️ is not a yes. */
const YES_EMOJI = new Set(["✅", "👍", "👍🏻", "👍🏼", "👍🏽", "👍🏾", "👍🏿"]);

export function isFeeConfirmYesEmoji(emoji: string | null | undefined): boolean {
  return YES_EMOJI.has((emoji ?? "").trim());
}

/** The fee confirm prompt a reaction is on. */
export interface FeeConfirmPrompt {
  botJobId: string;
  matchId: string;
  orgId: string;
  /** The number the prompt was DMed to, digits without "+". */
  phone: string;
}

export interface FeeConfirmReactionDeps {
  prompt: (waMessageId: string) => Promise<FeeConfirmPrompt | null>;
  /** The newest fee confirm prompt queued for the match (in its club). */
  latestPromptId: (prompt: FeeConfirmPrompt) => Promise<string | null>;
  /** The match's club's collector, when it collects payments. */
  collector: (matchId: string) => Promise<{ userId: string; phone: string | null } | null>;
  /** The typed yes's release and ack (`confirmCollectorFeeByReaction`). */
  confirm: (userId: string, matchId: string) => Promise<CollectorReplyResult | null>;
  /** Queue the ack DM to the collector. */
  queueAck: (ack: { orgId: string; phone: string; text: string; matchId: string }) => Promise<void>;
}

export interface FeeConfirmReactionInput {
  waMessageId: string;
  emoji: string;
  fromPhone?: string | null;
}

const samePhone = (a: string | null | undefined, b: string | null | undefined): boolean => {
  const x = a ? e164Digits(a) : null;
  const y = b ? e164Digits(b) : null;
  return x !== null && x === y;
};

/**
 * Null when the reaction is not on a fee confirm prompt; otherwise what
 * was done (for the route's response and the logs).
 */
export async function runFeeConfirmReaction(
  input: FeeConfirmReactionInput,
  deps: FeeConfirmReactionDeps,
): Promise<Record<string, unknown> | null> {
  const prompt = await deps.prompt(input.waMessageId);
  if (!prompt) return null;

  if (!isFeeConfirmYesEmoji(input.emoji)) return { ok: true, ignored: "not-yes" };

  if (input.fromPhone && input.fromPhone.trim() && !samePhone(input.fromPhone, prompt.phone)) {
    return { ok: true, ignored: "reactor-not-the-recipient" };
  }

  const collector = await deps.collector(prompt.matchId);
  if (!collector || !samePhone(collector.phone, prompt.phone)) {
    return { ok: true, ignored: "not-the-collector" };
  }

  if ((await deps.latestPromptId(prompt)) !== prompt.botJobId) {
    return { ok: true, ignored: "superseded-prompt" };
  }

  const result = await deps.confirm(collector.userId, prompt.matchId);
  if (!result) return { ok: true, ignored: "nothing-pending" };

  await deps.queueAck({
    orgId: result.orgId ?? prompt.orgId,
    phone: prompt.phone,
    text: result.reply,
    matchId: prompt.matchId,
  });
  return { ok: true, handled: "fee-confirm-reaction", released: result.released ?? 0, matchId: prompt.matchId };
}

/**
 * Which fee confirm prompt was reacted to? Null for every other message.
 * Never throws: the route also serves bench offers and recruit invites.
 */
export async function resolveFeeConfirmPrompt(waMessageId: string): Promise<FeeConfirmPrompt | null> {
  try {
    if (!waMessageId) return null;
    const dispatched = await db.sentNotification.findFirst({
      where: { waMessageId, kind: "dm" },
      select: { key: true },
    });
    if (!dispatched?.key.startsWith(DISPATCH_PREFIX)) return null;
    const botJobId = dispatched.key.slice(DISPATCH_PREFIX.length);
    if (!botJobId) return null;
    const job = await db.botJob.findUnique({
      where: { id: botJobId },
      select: { id: true, kind: true, orgId: true, phone: true, matchId: true, aboutKey: true },
    });
    if (!job || job.kind !== "dm" || !job.matchId || !job.phone) return null;
    if (job.aboutKey !== feeConfirmAboutKey(job.matchId)) return null;
    return { botJobId: job.id, matchId: job.matchId, orgId: job.orgId, phone: job.phone };
  } catch (err) {
    console.error("[fee-confirm-reaction] could not resolve the reacted-to DM:", err);
    return null;
  }
}

/** The database wiring for `runFeeConfirmReaction`. */
export function handleFeeConfirmReaction(input: FeeConfirmReactionInput): Promise<Record<string, unknown> | null> {
  return runFeeConfirmReaction(input, {
    prompt: resolveFeeConfirmPrompt,
    latestPromptId: async ({ orgId, matchId }) =>
      (
        await db.botJob.findFirst({
          where: { orgId, kind: "dm", aboutKey: feeConfirmAboutKey(matchId) },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: { id: true },
        })
      )?.id ?? null,
    collector: async (matchId) => {
      const m = await db.match.findUnique({
        where: { id: matchId },
        select: {
          activity: {
            select: {
              orgId: true,
              org: {
                select: { paymentHolderId: true, paymentCollectionEnabled: true },
              },
            },
          },
        },
      });
      const org = m?.activity.org;
      if (!org?.paymentCollectionEnabled || !org.paymentHolderId) return null;
      const holder = await db.user.findUnique({ where: { id: org.paymentHolderId }, select: { phoneNumber: true } });
      return { userId: org.paymentHolderId, phone: holder?.phoneNumber ?? null };
    },
    confirm: confirmCollectorFeeByReaction,
    queueAck: async ({ orgId, phone, text, matchId }) => {
      await db.botJob.create({ data: { orgId, kind: "dm", phone, text, matchId, ...REPLY_PRIORITY } });
    },
  });
}
