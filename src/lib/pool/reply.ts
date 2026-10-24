/**
 * A REPLY IN WORDS TO A POOL OFFER, UNTIL L6 READS IT (slice L5a,
 * 2026-10-24). No model, no phrase list: a STATE rule only.
 *
 * A DM from someone whose latest pool offer reached him in the last day:
 *   still open   one line, "to answer the offer, tap the link" with the link;
 *   just ended   (expired, filled by others, or he lost the race) one line,
 *                "that place has gone";
 * each at most ONCE per offer (a `SentNotification` key), so a chatty
 * reply never gets a stream of answers. Only an offer that REACHED him
 * (`sentAt`, the Pi's "sent") is ever referred to (review of #400, M3).
 *
 * NEVER SWALLOWS A MEMBER'S DM (review of #400, minor 1). The line is taken
 * only when the DM is clearly about the offer, from facts, not words:
 *   - it is a swipe-reply QUOTING the offer's own message (its WhatsApp
 *     id), or
 *   - he belongs to no club, so nothing else in the route could answer him.
 * A club member's plain DM gets null and carries on to his club's Q&A
 * exactly as before. Anything else: null too.
 */
import { db } from "../db";
import { ORDINARY_MEMBER_WHERE } from "../guest-membership";
import { sameWhatsAppMessage } from "../quoted-message";
import { appUrl } from "../app-url";
import { normaliseLang } from "../i18n/lang";
import { queuePlatformDm } from "../platform-jobs";
import { buildPoolManageLink } from "./links";
import { poolReplyGoneText, poolReplyTapText } from "./offer-copy";
import { poolOfferPath } from "./offer-token";

const DAY_MS = 24 * 3600_000;

export type PoolReplyAnswer = "pool-offer-tap-link" | "pool-offer-gone" | null;

export async function answerPoolOfferReply(args: { userId: string; quotedId?: string | null; now?: Date }): Promise<PoolReplyAnswer> {
  const now = args.now ?? new Date();
  try {
    const offer = await db.poolOffer.findFirst({
      where: { userId: args.userId, sentAt: { gte: new Date(now.getTime() - DAY_MS), lte: now } },
      orderBy: { sentAt: "desc" },
      select: { id: true, outcome: true, expiresAt: true, platformJobId: true, ask: { select: { status: true, org: { select: { name: true } } } } },
    });
    if (!offer) return null;
    const job = offer.platformJobId ? await db.platformJob.findUnique({ where: { id: offer.platformJobId }, select: { waMessageId: true } }) : null;
    const quotesOffer = !!args.quotedId && !!job?.waMessageId && sameWhatsAppMessage(args.quotedId, job.waMessageId);
    const inAClub = (await db.membership.count({ where: { userId: args.userId, leftAt: null, ...ORDINARY_MEMBER_WHERE } })) > 0;
    if (!quotesOffer && inAClub) return null;
    const open = offer.outcome === null && offer.ask.status === "open" && offer.expiresAt.getTime() > now.getTime();
    const ended = offer.outcome === null || offer.outcome === "expired" || offer.outcome === "filled" || offer.outcome === "ignored";
    const kind: PoolReplyAnswer = open ? "pool-offer-tap-link" : ended ? "pool-offer-gone" : null;
    if (!kind) return null;
    try {
      await db.sentNotification.create({ data: { key: `pool-reply:${offer.id}:${kind}`, kind: "pool-reply" } });
    } catch {
      return null; // answered once already: the route carries on
    }
    const profile = await db.poolProfile.findUnique({ where: { userId: args.userId }, select: { language: true, user: { select: { phoneNumber: true } } } });
    const phone = profile?.user?.phoneNumber;
    if (!profile || !phone) return null;
    const lang = normaliseLang(profile.language);
    const manageLink = await buildPoolManageLink(args.userId);
    const text =
      kind === "pool-offer-tap-link"
        ? poolReplyTapText(lang, { tapLink: appUrl(poolOfferPath(offer.id)), manageLink })
        : poolReplyGoneText(lang, { club: offer.ask.org.name, manageLink });
    await queuePlatformDm({ phone, text, purpose: "pool-reply", refId: offer.id });
    await db.poolProfile.updateMany({ where: { userId: args.userId }, data: { lastActiveAt: now } });
    return kind;
  } catch (err) {
    console.error(`[pool] ${args.userId}: reply to an offer not answered:`, err instanceof Error ? err.message : "failed");
    return null;
  }
}
