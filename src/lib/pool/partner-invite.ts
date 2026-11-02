/**
 * THE PARTNER POOL INVITE, THE FLOW (Kemal, 2026-11-02). Thin I/O around
 * the pure rules (`partner-invite-rules.ts`) and the signed link
 * (`partner-invite-token.ts`).
 *
 *   sweepPartnerPoolInvites  on every platform poll, beside the club
 *                            invitations' after-game question: each partner
 *                            guest due the one DM gets it (who and when:
 *                            the rules' header)
 *   openPartnerPoolInvite    what /play/j/<token> shows
 *   joinFromPartnerInvite    the page's Join: the member join itself
 *                            (`member-optin.ts` `joinPoolAsMember`), active
 *                            at once, consent from the page's ticks
 *   restartFromPartnerInvite a stopped profile started again IN PLACE, by
 *                            the manage page's own restart rule
 *
 * ONCE EVER. The marker (`SentNotification`, `partnerInviteKey`) and the DM
 * (`PlatformJob`, purpose "pool-partner-invite") are written in ONE
 * transaction, and the key is unique, so two polls cannot both send it. The
 * marker carries no match (a deleted match must not make him due again).
 *
 * THE SWITCHES. Nothing is sent while the pool's platform switch is off
 * (or unread) or pool sign-ups are braked; the 36 hour window means a
 * game played meanwhile is never invited late.
 *
 * WHICH CHANNEL AND LANGUAGE. The platform channel (the pool's own DMs,
 * whatever the clubs' switches say). He has no pool profile, so he reads
 * it in his own club's language, held through his own club's quiet hours.
 *
 * Logs carry ids only.
 */
import { db } from "../db";
import { appUrl } from "../app-url";
import { normaliseLang, type Lang } from "../i18n/lang";
import { partnerInviteCopy } from "../i18n/pool-partner-invite";
import { QUIET_HOURS_SELECT, quietHoursOf } from "../message-hours";
import { PlatformDmRefused, queuePlatformDm, type PlatformDmClient } from "../platform-jobs";
import { isPoolOffersEnabled, isPoolSignupPaused } from "./flags";
import { settleGuestResult, type AttendanceLike } from "./guest-report";
import { applyManageAction, type PoolManageResult } from "./manage";
import { memberPrefill, phoneTail, type MemberPrefill } from "./member-prefill";
import { joinPoolAsMember, memberClubs, type MemberJoinResult } from "./member-optin";
import {
  PARTNER_INVITE_KIND,
  partnerInviteDue,
  partnerInviteKey,
  partnerInviteKickoffRange,
  partnerInvitePageState,
  partnerInviteSendAfter,
  type PartnerInvitePage,
} from "./partner-invite-rules";
import { partnerInvitePath, readPartnerInviteToken } from "./partner-invite-token";
import type { PoolFields } from "./profile-fields";
import { GUEST_RESULTS, isOneOf } from "./vocab";

type Env = Record<string, string | undefined>;

export const PARTNER_INVITE_PURPOSE = "pool-partner-invite" as const;

/** Partner guest places read per poll. */
const SWEEP_LIMIT = 200;

// ── After the game ─────────────────────────────────────────────────────

