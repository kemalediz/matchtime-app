/**
 * AN ORGANISER CALLING THE GAME OFF WITHOUT A TAG: THE OFFER AND HIS ANSWER
 * (Vets MNF, 2026-10-26).
 *
 * In the players' group MatchTime speaks only when tagged, so an
 * organiser's untagged "it's off gents" gets no reply there. Instead:
 *
 *   1. `offerCalloffIfCalled` (the analyze route, after every owner has
 *      decided its message): for an organiser's untagged message while a
 *      game is coming (`calloff-offer-rules.ts`), the model reads whether
 *      it calls that game off, against the group's recent chat
 *      (`calloff-reader.ts`). If it does, the organiser is DM'd ONCE for
 *      that game: "Sounds like Monday is off. Reply *cancel* ...". The
 *      group's result is untouched: no reply, no reaction.
 *   2. `handleCalloffDmReply` (the DM route): while that offer is open, his
 *      next DM is read by the model. A yes runs the ONE cancel core every
 *      door uses (`cancelMatchById`, `match-cancel.ts`: the group is told,
 *      a monthly club's regulars get their cancelled-week credit, a game
 *      already kicked off is marked as not played), and he is told it is
 *      done in HQ's words. A no leaves the game on and says so. Anything
 *      else falls through to the DM route's other handlers: he may be
 *      talking about something else.
 *
 * Every step is best effort and never throws into its caller: a failure
 * is logged and the game stays exactly as it was.
 */
import { db } from "./db";
import { ORDINARY_MEMBER_WHERE } from "./guest-membership";
import { REPLY_PRIORITY } from "./dm-reply-priority";
import { dayTimeLabel, weekdayLabel, dayCommaTimeLabel } from "./i18n/dates";
import { calloffCopy } from "./i18n/calloff-offer";
import { t } from "./i18n/t";
import { normalisePhone } from "./phone";
import type { ContextMessage } from "./reply-context";
import { readCalloffReply, readGroupCalloff } from "./calloff-reader";
import {
  CALLOFF_AFTER_KICKOFF_HOURS,
  CALLOFF_GAME_STATUSES,
  CALLOFF_LOOKAHEAD_DAYS,
  CALLOFF_OFFER_CLOSED_KIND,
  CALLOFF_OFFER_KIND,
  CALLOFF_OFFER_OPEN_HOURS,
  calloffOfferKey,
  calloffOfferOpen,
  isCalloffCandidate,
  nextGameForCalloff,
} from "./calloff-offer-rules";

export interface CalloffMessage {
  waMessageId: string;
  body: string;
  /** The sender's roster label, as the recent chat names him. */
  authorName: string | null;
  userId: string | null;
  /** The sender's phone as the Pi saw it (digits), if any. */
  phone: string | null;
  /** Any tag at all (`messageTagsBot`): the tagged path owns those. */
  tagged: boolean;
  late: boolean;
  capped: boolean;
  reply: ContextMessage | null;
}

export type CalloffOfferOutcome = { waMessageId: string; outcome: "offered" | "not-a-calloff" | "already-offered" | "no-phone" };

const digits = (p: string | null | undefined): string | null => (p ? (normalisePhone(p)?.replace(/^\+/, "") ?? null) : null);

/** The players' group: DM an organiser who called the next game off. Never throws. */
export async function offerCalloffIfCalled(input: {
  orgId: string;
  lang: string | null;
  now: Date;
  messages: CalloffMessage[];
  history: Array<{ author: string | null; body: string }>;
  deps?: { read?: typeof readGroupCalloff };
}): Promise<CalloffOfferOutcome[]> {
  try {
    return await offer(input);
  } catch (err) {
    console.error("[calloff-offer] offer failed:", err instanceof Error ? err.message : "failed");
    return [];
  }
}

