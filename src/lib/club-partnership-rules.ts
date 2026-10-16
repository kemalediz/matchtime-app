/**
 * PARTNER CLUBS, THE PURE RULES (cross-club ask, slice S1, 2026-10-16).
 * Plan: MDs/cross-club-player-ask-plan-2026-10-16.md, sections 3.1, 3.2
 * and 4; decisions D1, D2, D3 and D12 (section 0).
 *
 *   - One `ClubPartnership` row per direction: "FNF may ask Sutton FC" is
 *     not "Sutton FC may ask FNF" (D2).
 *   - Only the platform owner creates one (D1, `planCreate`).
 *   - An OWNER of each club accepts it for that club; it is "active" once
 *     both have. An owner of either side declines a proposal or removes a
 *     pairing ("ended"). An owner or admin of either side pauses it, and
 *     only the side that paused resumes it, so one club can never undo the
 *     other's pause.
 *   - The partner side alone chooses how its organisers approve an ask
 *     ("each-ask" or "standing", D3); the asking side alone chooses when it
 *     asks and its cut-off (D4, D12).
 *
 * Pure. No database, no model. The writer is `club-partnership.ts`.
 */

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

export type CreatePlan = { ok: true; mode: "create" | "reopen" } | { ok: false; refusal: "same-club" | "exists" };

/** The platform owner pairs two clubs, one direction. */
export function planCreate(existing: PartnershipRow | null, askerOrgId: string, partnerOrgId: string): CreatePlan {
  if (askerOrgId === partnerOrgId) return { ok: false, refusal: "same-club" };
  if (!existing) return { ok: true, mode: "create" };
  if (existing.status === "ended") return { ok: true, mode: "reopen" };
  return { ok: false, refusal: "exists" };
}

export type PartnershipAction = "accept" | "decline" | "pause" | "resume" | "end";

export type ActionRefusal =
  | "not-a-side"
  | "owner-only"
  | "admin-only"
  | "ended"
  | "not-proposed"
  | "already-accepted"
  | "not-active"
  | "not-paused"
  | "paused-by-other";

export interface PartnershipPatch {
  status?: PartnershipStatus;
  askerAcceptedAt?: Date;
  askerAcceptedBy?: string;
  partnerAcceptedAt?: Date;
  partnerAcceptedBy?: string;
  pausedByOrgId?: string | null;
}

export type ActionPlan = { ok: true; patch: PartnershipPatch } | { ok: false; refusal: ActionRefusal };

/** What one club's organiser may do to a pairing, and the row change. */
export function planPartnershipAction(
  p: PartnershipRow,
  a: { orgId: string; role: ClubRole; action: PartnershipAction; userId: string; now: Date },
): ActionPlan {
  const side = sideOf(p, a.orgId);
  if (!side) return { ok: false, refusal: "not-a-side" };
  const owner = a.role === "OWNER";
  const admin = owner || a.role === "ADMIN";

  switch (a.action) {
    case "accept": {
      if (!owner) return { ok: false, refusal: "owner-only" };
      if (p.status === "ended") return { ok: false, refusal: "ended" };
      if (p.status !== "proposed") return { ok: false, refusal: "not-proposed" };
      const mine = side === "asker" ? p.askerAcceptedAt : p.partnerAcceptedAt;
      if (mine) return { ok: false, refusal: "already-accepted" };
      const theirs = side === "asker" ? p.partnerAcceptedAt : p.askerAcceptedAt;
      const patch: PartnershipPatch =
        side === "asker" ? { askerAcceptedAt: a.now, askerAcceptedBy: a.userId } : { partnerAcceptedAt: a.now, partnerAcceptedBy: a.userId };
      if (theirs) patch.status = "active";
      return { ok: true, patch };
    }
    case "decline": {
      if (!owner) return { ok: false, refusal: "owner-only" };
      if (p.status === "ended") return { ok: false, refusal: "ended" };
      if (p.status !== "proposed") return { ok: false, refusal: "not-proposed" };
      return { ok: true, patch: { status: "ended", pausedByOrgId: null } };
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
      if (!owner) return { ok: false, refusal: "owner-only" };
      if (p.status === "ended") return { ok: false, refusal: "ended" };
      return { ok: true, patch: { status: "ended", pausedByOrgId: null } };
    }
  }
}