/** Every platform poll. The DMs queued; never throws past one person. */
export async function sweepPartnerPoolInvites(now: Date, env: Env): Promise<number> {
  if (!isPoolOffersEnabled(env) || isPoolSignupPaused(env)) return 0;
  const range = partnerInviteKickoffRange(now);
  const places = await db.guestPlace.findMany({
    where: { source: "partner", partnerAskId: { not: null }, match: { date: { gte: range.from, lte: range.to }, status: "COMPLETED" } },
    select: {
      userId: true,
      orgId: true,
      fromOrgId: true,
      matchId: true,
      partnerAskId: true,
      result: true,
      settledAt: true,
      match: { select: { date: true, status: true, activity: { select: { matchDurationMins: true } } } },
    },
    orderBy: { match: { date: "asc" } },
    take: SWEEP_LIMIT,
  });
  if (places.length === 0) return 0;

  const userIds = [...new Set(places.map((p) => p.userId))];
  const [sent, profiles, consents, users, asks, rows, orgs] = await Promise.all([
    db.sentNotification.findMany({ where: { key: { in: userIds.map(partnerInviteKey) } }, select: { key: true } }),
    db.poolProfile.findMany({ where: { userId: { in: userIds } }, select: { userId: true } }),
    db.poolConsentRecord.findMany({ where: { userId: { in: userIds } }, select: { userId: true }, distinct: ["userId"] }),
    db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, phoneNumber: true } }),
    db.partnerAsk.findMany({ where: { id: { in: [...new Set(places.map((p) => p.partnerAskId!))] } }, select: { id: true, matchId: true, pickedUserIds: true } }),
    db.attendance.findMany({ where: { OR: places.map((p) => ({ matchId: p.matchId, userId: p.userId })) }, select: { matchId: true, userId: true, status: true } }),
    db.organisation.findMany({
      where: { id: { in: [...new Set(places.flatMap((p) => [p.orgId, p.fromOrgId].filter((x): x is string => !!x)))] } },
      select: { id: true, name: true, language: true, ...QUIET_HOURS_SELECT },
    }),
  ]);
  const sentKeys = new Set(sent.map((s) => s.key));
  const inPool = new Set(profiles.map((p) => p.userId));
  const wasInPool = new Set(consents.map((c) => c.userId));
  const phoneOf = new Map(users.map((u) => [u.id, u.phoneNumber]));
  const askOf = new Map(asks.map((a) => [a.id, a]));
  const statusOf = new Map(rows.map((r) => [`${r.matchId}:${r.userId}`, r.status as AttendanceLike]));
  const orgOf = new Map(orgs.map((o) => [o.id, o]));

  let n = 0;
  for (const p of places) {
    const ask = askOf.get(p.partnerAskId!);
    const phone = phoneOf.get(p.userId) ?? null;
    const match = { kickoff: p.match.date, durationMins: p.match.activity.matchDurationMins, status: p.match.status };
    const due = partnerInviteDue({
      match,
      picked: !!ask && ask.matchId === p.matchId && ask.pickedUserIds.includes(p.userId),
      result: settleGuestResult(
        {
          match: match as Parameters<typeof settleGuestResult>[0]["match"],
          attendance: statusOf.get(`${p.matchId}:${p.userId}`) ?? null,
          recorded: isOneOf(GUEST_RESULTS, p.result) ? p.result : null,
          settled: p.settledAt !== null,
        },
        now,
      ),
      hasProfile: inPool.has(p.userId),
      everInPool: wasInPool.has(p.userId),
      hasPhone: !!phone,
      sentBefore: sentKeys.has(partnerInviteKey(p.userId)),
      now,
    });
    const asker = orgOf.get(p.orgId);
    const home = p.fromOrgId ? orgOf.get(p.fromOrgId) : undefined;
    if (!due.due || !phone || !asker || !home) continue;
    if (await inviteOne({ userId: p.userId, phone, club: asker.name, home, now })) n++;
    // One try per person per poll, whatever came of it.
    sentKeys.add(partnerInviteKey(p.userId));
  }
  if (n > 0) console.log(`[pool-partner-invite] ${n} invite(s) queued`);
  return n;
}

