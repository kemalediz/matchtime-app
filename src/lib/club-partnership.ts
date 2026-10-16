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
 * Off by default: no club has a partner until the platform owner pairs two
 * clubs (D1), so nothing here runs for Sutton FC or anyone else until then.
 * Logs carry ids only.
 */
import { db } from "./db";
import { sendAdminNotice } from "./admin-channel";
import { t } from "./i18n/t";
import {
  PARTNER_ASK_CUTOFF_DEFAULT_HOURS,
  normalisePartnerAskWhen,
  parseAskTime,
  parseCutoffHours,
  parsePartnerApproval,
  parsePartnerAskWhen,
  planCreate,
  planPartnershipAction,
  sideOf,
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
  /** Paused, and by which side. */
  pausedBy: "us" | "them" | null;
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
      pausedBy: r.status === "paused" && r.pausedByOrgId ? (r.pausedByOrgId === orgId ? "us" : "them") : null,
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

export type CreateResult = { ok: true; id: string; reopened: boolean } | { ok: false; refusal: "same-club" | "exists" | "no-club" };

/**
 * The platform owner pairs two clubs, one direction (D1, D2). The caller
 * has proven the user is a superadmin. Both clubs' organisers are told,
 * each in its own language, and each club's owner then accepts or
 * declines on its settings page.
 */
export async function createPartnership(args: {
  creatorUserId: string;
  askerOrgId: string;
  partnerOrgId: string;
  now?: Date;
}): Promise<CreateResult> {
  const now = args.now ?? new Date();
  const [asker, partner, existing] = await Promise.all([
    db.organisation.findUnique({ where: { id: args.askerOrgId }, select: { id: true, name: true, language: true } }),
    db.organisation.findUnique({ where: { id: args.partnerOrgId }, select: { id: true, name: true, language: true } }),
    db.clubPartnership.findUnique({ where: { askerOrgId_partnerOrgId: { askerOrgId: args.askerOrgId, partnerOrgId: args.partnerOrgId } } }),
  ]);
  const plan = planCreate(existing, args.askerOrgId, args.partnerOrgId);
  if (!plan.ok) return plan;
  if (!asker || !partner) return { ok: false, refusal: "no-club" };

  let id: string;
  if (plan.mode === "create") {
    id = (
      await db.clubPartnership.create({
        data: { askerOrgId: asker.id, partnerOrgId: partner.id, createdByUserId: args.creatorUserId },
        select: { id: true },
      })
    ).id;
  } else {
    // An ended pair, proposed again: both acceptances needed afresh, and
    // the partner's approval back to its default.
    const reopened = await db.clubPartnership.updateMany({
      where: { id: existing!.id, status: "ended" },
      data: {
        status: "proposed",
        partnerApproval: "each-ask",
        askerAcceptedAt: null,
        askerAcceptedBy: null,
        partnerAcceptedAt: null,
        partnerAcceptedBy: null,
        pausedByOrgId: null,
        createdByUserId: args.creatorUserId,
      },
    });
    if (reopened.count === 0) return { ok: false, refusal: "exists" };
    id = existing!.id;
  }
  console.log(`[partner-clubs] pairing ${id}: ${asker.id} may ask ${partner.id} (${plan.mode})`);

  await Promise.all([
    sendAdminNotice({
      orgId: asker.id,
      now,
      nextPath: PARTNER_SETTINGS_PATH,
      text: (link) => t(asker.language).pc_paired_notice_asker({ club: asker.name, other: partner.name, link }),
    }),
    sendAdminNotice({
      orgId: partner.id,
      now,
      nextPath: PARTNER_SETTINGS_PATH,
      text: (link) => t(partner.language).pc_paired_notice_partner({ club: partner.name, other: asker.name, link }),
    }),
  ]).catch((err) => console.error(`[partner-clubs] pairing ${id}: notices not queued:`, err instanceof Error ? err.message : "failed"));

  return { ok: true, id, reopened: plan.mode === "reopen" };
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
