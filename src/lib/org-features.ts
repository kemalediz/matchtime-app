/**
 * Per-org feature-module resolution.
 *
 * Every bot capability is independently toggleable so a group can run
 * only the bits it wants (Amir's Thursday group, 2026-05-18: MoM +
 * player rating only, everything else off). Each side-effect entry
 * point calls getOrgFeatures() and guard-clauses out when its module
 * is off.
 *
 * Design:
 *  - Discrete boolean columns on Organisation (matches the codebase's
 *    existing `paymentTrackingEnabled` pattern; queryable; additive
 *    per the "strictly additive schema" rule).
 *  - Defaults TRUE for the established modules so the migration is a
 *    no-op for live orgs (Sutton FC keeps every feature). Payment is
 *    the pre-existing opt-in flag, surfaced here read-only for a
 *    single consistent view — its own gates are unchanged.
 *  - Falls OPEN by org-missing only for the master switch: if the org
 *    row can't be found we return all-false (nothing should run for
 *    an unknown group anyway; whatsappBotEnabled already gates that).
 */
import { db } from "./db";
import type { FeatureKey } from "./org-features-meta";

export { FEATURE_META } from "./org-features-meta";
export type { FeatureKey, ToggleableKey } from "./org-features-meta";

export interface OrgFeatures {
  /** Master switch — bot does anything at all for this group. */
  botEnabled: boolean;
  attendance: boolean;
  bench: boolean;
  teamBalancing: boolean;
  momVoting: boolean;
  playerRating: boolean;
  reminders: boolean;
  statsQa: boolean;
  /** Pre-existing opt-in flag; surfaced for a single source of truth. */
  paymentTracking: boolean;
  /** "Squad from pasted list" mode (Amir's Thursday group shape).
   *  When true, the analyze route stores group messages without calling
   *  the LLM, and `/api/cron/extract-squads` runs the one-shot squad
   *  extraction over a rolling 3-day window. Auto-set at onboarding for
   *  orgs that need a squad-of-record (MoM/ratings) but don't track
   *  in/out (attendance off). Default false; never on for Sutton. */
  squadFromList: boolean;
}


const ALL_OFF: OrgFeatures = {
  botEnabled: false,
  attendance: false,
  bench: false,
  teamBalancing: false,
  momVoting: false,
  playerRating: false,
  reminders: false,
  statsQa: false,
  paymentTracking: false,
  squadFromList: false,
};

function fromRow(row: {
  whatsappBotEnabled: boolean;
  featureAttendance: boolean;
  featureBench: boolean;
  featureTeamBalancing: boolean;
  featureMomVoting: boolean;
  featurePlayerRating: boolean;
  featureReminders: boolean;
  featureStatsQa: boolean;
  paymentTrackingEnabled: boolean;
  featureSquadFromList: boolean;
}): OrgFeatures {
  return {
    botEnabled: row.whatsappBotEnabled,
    attendance: row.featureAttendance,
    bench: row.featureBench,
    teamBalancing: row.featureTeamBalancing,
    momVoting: row.featureMomVoting,
    playerRating: row.featurePlayerRating,
    reminders: row.featureReminders,
    statsQa: row.featureStatsQa,
    paymentTracking: row.paymentTrackingEnabled,
    squadFromList: row.featureSquadFromList,
  };
}

const SELECT = {
  whatsappBotEnabled: true,
  featureAttendance: true,
  featureBench: true,
  featureTeamBalancing: true,
  featureMomVoting: true,
  featurePlayerRating: true,
  featureReminders: true,
  featureStatsQa: true,
  paymentTrackingEnabled: true,
  featureSquadFromList: true,
} as const;

export async function getOrgFeatures(orgId: string): Promise<OrgFeatures> {
  const row = await db.organisation.findUnique({
    where: { id: orgId },
    select: SELECT,
  });
  return row ? fromRow(row) : { ...ALL_OFF };
}

/** Resolve features from the WhatsApp group id (the bot's usual key).
 *  Returns null when the group maps to no org. */
export async function getOrgFeaturesByGroup(
  groupId: string,
): Promise<{ orgId: string; features: OrgFeatures } | null> {
  const row = await db.organisation.findFirst({
    where: { whatsappGroupId: groupId },
    select: { id: true, ...SELECT },
  });
  if (!row) return null;
  return { orgId: row.id, features: fromRow(row) };
}

// FEATURE_META + FeatureKey/ToggleableKey are re-exported at the top
// from ./org-features-meta (client-safe — no db import).
