/**
 * ASKING A PARTNER CLUB FOR A PLAYER, THE PURE RULES (slice S2, 2026-10-16).
 * Plan: MDs/cross-club-player-ask-plan-2026-10-16.md, sections 3.3 to 3.5
 * and 3.13; decisions D3, D4, D8 and D12 (section 0).
 *
 *   canAsk            may this club ask this partner now, for this match?
 *   partnerReachable  may MatchTime post in the partner's players' group?
 *   askWindows        the cut-off (`postBy`) and the close (`closesAt`)
 *   closeReason       should an open ask close now, and why?
 *
 * THE CUT-OFF (Kemal, 2026-10-16): "the last partner ask goes out at least
 * 4 hours before kickoff" by default, the asking club's setting
 * (`partnerAskCutoffHours`, 1 to 24). Nothing is requested, approved or
 * posted after `postBy`; an ask still waiting for the partner's approval
 * expires there. A posted ask stays open for volunteers until kickoff
 * (`closesAt`) or until the place is filled.
 *
 * Pure: no database, no model. Code decides; nothing here reads words.
 */
import type { ClubRole, PartnerAskWhen } from "./club-partnership-rules";

/** D12: at most this many asks a London day into one partner group. */
export const PARTNER_ASKS_PER_DAY = 2;

/** The statuses of an ask that is still open. One per (match, partner):
 *  a partial unique index holds it (prisma/sql/partner-ask-check.sql). */
export const OPEN_ASK_STATUSES = ["awaiting-approval", "posted"] as const;
export type PartnerAskStatus = "awaiting-approval" | "posted" | "filled" | "declined" | "expired" | "cancelled" | "refused";
export type PartnerAskVia = "button" | "hq" | "dm" | "auto" | "link";

/** Plan 3.13: a post whose WhatsApp id never came back is reported to the
 *  asking club's organisers after this long, never silently. */
export const MISSING_POST_ID_AFTER_MS = 10 * 60 * 1000;

const HOUR = 60 * 60 * 1000;
const LIVE_MATCH = new Set(["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"]);

export function isOpenAskStatus(status: string): boolean {
  return (OPEN_ASK_STATUSES as readonly string[]).includes(status);
}

/** The cut-off and the close for a match at `kickoff`. */
export function askWindows(kickoff: Date, cutoffHours: number): { postBy: Date; closesAt: Date } {
  return { postBy: new Date(kickoff.getTime() - cutoffHours * HOUR), closesAt: new Date(kickoff.getTime()) };
}

export type AskRefusal =
  | "partnership-inactive"
  | "asking-off"
  | "not-admin"
  | "not-next-match"
  | "match-not-open"
  | "no-places"
  | "too-late"
  | "already-open"
  | "daily-cap"
  | PartnerGateRefusal;

export interface CanAskInput {
  partnershipStatus: string;
  askWhen: PartnerAskWhen;
  via: PartnerAskVia;
  /** The requester's role in the asking club; null for the automatic ask. */
  requesterRole: ClubRole | null;
  /** `isNextUpcomingForPosting` for this match in the asking club. */
  isNextMatch: boolean;
  matchStatus: string;
  matchHistorical: boolean;
  placesOpen: number;
  now: Date;
  postBy: Date;
  /** An ask to this partner for this match is already open. */
  openAskForPair: boolean;
  /** Asks already counted against the partner group today (D12). */
  partnerAsksToday: number;
}

export type CanAskResult = { ok: true } | { ok: false; refusal: AskRefusal };

/** May the asking club ask now? The order is the order an organiser can
 *  act on: a setting first, then the game, then the limits. */
