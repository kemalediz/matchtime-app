/**
 * A GUEST'S DM "OUT" (cross-club ask, review H4; plan 3.7 "Cold DMs while
 * a guest").
 *
 * A Sutton FC player picked for FNF's Friday who DMs MatchTime "OUT" may
 * mean FNF's game or his own club's Tuesday. The cold DM path targets his
 * own club only (a guest membership is never its target), so without this
 * he would silently be dropped from his own game. While he has a LIVE
 * place in the asking club's match (CONFIRMED or on the bench, the match
 * still to play, not a past guest):
 *
 *   - OUT, with a game of his own too: ONE short question, "1" for the
 *     asking club's game or "2" for his own; nothing is dropped until he
 *     answers. The answer is read as structured data (the digit alone),
 *     within 30 minutes.
 *   - OUT, no game of his own: out of the guest game at once.
 *   - IN, or anything else: not this handler's; the ordinary path decides.
 *
 * Whether it IS an OUT comes from the same resolver every DM uses
 * (`resolveDmSelfAttendance`). DMs are in HIS club's language (D9) and go
 * out as his club's BotJobs. Logs carry ids only.
 */
import { db } from "./db";
import { REPLY_PRIORITY } from "./dm-reply-priority";
import { withOrgAiBudget } from "./ai-budget";
import { resolveDmSelfAttendance } from "./dm-self-attendance";
import { loadMatchAvailabilityFacts } from "./match-availability-context";
import { quoteForMatch, type QuotedBotMessage } from "./reply-context";
import { findDmRegistrationTarget } from "./dm-registration-target";
import { applyOutOfBandSelfAttendance } from "./out-of-band-self-attendance";
import { handlePartnerVolunteer, withdrawGuest } from "./partner-guest";
import { matchtimeWaNumber } from "./club-connect";
import { askDmLink, askDmPrefill, askRefCandidates, askRefCode, stripAskRef } from "./partner-ask-ref";
import { partnerAskToQuestion } from "./partner-volunteer-rules";
import { dayCommaTimeLabel } from "./i18n/dates";
import { t } from "./i18n/t";
import { usableName } from "./player-display-name";

const LIVE = ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"];
/** How long the "which game?" question waits for its answer. */
export const GUEST_DM_WHICH_TTL_MS = 30 * 60 * 1000;

/** "1" or "2", the digit alone; anything else is not an answer. */
export function parseWhichAnswer(text: string): 1 | 2 | null {
  const v = text.trim();
  return v === "1" ? 1 : v === "2" ? 2 : null;
}

interface LiveGuestPlace {
  askerOrgId: string;
  askerName: string;
  fromOrgId: string;
  fromName: string;
  lang: string;
  matchId: string;
  date: Date;
}

/** His live place as a guest, or null. */
async function findLiveGuestPlace(userId: string): Promise<LiveGuestPlace | null> {
  const mems = await db.membership.findMany({
    where: { userId, leftAt: null, guestFromOrgId: { not: null } },
    select: { orgId: true, guestFromOrgId: true, guestMatchId: true },
  });
  for (const m of mems) {
    if (!m.guestMatchId || !m.guestFromOrgId) continue;
    const [row, match] = await Promise.all([
      db.attendance.findUnique({ where: { matchId_userId: { matchId: m.guestMatchId, userId } }, select: { status: true } }),
      db.match.findUnique({ where: { id: m.guestMatchId }, select: { id: true, date: true, status: true } }),
    ]);
    if (!row || (row.status !== "CONFIRMED" && row.status !== "BENCH")) continue;
    if (!match || !LIVE.includes(match.status)) continue;
    const [asker, from] = await Promise.all([
      db.organisation.findUnique({ where: { id: m.orgId }, select: { name: true } }),
      db.organisation.findUnique({ where: { id: m.guestFromOrgId }, select: { name: true, language: true } }),
    ]);
    if (!asker || !from) continue;
    return { askerOrgId: m.orgId, askerName: asker.name, fromOrgId: m.guestFromOrgId, fromName: from.name, lang: from.language, matchId: match.id, date: match.date };
  }
  return null;
}

async function dm(orgId: string, phone: string | null, text: string): Promise<void> {
  if (!phone) return;
  await db.botJob.create({ data: { orgId, kind: "dm", phone, text, ...REPLY_PRIORITY } });
}

