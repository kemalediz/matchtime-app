/**
 * PARTNER CLUBS, THE ONE WRITER (cross-club ask, slice S1, 2026-10-16).
 * Plan: MDs/cross-club-player-ask-plan-2026-10-16.md, sections 3.1 and 3.2.
 *
 * Every write to `ClubPartnership`, and to the asking club's three
 * settings (`partnerAskWhen`, `partnerAskTime`, `partnerAskCutoffHours`),
 * happens here; a source guard test keeps it so. The decisions are the
 * pure rules in `club-partnership-rules.ts`; this file loads, applies them
 * with a compare-and-set, and tells the clubs.
 *
 * Partner discovery (slice P1, 2026-10-22,
 * MDs/partner-discovery-plan-2026-10-21.md): the two discovery settings
 * ("Let nearby clubs find us and send requests", "Accept partner requests
 * automatically"), the club's venue status for the settings prompt, and
 * the weekly venue reminder. Slice P5: the platform owner no longer pairs
 * clubs; it pauses, resumes and ends any pairing (`platformActOnPartnership`).
 * Logs carry ids only.
 */
import { db } from "./db";
import { ORDINARY_MEMBER_WHERE } from "@/lib/guest-membership";
import { sendAdminNotice } from "./admin-channel";
import { recordMatchTimeQuestion } from "./admin-group-log";
import { servingClubWhere } from "./club-approval-state";
import { londonMidnight } from "./club-connect-rules";
import { t } from "./i18n/t";
import {
  PARTNER_REQUEST_EXPIRES_MS,
  REQUEST_DEFAULT_APPROVAL,
  canBlock,
  clubPositions,
  nearestMiles,
  pairingNoticeKey,
  planRequest,
  type RequestRefusal,
  PARTNER_ASK_CUTOFF_DEFAULT_HOURS,
  normalisePartnerAskWhen,
  parseAskTime,
  parseCutoffHours,
  parsePartnerApproval,
  parsePartnerAskWhen,
  PLATFORM_PAUSE,
  VENUE_REMINDER_EVERY_MS,
  autoAcceptOf,
  canChangeDiscoverySettings,
  hasGeocodedVenue,
  isDiscoverable,
  parseSwitch,
  planPartnershipAction,
  planPlatformAction,
  sideOf,
  venueLookupRunning,
  venueReminderDue,
  type PlatformAction,
  type ActionRefusal,
  type ClubRole,
  type PartnerApproval,
  type PartnerAskWhen,
  type PartnershipAction,
  type PartnershipSide,
  type PartnershipStatus,
} from "./club-partnership-rules";

/** Where a club's organisers manage their partner clubs. */
export const PARTNER_SETTINGS_PATH = "/admin/settings#partner-clubs";

/** One pairing as one club sees it. */
export interface PartnershipView {
  id: string;
  side: PartnershipSide;
  otherOrgId: string;
  otherOrgName: string;
  status: PartnershipStatus;
  partnerApproval: PartnerApproval;
  /** This club's owner has accepted. */
  weAccepted: boolean;
  /** The other club's owner has accepted. */
  theyAccepted: boolean;
  /** Paused, and by which side, or by the MatchTime team (P5). */
  pausedBy: "us" | "them" | "platform" | null;
  /** P3: "request" when one club asked the other, "owner" for the
   *  platform owner's older pairings. */
  origin: "owner" | "request";
  /** P3: for a pairing that lets the other club ask us, whether we may
   *  already ask them (or have asked): the "ask them too" button hides. */
  reverseOpen: boolean;
}

/** A club's pairings in either direction, except ended ones. */
export async function loadPartnershipsForOrg(orgId: string): Promise<PartnershipView[]> {
  const rows = await db.clubPartnership.findMany({
    where: { OR: [{ askerOrgId: orgId }, { partnerOrgId: orgId }], status: { not: "ended" } },
    orderBy: { createdAt: "asc" },
    include: { askerOrg: { select: { name: true } }, partnerOrg: { select: { name: true } } },
  });
  // The clubs we may ask, or have asked (any pairing not ended).
  const weAsk = new Set(rows.filter((r) => r.askerOrgId === orgId).map((r) => r.partnerOrgId));
  return rows.map((r) => {
    const side = r.askerOrgId === orgId ? "asker" : "partner";
    return {
      origin: r.origin === "request" ? "request" : "owner",
      reverseOpen: side === "partner" ? weAsk.has(r.askerOrgId) : true,
      id: r.id,
      side,
      otherOrgId: side === "asker" ? r.partnerOrgId : r.askerOrgId,
      otherOrgName: side === "asker" ? r.partnerOrg.name : r.askerOrg.name,
      status: r.status as PartnershipStatus,
      partnerApproval: parsePartnerApproval(r.partnerApproval) ?? "each-ask",
      weAccepted: !!(side === "asker" ? r.askerAcceptedAt : r.partnerAcceptedAt),
      theyAccepted: !!(side === "asker" ? r.partnerAcceptedAt : r.askerAcceptedAt),
      pausedBy:
        r.status === "paused" && r.pausedByOrgId
          ? r.pausedByOrgId === PLATFORM_PAUSE
            ? "platform"
            : r.pausedByOrgId === orgId
              ? "us"
              : "them"
          : null,
    };
  });
}

