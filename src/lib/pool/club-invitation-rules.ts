/**
 * A CLUB INVITATION'S LIFE (local player pool L8, 2026-10-24). PURE.
 *
 * Approved spec, "Joining the group" and "Guest players in the app": after
 * a game both sides are asked; only on BOTH yeses does the guest get the
 * group's invite link. An organiser's "Invite to club" tap counts as the
 * club's yes. One row per invitation (`ClubInvitation`, L1 decision #9),
 * one open per club and person (partial unique index).
 *
 * THE ORDER (decision L8.1). After a game the GUEST is asked first, and the
 * organisers only once he said yes: they are never asked about someone who
 * does not want to join, and he never learns of a "no" to a question he
 * did not ask. Either order ends the same way: whichever yes comes second
 * sends the link (`send-link`).
 *
 * Effects are what the I/O half (`club-invitation.ts`) does after writing
 * the patch:
 *   send-link             the link goes to him (both said yes)
 *   tell-club-wants-join  the organisers hear he wants to join (his yes
 *                         came first)
 *   tell-guest-closed     he said yes and the club said no or never
 *                         answered: one kind line, no reason given
 */

export const CLUB_INVITE_RULES = Object.freeze({
  /** The after-game question goes this long after the game ends (and is
   *  then held to the end of the pool's quiet hours). */
  afterGameDelayMins: 60,
  /** No after-game question once this long has passed since the game
   *  ended (a sweep that was down never sends a stale one). */
  afterGameWindowHours: 36,
  /** Once he said yes, the club has this long to answer; then the
   *  invitation is withdrawn and he is told once. */
  clubAnswerDays: 7,
  /** After his "No thanks", the club's Invite button is greyed this long. */
  playerDeclineCooldownDays: 30,
  /** Once both said yes, the card says "invite link sent" this long (or
   *  until he joins). */
  linkSentShownDays: 30,
});

const DAY_MS = 86_400_000;

export interface InvitationFacts {
  status: string;
  origin: string;
  clubYesAt: Date | null;
  playerYesAt: Date | null;
  declinedBy: string | null;
  closedAt: Date | null;
  createdAt: Date;
  /** When the link DM was queued; null while none has gone (no source yet). */
  linkSentAt?: Date | null;
}

export type InvitationEvent =
  | { kind: "player-yes"; at: Date }
  | { kind: "player-no"; at: Date }
  | { kind: "club-yes"; at: Date; byUserId: string }
  | { kind: "club-no"; at: Date; byUserId: string }
  | { kind: "club-silent"; at: Date; byUserId?: string };

export type InvitationEffect = "send-link" | "tell-club-wants-join" | "tell-guest-closed";

export interface InvitationPatch {
  status?: "accepted" | "declined" | "withdrawn";
  clubYesAt?: Date;
  clubYesById?: string;
  playerYesAt?: Date;
  declinedBy?: "club" | "player";
  closedAt?: Date;
}

export type InvitationStep =
  | { ok: true; patch: InvitationPatch; effects: InvitationEffect[] }
  | { ok: false; reason: "closed" | "already-answered" | "not-due" };

export function invitationStep(inv: InvitationFacts, ev: InvitationEvent): InvitationStep {
  if (inv.status !== "open") return { ok: false, reason: "closed" };
  switch (ev.kind) {
    case "player-yes":
      if (inv.playerYesAt) return { ok: false, reason: "already-answered" };
      return inv.clubYesAt
        ? { ok: true, patch: { playerYesAt: ev.at, status: "accepted", closedAt: ev.at }, effects: ["send-link"] }
        : { ok: true, patch: { playerYesAt: ev.at }, effects: ["tell-club-wants-join"] };
    case "player-no":
      return { ok: true, patch: { status: "declined", declinedBy: "player", closedAt: ev.at }, effects: [] };
    case "club-yes":
      if (inv.clubYesAt) return { ok: false, reason: "already-answered" };
      return inv.playerYesAt
        ? { ok: true, patch: { clubYesAt: ev.at, clubYesById: ev.byUserId, status: "accepted", closedAt: ev.at }, effects: ["send-link"] }
        : { ok: true, patch: { clubYesAt: ev.at, clubYesById: ev.byUserId }, effects: [] };
    case "club-no":
      return {
        ok: true,
        patch: { status: "declined", declinedBy: "club", closedAt: ev.at, clubYesById: ev.byUserId },
        effects: inv.playerYesAt ? ["tell-guest-closed"] : [],
      };
    case "club-silent": {
      // Only an invitation waiting on the CLUB expires: his own answer is
      // never chased and never times out (spec: it stays until answered).
      if (!inv.playerYesAt || inv.clubYesAt) return { ok: false, reason: "not-due" };
      if (ev.at.getTime() - inv.playerYesAt.getTime() < CLUB_INVITE_RULES.clubAnswerDays * DAY_MS) return { ok: false, reason: "not-due" };
      return { ok: true, patch: { status: "withdrawn", closedAt: ev.at }, effects: ["tell-guest-closed"] };
    }
  }
}

