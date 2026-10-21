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
 * TWO MESSAGES CARRY THAT COPY (`buildFeeConfirmPrompt`)
 * ------------------------------------------------------
 *   a. the prompt dm-reply queues as a BotJob when the collector TYPES an
 *      amount (aboutKey `<matchId>:fee-confirm`);
 *   b. the MONTHLY-SQUAD PAYG fee question the scheduler sends itself
 *      (bot-scheduler.ts 6a-bis): "£8 each for N players ... Reply ✅".
 *      It is not a BotJob. due-posts claims it as `<matchId>:fee-ask` (or
 *      `:fee-ask:again`, its one re-ask) with `targetUser` = the collector,
 *      and /ack stamps the sent id on that row. Until 2026-10-21 a ✅ on it
 *      was dropped (`no-open-offer`): only (a) was joined.
 *
 * HOW A REACTION FINDS ITS PROMPT
 * -------------------------------
 * By the id WhatsApp gives us for the reacted-to message, never by words:
 *
 *   reaction.waMessageId
 *     → SentNotification{ kind:"dm", waMessageId }   ← stamped by /ack
 *     → its key:
 *        a. `botjob-<botJobId>` → BotJob{ id, aboutKey:"<matchId>:fee-confirm" }
 *        b. `<matchId>:fee-ask[:again]` → the row's own matchId + targetUser
 *
 * THE GATES, in order (every one fails to "do nothing"):
 *   1. it is a fee confirm prompt (else null: the route falls through);
 *   2. the emoji is ✅ or 👍;
 *   3. the reactor is the person the prompt was DMed to (a 1-1 chat has
 *      only them and MatchTime, and the Pi drops our own reactions, so an
 *      @lid reactor with no readable phone is them);
 *   4. that person is the club's collector today, with collection on;
 *   5. it is the LATEST fee question for the match, of either kind (a
 *      newer amount, typed or asked, supersedes);
 *   6. `confirmCollectorFeeByReaction`: the typed yes's own path. The
 *      monthly staging rules may stage the PAYG price exactly as for a
 *      typed yes, an amount must then be pending, and the compare-and-set
 *      release claims the match once.
 */
import { db } from "./db";
import { e164Digits } from "./phone";
import { REPLY_PRIORITY } from "./dm-reply-priority";
import { confirmCollectorFeeByReaction } from "./payment-flow";
import type { CollectorReplyResult } from "./payment-flow";
import { feeAskKeys, matchOfFeeAskKey } from "./monthly-week";

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
  /** The reacted-to DM's dispatch key: `botjob-<id>` for the prompt a
   *  typed amount queued, `<matchId>:fee-ask[:again]` for the scheduler's
   *  monthly PAYG question. */
  ref: string;
  /** The key the typed yes knows this question by when it is quoted:
   *  `<matchId>:fee-confirm`, or the scheduler key itself. */
  askKey: string;
  matchId: string;
  orgId: string;
  /** The number the prompt was DMed to, digits without "+". */
  phone: string;
  /** The user the scheduler addressed it to (`SentNotification.targetUser`).
   *  Null for a BotJob prompt, which records only the phone. */
  recipientUserId: string | null;
}

export interface FeeConfirmReactionDeps {
  prompt: (waMessageId: string) => Promise<FeeConfirmPrompt | null>;
  /** The `ref` of the newest fee question out for the match, of either
   *  kind (in its club). */
  latestPromptRef: (prompt: FeeConfirmPrompt) => Promise<string | null>;
  /** The match's club's collector, when it collects payments. */
  collector: (matchId: string) => Promise<{ userId: string; phone: string | null } | null>;
  /** The typed yes's release and ack (`confirmCollectorFeeByReaction`). */
  confirm: (userId: string, matchId: string, askKey: string) => Promise<CollectorReplyResult | null>;
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
  if (
    !collector ||
    !samePhone(collector.phone, prompt.phone) ||
    (prompt.recipientUserId !== null && prompt.recipientUserId !== collector.userId)
  ) {
    return { ok: true, ignored: "not-the-collector" };
  }