/** Every pairing on the platform, for the owner's page. */
export async function loadAllPartnerships() {
  return db.clubPartnership.findMany({
    orderBy: { createdAt: "desc" },
    include: { askerOrg: { select: { name: true } }, partnerOrg: { select: { name: true } } },
  });
}

export type ActResult = { ok: true; status: PartnershipStatus } | { ok: false; refusal: ActionRefusal | "not-found" | "changed" };

/**
 * One club's organiser accepts, declines, pauses, resumes or removes a
 * pairing. The caller has proven the user's role in `orgId`. The update is
 * a compare-and-set on the status read, so two organisers pressing at once
 * cannot both win.
 */
export async function actOnPartnership(args: {
  partnershipId: string;
  orgId: string;
  userId: string;
  role: ClubRole;
  action: PartnershipAction;
  /** Accepting as the partner side: its per-ask choice (P3). */
  approval?: PartnerApproval;
  now?: Date;
}): Promise<ActResult> {
  const now = args.now ?? new Date();
  const row = await db.clubPartnership.findUnique({ where: { id: args.partnershipId } });
  if (!row || !sideOf(row, args.orgId)) return { ok: false, refusal: "not-found" };
  const approval = args.approval === undefined ? undefined : (parsePartnerApproval(args.approval) ?? undefined);
  const plan = planPartnershipAction(row, { orgId: args.orgId, role: args.role, action: args.action, userId: args.userId, now, approval });
  if (!plan.ok) return plan;
  const done = await db.clubPartnership.updateMany({
    where: {
      id: row.id,
      status: row.status,
      // Accepting is decided on the other side's acceptance as read; a
      // concurrent acceptance changes it and this one retries.
      askerAcceptedAt: row.askerAcceptedAt,
      partnerAcceptedAt: row.partnerAcceptedAt,
    },
    data: plan.patch,
  });
  if (done.count === 0) return { ok: false, refusal: "changed" };
  const status = (plan.patch.status ?? row.status) as PartnershipStatus;
  console.log(`[partner-clubs] pairing ${row.id}: ${args.action} by ${args.orgId}, now ${status}`);
  // A request answered by the club it went to (P3): the asking club is
  // told either way, and the owners when an admin accepted (D-2). A
  // failure to queue a notice never undoes the answer.
  if (row.origin === "request" && row.partnerOrgId === args.orgId && (args.action === "accept" || args.action === "decline")) {
    await tellRequestAnswered({ row, action: args.action, status, userId: args.userId, role: args.role, now }).catch((err) =>
      console.error(`[partner-clubs] pairing ${row.id}: answer notices not queued: ${(err as Error)?.name ?? "error"}`),
    );
  }
  return { ok: true, status };
}

/** The partner side chooses how its organisers approve an ask (D3). */
export async function setPartnerApproval(args: {
  partnershipId: string;
  orgId: string;
  value: unknown;
}): Promise<{ ok: true; value: PartnerApproval } | { ok: false; refusal: "bad-value" | "not-partner" }> {
  const value = parsePartnerApproval(args.value);
  if (!value) return { ok: false, refusal: "bad-value" };
  const done = await db.clubPartnership.updateMany({
    where: { id: args.partnershipId, partnerOrgId: args.orgId, status: { not: "ended" } },
    data: { partnerApproval: value },
  });
  if (done.count === 0) return { ok: false, refusal: "not-partner" };
  return { ok: true, value };
}

export interface PartnerAskSettings {
  when: PartnerAskWhen;
  /** "HH:MM", or null for the default. */
  time: string | null;
  cutoffHours: number;
}

export async function loadPartnerAskSettings(orgId: string): Promise<PartnerAskSettings | null> {
  const org = await db.organisation.findUnique({
    where: { id: orgId },
    select: { partnerAskWhen: true, partnerAskTime: true, partnerAskCutoffHours: true },
  });
  if (!org) return null;
  return {
    when: normalisePartnerAskWhen(org.partnerAskWhen),
    time: parseAskTime(org.partnerAskTime),
    cutoffHours: parseCutoffHours(org.partnerAskCutoffHours) ?? PARTNER_ASK_CUTOFF_DEFAULT_HOURS,
  };
}

/**
 * The asking club's settings (D4, D12). Each field is checked; a bad one
 * refuses the whole save and nothing is written. The keys join
 * `settingsSetByOrganiser`, like every setting saved on the page.
 */