export type GuestDmResult = { handled: "guest-dm-which" | "guest-dm-out-guest" | "guest-dm-out-own" } | null;

export async function handleGuestDmOut(args: {
  userId: string;
  userName: string | null;
  text: string;
  /** His phone without "+", for the reply. */
  replyPhone: string | null;
  now?: Date;
  /** The MatchTime message this DM swipe-replies to, resolved once by the
   *  route, or null. */
  quoted?: QuotedBotMessage | null;
}): Promise<GuestDmResult> {
  const now = args.now ?? new Date();

  // 1. The answer to a question asked in the last 30 minutes.
  const answer = parseWhichAnswer(args.text);
  if (answer) {
    const asked = await db.sentNotification.findFirst({
      where: { kind: "xask-dm-out", key: { startsWith: `xask:dmout:${args.userId}:` }, createdAt: { gte: new Date(now.getTime() - GUEST_DM_WHICH_TTL_MS) } },
      orderBy: { createdAt: "desc" },
      select: { key: true },
    });
    if (asked) {
      const [, , , guestMatchId, ownMatchId] = asked.key.split(":");
      await db.sentNotification.deleteMany({ where: { key: asked.key } });
      if (answer === 1) {
        await withdrawGuest({ userId: args.userId, matchId: guestMatchId, now });
        return { handled: "guest-dm-out-guest" };
      }
      const own = await findDmRegistrationTarget(args.userId);
      if (own && own.matchId === ownMatchId) {
        await applyOutOfBandSelfAttendance({
          userId: args.userId,
          matchId: own.matchId,
          orgId: own.orgId,
          decision: "out",
          matchName: own.matchName,
          matchWhen: own.matchWhen,
          lang: own.lang,
          source: "dm",
          replyPhone: args.replyPhone,
        });
      }
      return { handled: "guest-dm-out-own" };
    }
  }

  // 2. A live guest place, and an OUT.
  const place = await findLiveGuestPlace(args.userId);
  if (!place) return null;
  // What MatchTime last said to him and where he stands for the guest game.
  const facts = await loadMatchAvailabilityFacts({
    userId: args.userId,
    matchId: place.matchId,
    phone: args.replyPhone,
    // A quote about another match never steers his guest game.
    quoted: quoteForMatch(args.quoted, place.matchId),
  });
  const resolution = await withOrgAiBudget(place.fromOrgId, () =>
    resolveDmSelfAttendance({
      text: args.text,
      hasPendingPrompt: false,
      context: {
        ...facts,
        playerName: args.userName,
        clubName: place.askerName,
        matchName: place.askerName,
        matchWhen: dayCommaTimeLabel(place.lang, place.date),
      },
    }),
  );
  if (resolution.decision !== "out") return null;

  const own = await findDmRegistrationTarget(args.userId);
  const s = t(place.lang);
  if (!own) {
    await withdrawGuest({ userId: args.userId, matchId: place.matchId, now });
    return { handled: "guest-dm-out-guest" };
  }
  await db.sentNotification.create({
    data: { key: `xask:dmout:${args.userId}:${place.matchId}:${own.matchId}:${now.getTime()}`, kind: "xask-dm-out" },
  });
  await dm(
    place.fromOrgId,
    args.replyPhone,
    s.xask_dm_which({ asker: place.askerName, askerDay: dayCommaTimeLabel(place.lang, place.date), own: own.clubName, ownDay: own.matchWhen }),
  );
  console.log(`[partner-guest-dm] ${args.userId}: asked which game (${place.matchId} or ${own.matchId})`);
  return { handled: "guest-dm-which" };
}

// ── Volunteering by DM (Kemal, 2026-10-21) ─────────────────────────────────
//
// The partner group sees only the ask itself. Its tap-to-DM link opens a
// DM to MatchTime prefilled with "IN (ref K7Q2)", K7Q2 being the ask's code
// (partner-ask-ref.ts). The code says WHICH ask; IN or OUT is the DM
// resolver's call on his words with the code taken out; the volunteer
// writer (`handlePartnerVolunteer`, the one writer onto another club's
// match) does everything else and answers him by DM. The same writer serves
// a swipe-reply in the group, so there is one path, whichever door he used.

/** How far back a code is looked up: asks posted in the last fortnight. */
export const ASK_REF_LOOKBACK_MS = 14 * 24 * 3600_000;