/** The moment an invitation waiting on the club is withdrawn. */
export function clubSilentBefore(now: Date): Date {
  return new Date(now.getTime() - CLUB_INVITE_RULES.clubAnswerDays * DAY_MS);
}

// ── After the game ─────────────────────────────────────────────────────

export type AfterGameSkip = "too-soon" | "too-late" | "not-played" | "member" | "stopped" | "no-phone" | "asked-before";

export function afterGameAskDue(c: {
  match: { kickoff: Date; durationMins: number; status: string };
  /** His settled result for the game (`guest-report.ts` `settleGuestResult`). */
  result: string | null;
  member: boolean;
  /** "none" (a partner guest), "deleted", or his pool profile's status. */
  pool: string;
  hasPhone: boolean;
  /** This club asked him after a game before (any invitation, any status). */
  askedBefore: boolean;
  now: Date;
}): { due: true } | { due: false; why: AfterGameSkip } {
  if (c.result !== "played") return { due: false, why: "not-played" };
  if (c.member) return { due: false, why: "member" };
  if (c.pool === "stopped" || c.pool === "deleted") return { due: false, why: "stopped" };
  if (!c.hasPhone) return { due: false, why: "no-phone" };
  if (c.askedBefore) return { due: false, why: "asked-before" };
  const end = c.match.kickoff.getTime() + c.match.durationMins * 60_000;
  const now = c.now.getTime();
  if (now < end + CLUB_INVITE_RULES.afterGameDelayMins * 60_000) return { due: false, why: "too-soon" };
  if (now > end + CLUB_INVITE_RULES.afterGameWindowHours * 3600_000) return { due: false, why: "too-late" };
  return { due: true };
}

/** The widest kickoff range a due after-game question can come from. */
export function afterGameKickoffRange(now: Date, maxDurationMins = 24 * 60): { from: Date; to: Date } {
  return {
    from: new Date(now.getTime() - CLUB_INVITE_RULES.afterGameWindowHours * 3600_000 - maxDurationMins * 60_000),
    to: new Date(now.getTime() - CLUB_INVITE_RULES.afterGameDelayMins * 60_000),
  };
}

// ── The card ───────────────────────────────────────────────────────────

/**
 *   none       nothing open (and no recent no thanks)
 *   asked      asked after the game, nobody answered yet
 *   club-yes   the club said yes, waiting for him
 *   player-yes he wants to join, waiting for the club
 *   approved   both said yes, no link has gone yet (no link source):
 *              waiting for the group link, however long (review M1)
 *   accepted   both said yes, the link went; he has not joined yet
 *   declined   he said no thanks lately
 */
export type InvitationView = "none" | "asked" | "club-yes" | "player-yes" | "approved" | "accepted" | "declined";

export function invitationView(rows: readonly InvitationFacts[], now: Date): InvitationView {
  const openRow = rows.find((r) => r.status === "open");
  if (openRow) return openRow.clubYesAt ? "club-yes" : openRow.playerYesAt ? "player-yes" : "asked";
  if (rows.some((r) => r.status === "accepted" && !r.linkSentAt)) return "approved";
  const sentWithin = (r: InvitationFacts) => !!r.linkSentAt && now.getTime() - r.linkSentAt.getTime() < CLUB_INVITE_RULES.linkSentShownDays * DAY_MS;
  if (rows.some((r) => r.status === "accepted" && sentWithin(r))) return "accepted";
  const cooldown = CLUB_INVITE_RULES.playerDeclineCooldownDays * DAY_MS;
  const recentNo = rows.some((r) => r.status === "declined" && r.declinedBy === "player" && r.closedAt && now.getTime() - r.closedAt.getTime() < cooldown);
  return recentNo ? "declined" : "none";
}
