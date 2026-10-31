/**
 * THE FRIEND LINK, PURE RULES (Kemal, 2026-10-31; plan
 * MDs/friend-link-plan-2026-10-31.md). No Prisma, no clock of its own.
 *
 * A player says a friend is coming ("my friend Ali is in", "+1", "my
 * brother can play"). MatchTime does not add the friend: it DMs the player
 * a personal link for that one match, and the friend joins only by opening
 * it, filling in the /play form and sending his own WhatsApp code. He then
 * becomes a pool member and is booked straight in (or on the bench).
 *
 *   decideThirdPartyIn      the engine's reading of a third-party claim,
 *                           from the extractor's facts (no words read here)
 *   friendLinkState         is a link still usable, from the match as it is
 *   friendBookingRefusal    why a confirmed friend is not booked, if at all
 *   existingProfileOutcome  a friend who already has a pool profile (D6)
 *   newLinksAllowed         the per-member cap (D3)
 *   friendCodeExpiry        his code dies at kick-off, or after the pool's
 *                           usual three days when that is sooner
 *   friendShortName         "Ali Y.", how the group sees him
 */
import { POOL_CONFIRM } from "../pool/rules";

export const FRIEND_LINK = Object.freeze({
  /** Unused links one member may hold for one match (D3). */
  openLinksPerMemberPerMatch: 3,
});

export type FriendPersonKind = "named" | "relation" | "group" | "placeholder";

export interface ThirdPartyInFacts {
  polarity: "in" | "out" | "bench";
  personKind: FriendPersonKind;
  /** Verbatim from the extractor. */
  personRef: string;
  /** What `resolvePerson` made of a NAMED reference; "not-a-person" for
   *  every other kind (never matched against the roster). */
  resolution: "resolved" | "ambiguous" | "unknown" | "not-a-person";
  /** `refWrittenIn(personRef, body)`: the name is really in the message. */
  writtenInMessage: boolean;
  /** The reference is a raw-digits mention nobody could name. */
  rawDigits: boolean;
  senderKnown: boolean;
  senderIsAdmin: boolean;
  attendanceOn: boolean;
  hasActiveMatch: boolean;
}

export type ThirdPartyInDecision =
  /** Send the sender a friend link; write nothing. */
  | { kind: "friend_link"; friendName: string | null; reason: string }
  /** Not a friend link: the engine carries on exactly as before. */
  | { kind: "today"; reason: string }
  /** A friend, but nothing to link to (no match, attendance off): nothing at all. */
  | { kind: "none"; reason: string };

export function decideThirdPartyIn(f: ThirdPartyInFacts): ThirdPartyInDecision {
  if (f.polarity !== "in") return { kind: "today", reason: "not an IN for someone else" };
  if (f.rawDigits) return { kind: "today", reason: "a mention nobody could name" };
  if (f.personKind === "group") return { kind: "today", reason: "a group is nobody to send a link for" };
  const unnamed = f.personKind === "relation" || f.personKind === "placeholder";
  const newNamed = f.personKind === "named" && f.resolution === "unknown" && f.writtenInMessage;
  if (!unnamed && !newNamed) return { kind: "today", reason: "the person is a member, ambiguous or not written in the message" };
  // D1: an organiser adding a guest is roster work by the person in charge.
  if (f.senderIsAdmin) return { kind: "today", reason: "an organiser adds a guest directly (friend link D1)" };
  // Nobody to send a link to: today's path, which degrades it ("unknown
  // guest ... offered by an unresolved sender") so the operator sees it.
  if (!f.senderKnown) return { kind: "today", reason: "friend link: the sender could not be resolved" };
  if (!f.attendanceOn) return { kind: "none", reason: "friend link: attendance is off for this club" };
  if (!f.hasActiveMatch) return { kind: "none", reason: "friend link: no match to link to" };
  const friendName = newNamed ? f.personRef.trim() || null : null;
  return { kind: "friend_link", friendName, reason: `friend link for ${friendName ? `"${friendName}"` : `an unnamed friend ("${f.personRef}")`}: nobody added` };
}

export type FriendLinkState = "open" | "used" | "started" | "called-off";

const LIVE_MATCH = ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"];

export function friendLinkState(a: { used: boolean; matchStatus: string; isHistorical: boolean; kickoff: Date; now: Date }): FriendLinkState {
  if (a.used) return "used";
  if (a.matchStatus === "CANCELLED") return "called-off";
  if (!LIVE_MATCH.includes(a.matchStatus) || a.isHistorical || a.now.getTime() >= a.kickoff.getTime()) return "started";
  return "open";
}

/** Why a friend with a confirmed code is not booked (FriendLink.outcome). */
export const FRIEND_NOT_BOOKED = ["used", "started", "called-off", "issuer", "already-on-match", "blocked", "elsewhere", "failed"] as const;
export type FriendNotBooked = (typeof FRIEND_NOT_BOOKED)[number];

export function friendBookingRefusal(a: {
  linkState: FriendLinkState;
  /** The number that sent the code is the member who was sent the link. */
  isIssuer: boolean;
  /** He already has a CONFIRMED or BENCH row on this match. */
  alreadyOnMatch: boolean;
  /** The club blocked him, MatchTime paused him for reports or by hand, or
   *  an organiser removed him from this club (`guest-door-rules.ts`). */
  blocked: boolean;
  /** He is this club's live guest for another match (one guest match per row). */
  guestElsewhere: boolean;
}): FriendNotBooked | null {
  if (a.linkState !== "open") return a.linkState;
  if (a.isIssuer) return "issuer";
  if (a.alreadyOnMatch) return "already-on-match";
  if (a.blocked) return "blocked";
  if (a.guestElsewhere) return "elsewhere";
  return null;
}

/** D6: a friend whose number already has a pool profile. */
export function existingProfileOutcome(p: { status: string; pausedReason: string | null }): { book: boolean; reactivate: boolean } {
  // A pause for reports or by the MatchTime team is a person's to lift,
  // whatever the status (a stopped profile keeps it, `manage-rules.ts`).
  if (p.pausedReason === "reports" || p.pausedReason === "admin") return { book: false, reactivate: false };
  // Stopped (consent withdrawn): his code is fresh consent. Reactivated in
  // place by the pool's own restart rule, which keeps a no-show pause.
  if (p.status === "stopped") return { book: true, reactivate: true };
  return { book: true, reactivate: false };
}

export function newLinksAllowed(a: { unusedOpen: number; wanted: number }): number {
  return Math.max(0, Math.min(a.wanted, FRIEND_LINK.openLinksPerMemberPerMatch - a.unusedOpen));
}

export function friendCodeExpiry(now: Date, kickoff: Date): Date {
  const usual = now.getTime() + POOL_CONFIRM.codeTtlDays * 24 * 3600_000;
  return new Date(Math.min(usual, kickoff.getTime()));
}

export function friendShortName(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts[0]} ${parts[parts.length - 1].charAt(0).toLocaleUpperCase()}.`;
}