export async function savePartnerAskSettings(
  orgId: string,
  patch: { when?: unknown; time?: unknown; cutoffHours?: unknown },
): Promise<{ ok: true; settings: PartnerAskSettings } | { ok: false; refusal: "bad-when" | "bad-time" | "bad-cutoff" | "no-club" }> {
  const data: { partnerAskWhen?: string; partnerAskTime?: string; partnerAskCutoffHours?: number } = {};
  const keys: string[] = [];
  if (patch.when !== undefined) {
    const when = parsePartnerAskWhen(patch.when);
    if (!when) return { ok: false, refusal: "bad-when" };
    data.partnerAskWhen = when;
    keys.push("partnerAskWhen");
  }
  if (patch.time !== undefined) {
    const time = parseAskTime(patch.time);
    if (!time) return { ok: false, refusal: "bad-time" };
    data.partnerAskTime = time;
    keys.push("partnerAskTime");
  }
  if (patch.cutoffHours !== undefined) {
    const hours = parseCutoffHours(patch.cutoffHours);
    if (hours === null) return { ok: false, refusal: "bad-cutoff" };
    data.partnerAskCutoffHours = hours;
    keys.push("partnerAskCutoffHours");
  }
  if (keys.length > 0) {
    await db.organisation.update({ where: { id: orgId }, data: { ...data, settingsSetByOrganiser: { push: keys } } });
  }
  const settings = await loadPartnerAskSettings(orgId);
  return settings ? { ok: true, settings } : { ok: false, refusal: "no-club" };
}

/**
 * The platform owner pauses, resumes or ends a pairing (P5, D-6). The
 * caller has proven the user is a superadmin. A compare-and-set on the
 * status read, like a club's own action. Nobody is messaged: an override
 * for abuse or support.
 */
export async function platformActOnPartnership(args: {
  partnershipId: string;
  action: PlatformAction;
  now?: Date;
}): Promise<ActResult> {
  const now = args.now ?? new Date();
  const row = await db.clubPartnership.findUnique({ where: { id: args.partnershipId } });
  if (!row) return { ok: false, refusal: "not-found" };
  const plan = planPlatformAction(row, { action: args.action, now });
  if (!plan.ok) return plan;
  const done = await db.clubPartnership.updateMany({ where: { id: row.id, status: row.status }, data: plan.patch });
  if (done.count === 0) return { ok: false, refusal: "changed" };
  const status = (plan.patch.status ?? row.status) as PartnershipStatus;
  console.log(`[partner-clubs] pairing ${row.id}: ${args.action} by the platform owner, now ${status}`);
  return { ok: true, status };
}

// ─── Partner discovery (slice P1, 2026-10-22) ─────────────────────────────

export interface DiscoverySettings {
  /** "Let nearby clubs find us and send requests". */
  discoverable: boolean;
  /** "Accept partner requests automatically". */
  autoAccept: boolean;
  /** "Share our players' ratings with partner clubs" (2026-10-22). */
  shareRatings: boolean;
}

const DISCOVERY_SELECT = { discoverable: true, autoAcceptPartnerRequests: true, sharePlayerRatingsWithPartners: true } as const;

export async function loadDiscoverySettings(orgId: string): Promise<DiscoverySettings | null> {
  const org = await db.organisation.findUnique({ where: { id: orgId }, select: DISCOVERY_SELECT });
  if (!org) return null;
  return { discoverable: isDiscoverable(org), autoAccept: autoAcceptOf(org), shareRatings: org.sharePlayerRatingsWithPartners === true };
}

/**
 * An owner or admin changes either setting. The role is checked here too
 * (the action has proven it), a value that is not a real on or off refuses
 * the whole save, and a change to `discoverable` records who and when.
 */
export async function saveDiscoverySettings(args: {
  orgId: string;
  userId: string;
  role: ClubRole;
  patch: { discoverable?: unknown; autoAccept?: unknown; shareRatings?: unknown };
  now?: Date;
}): Promise<{ ok: true; settings: DiscoverySettings } | { ok: false; refusal: "not-admin" | "bad-value" | "no-club" }> {
  if (!canChangeDiscoverySettings(args.role)) return { ok: false, refusal: "not-admin" };
  const now = args.now ?? new Date();
  const data: {
    discoverable?: boolean;
    discoverableAt?: Date;
    discoverableById?: string;
    autoAcceptPartnerRequests?: boolean;
    sharePlayerRatingsWithPartners?: boolean;
  } = {};
  const keys: string[] = [];
  if (args.patch.discoverable !== undefined) {
    const on = parseSwitch(args.patch.discoverable);
    if (on === null) return { ok: false, refusal: "bad-value" };
    Object.assign(data, { discoverable: on, discoverableAt: now, discoverableById: args.userId });
    keys.push("discoverable");
  }
  if (args.patch.autoAccept !== undefined) {
    const on = parseSwitch(args.patch.autoAccept);
    if (on === null) return { ok: false, refusal: "bad-value" };
    data.autoAcceptPartnerRequests = on;
    keys.push("autoAcceptPartnerRequests");
  }
  if (args.patch.shareRatings !== undefined) {
    const on = parseSwitch(args.patch.shareRatings);
    if (on === null) return { ok: false, refusal: "bad-value" };
    data.sharePlayerRatingsWithPartners = on;
    keys.push("sharePlayerRatingsWithPartners");
  }
  if (keys.length > 0) {
    await db.organisation.update({ where: { id: args.orgId }, data: { ...data, settingsSetByOrganiser: { push: keys } } });
    console.log(`[partner-clubs] org ${args.orgId}: discovery settings saved (${keys.join(", ")}) by ${args.userId}`);
  }
  const settings = await loadDiscoverySettings(args.orgId);
  return settings ? { ok: true, settings } : { ok: false, refusal: "no-club" };
}

