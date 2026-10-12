/**
 * APPROVED BUT SETTING UP: the database half, and the ONLY module that may
 * write `Organisation.setupStage` (2026-10-12, go-live plan 2.1 and 2.2).
 * The design, the fragments and the predicates are in the pure half,
 * `club-setup-rules.ts`, re-exported here; import from this file unless
 * the caller must stay free of the database.
 *
 * Slice S1 builds the rails, not the flow. Nothing here moves a club yet:
 *
 *   pending -> approved and setting up   slice S3, inside `decideClub`'s
 *       one compare-and-set, by spreading `settingUpClubFields()`.
 *   setting up -> live                   slice S4, `goLiveClub`, which
 *       belongs in THIS file: one compare-and-set on
 *       `SETTING_UP_CLUB_WHERE` that also switches the bot on and stamps
 *       `liveAt` and `liveBy`.
 *
 * What keeps a setting-up club silent, and where each rail lives:
 *   - the CHECK constraint (prisma/sql/org-setup-check.sql): the bot is
 *     never on, so analyze, due-posts, the scheduler, group-join,
 *     group-leave, sync-participants and the Pi's monitored set are all
 *     blind to it;
 *   - `loadSilentGroupIds` (club-approval.ts): its group is SILENT, so the
 *     Pi drops its messages, the in-group setup can never start there, and
 *     MatchTime's removal from it is still reported;
 *   - `aiAllowanceUsd` (ai-budget.ts): $0, except the one setup reading;
 *   - `settingUpClubsReason` below: a DM from its organiser stops before
 *     any model path;
 *   - `linkAdminGroup` (admin-group-link.ts): no reply in its players'
 *     group.
 */
import { db } from "./db";
import { servingClubWhere } from "./club-approval-state";
import { SETUP_STAGE_SELECT, isClubSettingUp, settingUpOnly } from "./club-setup-rules";

export {
  SETUP_STAGES,
  SETTING_UP_CLUB_WHERE,
  LIVE_STAGE_WHERE,
  BOT_ON_OR_SETTING_UP_WHERE,
  SETUP_STAGE_SELECT,
  isSetupHoldEnabled,
  isClubSettingUp,
  settingUpClubFields,
  settingUpOnly,
  type SetupStage,
} from "./club-setup-rules";

/** Is this one club approved and still setting up? False for no such club. */
export async function isClubSettingUpById(orgId: string): Promise<boolean> {
  const org = await db.organisation.findFirst({ where: { id: orgId }, select: SETUP_STAGE_SELECT });
  return !!org && isClubSettingUp(org);
}

/**
 * The dm-reply rail (go-live plan 2.2 point 4): is every club MatchTime
 * serves for this DM sender still setting up? "club-setting-up" means the
 * DM must go nowhere near a model path (the admin-command classifier, Q&A,
 * ...). null means carry on.
 *
 * Call it AFTER `nonServingClubsReason` (a sender with no served club at
 * all is that rail's) and after the deterministic help. A sender who also
 * belongs to a live club is not caught: they are handled exactly as today.
 * One small query, by primary key; none for a sender with no clubs.
 */
export async function settingUpClubsReason(orgIds: string[]): Promise<"club-setting-up" | null> {
  if (orgIds.length === 0) return null;
  const served = await db.organisation.findMany({
    where: { id: { in: orgIds }, ...servingClubWhere() },
    select: SETUP_STAGE_SELECT,
  });
  return settingUpOnly(served ?? []) ? "club-setting-up" : null;
}
