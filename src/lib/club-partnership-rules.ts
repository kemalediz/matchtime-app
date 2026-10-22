/**
 * PARTNER CLUBS, THE PURE RULES (cross-club ask, slice S1, 2026-10-16).
 * Plan: MDs/cross-club-player-ask-plan-2026-10-16.md, sections 3.1, 3.2
 * and 4; decisions D1, D2, D3 and D12 (section 0).
 *
 *   - One `ClubPartnership` row per direction: "FNF may ask Sutton FC" is
 *     not "Sutton FC may ask FNF" (D2).
 *   - Since partner discovery (2026-10-22, P5) the platform owner no
 *     longer creates one: clubs send each other requests (P3). The
 *     platform owner keeps pause and end as an override
 *     (`planPlatformAction`).
 *   - An OWNER or ADMIN of each club accepts it for that club (D-2, Kemal
 *     2026-10-22); it is "active" once both have. A request (P3) carries
 *     the asking club's acceptance from the start, so the other club's one
 *     acceptance makes it active. An owner or admin of either side declines
 *     a proposal or removes a pairing ("ended"), the asking side withdraws
 *     its own pending request, and either side pauses it; only the side
 *     that paused resumes it, so one club can never undo the other's pause.
 *   - The partner side alone chooses how its organisers approve an ask
 *     ("each-ask" or "standing", D3); the asking side alone chooses when it
 *     asks and its cut-off (D4, D12).
 *
 * Pure. No database, no model. The writer is `club-partnership.ts`.
 */

import { distanceKm } from "./geo";

export type PartnershipStatus = "proposed" | "active" | "paused" | "ended";
export type PartnerApproval = "each-ask" | "standing";
export type PartnerAskWhen = "off" | "on-request" | "auto";
export type PartnershipSide = "asker" | "partner";
export type ClubRole = "OWNER" | "ADMIN" | "PLAYER";

export const PARTNER_ASK_WHEN: readonly PartnerAskWhen[] = ["off", "on-request", "auto"];
export const PARTNER_APPROVALS: readonly PartnerApproval[] = ["each-ask", "standing"];

/** The cut-off (Kemal, 2026-10-16): the last ask goes out at least this
 *  many hours before kickoff. The schema default and the CHECK agree. */
export const PARTNER_ASK_CUTOFF_DEFAULT_HOURS = 4;
export const PARTNER_ASK_CUTOFF_MIN_HOURS = 1;
export const PARTNER_ASK_CUTOFF_MAX_HOURS = 24;

/** The automatic ask's match-day time when none is set. */
export const PARTNER_ASK_TIME_DEFAULT = "16:00";

/** A stored value, read: anything unknown is "off", never a third meaning. */
export function normalisePartnerAskWhen(value: unknown): PartnerAskWhen {
  return parsePartnerAskWhen(value) ?? "off";
}

/** A value to save: exactly one of the three, or refused. */
export function parsePartnerAskWhen(value: unknown): PartnerAskWhen | null {
  return typeof value === "string" && (PARTNER_ASK_WHEN as readonly string[]).includes(value) ? (value as PartnerAskWhen) : null;
}

export function parsePartnerApproval(value: unknown): PartnerApproval | null {
  return typeof value === "string" && (PARTNER_APPROVALS as readonly string[]).includes(value) ? (value as PartnerApproval) : null;
}

/** Whole hours from 1 to 24, or refused. */
export function parseCutoffHours(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isInteger(n)) return null;
  return n >= PARTNER_ASK_CUTOFF_MIN_HOURS && n <= PARTNER_ASK_CUTOFF_MAX_HOURS ? n : null;
}

/** A London wall-clock "H:MM" or "HH:MM", zero padded; anything else refused. */
export function parseAskTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

/** The automatic ask's time in force. */
export function effectiveAskTime(stored: string | null | undefined): string {
  return parseAskTime(stored) ?? PARTNER_ASK_TIME_DEFAULT;
}

export interface PartnershipRow {
  askerOrgId: string;
  partnerOrgId: string;
  status: string;
  askerAcceptedAt: Date | null;
  partnerAcceptedAt: Date | null;
  pausedByOrgId: string | null;
}

/** Which side of a pairing a club is on, or none. */
export function sideOf(p: Pick<PartnershipRow, "askerOrgId" | "partnerOrgId">, orgId: string): PartnershipSide | null {
  if (p.askerOrgId === orgId) return "asker";
  if (p.partnerOrgId === orgId) return "partner";
  return null;
}

export type PartnershipAction = "accept" | "decline" | "withdraw" | "pause" | "resume" | "end";