/**
 * The ask a DM's code names, or null. Only codes MatchTime issued count:
 * one query over the asks posted lately, each id hashed to its code. Two
 * asks sharing a code are no ask (never a guess). No code in the text: no
 * query.
 */
export async function findAskByRef(text: string, now: Date = new Date()): Promise<{ askId: string } | null> {
  const candidates = askRefCandidates(text);
  if (candidates.length === 0) return null;
  const asks = await db.partnerAsk.findMany({
    where: { postedAt: { gte: new Date(now.getTime() - ASK_REF_LOOKBACK_MS) } },
    select: { id: true },
  });
  for (const c of candidates) {
    const hits = asks.filter((a) => askRefCode(a.id) === c);
    if (hits.length === 1) return { askId: hits[0].id };
  }
  return null;
}

interface AskForDm {
  askId: string;
  askerName: string;
  partnerOrgId: string;
  partnerName: string;
  lang: string;
  day: string;
  link: string | null;
  prefill: string;
}

async function loadAskForDm(askId: string): Promise<AskForDm | null> {
  const ask = await db.partnerAsk.findUnique({
    where: { id: askId },
    select: { id: true, askerOrgId: true, partnerOrgId: true, match: { select: { date: true } } },
  });
  if (!ask) return null;
  const [asker, partner] = await Promise.all([
    db.organisation.findUnique({ where: { id: ask.askerOrgId }, select: { name: true } }),
    db.organisation.findUnique({ where: { id: ask.partnerOrgId }, select: { name: true, language: true } }),
  ]);
  if (!asker || !partner) return null;
  return {
    askId: ask.id,
    askerName: asker.name,
    partnerOrgId: ask.partnerOrgId,
    partnerName: partner.name,
    lang: partner.language,
    day: dayCommaTimeLabel(partner.language, ask.match.date),
    link: askDmLink({ number: matchtimeWaNumber(), lang: partner.language, askId: ask.id }),
    prefill: askDmPrefill(partner.language, askRefCode(ask.id)),
  };
}

/** His phone on file, without "+". */
async function phoneOnFile(userId: string): Promise<string | null> {
  return (await db.user.findUnique({ where: { id: userId }, select: { phoneNumber: true } }))?.phoneNumber?.replace(/^\+/, "") ?? null;
}

/** The one "which game?" per person per ask, shared by the group's D5b and
 *  the DM's. True when this caller got it. */
async function claimWhich(askId: string, userId: string): Promise<boolean> {
  try {
    await db.sentNotification.create({ data: { key: `xask:${askId}:which:${userId}`, kind: "xask-which" } });
    return true;
  } catch {
    return false;
  }
}

export type CodedAskDmResult = { handled: "xask-dm-volunteer" | "xask-dm-unclear" | "xask-dm-name-ask"; outcome: string };

/**
 * A DM carrying an ask's code. The resolver decides IN or OUT on his words
 * without the code (the untouched prefill is a plain IN on its free fast
 * path); unreadable, he gets the link again and nothing is written.
 */
export async function handleCodedPartnerAskDm(args: {
  askId: string;
  userId: string;
  userName: string | null;
  text: string;
  replyPhone: string | null;
  waMessageId: string;
  now?: Date;
}): Promise<CodedAskDmResult> {
  const now = args.now ?? new Date();
  const ask = await loadAskForDm(args.askId);
  if (!ask) return { handled: "xask-dm-volunteer", outcome: "failed" };
  const resolution = await withOrgAiBudget(ask.partnerOrgId, () =>
    resolveDmSelfAttendance({
      text: stripAskRef(args.text),
      hasPendingPrompt: false,
      context: { playerName: args.userName, clubName: ask.askerName, matchName: ask.askerName, matchWhen: ask.day },
    }),
  );
  if (!resolution.decision) {
    await dm(ask.partnerOrgId, args.replyPhone ?? (await phoneOnFile(args.userId)), t(ask.lang).xask_dm_unclear({ asker: ask.askerName, link: ask.link, prefill: ask.prefill }));
    console.log(`[partner-guest-dm] ${args.userId}: a DM with ask ${ask.askId}'s code, not read as IN or OUT`);
    return { handled: "xask-dm-unclear", outcome: "unclear" };
  }
  // No name on file (C2, MT Test, 2026-10-22): ask for one before his
  // place is written, so the asking club never lists him as "(unnamed)".
  // An OUT needs no name and is not held up.
  if (resolution.decision === "in" && !usableName(args.userName)) {
    await askVolunteerName(ask, args.userId, args.replyPhone);
    return { handled: "xask-dm-name-ask", outcome: "asked-name" };
  }
  const r = await handlePartnerVolunteer(
    { askId: ask.askId, userId: args.userId, name: args.userName ?? "", polarity: resolution.decision, sourceMessageId: args.waMessageId, replyPhone: args.replyPhone },
    now,
  );
  console.log(`[partner-guest-dm] ${args.userId}: ${resolution.decision} for ask ${ask.askId} by DM (${r.outcome}, via ${resolution.via})`);
  return { handled: "xask-dm-volunteer", outcome: r.outcome };
}

