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
import { normaliseLang, type Lang } from "./i18n/lang";
import { normaliseBenchPickMode, type BenchPickMode } from "./squad-capacity";

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
  /** Stripe per-match fee collection (2026-06-03). Fully gated; needs
   *  Stripe connected too. Default off. */
  paymentCollection: boolean;
  /** "Squad from pasted list" mode (Amir's Thursday group shape).
   *  When true, the analyze route stores group messages without calling
   *  the LLM, and the squad extraction (folded into the generate-teams
   *  cron — Vercel cap = 3) runs the one-shot LLM pass over messages
   *  since the previous match ended. Auto-set at onboarding for orgs
   *  that need a squad-of-record (MoM/ratings) but don't track in/out
   *  (attendance off). Default false; never on for Sutton. */
  squadFromList: boolean;
  /** The language this group is spoken to in (`Organisation.language`,
   *  2026-09-16). Carried here so `loadSquadState`'s single
   *  `getOrgFeatures` call puts it on `SquadState.features` with no
   *  extra query. Always a language the product ships: an unknown
   *  column value normalises to "en". Phase 0: no consumer reads it
   *  yet. See MDs/multi-language-design-2026-09-16.md section 4.1. */
  language: Lang;
  /** Rolling squad (2026-09-30, `Organisation.rollingSquadEnabled`):
   *  last match's players are carried onto the next one. Default off.
   *  Deliberately NOT in `FEATURE_META`, which also drives the in-group
   *  setup menu; it is set on /admin/settings, "Weekly routine". */
  rollingSquad: boolean;
  /** Who fills an open place (2026-10-01, slice 2b,
   *  `Organisation.benchPickMode`): "first-come" (today, every existing
   *  club) or "organiser". Carried here so `SquadState.features` has it
   *  with no extra query. Not in `FEATURE_META`, like `rollingSquad`. */
  benchPickMode: BenchPickMode;
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
  paymentCollection: false,
  squadFromList: false,
  language: "en",
  rollingSquad: false,
  benchPickMode: "first-come",
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
  paymentCollectionEnabled: boolean;
  featureSquadFromList: boolean;
  language: string;
  rollingSquadEnabled: boolean;
  benchPickMode?: string | null;
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
    paymentCollection: row.paymentCollectionEnabled,
    squadFromList: row.featureSquadFromList,
    language: normaliseLang(row.language),
    rollingSquad: row.rollingSquadEnabled,
    benchPickMode: normaliseBenchPickMode(row.benchPickMode),
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
  paymentCollectionEnabled: true,
  featureSquadFromList: true,
  language: true,
  rollingSquadEnabled: true,
  benchPickMode: true,
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