async function offer(input: Parameters<typeof offerCalloffIfCalled>[0]): Promise<CalloffOfferOutcome[]> {
  const { orgId, now } = input;
  const known = input.messages.filter((m) => !m.tagged && !m.late && !m.capped && !!m.userId);
  if (known.length === 0) return [];
  const organisers = new Set(
    (
      await db.membership.findMany({
        where: { orgId, userId: { in: [...new Set(known.map((m) => m.userId!))] }, leftAt: null, role: { in: ["OWNER", "ADMIN"] }, ...ORDINARY_MEMBER_WHERE },
        select: { userId: true },
      })
    ).map((r) => r.userId),
  );
  const candidates = input.messages.filter((m) =>
    isCalloffCandidate({ tagged: m.tagged, senderKnown: !!m.userId, organiser: !!m.userId && organisers.has(m.userId), late: m.late, capped: m.capped }),
  );
  if (candidates.length === 0) return [];

  const rows = await db.match.findMany({
    where: {
      activity: { orgId },
      isHistorical: false,
      status: { in: [...CALLOFF_GAME_STATUSES] },
      date: {
        gte: new Date(now.getTime() - CALLOFF_AFTER_KICKOFF_HOURS * 3600_000),
        lte: new Date(now.getTime() + CALLOFF_LOOKAHEAD_DAYS * 24 * 3600_000),
      },
    },
    select: { id: true, date: true, status: true, activity: { select: { name: true } } },
  });
  const game = nextGameForCalloff(rows, now);
  if (!game) return [];

  const read = input.deps?.read ?? readGroupCalloff;
  const copy = calloffCopy(input.lang);
  const out: CalloffOfferOutcome[] = [];
  for (const m of candidates) {
    const key = calloffOfferKey(game.id, m.userId!);
    // Once per organiser per game: no model call for a second message.
    if (await db.sentNotification.findUnique({ where: { key }, select: { id: true } })) {
      out.push({ waMessageId: m.waMessageId, outcome: "already-offered" });
      continue;
    }
    const calledOff = await read({
      authorName: m.authorName,
      body: m.body,
      game: `${dayCommaTimeLabel(input.lang, game.date)} (${game.activity.name})`,
      history: input.history,
      reply: m.reply,
      now,
    });
    if (!calledOff) {
      out.push({ waMessageId: m.waMessageId, outcome: "not-a-calloff" });
      continue;
    }
    const phone = digits(m.phone) ?? digits((await db.user.findUnique({ where: { id: m.userId! }, select: { phoneNumber: true } }))?.phoneNumber);
    if (!phone) {
      console.warn(`[calloff-offer] ${orgId}: ${m.waMessageId} called ${game.id} off but the organiser has no phone to DM`);
      out.push({ waMessageId: m.waMessageId, outcome: "no-phone" });
      continue;
    }
    const text = copy.offer({ day: weekdayLabel(input.lang, game.date) });
    try {
      await db.sentNotification.create({ data: { key, kind: CALLOFF_OFFER_KIND, matchId: game.id, targetUser: m.userId!, text } });
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") {
        out.push({ waMessageId: m.waMessageId, outcome: "already-offered" });
        continue;
      }
      throw err;
    }
    await db.botJob.create({ data: { orgId, kind: "dm", phone, text, matchId: game.id, aboutKey: key, ...REPLY_PRIORITY } });
    console.log(`[calloff-offer] ${orgId}: ${m.waMessageId} called ${game.id} off untagged: the organiser is asked by DM`);
    out.push({ waMessageId: m.waMessageId, outcome: "offered" });
  }
  return out;
}

export type CalloffReplyHandled = { handled: "calloff-cancelled" | "calloff-left-on" | "calloff-not-cancelled"; matchId: string; result?: string };

/**
 * The DM route: his reply while an offer is open. Null when he has no open
 * offer, or his words are neither a yes nor a no: the DM goes on to the
 * other handlers. Never throws.
 */