async function inviteOne(a: {
  userId: string;
  phone: string;
  club: string;
  home: { language: string; quietHoursEnabled: boolean; quietHoursFrom: string | null; quietHoursTo: string | null };
  now: Date;
}): Promise<boolean> {
  const lang = normaliseLang(a.home.language);
  const text = partnerInviteCopy(lang).dm({ club: a.club, link: appUrl(partnerInvitePath(a.userId, a.now)) });
  const sendAfter = partnerInviteSendAfter(a.now, quietHoursOf(a.home));
  const marker = { key: partnerInviteKey(a.userId), kind: PARTNER_INVITE_KIND, targetUser: a.userId };
  try {
    await db.$transaction(async (tx) => {
      await tx.sentNotification.create({ data: marker });
      await queuePlatformDm({ phone: a.phone, text, purpose: PARTNER_INVITE_PURPOSE, refId: a.userId, sendAfter, client: tx as unknown as PlatformDmClient });
    });
    return true;
  } catch (err) {
    // Another poll wrote it first: his one invite is on its way.
    if ((err as { code?: string })?.code === "P2002") return false;
    if (err instanceof PlatformDmRefused) {
      // The channel will never take it (his number is not one it may
      // message): marked, so it is not tried on every poll for 36 hours.
      console.error(`[pool-partner-invite] ${a.userId} not queued: ${err.code}`);
      await db.sentNotification.createMany({ data: [marker], skipDuplicates: true }).catch(() => undefined);
      return false;
    }
    console.error(`[pool-partner-invite] ${a.userId} failed; the next poll tries again:`, err instanceof Error ? err.message : "failed");
    return false;
  }
}

// ── The page ───────────────────────────────────────────────────────────

export interface PartnerInviteView {
  state: PartnerInvitePage;
  /** The page's first language: his clubs' (`memberPrefill`), else English. */
  lang: Lang;
  /** For "join": the form's starting values from his clubs. */
  prefill: MemberPrefill | null;
  /** For "join": his name as the pool shows it, and the last 4 digits of
   *  his number (never the whole number). */
  name: string | null;
  tail: string | null;
  earlyList: boolean;
}

export async function openPartnerPoolInvite(token: string, opts: { earlyList: boolean; signupsPaused: boolean; now?: Date }): Promise<PartnerInviteView> {
  const now = opts.now ?? new Date();
  const read = readPartnerInviteToken(token, now);
  const user =
    read.kind === "ok"
      ? await db.user.findUnique({ where: { id: read.userId }, select: { id: true, name: true, phoneNumber: true, poolProfile: { select: { status: true } } } })
      : null;
  const state = partnerInvitePageState({
    token: read.kind,
    user: user ? { hasPhone: !!user.phoneNumber } : null,
    profile: user?.poolProfile ?? null,
    signupsPaused: opts.signupsPaused,
  });
  const empty: PartnerInviteView = { state, lang: "en", prefill: null, name: null, tail: null, earlyList: opts.earlyList };
  if (!user || state === "invalid" || state === "expired") return empty;
  const prefill = memberPrefill({ name: user.name, clubs: await memberClubs(user.id) });
  if (state !== "join") return { ...empty, lang: normaliseLang(prefill.language) };
  return { ...empty, lang: normaliseLang(prefill.language), prefill, name: prefill.name || null, tail: phoneTail(user.phoneNumber!) };
}

export type PartnerJoinResult = MemberJoinResult | { ok: false; reason: "link-closed" };

/** Join from the page. `fields` are already validated (`validatePoolSignup`). */
export async function joinFromPartnerInvite(token: string, fields: PoolFields, opts: { earlyList: boolean; now?: Date }): Promise<PartnerJoinResult> {
  const now = opts.now ?? new Date();
  const read = readPartnerInviteToken(token, now);
  if (read.kind !== "ok") return { ok: false, reason: "link-closed" };
  return joinPoolAsMember(read.userId, fields, { earlyList: opts.earlyList, now, origin: "partner-invite" });
}

/** A stopped profile, started again in place (fresh consent, ticked on the page). */
export async function restartFromPartnerInvite(token: string, consent: boolean, now: Date = new Date()): Promise<PoolManageResult | { ok: false; reason: "link-closed" }> {
  const read = readPartnerInviteToken(token, now);
  if (read.kind !== "ok") return { ok: false, reason: "link-closed" };
  return applyManageAction(read.userId, "restart", { consent, now });
}
