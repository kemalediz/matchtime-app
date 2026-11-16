/**
 * A FRIEND LINK'S CODE, THE POOL'S HALF (2026-10-31; review of #488,
 * 2026-11-01). Called by the /play confirm handler (`confirm.ts`) for a
 * waiting sign-up made from a friend link. Lives in src/lib/pool because it
 * writes the pool's tables (`source-guard.test.ts`); the booking itself is
 * `friend-link/book.ts`.
 *
 *   friendCodeExpiresAt     the code dies at the game's CURRENT kick-off
 *                           (a moved game moves it) or after three days
 *   claimFriendCode /       one handling per WhatsApp message: claimed
 *   releaseFriendCode       before the work, given back if the work fails,
 *                           so a retry after an error still works
 *   friendCodeSeen          this number has used this friend code already
 *                           (booked or told why not): a resend is silent
 *   confirmFriendWithProfile
 *                           a number that already has a profile (D6): no
 *                           second profile. Stopped: reactivated IN PLACE by
 *                           the pool's own restart rule (fresh consent on
 *                           WhatsApp, a no-show pause kept, the referral
 *                           settled). Paused for reports or by hand: not
 *                           booked. The waiting sign-up goes, and the code
 *                           is remembered, only once the booking has an
 *                           answer; a booking that failed keeps both.
 *   retryFriendBooking      a new friend whose profile was made but whose
 *                           booking failed: his code again books him
 */
import { db } from "../db";
import { bookFriend, type BookFriendResult } from "../friend-link/book";
import { existingProfileOutcome, friendCodeExpiry } from "../friend-link/rules";
import { recordPoolConsent } from "./consent-record";
import { settlePoolReferral } from "./growth";
import { manageTransition, type ManageProfileState } from "./manage-rules";
import { applyStandingPause, type StandingPauseClient } from "./standing-pause";

type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

const codeKey = (waMessageId: string) => `friend-code:${waMessageId}`;
const usedKey = (userId: string, code: string) => `friend-code-used:${userId}:${code}`;

/** Has this WhatsApp message been handled as a friend code already? */
export async function friendCodeHandled(waMessageId: string): Promise<boolean> {
  return !!(await db.sentNotification.findUnique({ where: { key: codeKey(waMessageId) }, select: { id: true } }));
}

/** Claim this message for one handling; false when another got it. */
export async function claimFriendCode(waMessageId: string): Promise<boolean> {
  const { count } = await db.sentNotification.createMany({ data: [{ key: codeKey(waMessageId), kind: "friend-code" }], skipDuplicates: true });
  return count === 1;
}

/** Give the claim back: the work failed, a retry of this message may try again. */
export async function releaseFriendCode(waMessageId: string): Promise<void> {
  await db.sentNotification.deleteMany({ where: { key: codeKey(waMessageId) } });
}

/** This number already used one of these friend codes. */
export async function friendCodeSeen(userId: string, codes: readonly string[]): Promise<boolean> {
  if (codes.length === 0) return false;
  return (await db.sentNotification.count({ where: { key: { in: codes.map((c) => usedKey(userId, c)) } } })) > 0;
}

/** When a friend-link sign-up's code stops working, read now. */
export async function friendCodeExpiresAt(row: { createdAt: Date; confirmCodeExpiresAt: Date | null; friendLinkId: string | null }): Promise<Date | null> {
  if (!row.friendLinkId) return row.confirmCodeExpiresAt;
  const link = await db.friendLink.findUnique({ where: { id: row.friendLinkId }, select: { match: { select: { date: true } } } });
  return link ? friendCodeExpiry(row.createdAt, link.match.date) : row.confirmCodeExpiresAt;
}

/** Booked, or a definitive no: the code is spent. A failed booking is not. */
const settled = (r: BookFriendResult) => r.booked !== false || r.reason !== "failed";

export async function confirmFriendWithProfile(a: {
  row: { id: string; confirmCode: string | null; friendLinkId: string | null; referrerUserId: string | null };
  userId: string;
  profile: { id: string; status: string; pausedReason: string | null; pausedAt: Date | null };
  phone: string;
  waMessageId: string;
  now: Date;
}): Promise<{ result: string; replied: boolean }> {
  const { row, userId, profile, phone, waMessageId, now } = a;
  const linkId = row.friendLinkId!;
  const outcome = existingProfileOutcome({ status: profile.status, pausedReason: profile.pausedReason });
  if (outcome.reactivate) {
    const t = manageTransition({ action: "restart", profile: profile as ManageProfileState, now, consent: true, evidence: waMessageId });
    if (!t.ok) return { result: `friend-restart-refused:${t.reason}`, replied: false };
    const done = await db.$transaction(async (tx: Tx) => {
      const { count } = await tx.poolProfile.updateMany({
        where: { id: profile.id, status: "stopped" },
        data: { ...t.patch, consentChannel: "whatsapp", ...(row.referrerUserId ? { referrerUserId: row.referrerUserId } : {}) },
      });
      if (count !== 1) return false;
      await recordPoolConsent(tx, { userId, action: "consent", channel: "whatsapp", evidence: waMessageId, version: t.patch.consentVersion ?? null, phone, code: row.confirmCode, at: now });
      await applyStandingPause(tx as unknown as StandingPauseClient, userId, now);
      if (row.referrerUserId) await settlePoolReferral(tx, profile.id, { friendAccountExisted: true });
      return true;
    });
    if (!done) return { result: "friend-restart-race-lost", replied: false };
  }
  const r = await bookFriend({ linkId, userId, phone, waMessageId, newToPool: outcome.reactivate, blockedProfile: !outcome.book, now });
  if (settled(r)) {
    await db.$transaction(async (tx: Tx) => {
      if (row.confirmCode) await tx.sentNotification.createMany({ data: [{ key: usedKey(userId, row.confirmCode), kind: "friend-code-used" }], skipDuplicates: true });
      await tx.poolProfile.deleteMany({ where: { id: row.id, status: "pending-verify" } });
    });
  }
  return { result: `friend-existing:${r.booked || r.reason}`, replied: true };
}

/** A new friend's own code again, after his booking failed: book him now.
 *  Null when there is nothing to retry (no link, or the link is spent). */
export async function retryFriendBooking(a: { userId: string; phone: string; waMessageId: string; now: Date }): Promise<BookFriendResult | null> {
  const p = await db.poolProfile.findUnique({ where: { userId: a.userId }, select: { friendLinkId: true } });
  if (!p?.friendLinkId) return null;
  const link = await db.friendLink.findUnique({ where: { id: p.friendLinkId }, select: { usedAt: true } });
  if (!link || link.usedAt) return null;
  return bookFriend({ linkId: p.friendLinkId, userId: a.userId, phone: a.phone, waMessageId: a.waMessageId, newToPool: true, now: a.now });
}