/** Where the venue lookup sits on the settings page (the reminder's link). */
export const CLUB_VENUE_SETTINGS_PATH = "/admin/settings#club-venue";

/** What a club's venue status needs, read in one query. */
const VENUE_STATUS_SELECT = {
  id: true,
  name: true,
  language: true,
  venueReminderSentAt: true,
  homeVenue: { select: { name: true, formattedAddress: true, lat: true, lng: true } },
  activities: {
    where: { isActive: true },
    orderBy: { createdAt: "asc" },
    select: {
      isActive: true,
      venueLookupStatus: true,
      venueResolvedAt: true,
      venueRef: { select: { name: true, lat: true, lng: true } },
    },
  },
} as const;

interface VenueStatusRow {
  id: string;
  name: string;
  language: string;
  venueReminderSentAt: Date | null;
  homeVenue: { name: string; formattedAddress: string | null; lat: number | null; lng: number | null } | null;
  activities: Array<{
    isActive: boolean;
    venueLookupStatus: string | null;
    venueResolvedAt: Date | null;
    venueRef: { name: string; lat: number | null; lng: number | null } | null;
  }>;
}

const hasVenueOf = (o: VenueStatusRow) =>
  hasGeocodedVenue({ homeVenue: o.homeVenue, games: o.activities.map((a) => ({ isActive: a.isActive, venue: a.venueRef })) });

export interface ClubVenueStatus {
  /** An active game's venue or the home venue has a position. */
  hasVenue: boolean;
  homeVenue: { name: string; address: string | null } | null;
  /** The first active game's geocoded venue, if any. */
  gameVenue: { name: string } | null;
}

/** For the settings page: does the club have a venue nearby clubs can find? */
export async function loadClubVenueStatus(orgId: string): Promise<ClubVenueStatus | null> {
  const org: VenueStatusRow | null = await db.organisation.findUnique({ where: { id: orgId }, select: VENUE_STATUS_SELECT });
  if (!org) return null;
  const game = org.activities.find((a) => a.isActive && a.venueRef && a.venueRef.lat !== null && a.venueRef.lng !== null);
  const home = org.homeVenue && org.homeVenue.lat !== null && org.homeVenue.lng !== null ? org.homeVenue : null;
  return {
    hasVenue: hasVenueOf(org),
    homeVenue: home ? { name: home.name, address: home.formattedAddress } : null,
    gameVenue: game?.venueRef ? { name: game.venueRef.name } : null,
  };
}

/**
 * The clubs the reminder is for: live (approved, not dormant, served, in
 * its players' group with MatchTime switched on). A muted or billing-paused
 * club is not reminded: its notices would not go out until it is back, and
 * then all at once.
 */
function remindableClubWhere() {
  return { ...servingClubWhere(), dormantAt: null, whatsappGroupId: { not: null }, whatsappBotEnabled: true };
}

export type VenueReminderOutcome = "sent" | "not-due" | "already";

/**
 * THE WEEKLY VENUE REMINDER (plan 2.1, Kemal 2026-10-22). One notice to a
 * live club's owners and admins, through the club's admin channel
 * (`sendAdminNotice`, which holds it through the club's quiet hours), with
 * each admin's own signed-in link straight to the venue lookup on the
 * settings page. At most once a week, never to a club with a venue, so it
 * stops for good once one is set.
 *
 * EXACTLY ONCE A WEEK, whoever races whom: the claim is a compare-and-set
 * of `venueReminderSentAt` against the value this run read. Of two runs
 * that read the same stamp, Postgres lets one UPDATE match; the other
 * matches nothing (its WHERE is re-checked after the first commits) and
 * sends nothing. The stamp is durable, so a restart changes nothing. If
 * the notice cannot be queued, the claim is put back for the next run.
 */
export async function sendVenueReminder(orgId: string, now: Date = new Date()): Promise<VenueReminderOutcome> {
  const org: VenueStatusRow | null = await db.organisation.findFirst({ where: { id: orgId, ...remindableClubWhere() }, select: VENUE_STATUS_SELECT });
  if (!org) return "not-due";
  const due = venueReminderDue({
    hasVenue: hasVenueOf(org),
    lastSentAt: org.venueReminderSentAt,
    lookupRunning: venueLookupRunning(org.activities, now),
    now,
  });
  if (!due) return "not-due";

  const claim = await db.organisation.updateMany({
    where: { id: orgId, venueReminderSentAt: org.venueReminderSentAt },
    data: { venueReminderSentAt: now },
  });
  if (claim.count !== 1) return "already";

  const s = t(org.language);
  try {
    const sent = await sendAdminNotice({
      orgId,
      now,
      nextPath: CLUB_VENUE_SETTINGS_PATH,
      text: (link) => s.pd_venue_reminder_dm({ club: org.name, link }),
    });
    console.log(`[partner-clubs] org ${orgId}: venue reminder queued (${sent.channel}, ${sent.queued})`);
  } catch (err) {
    // Put the claim back, so the next run sends it.
    await db.organisation
      .updateMany({ where: { id: orgId, venueReminderSentAt: now }, data: { venueReminderSentAt: org.venueReminderSentAt } })
      .catch(() => undefined);
    throw err;
  }
  return "sent";
}

