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
import type { QuotedBotMessage } from "./reply-context";
import { findDmRegistrationTarget } from "./dm-registration-target";
import { applyOutOfBandSelfAttendance } from "./out-of-band-self-attendance";
import { withdrawGuest } from "./partner-guest";
import { dayCommaTimeLabel } from "./i18n/dates";
import { t } from "./i18n/t";

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
    quoted: args.quoted ?? null,
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