export type ActionRefusal =
  | "not-a-side"
  /** No longer returned since D-2 (owners and admins alike); kept so an
   *  older caller's switch still compiles. */
  | "owner-only"
  | "admin-only"
  | "ended"
  | "not-proposed"
  | "already-accepted"
  | "not-active"
  | "not-paused"
  | "paused-by-other"
  | "not-asker";

export interface PartnershipPatch {
  status?: PartnershipStatus;
  askerAcceptedAt?: Date;
  askerAcceptedBy?: string;
  partnerAcceptedAt?: Date;
  partnerAcceptedBy?: string;
  pausedByOrgId?: string | null;
  /** The partner side's per-ask choice, set as it accepts (P3). */
  partnerApproval?: PartnerApproval;
  /** Partner discovery (2026-10-22): when, by which club and why it ended,
   *  so the 30-day wait after a decline or an end can be read (P3). */
  endedAt?: Date;
  endedByOrgId?: string | null;
  endReason?: PartnershipEndReason;
}

export type ActionPlan = { ok: true; patch: PartnershipPatch } | { ok: false; refusal: ActionRefusal };

/** What one club's organiser may do to a pairing, and the row change. */
export function planPartnershipAction(
  p: PartnershipRow,
  a: {
    orgId: string;
    role: ClubRole;
    action: PartnershipAction;
    userId: string;
    now: Date;
    /** Accepting as the partner side: its per-ask choice (P3). Omitted, the
     *  row keeps what it has ("post without asking" for a request). */
    approval?: PartnerApproval;
  },
): ActionPlan {
  const side = sideOf(p, a.orgId);
  if (!side) return { ok: false, refusal: "not-a-side" };
  const admin = a.role === "OWNER" || a.role === "ADMIN";

  switch (a.action) {
    case "accept": {
      if (!admin) return { ok: false, refusal: "admin-only" };
      if (p.status === "ended") return { ok: false, refusal: "ended" };
      if (p.status !== "proposed") return { ok: false, refusal: "not-proposed" };
      const mine = side === "asker" ? p.askerAcceptedAt : p.partnerAcceptedAt;
      if (mine) return { ok: false, refusal: "already-accepted" };
      const theirs = side === "asker" ? p.partnerAcceptedAt : p.askerAcceptedAt;
      const patch: PartnershipPatch =
        side === "asker" ? { askerAcceptedAt: a.now, askerAcceptedBy: a.userId } : { partnerAcceptedAt: a.now, partnerAcceptedBy: a.userId };
      if (theirs) patch.status = "active";
      if (side === "partner" && a.approval) patch.partnerApproval = a.approval;
      return { ok: true, patch };
    }
    case "decline": {
      if (!admin) return { ok: false, refusal: "admin-only" };
      if (p.status === "ended") return { ok: false, refusal: "ended" };
      if (p.status !== "proposed") return { ok: false, refusal: "not-proposed" };
      return { ok: true, patch: { status: "ended", pausedByOrgId: null, endedAt: a.now, endedByOrgId: a.orgId, endReason: "declined" } };
    }
    case "withdraw": {
      // The asking club takes back its own pending request (plan 3.4).
      if (!admin) return { ok: false, refusal: "admin-only" };
      if (side !== "asker") return { ok: false, refusal: "not-asker" };
      if (p.status === "ended") return { ok: false, refusal: "ended" };
      if (p.status !== "proposed") return { ok: false, refusal: "not-proposed" };
      return { ok: true, patch: { status: "ended", pausedByOrgId: null, endedAt: a.now, endedByOrgId: a.orgId, endReason: "withdrawn" } };
    }
    case "pause": {
      if (!admin) return { ok: false, refusal: "admin-only" };
      if (p.status !== "active") return { ok: false, refusal: "not-active" };
      return { ok: true, patch: { status: "paused", pausedByOrgId: a.orgId } };
    }
    case "resume": {
      if (!admin) return { ok: false, refusal: "admin-only" };
      if (p.status !== "paused") return { ok: false, refusal: "not-paused" };
      if (p.pausedByOrgId && p.pausedByOrgId !== a.orgId) return { ok: false, refusal: "paused-by-other" };
      return { ok: true, patch: { status: "active", pausedByOrgId: null } };
    }
    case "end": {
      if (!admin) return { ok: false, refusal: "admin-only" };
      if (p.status === "ended") return { ok: false, refusal: "ended" };
      return { ok: true, patch: { status: "ended", pausedByOrgId: null, endedAt: a.now, endedByOrgId: a.orgId, endReason: "ended" } };
    }
  }
}