// ── A volunteer with no name (2026-10-22) ──────────────────────────────────
//
// Prod, MT Test: C2 volunteered by the DM code with an empty User.name, and
// the asking club's squad listed him as "(unnamed)". So an IN from a
// volunteer MatchTime holds no name for gets ONE question first, and his
// NEXT DM within the window is the name: taken as typed (trimmed, spaces
// collapsed, capped), never parsed for phrases. It fills an EMPTY
// User.name only, never overwrites one, and then the volunteer writer runs
// exactly as for a named volunteer. A reply that cannot be a name (no
// letter, a phone number) gets the question once more and writes nothing.

/** How long the name question waits for his reply. */
export const VOLUNTEER_NAME_TTL_MS = 12 * 3600_000;
/** The longest name kept from his reply. */
const VOLUNTEER_NAME_MAX = 40;

/** His reply as a name, or null when it cannot be one. (pure) */
export function volunteerNameFromReply(text: string): string | null {
  const v = usableName(text);
  return v ? v.slice(0, VOLUNTEER_NAME_MAX).trim() : null;
}

const nameKeyPrefix = (userId: string) => `xask:name:${userId}:`;

async function askVolunteerName(ask: AskForDm, userId: string, replyPhone: string | null): Promise<void> {
  // One open question per person: the newest ask he said IN to.
  await db.sentNotification.deleteMany({ where: { key: { startsWith: nameKeyPrefix(userId) } } });
  await db.sentNotification.create({ data: { key: `${nameKeyPrefix(userId)}${ask.askId}`, kind: "xask-dm-name", targetUser: userId } });
  await dm(ask.partnerOrgId, replyPhone ?? (await phoneOnFile(userId)), t(ask.lang).xask_dm_name_ask({ asker: ask.askerName, day: ask.day }));
  console.log(`[partner-guest-dm] ${userId}: no name on file, asked for one before ask ${ask.askId}`);
}

/**
 * His reply to the name question, or null when no question is open for
 * him (the DM is then nobody's business here).
 */
export async function handleVolunteerNameReply(args: {
  userId: string;
  text: string;
  replyPhone: string | null;
  waMessageId: string;
  now?: Date;
}): Promise<CodedAskDmResult | null> {
  const now = args.now ?? new Date();
  const asked = await db.sentNotification.findFirst({
    where: { kind: "xask-dm-name", key: { startsWith: nameKeyPrefix(args.userId) }, createdAt: { gte: new Date(now.getTime() - VOLUNTEER_NAME_TTL_MS) } },
    orderBy: { createdAt: "desc" },
    select: { key: true },
  });
  if (!asked) return null;
  const askId = asked.key.slice(nameKeyPrefix(args.userId).length);
  const name = volunteerNameFromReply(args.text);
  if (!name) {
    const ask = await loadAskForDm(askId);
    if (!ask) return null;
    await dm(ask.partnerOrgId, args.replyPhone ?? (await phoneOnFile(args.userId)), t(ask.lang).xask_dm_name_ask({ asker: ask.askerName, day: ask.day }));
    console.log(`[partner-guest-dm] ${args.userId}: reply to the name question was not a name, asked again`);
    return { handled: "xask-dm-name-ask", outcome: "asked-name-again" };
  }
  await db.user.updateMany({ where: { id: args.userId, OR: [{ name: null }, { name: "" }] }, data: { name } });
  await db.sentNotification.deleteMany({ where: { key: asked.key } });
  const r = await handlePartnerVolunteer(
    { askId, userId: args.userId, name, polarity: "in", sourceMessageId: args.waMessageId, replyPhone: args.replyPhone },
    now,
  );
  console.log(`[partner-guest-dm] ${args.userId}: named, then in for ask ${askId} by DM (${r.outcome})`);
  return { handled: "xask-dm-volunteer", outcome: r.outcome };
}