/**
 * The daily cron's half (`/api/cron/venue-reminder`): every live club not
 * reminded in the last week. Each club is decided, claimed and sent by
 * `sendVenueReminder`; a failure on one never stops the others.
 */
export async function runVenueReminderSweep(now: Date = new Date()): Promise<{ considered: number; sent: number }> {
  const weekAgo = new Date(now.getTime() - VENUE_REMINDER_EVERY_MS);
  const candidates = await db.organisation.findMany({
    where: {
      ...remindableClubWhere(),
      OR: [{ venueReminderSentAt: null }, { venueReminderSentAt: { lte: weekAgo } }],
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  let sent = 0;
  for (const c of candidates) {
    try {
      if ((await sendVenueReminder(c.id, now)) === "sent") sent++;
    } catch (err) {
      console.error(`[partner-clubs] org ${c.id}: venue reminder failed; the next run retries: ${(err as Error)?.name ?? "error"}`);
    }
  }
  return { considered: candidates.length, sent };
}

// ─── Partner requests (slice P3, 2026-10-22) ──────────────────────────────
// Plan: MDs/partner-discovery-plan-2026-10-21.md, sections 3.1 to 3.5.

/** Where the asking club finds clubs near it (P2's page). */
export const FIND_CLUBS_PATH = "/admin/partners/find";

/** The settings page with the one-tap "ask them too" for one pairing
 *  highlighted (D-1). The link only opens the page: the organiser's tap on
 *  the button is the request, never the link itself (a link preview or a
 *  forwarded message must not send a request). */
export function askTooPath(partnershipId: string): string {
  return `/admin/settings?askToo=${encodeURIComponent(partnershipId)}#partner-clubs`;
}

export type RequestOutcome =
  | { partnerOrgId: string; partnerName: string | null; outcome: "sent" | "active" }
  | { partnerOrgId: string; partnerName: string | null; outcome: "refused"; refusal: RequestRefusal };

export interface RequestResult {
  results: RequestOutcome[];
  /** How many went (sent, or accepted at once). */
  sent: number;
  /** The day's 20 stopped part of the selection: "sent the nearest N". */
  capped: boolean;
}

/** At most this many clubs in one send (a select-all on the 10-mile page). */
const MAX_IDS_PER_SEND = 500;

const POSITION = { lat: true, lng: true } as const;
const CARD_CLUB_SELECT = {
  id: true,
  name: true,
  language: true,
  discoverable: true,
  autoAcceptPartnerRequests: true,
  approvalStatus: true,
  homeVenue: { select: POSITION },
  activities: {
    where: { isActive: true },
    orderBy: { createdAt: "asc" },
    select: { isActive: true, dayOfWeek: true, time: true, venueRef: { select: POSITION }, sport: { select: { playersPerTeam: true } } },
  },
} as const;

interface CardClub {
  id: string;
  name: string;
  language: string;
  discoverable: boolean;
  autoAcceptPartnerRequests: boolean;
  approvalStatus: string;
  homeVenue: { lat: number | null; lng: number | null } | null;
  activities: Array<{
    isActive: boolean;
    dayOfWeek: number;
    time: string;
    venueRef: { lat: number | null; lng: number | null } | null;
    sport: { playersPerTeam: number } | null;
  }>;
}

const positionsOf = (c: CardClub) =>
  clubPositions({ homeVenue: c.homeVenue, games: c.activities.map((a) => ({ isActive: a.isActive, venue: a.venueRef })) });

/**
 * What B is told about A (plan 2.3), in B's language: the distance, each
 * active game (day, kickoff, format) and the member count. Never a
 * person's name, a phone number, a group or a rating.
 */
function requestCard(asker: CardClub, members: number, partner: CardClub): string {
  const s = t(partner.language);
  const parts: string[] = [];
  const miles = nearestMiles(positionsOf(asker), positionsOf(partner));
  if (miles !== null) parts.push(s.pr_card_miles({ miles }));
  const games = asker.activities.filter((a) => a.isActive);
  if (games.length === 0) parts.push(s.pr_card_no_game);
  for (const g of games) {
    const perSide = g.sport?.playersPerTeam;
    parts.push(s.pr_card_game({ dow: g.dayOfWeek, time: g.time, format: perSide ? s.sj_per_side_option({ perSide }) : null }));
  }
  parts.push(s.pr_card_members({ count: members }));
  return parts.join(", ");
}

/** Live, non-guest members: what the card counts (plan 2.3). */
function memberCount(orgId: string): Promise<number> {
  return db.membership.count({ where: { orgId, leftAt: null, ...ORDINARY_MEMBER_WHERE } });
}

/**
 * CLUB A ASKS ONE OR MORE CLUBS TO BECOME PARTNER CLUBS (plan 3.1). One
 * `ClubPartnership` row per club, A asking B, with A's acceptance on it
 * from the start: A's request is A's consent. The caller has proven the
 * user's role in A; the pure `planRequest` decides each club.
 *
 * `partnerOrgIds` come in the order the search page lists them, nearest
 * first, so a "select all" past the day's 20 sends the nearest 20 and the
 * rest are refused "daily-cap" (`capped`).
 *
 * THE CAPS, ATOMICALLY: the day's count and the pending count are read
 * again, and every row written, inside ONE transaction holding a
 * transaction-scoped advisory lock per asking club. Two organisers of A
 * pressing Send at once run one after the other, so 19 sent plus two at
 * once is exactly 20.
 *
 * A club with "Accept partner requests automatically" on becomes active at
 * once. The notices go after the commit: B's organisers get the request
 * (tagged for a WhatsApp reply 1 or 2), or are told who joined.
 */
export async function requestPartnerships(args: {
  askerOrgId: string;
  userId: string;
  role: ClubRole;
  partnerOrgIds: string[];
  now?: Date;
}): Promise<RequestResult> {
  const now = args.now ?? new Date();
  const ids = [...new Set(args.partnerOrgIds.filter((x): x is string => typeof x === "string" && x.length > 0))].slice(0, MAX_IDS_PER_SEND);
  const refuseAll = (refusal: RequestRefusal): RequestResult => ({
    results: ids.map((partnerOrgId) => ({ partnerOrgId, partnerName: null, outcome: "refused", refusal })),
    sent: 0,
    capped: false,
  });
  if (ids.length === 0) return { results: [], sent: 0, capped: false };
  if (args.role !== "OWNER" && args.role !== "ADMIN") return refuseAll("not-admin");

  const asker = (await db.organisation.findUnique({ where: { id: args.askerOrgId }, select: CARD_CLUB_SELECT })) as CardClub | null;
  if (!asker) return refuseAll("no-club");
  const others = ids.filter((id) => id !== asker.id);
  const [partners, theirRows, blocks] = await Promise.all([
    db.organisation.findMany({ where: { id: { in: others } }, select: CARD_CLUB_SELECT }) as Promise<CardClub[]>,
    db.clubPartnership.findMany({
      where: { askerOrgId: { in: others }, partnerOrgId: asker.id, status: { in: ["active", "paused"] } },
      select: { askerOrgId: true },
    }),
    db.clubBlock.findMany({
      where: { OR: [{ blockerOrgId: asker.id, blockedOrgId: { in: others } }, { blockerOrgId: { in: others }, blockedOrgId: asker.id }] },
      select: { blockerOrgId: true, blockedOrgId: true },
    }),
  ]);
  const byId = new Map(partners.map((p) => [p.id, p]));
  const theyMayAskUs = new Set(theirRows.map((r) => r.askerOrgId));
  const blocked = new Set(blocks.map((b) => (b.blockerOrgId === asker.id ? b.blockedOrgId : b.blockerOrgId)));
  const since = londonMidnight(now);
  const expiresAt = new Date(now.getTime() + PARTNER_REQUEST_EXPIRES_MS);

  const written = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`club-request:${asker.id}`}))`;
    let sentToday = await tx.clubPartnership.count({ where: { askerOrgId: asker.id, origin: "request", askerAcceptedAt: { gte: since } } });
    let pending = await tx.clubPartnership.count({ where: { askerOrgId: asker.id, origin: "request", status: "proposed" } });
    const mine = await tx.clubPartnership.findMany({
      where: { askerOrgId: asker.id, partnerOrgId: { in: others } },
      select: { id: true, partnerOrgId: true, status: true, endReason: true, endedAt: true, endedByOrgId: true },
    });
    const existingFor = new Map(mine.map((r) => [r.partnerOrgId, r]));
    const out: Array<RequestOutcome & { id?: string }> = [];
    for (const partnerOrgId of ids) {
      const partner = byId.get(partnerOrgId) ?? null;
      const existing = existingFor.get(partnerOrgId) ?? null;
      const plan = planRequest({
        askerOrgId: asker.id,
        partnerOrgId,
        role: args.role,
        askerDiscoverable: isDiscoverable(asker),
        partner: partner ? { approved: partner.approvalStatus === "approved", discoverable: isDiscoverable(partner) } : null,
        theyMayAskUs: theyMayAskUs.has(partnerOrgId),
        existing,
        blocked: blocked.has(partnerOrgId),
        sentToday,
        pending,
        now,
      });
      const partnerName = partner?.name ?? null;
      if (!plan.ok) {
        out.push({ partnerOrgId, partnerName, outcome: "refused", refusal: plan.refusal });
        continue;
      }
      const auto = autoAcceptOf(partner!);
      const data = {
        status: auto ? "active" : "proposed",
        origin: "request",
        partnerApproval: REQUEST_DEFAULT_APPROVAL,
        askerAcceptedAt: now,
        askerAcceptedBy: args.userId,
        partnerAcceptedAt: auto ? now : null,
        partnerAcceptedBy: null,
        pausedByOrgId: null,
        createdByUserId: args.userId,
        expiresAt: auto ? null : expiresAt,
        endedAt: null,
        endedByOrgId: null,
        endReason: null,
      };
      let id: string;
      if (plan.mode === "create") {
        id = (await tx.clubPartnership.create({ data: { askerOrgId: asker.id, partnerOrgId, ...data }, select: { id: true } })).id;
      } else {
        const reopened = await tx.clubPartnership.updateMany({ where: { id: existing!.id, status: "ended" }, data });
        if (reopened.count === 0) {
          out.push({ partnerOrgId, partnerName, outcome: "refused", refusal: "already-pending" });
          continue;
        }
        id = existing!.id;
      }
      sentToday++;
      if (!auto) pending++;
      out.push({ partnerOrgId, partnerName, outcome: auto ? "active" : "sent", id });
    }
    return out;
  });

  const members = written.some((w) => w.outcome !== "refused") ? await memberCount(asker.id) : 0;
  for (const w of written) {
    if (w.outcome === "refused" || !w.id) continue;
    console.log(`[partner-clubs] pairing ${w.id}: ${asker.id} asks ${w.partnerOrgId} (${w.outcome})`);
    const partner = byId.get(w.partnerOrgId)!;
    try {
      if (w.outcome === "sent") await tellRequest({ id: w.id, asker, members, partner, now });
      else await tellAutoAccepted({ asker, partner, now });
    } catch (err) {
      console.error(`[partner-clubs] pairing ${w.id}: request notices not queued: ${(err as Error)?.name ?? "error"}`);
    }
  }
  const results: RequestOutcome[] = written.map((w) =>
    w.outcome === "refused"
      ? { partnerOrgId: w.partnerOrgId, partnerName: w.partnerName, outcome: "refused", refusal: w.refusal }
      : { partnerOrgId: w.partnerOrgId, partnerName: w.partnerName, outcome: w.outcome },
  );
  const sent = results.filter((r) => r.outcome !== "refused").length;
  return { results, sent, capped: results.some((r) => r.outcome === "refused" && r.refusal === "daily-cap") };
}

/** B's organisers are asked (plan 3.1), tagged so a WhatsApp reply 1 or 2
 *  or a ✅ on it finds this pairing and this club (`pairing-reply.ts`). */
async function tellRequest(a: { id: string; asker: CardClub; members: number; partner: CardClub; now: Date }) {
  const s = t(a.partner.language);
  const aboutKey = pairingNoticeKey(a.id, a.partner.id);
  const card = requestCard(a.asker, a.members, a.partner);
  const sent = await sendAdminNotice({
    orgId: a.partner.id,
    now: a.now,
    nextPath: PARTNER_SETTINGS_PATH,
    aboutKey,
    text: (link, audience) => s.pr_request_notice({ asker: a.asker.name, club: a.partner.name, card, link, inGroup: audience === "group" }),
  });
  if (sent.channel === "admin-group" && sent.groupText) {
    await recordMatchTimeQuestion({ orgId: a.partner.id, askRef: aboutKey, text: sent.groupText, now: a.now });
  }
}

/** Auto-accept on: B's organisers are told who joined, A that it was accepted. */
async function tellAutoAccepted(a: { asker: CardClub; partner: CardClub; now: Date }) {
  const sp = t(a.partner.language);
  await sendAdminNotice({
    orgId: a.partner.id,
    now: a.now,
    nextPath: PARTNER_SETTINGS_PATH,
    text: (link) => sp.pr_auto_joined_notice({ asker: a.asker.name, club: a.partner.name, link }),
  });
  await sendAdminNotice({
    orgId: a.asker.id,
    now: a.now,
    text: t(a.asker.language).pr_accepted_notice({ partner: a.partner.name, club: a.asker.name }),
  });
}

/** B answered A's request (plan 3.2): A is told, and B's owners when one
 *  of its admins accepted (D-2), the accepter excepted. */
async function tellRequestAnswered(a: {
  row: { askerOrgId: string; partnerOrgId: string };
  action: "accept" | "decline";
  status: PartnershipStatus;
  userId: string;
  role: ClubRole;
  now: Date;
}) {
  const [asker, partner] = await Promise.all([
    db.organisation.findUnique({ where: { id: a.row.askerOrgId }, select: { id: true, name: true, language: true } }),
    db.organisation.findUnique({ where: { id: a.row.partnerOrgId }, select: { id: true, name: true, language: true } }),
  ]);
  if (!asker || !partner) return;
  const sa = t(asker.language);
  if (a.action === "decline") {
    await sendAdminNotice({ orgId: asker.id, now: a.now, text: sa.pr_declined_notice({ partner: partner.name }) });
    return;
  }
  if (a.status !== "active") return;
  await sendAdminNotice({ orgId: asker.id, now: a.now, text: sa.pr_accepted_notice({ partner: partner.name, club: asker.name }) });
  if (a.role === "ADMIN") {
    const sp = t(partner.language);
    const user = await db.user.findUnique({ where: { id: a.userId }, select: { name: true } });
    await sendAdminNotice({
      orgId: partner.id,
      now: a.now,
      nextPath: PARTNER_SETTINGS_PATH,
      excludeUserId: a.userId,
      text: (link) => sp.pr_admin_accepted_notice({ name: user?.name?.trim() || sp.pr_an_admin, asker: asker.name, club: partner.name, link }),
    });
  }
}

/** The asking club takes back a pending request (plan 3.4). B hears
 *  nothing; the request simply leaves its list. */
export function withdrawRequest(args: { partnershipId: string; orgId: string; userId: string; role: ClubRole; now?: Date }): Promise<ActResult> {
  return actOnPartnership({ ...args, action: "withdraw" });
}

export type BlockResult = { ok: true } | { ok: false; refusal: "not-admin" | "same-club" | "no-club" };

/**
 * Club B blocks club A (plan 3.4): A can never send B a request, B
 * disappears from A's nearby list (P2 reads `ClubBlock`), and any pairing
 * that lets A ask B ends as "blocked". Blocking twice is the same as once.
 * Nobody is messaged.
 */
export async function blockClub(args: { blockerOrgId: string; blockedOrgId: string; userId: string; role: ClubRole; now?: Date }): Promise<BlockResult> {
  const can = canBlock(args);
  if (!can.ok) return can;
  const now = args.now ?? new Date();
  const other = await db.organisation.findUnique({ where: { id: args.blockedOrgId }, select: { id: true } });
  if (!other) return { ok: false, refusal: "no-club" };
  try {
    await db.clubBlock.create({ data: { blockerOrgId: args.blockerOrgId, blockedOrgId: args.blockedOrgId, createdByUserId: args.userId } });
  } catch (err) {
    if ((err as { code?: string })?.code !== "P2002") throw err;
  }
  const ended = await db.clubPartnership.updateMany({
    where: { askerOrgId: args.blockedOrgId, partnerOrgId: args.blockerOrgId, status: { not: "ended" } },
    data: { status: "ended", pausedByOrgId: null, endedAt: now, endedByOrgId: args.blockerOrgId, endReason: "blocked" },
  });
  console.log(`[partner-clubs] org ${args.blockerOrgId} blocked ${args.blockedOrgId} (${ended.count} pairing ended) by ${args.userId}`);
  return { ok: true };
}

export async function unblockClub(args: { blockerOrgId: string; blockedOrgId: string; role: ClubRole }): Promise<{ ok: true } | { ok: false; refusal: "not-admin" }> {
  if (args.role !== "OWNER" && args.role !== "ADMIN") return { ok: false, refusal: "not-admin" };
  await db.clubBlock.deleteMany({ where: { blockerOrgId: args.blockerOrgId, blockedOrgId: args.blockedOrgId } });
  console.log(`[partner-clubs] org ${args.blockerOrgId} unblocked ${args.blockedOrgId}`);
  return { ok: true };
}

/** The clubs this club blocked, for the settings page's block list. */
export async function loadBlockedClubs(orgId: string): Promise<Array<{ orgId: string; name: string }>> {
  const rows = await db.clubBlock.findMany({
    where: { blockerOrgId: orgId },
    orderBy: { createdAt: "asc" },
    select: { blockedOrgId: true, blockedOrg: { select: { name: true } } },
  });
  return rows.map((r) => ({ orgId: r.blockedOrgId, name: r.blockedOrg.name }));
}

/**
 * THE DAILY EXPIRY SWEEP (`/api/cron/partner-requests`): every request
 * still pending 14 days after it was sent ends as "expired", and the
 * asking club is told ONCE. The claim is a compare-and-set on the row as
 * read (still proposed, same expiry), so two sweeps at once, or a sweep
 * racing an acceptance, end it at most once and tell A at most once.
 */
export async function runPartnerRequestExpirySweep(now: Date = new Date()): Promise<{ considered: number; expired: number }> {
  const due = await db.clubPartnership.findMany({
    where: { status: "proposed", origin: "request", expiresAt: { lte: now } },
    orderBy: { createdAt: "asc" },
    include: { askerOrg: { select: { name: true, language: true } }, partnerOrg: { select: { name: true } } },
  });
  let expired = 0;
  for (const r of due) {
    try {
      const claim = await db.clubPartnership.updateMany({
        where: { id: r.id, status: "proposed", expiresAt: r.expiresAt },
        data: { status: "ended", pausedByOrgId: null, endedAt: now, endedByOrgId: null, endReason: "expired" },
      });
      if (claim.count !== 1) continue;
      expired++;
      console.log(`[partner-clubs] pairing ${r.id}: request expired`);
      const s = t(r.askerOrg.language);
      await sendAdminNotice({
        orgId: r.askerOrgId,
        now,
        nextPath: FIND_CLUBS_PATH,
        text: (link) => s.pr_expired_notice({ partner: r.partnerOrg.name, link }),
      });
    } catch (err) {
      console.error(`[partner-clubs] pairing ${r.id}: expiry failed; the next run retries: ${(err as Error)?.name ?? "error"}`);
    }
  }
  return { considered: due.length, expired };
}