/**
 * The platform owner's override on /admin/clubs/partners (partner
 * discovery P5, D-6, Kemal 2026-10-22): pause, resume or end any pairing,
 * for abuse or support. Creating one on a club's behalf is gone, since
 * that would skip the club's consent.
 *
 * A platform pause is marked `PLATFORM_PAUSE` in `pausedByOrgId`, so
 * neither club can resume it (`planPartnershipAction` refuses
 * "paused-by-other"), and the platform resumes only its own pause, never a
 * club's.
 */
export type PlatformAction = "pause" | "resume" | "end";
export const PLATFORM_ACTIONS: readonly PlatformAction[] = ["pause", "resume", "end"];
export const PLATFORM_PAUSE = "platform";

export function planPlatformAction(p: PartnershipRow, a: { action: PlatformAction; now: Date }): ActionPlan {
  switch (a.action) {
    case "pause":
      if (p.status !== "active") return { ok: false, refusal: "not-active" };
      return { ok: true, patch: { status: "paused", pausedByOrgId: PLATFORM_PAUSE } };
    case "resume":
      if (p.status !== "paused") return { ok: false, refusal: "not-paused" };
      if (p.pausedByOrgId !== PLATFORM_PAUSE) return { ok: false, refusal: "paused-by-other" };
      return { ok: true, patch: { status: "active", pausedByOrgId: null } };
    case "end":
      if (p.status === "ended") return { ok: false, refusal: "ended" };
      return { ok: true, patch: { status: "ended", pausedByOrgId: null, endedAt: a.now, endedByOrgId: null, endReason: "ended" } };
  }
}

export function parsePlatformAction(value: unknown): PlatformAction | null {
  return typeof value === "string" && (PLATFORM_ACTIONS as readonly string[]).includes(value) ? (value as PlatformAction) : null;
}

// ─── Partner discovery (slice P1, 2026-10-22) ─────────────────────────────
// Plan: MDs/partner-discovery-plan-2026-10-21.md, sections 2.1 and 6.

/** `ClubPartnership.origin`. The CHECK in prisma/sql/partner-ask-check.sql
 *  carries exactly these. */
export const PARTNERSHIP_ORIGINS = ["owner", "request"] as const;
export type PartnershipOrigin = (typeof PARTNERSHIP_ORIGINS)[number];

/** `ClubPartnership.endReason`. Same CHECK file. */
export const PARTNERSHIP_END_REASONS = ["declined", "withdrawn", "ended", "expired", "blocked"] as const;
export type PartnershipEndReason = (typeof PARTNERSHIP_END_REASONS)[number];

/**
 * "Let nearby clubs find us and send requests". ON unless a club switched
 * it off: the column defaults to true, so every existing club reads as on
 * (Kemal, 2026-10-22), and a missing value reads on too.
 */
export function isDiscoverable(org: { discoverable?: boolean | null }): boolean {
  return org.discoverable !== false;
}

/** "Accept partner requests automatically". OFF unless switched on. */
export function autoAcceptOf(org: { autoAcceptPartnerRequests?: boolean | null }): boolean {
  return org.autoAcceptPartnerRequests === true;
}