  if ((await deps.latestPromptRef(prompt)) !== prompt.ref) {
    return { ok: true, ignored: "superseded-prompt" };
  }

  const result = await deps.confirm(collector.userId, prompt.matchId, prompt.askKey);
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
      select: { key: true, matchId: true, targetUser: true },
    });
    if (!dispatched) return null;
    if (dispatched.key.startsWith(DISPATCH_PREFIX)) return await botJobPrompt(dispatched.key);
    return await scheduledAskPrompt(dispatched);
  } catch (err) {
    console.error("[fee-confirm-reaction] could not resolve the reacted-to DM:", err);
    return null;
  }
}

/** (a) The prompt dm-reply queued for a typed amount. */
async function botJobPrompt(ref: string): Promise<FeeConfirmPrompt | null> {
  const botJobId = ref.slice(DISPATCH_PREFIX.length);
  if (!botJobId) return null;
  const job = await db.botJob.findUnique({
    where: { id: botJobId },
    select: { id: true, kind: true, orgId: true, phone: true, matchId: true, aboutKey: true },
  });
  if (!job || job.kind !== "dm" || !job.matchId || !job.phone) return null;
  if (job.aboutKey !== feeConfirmAboutKey(job.matchId)) return null;
  return { ref, askKey: job.aboutKey, matchId: job.matchId, orgId: job.orgId, phone: job.phone, recipientUserId: null };
}

/** (b) The scheduler's fee question, by its own claim row. */
async function scheduledAskPrompt(row: {
  key: string;
  matchId: string | null;
  targetUser: string | null;
}): Promise<FeeConfirmPrompt | null> {
  const matchId = matchOfFeeAskKey(row.key);
  if (!matchId || row.matchId !== matchId || !row.targetUser) return null;
  const [recipient, match] = await Promise.all([
    db.user.findUnique({ where: { id: row.targetUser }, select: { phoneNumber: true } }),
    db.match.findUnique({ where: { id: matchId }, select: { activity: { select: { orgId: true } } } }),
  ]);
  const phone = recipient?.phoneNumber ? e164Digits(recipient.phoneNumber) : null;
  if (!phone || !match) return null;
  return { ref: row.key, askKey: row.key, matchId, orgId: match.activity.orgId, phone, recipientUserId: row.targetUser };
}

/**
 * The `ref` of the newest fee question out for a match, of either kind:
 * the newest confirm prompt BotJob (queued, sent or not), or a scheduler
 * fee question that was SENT (its ack carried a message id). Newest by
 * creation; on a tie the typed amount's prompt wins.
 */
async function latestFeeQuestionRef({ orgId, matchId }: FeeConfirmPrompt): Promise<string | null> {
  const { first, again } = feeAskKeys(matchId);
  const [job, asks] = await Promise.all([
    db.botJob.findFirst({
      where: { orgId, kind: "dm", aboutKey: feeConfirmAboutKey(matchId) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, createdAt: true },
    }),
    db.sentNotification.findMany({
      where: { key: { in: [first, again] }, kind: "dm", waMessageId: { not: null } },
      select: { key: true, createdAt: true },
    }),
  ]);
  const at = (d: Date | null | undefined) => (d ? new Date(d).getTime() : Number.NEGATIVE_INFINITY);
  let newest: { ref: string; at: number } | null = job ? { ref: `${DISPATCH_PREFIX}${job.id}`, at: at(job.createdAt) } : null;
  for (const a of asks) if (!newest || at(a.createdAt) > newest.at) newest = { ref: a.key, at: at(a.createdAt) };
  return newest?.ref ?? null;
}

/** The database wiring for `runFeeConfirmReaction`. */
export function handleFeeConfirmReaction(input: FeeConfirmReactionInput): Promise<Record<string, unknown> | null> {
  return runFeeConfirmReaction(input, {
    prompt: resolveFeeConfirmPrompt,
    latestPromptRef: latestFeeQuestionRef,
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
