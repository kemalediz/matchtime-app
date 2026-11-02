/**
 * THE PARTNER POOL INVITE, ITS RULES (Kemal, 2026-11-02). PURE.
 *
 * A player from a PARTNER club who played in another club's game through a
 * partner ask gets ONE optional DM after that game: join the local player
 * pool. Joining is never a condition of playing. The I/O half is
 * `partner-invite.ts`; the link is `partner-invite-token.ts`.
 *
 * WHO. All of:
 *   picked      his id is on the ask's `pickedUserIds`: the volunteers
 *               still CONFIRMED when the ask closed at kick-off
 *               (`partner-guest.ts` `standDownVolunteers`). A volunteer
 *               not picked gets nothing.
 *   completed   the match is COMPLETED (`match-completion.ts`).
 *   played      his guest place's settled result is "played"
 *               (`guest-report.ts` `settleGuestResult`, the verdict the
 *               club invitation's after-game question uses): it waits for
 *               the no-show window to close, so a guest marked a no-show,
 *               a late cancel or a bench place never called up is not asked.
 *   no profile  no pool profile in any state (stopped included), and never
 *               one before (a deleted profile leaves the consent record):
 *               consent withdrawn stays withdrawn.
 *   a phone     the DM goes to his own WhatsApp.
 *   never sent  once per person EVER (`partnerInviteKey`), however many
 *               partner games he plays; one he ignores is never asked again.
 *
 * WHEN. The club invitation's after-game timing (`CLUB_INVITE_RULES`): from
 * an hour after the game ends, never once it is 36 hours stale (a sweep that
 * was down sends nothing late). Then held through HIS club's quiet hours
 * (`message-hours.ts`), as every club DM is.
 */
import { CLUB_INVITE_RULES, afterGameKickoffRange } from "./club-invitation-rules";
import { messageHoursSendAfter, type QuietHours } from "../message-hours";
import type { GuestResult } from "./vocab";

/** The once-ever marker (`SentNotification.key`): the person, never the match. */
export function partnerInviteKey(userId: string): string {
  return `pool-partner-invite:${userId}`;
}

export const PARTNER_INVITE_KIND = "pool-partner-invite";

export type PartnerInviteSkip =
  | "not-picked"
  | "not-completed"
  | "not-played"
  | "in-pool"
  | "was-in-pool"
  | "no-phone"
  | "sent-before"
  | "too-soon"
  | "too-late";

export function partnerInviteDue(c: {
  match: { kickoff: Date; durationMins: number; status: string };
  picked: boolean;
  /** His settled result for the game (`settleGuestResult`). */
  result: GuestResult | null;
  hasProfile: boolean;
  /** He was in the pool once and deleted his profile. */
  everInPool: boolean;
  hasPhone: boolean;
  sentBefore: boolean;
  now: Date;
}): { due: true } | { due: false; why: PartnerInviteSkip } {
  if (c.sentBefore) return { due: false, why: "sent-before" };
  if (!c.picked) return { due: false, why: "not-picked" };
  if (c.match.status !== "COMPLETED") return { due: false, why: "not-completed" };
  if (c.result !== "played") return { due: false, why: "not-played" };
  if (c.hasProfile) return { due: false, why: "in-pool" };
  if (c.everInPool) return { due: false, why: "was-in-pool" };
  if (!c.hasPhone) return { due: false, why: "no-phone" };
  const end = c.match.kickoff.getTime() + c.match.durationMins * 60_000;
  const now = c.now.getTime();
  if (now < end + CLUB_INVITE_RULES.afterGameDelayMins * 60_000) return { due: false, why: "too-soon" };
  if (now > end + CLUB_INVITE_RULES.afterGameWindowHours * 3600_000) return { due: false, why: "too-late" };
  return { due: true };
}

/** The widest kickoff range a due invite can come from (the after-game one). */
export const partnerInviteKickoffRange = afterGameKickoffRange;

/** Null: send now. Else the end of his own club's quiet hours. */
export function partnerInviteSendAfter(now: Date, quiet: QuietHours): Date | null {
  return messageHoursSendAfter(now, quiet);
}

// ── The page ───────────────────────────────────────────────────────────

/**
 *   invalid   not a link we signed, or it names nobody with a number
 *   expired   ours, but run out: nothing about him is read or shown
 *   member    already in the pool (active or paused): the done state
 *   stopped   he stopped pool messages: start again IN PLACE, his saved
 *             details kept (the manage page's restart rule)
 *   paused    pool sign-ups are braked (`POOL_SIGNUP_PAUSED`)
 *   join      the form, filled in from what his club knows
 */
export type PartnerInvitePage = "invalid" | "expired" | "member" | "stopped" | "paused" | "join";

export function partnerInvitePageState(a: {
  token: "ok" | "expired" | "invalid";
  user: { hasPhone: boolean } | null;
  /** His pool profile, any status, or null. */
  profile: { status: string } | null;
  signupsPaused: boolean;
}): PartnerInvitePage {
  if (a.token === "expired") return "expired";
  if (a.token !== "ok" || !a.user || !a.user.hasPhone) return "invalid";
  const status = a.profile?.status;
  if (status === "active" || status === "paused") return "member";
  if (status === "stopped") return "stopped";
  return a.signupsPaused ? "paused" : "join";
}