/**
 * A private IN WITHOUT a code while an ask to his club is open: is it for
 * the other club's game? Never guessed. ONE plain question with the ask's
 * link, nothing written; asked once per person per ask (the same claim as
 * the group's D5b), so his next IN is his own game's.
 *
 * The same state rule as D5b: with a game of his own (`own`, the caller
 * already resolved his DM as IN against it), only an ask posted in the last
 * hour and only while he has no place in his own game. With no game of his
 * own, any open ask, and the resolver reads his DM against the ask's game.
 */
export async function askAboutOpenPartnerAsk(args: {
  userId: string;
  userName?: string | null;
  text?: string;
  replyPhone: string | null;
  own: { matchId: string; clubName: string } | null;
  decision?: "in" | "out" | null;
  now?: Date;
}): Promise<boolean> {
  const now = args.now ?? new Date();
  if (args.own && args.decision !== "in") return false;
  const mems = await db.membership.findMany({ where: { userId: args.userId, leftAt: null, guestFromOrgId: null }, select: { orgId: true } });
  if (mems.length === 0) return false;
  const open = await db.partnerAsk.findMany({
    where: { partnerOrgId: { in: mems.map((m) => m.orgId) }, status: "posted", closesAt: { gt: now }, NOT: { volunteerUserIds: { has: args.userId } } },
    select: { id: true, postedAt: true },
    orderBy: { postedAt: "desc" },
  });
  if (open.length === 0) return false;

  let askId: string | null;
  if (args.own) {
    const ownRow = await db.attendance.findFirst({ where: { matchId: args.own.matchId, userId: args.userId }, select: { id: true } });
    askId =
      partnerAskToQuestion({
        now,
        asks: open.map((a) => ({ askId: a.id, askerName: "", open: true, postedAt: a.postedAt?.toISOString() ?? null })),
        senderUserId: args.userId,
        senderHasOwnRow: !!ownRow,
      })?.askId ?? null;
  } else {
    askId = open[0].id;
  }
  if (!askId) return false;
  const ask = await loadAskForDm(askId);
  if (!ask) return false;

  if (!args.own) {
    const resolution = await withOrgAiBudget(ask.partnerOrgId, () =>
      resolveDmSelfAttendance({
        text: args.text ?? "",
        hasPendingPrompt: false,
        context: { playerName: args.userName ?? null, clubName: ask.askerName, matchName: ask.askerName, matchWhen: ask.day },
      }),
    );
    if (resolution.decision !== "in") return false;
  }
  if (!(await claimWhich(ask.askId, args.userId))) return false;
  await dm(
    ask.partnerOrgId,
    args.replyPhone ?? (await phoneOnFile(args.userId)),
    t(ask.lang).xask_dm_which_in({ asker: ask.askerName, day: ask.day, own: args.own?.clubName ?? null, link: ask.link, prefill: ask.prefill }),
  );
  console.log(`[partner-guest-dm] ${args.userId}: a private IN with no code while ask ${ask.askId} is open; asked which`);
  return true;
}

/**
 * D5b's question by DM (2026-10-21): a plain IN in his group soon after an
 * ask, with no place in his own game. Claimed once per person per ask.
 * "dm" sent privately; "group" claimed but he has no number, so the batch
 * says it in the group as before; false when asked already.
 */
export async function askPartnerWhichByDm(args: { askId: string; userId: string }): Promise<"dm" | "group" | false> {
  if (!(await claimWhich(args.askId, args.userId))) return false;
  const ask = await loadAskForDm(args.askId);
  const phone = await phoneOnFile(args.userId);
  if (!ask || !phone) return "group";
  await dm(ask.partnerOrgId, phone, t(ask.lang).xask_which_dm({ asker: ask.askerName, day: ask.day, own: ask.partnerName, link: ask.link, prefill: ask.prefill }));
  console.log(`[partner-guest-dm] ${args.userId}: D5b question for ask ${ask.askId} sent by DM`);
  return "dm";
}