export async function handleCalloffDmReply(input: {
  userId: string;
  text: string;
  replyPhone: string | null;
  now: Date;
  deps?: { read?: typeof readCalloffReply; budget?: <T>(orgId: string, fn: () => Promise<T>) => Promise<T> };
}): Promise<CalloffReplyHandled | null> {
  try {
    return await reply(input);
  } catch (err) {
    console.error("[calloff-offer] reply failed:", err instanceof Error ? err.message : "failed");
    return null;
  }
}

async function reply(input: Parameters<typeof handleCalloffDmReply>[0]): Promise<CalloffReplyHandled | null> {
  const { userId, now } = input;
  const offers = await db.sentNotification.findMany({
    where: { kind: CALLOFF_OFFER_KIND, targetUser: userId, createdAt: { gte: new Date(now.getTime() - CALLOFF_OFFER_OPEN_HOURS * 3600_000) } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      text: true,
      createdAt: true,
      match: { select: { id: true, date: true, status: true, activity: { select: { orgId: true, name: true, org: { select: { language: true } } } } } },
    },
  });
  const open = offers.find((o) => o.match && calloffOfferOpen({ offeredAt: o.createdAt, matchStatus: o.match.status, now }));
  if (!open?.match) return null;
  const match = open.match;
  const orgId = match.activity.orgId;
  const lang = match.activity.org?.language ?? null;
  const copy = calloffCopy(lang);
  const day = weekdayLabel(lang, match.date);

  const read = input.deps?.read ?? readCalloffReply;
  const budget = input.deps?.budget ?? (async (key, fn) => (await import("./ai-budget")).withOrgAiBudget(key, fn));
  const answer = await budget(orgId, () => read({ question: open.text ?? copy.offer({ day }), text: input.text, lang }));
  if (answer === "other") return null;

  // Still an organiser of the club now, or his word cancels nothing.
  const still = await db.membership.findFirst({
    where: { orgId, userId, leftAt: null, role: { in: ["OWNER", "ADMIN"] }, ...ORDINARY_MEMBER_WHERE },
    select: { id: true },
  });
  if (!still) return null;

  // Answered: closed, so the next DM is not read as this answer again.
  const closed = await db.sentNotification.updateMany({ where: { id: open.id, kind: CALLOFF_OFFER_KIND }, data: { kind: CALLOFF_OFFER_CLOSED_KIND } });
  if (closed.count === 0) return null; // another delivery of this DM answered it

  const send = async (text: string) => {
    if (input.replyPhone) await db.botJob.create({ data: { orgId, kind: "dm", phone: input.replyPhone, text, matchId: match.id, ...REPLY_PRIORITY } });
  };
  if (answer === "no") {
    await send(copy.left_on({ day }));
    return { handled: "calloff-left-on", matchId: match.id };
  }

  const { cancelMatchById, notPlayedReply, notPlayedGameLabel } = await import("./match-cancel");
  const r = await cancelMatchById(match.id, { now });
  console.log(`[calloff-offer] ${match.id}: cancel from the organiser's DM: ${r.kind}`);
  const s = t(lang);
  const game = notPlayedGameLabel(lang, match.activity.name, match.date);
  if (r.kind === "cancelled") {
    await send(s.hq_match_cancelled({ activityName: r.activityName, when: dayTimeLabel(lang, r.date) }));
    return { handled: "calloff-cancelled", matchId: match.id, result: r.kind };
  }
  if (r.kind === "not-played") {
    const extra = r.creditedGames > 0 ? (await import("./month-close-copy")).buildCancelCreditLine({ count: 1, lang }) : null;
    await send(notPlayedReply(lang, r, extra));
    return { handled: "calloff-cancelled", matchId: match.id, result: r.kind };
  }
  if (r.kind === "already") {
    await send(copy.already_off({ game }));
    return { handled: "calloff-not-cancelled", matchId: match.id, result: r.kind };
  }
  await send(r.kind === "scored" ? s.not_played_scored({ game }) : copy.cannot_cancel({ game }));
  return { handled: "calloff-not-cancelled", matchId: match.id, result: r.kind };
}
