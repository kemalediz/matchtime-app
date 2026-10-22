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
import { sendAdminNotice } from "./admin-channel";
import { servingClubWhere } from "./club-approval-state";
import { t } from "./i18n/t";
import {
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
}

/** A club's pairings in either direction, except ended ones. */
export async function loadPartnershipsForOrg(orgId: string): Promise<PartnershipView[]> {
  const rows = await db.clubPartnership.findMany({
    where: { OR: [{ askerOrgId: orgId }, { partnerOrgId: orgId }], status: { not: "ended" } },
    orderBy: { createdAt: "asc" },
    include: { askerOrg: { select: { name: true } }, partnerOrg: { select: { name: true } } },
  });
  return rows.map((r) => {
    const side = r.askerOrgId === orgId ? "asker" : "partner";
    return {
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
  now?: Date;
}): Promise<ActResult> {
  const now = args.now ?? new Date();
  const row = await db.clubPartnership.findUnique({ where: { id: args.partnershipId } });
  if (!row || !sideOf(row, args.orgId)) return { ok: false, refusal: "not-found" };
  const plan = planPartnershipAction(row, { orgId: args.orgId, role: args.role, action: args.action, userId: args.userId, now });
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
}

const DISCOVERY_SELECT = { discoverable: true, autoAcceptPartnerRequests: true } as const;

export async function loadDiscoverySettings(orgId: string): Promise<DiscoverySettings | null> {
  const org = await db.organisation.findUnique({ where: { id: orgId }, select: DISCOVERY_SELECT });
  if (!org) return null;
  return { discoverable: isDiscoverable(org), autoAccept: autoAcceptOf(org) };
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
  patch: { discoverable?: unknown; autoAccept?: unknown };
  now?: Date;
}): Promise<{ ok: true; settings: DiscoverySettings } | { ok: false; refusal: "not-admin" | "bad-value" | "no-club" }> {
  if (!canChangeDiscoverySettings(args.role)) return { ok: false, refusal: "not-admin" };
  const now = args.now ?? new Date();
  const data: { discoverable?: boolean; discoverableAt?: Date; discoverableById?: string; autoAcceptPartnerRequests?: boolean } = {};
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