export function canAsk(i: CanAskInput): CanAskResult {
  const no = (refusal: AskRefusal): CanAskResult => ({ ok: false, refusal });
  if (i.partnershipStatus !== "active") return no("partnership-inactive");
  if (i.askWhen === "off") return no("asking-off");
  if (i.via === "auto") {
    if (i.askWhen !== "auto") return no("asking-off");
  } else if (i.requesterRole !== "OWNER" && i.requesterRole !== "ADMIN") {
    return no("not-admin");
  }
  if (i.matchHistorical || !LIVE_MATCH.has(i.matchStatus)) return no("match-not-open");
  if (!i.isNextMatch) return no("not-next-match");
  if (i.placesOpen <= 0) return no("no-places");
  if (i.now.getTime() >= i.postBy.getTime()) return no("too-late");
  if (i.openAskForPair) return no("already-open");
  if (i.partnerAsksToday >= PARTNER_ASKS_PER_DAY) return no("daily-cap");
  return { ok: true };
}

export type PartnerGateRefusal =
  | "partner-muted"
  | "partner-dormant"
  | "partner-not-approved"
  | "partner-paused"
  | "partner-setting-up"
  | "partner-no-group"
  | "partner-not-postable";

export interface PartnerGateInput {
  whatsappGroupId: string | null;
  whatsappBotEnabled: boolean;
  dormantAt: Date | null;
  /** `isClubApproved`. */
  approved: boolean;
  /** Billing pause, already read through `isBillingPaused`. */
  billingPaused: boolean;
  settingUp: boolean;
  /** `isGroupPostable` for the partner's players' group. */
  groupPostable: boolean;
}

/** May MatchTime post in the partner's players' group at all? Null: yes. */
export function partnerReachable(p: PartnerGateInput): PartnerGateRefusal | null {
  if (!p.approved) return "partner-not-approved";
  if (p.dormantAt) return "partner-dormant";
  if (p.billingPaused) return "partner-paused";
  if (p.settingUp) return "partner-setting-up";
  if (!p.whatsappGroupId) return "partner-no-group";
  if (!p.whatsappBotEnabled) return "partner-muted";
  if (!p.groupPostable) return "partner-not-postable";
  return null;
}

export type CloseReason =
  | "match-cancelled"
  | "match-moved"
  | "partnership-inactive"
  | "approval-expired"
  | "filled"
  | "kickoff";

export interface CloseInput {
  status: string;
  now: Date;
  postBy: Date;
  closesAt: Date;
  /** The match's kickoff now. A different time from `closesAt` means it moved. */
  matchDate: Date;
  matchStatus: string;
  partnershipStatus: string;
  placesOpen: number;
}

/** Should this open ask close now, and why? Null: it stays open. */
export function closeReason(i: CloseInput): CloseReason | null {
  if (!isOpenAskStatus(i.status)) return null;
  if (i.matchStatus === "CANCELLED") return "match-cancelled";
  if (i.matchDate.getTime() !== i.closesAt.getTime()) return "match-moved";
  if (i.partnershipStatus !== "active") return "partnership-inactive";
  if (i.placesOpen <= 0) return "filled";
  if (i.status === "awaiting-approval" && i.now.getTime() >= i.postBy.getTime()) return "approval-expired";
  if (i.now.getTime() >= i.closesAt.getTime()) return "kickoff";
  return null;
}

/** The status an ask closes into. Only a POSTED ask can be filled through
 *  its post; one still waiting for approval is cancelled when the place
 *  fills by another route. */
export function closedStatus(reason: CloseReason, status: string): PartnerAskStatus {
  if (reason === "filled") return status === "posted" ? "filled" : "cancelled";
  if (reason === "approval-expired" || reason === "kickoff") return "expired";
  return "cancelled";
}

/** Who hears about a close (D8): the partner group only about an ask it
 *  saw; the asking organisers when nobody came or it never got posted. */
export function closeTells(reason: CloseReason, status: string, volunteers: number): { partnerGroup: "filled" | "off" | null; asker: "expired-approval" | "nobody" | null } {
  const posted = status === "posted";
  return {
    partnerGroup: !posted ? null : reason === "filled" ? "filled" : reason === "kickoff" ? null : "off",
    asker: reason === "approval-expired" ? "expired-approval" : reason === "kickoff" && posted && volunteers === 0 ? "nobody" : null,
  };
}