/** A switch's value to save: a real boolean, or refused. */
export function parseSwitch(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** Only a club's owners and admins change either setting. */
export function canChangeDiscoverySettings(role: ClubRole): boolean {
  return role === "OWNER" || role === "ADMIN";
}

interface Position {
  lat: number | null;
  lng: number | null;
}
const geocoded = (v: Position | null | undefined): boolean => !!v && v.lat !== null && v.lng !== null;

/**
 * A club has a geocoded venue when one of its ACTIVE games is linked to a
 * venue with a position, or its home venue has one (plan 2.1). The same
 * test drives the settings prompt and the weekly reminder.
 */
export function hasGeocodedVenue(club: { homeVenue: Position | null; games: Array<{ isActive: boolean; venue: Position | null }> }): boolean {
  return geocoded(club.homeVenue) || club.games.some((g) => g.isActive && geocoded(g.venue));
}

/** The weekly venue reminder: once a week at most (Kemal, 2026-10-22). */
export const VENUE_REMINDER_EVERY_MS = 7 * 24 * 60 * 60 * 1000;

/** A game's venue lookup reported "pending" this recently is still running. */
export const VENUE_LOOKUP_RUNNING_MS = 60 * 60 * 1000;

/** A game's lookup is still running: a club created a moment ago is not
 *  told it has no venue while Google is answering. */
export function venueLookupRunning(
  games: Array<{ isActive: boolean; venueLookupStatus: string | null; venueResolvedAt: Date | null }>,
  now: Date,
): boolean {
  return games.some(
    (g) => g.isActive && g.venueLookupStatus === "pending" && !!g.venueResolvedAt && now.getTime() - g.venueResolvedAt.getTime() < VENUE_LOOKUP_RUNNING_MS,
  );
}

/**
 * Is the weekly "confirm your venue" reminder due? Never for a club with a
 * venue (so it stops for good once one is set), never while a lookup is
 * running, and at most once in any 7 days.
 */
export function venueReminderDue(a: { hasVenue: boolean; lastSentAt: Date | null; lookupRunning: boolean; now: Date }): boolean {
  if (a.hasVenue || a.lookupRunning) return false;
  if (!a.lastSentAt) return true;
  const since = a.now.getTime() - a.lastSentAt.getTime();
  return since >= VENUE_REMINDER_EVERY_MS;
}

/**
 * What MatchTime's pairing notice to one club is about (2026-10-21): the
 * `BotJob.aboutKey` of each DM copy, and the HQ log's `askRef` when it went
 * to the club's admin group. A WhatsApp reply or reaction on the notice
 * finds its pairing AND its club by this key, never by the notice's words,
 * so one person who owns both clubs (two notices) answers each one alone.
 */
const PAIRING_KEY_PREFIX = "pairing:";

export function pairingNoticeKey(partnershipId: string, orgId: string): string {
  return `${PAIRING_KEY_PREFIX}${partnershipId}:${orgId}`;
}

export function parsePairingNoticeKey(key: string | null | undefined): { partnershipId: string; orgId: string } | null {
  if (!key || !key.startsWith(PAIRING_KEY_PREFIX)) return null;
  const [partnershipId, orgId, ...rest] = key.slice(PAIRING_KEY_PREFIX.length).split(":");
  if (!partnershipId || !orgId || rest.length > 0) return null;
  return { partnershipId, orgId };
}

/** This club's side has not accepted a pairing that is still proposed. */
export function waitingForSide(
  p: Pick<PartnershipRow, "askerOrgId" | "partnerOrgId" | "status" | "askerAcceptedAt" | "partnerAcceptedAt">,
  orgId: string,
): boolean {
  const side = sideOf(p, orgId);
  if (!side || p.status !== "proposed") return false;
  return !(side === "asker" ? p.askerAcceptedAt : p.partnerAcceptedAt);
}

// ─── Partner requests (slice P3, 2026-10-22) ──────────────────────────────
// Plan: MDs/partner-discovery-plan-2026-10-21.md, sections 3.1 to 3.5;
// decisions D-1 to D-4 (section 9).

const DAY_MS = 24 * 60 * 60 * 1000;

/** New requests one club may send per London day (D-4). */
export const PARTNER_REQUESTS_PER_DAY = 20;
/** Requests one club may have waiting at once (D-4). */
export const PARTNER_REQUESTS_PENDING_MAX = 50;
/** An unanswered pairing request ends after this (D-4). An ask for
 *  players has no such limit: it ends with its match. */
export const PARTNER_REQUEST_EXPIRES_MS = 14 * DAY_MS;
/** After the other club declined or ended it, the wait before asking again. */
export const PARTNER_REQUEST_COOLDOWN_MS = 30 * DAY_MS;
/** A pairing made by a request: the partner's asks go straight into its
 *  players' group unless it chooses otherwise (Kemal, 2026-10-22). */
export const REQUEST_DEFAULT_APPROVAL: PartnerApproval = "standing";

/** The pairing row A to B as it stands, if one exists (one per direction). */
export interface ExistingPairing {
  status: string;
  endReason: string | null;
  endedAt: Date | null;
  endedByOrgId: string | null;
}

/**
 * When A may ask B again, or null for no wait: only after B declined or
 * ended it (D-4). Withdrawn and expired requests, A's own end, a block
 * (lifted by B's own unblock) and the platform owner's end carry no wait.
 */
export function cooldownUntil(existing: ExistingPairing | null, partnerOrgId: string, now: Date): Date | null {
  if (!existing || existing.status !== "ended" || !existing.endedAt) return null;
  if (existing.endedByOrgId !== partnerOrgId) return null;
  if (existing.endReason !== "declined" && existing.endReason !== "ended") return null;
  const until = new Date(existing.endedAt.getTime() + PARTNER_REQUEST_COOLDOWN_MS);
  return until.getTime() > now.getTime() ? until : null;
}

export interface RequestFacts {
  askerOrgId: string;
  partnerOrgId: string;
  /** The sender's role in the asking club. */
  role: ClubRole;
  /** The asking club's "Let nearby clubs find us" (D-3). */
  askerDiscoverable: boolean;
  /** The other club, or null when it does not exist. */
  partner: { approved: boolean; discoverable: boolean } | null;
  /** The other club may already ask us (active or paused): the one-tap
   *  "ask them too" (D-1), which needs neither switch. */
  theyMayAskUs: boolean;
  existing: ExistingPairing | null;
  /** Either club blocked the other. */
  blocked: boolean;
  /** Requests this club sent since London midnight. */
  sentToday: number;
  /** Requests this club has waiting. */
  pending: number;
  now: Date;
}

export type RequestRefusal =
  | "not-admin"
  | "same-club"
  | "no-club"
  | "blocked"
  | "hidden"
  | "not-listed"
  | "already-pending"
  | "already-paired"
  | "cooldown"
  | "pending-cap"
  | "daily-cap";

export type RequestPlan = { ok: true; mode: "create" | "reopen" } | { ok: false; refusal: RequestRefusal };

/**
 * May club A send club B a request now, and is it a new row or an ended
 * one reopened (one row per direction)? Checked in this order, so the
 * reason given is the most lasting one.
 */
export function planRequest(f: RequestFacts): RequestPlan {
  if (f.role !== "OWNER" && f.role !== "ADMIN") return { ok: false, refusal: "not-admin" };
  if (f.askerOrgId === f.partnerOrgId) return { ok: false, refusal: "same-club" };
  if (!f.partner || !f.partner.approved) return { ok: false, refusal: "no-club" };
  if (f.blocked) return { ok: false, refusal: "blocked" };
  if (!f.theyMayAskUs) {
    if (!f.askerDiscoverable) return { ok: false, refusal: "hidden" };
    if (!f.partner.discoverable) return { ok: false, refusal: "not-listed" };
  }
  if (f.existing) {
    if (f.existing.status === "proposed") return { ok: false, refusal: "already-pending" };
    if (f.existing.status !== "ended") return { ok: false, refusal: "already-paired" };
    if (cooldownUntil(f.existing, f.partnerOrgId, f.now)) return { ok: false, refusal: "cooldown" };
  }
  if (f.pending >= PARTNER_REQUESTS_PENDING_MAX) return { ok: false, refusal: "pending-cap" };
  if (f.sentToday >= PARTNER_REQUESTS_PER_DAY) return { ok: false, refusal: "daily-cap" };
  return { ok: true, mode: f.existing ? "reopen" : "create" };
}

/** A pending request past its 14 days. Only requests expire; a pairing the
 *  platform owner proposed (none left in prod) waits as it always did. */
export function requestExpired(r: { status: string; origin: string; expiresAt: Date | null }, now: Date): boolean {
  return r.status === "proposed" && r.origin === "request" && !!r.expiresAt && r.expiresAt.getTime() <= now.getTime();
}

/** Owners and admins block another club (plan 3.4), never their own. */
export function canBlock(a: {
  role: ClubRole;
  blockerOrgId: string;
  blockedOrgId: string;
}): { ok: true } | { ok: false; refusal: "not-admin" | "same-club" } {
  if (a.role !== "OWNER" && a.role !== "ADMIN") return { ok: false, refusal: "not-admin" };
  if (a.blockerOrgId === a.blockedOrgId) return { ok: false, refusal: "same-club" };
  return { ok: true };
}

// ── The card in the request notice (plan 2.3) ──

const KM_PER_MILE = 1.609344;

/** Where a club is measured from (plan 2.2): its active games' geocoded
 *  venues, or, with no active game, its home venue. */
export function clubPositions(club: {
  homeVenue: Position | null;
  games: Array<{ isActive: boolean; venue: Position | null }>;
}): Array<{ lat: number; lng: number }> {
  const active = club.games.filter((g) => g.isActive);
  const from = active.length > 0 ? active.map((g) => g.venue) : [club.homeVenue];
  return from.filter((v): v is { lat: number; lng: number } => geocoded(v));
}

/** The nearest distance between two clubs, in miles to 0.1, or null when
 *  either has no geocoded venue. */
export function nearestMiles(a: Array<{ lat: number; lng: number }>, b: Array<{ lat: number; lng: number }>): number | null {
  let best: number | null = null;
  for (const x of a) for (const y of b) {
    const km = distanceKm(x.lat, x.lng, y.lat, y.lng);
    if (best === null || km < best) best = km;
  }
  return best === null ? null : Math.round((best / KM_PER_MILE) * 10) / 10;
}
