/**
 * Per-category proactive-DM subscription preferences — PURE logic.
 *
 * This module holds the parts of the feature that must be unit-testable
 * without a database: the read's intent -> command mapping, the
 * command -> flag-patch mapping, the
 * acknowledgement copy, and the data-migration backfill rule. The DB
 * writer lives in `notification-prefs.ts` (setDmSubscriptions); the
 * senders that consult the flags live in bot-scheduler.ts / recruit.ts.
 *
 * Design note (why a per-category model): a player once DM'd the bot
 * "do not message me on any topic but payment". The only preference we
 * had was a single ratings toggle, so the bot silenced ratings, claimed
 * success, and then kept sending recruit/bench/reminder DMs — it lied.
 * Each proactive-DM category now has its own boolean flag on Membership
 * (all default true = subscribed). PAYMENT DMs have NO flag: someone who
 * owes money is always sent their pay link + chases.
 */
import { t } from "./i18n/t";
import { type Lang } from "./i18n/lang";

/** The per-category subscription boolean fields on `Membership`. Payment
 *  is intentionally absent — it is never opt-out-able. */
export const DM_SUB_FIELDS = [
  "subMatchInviteDm",
  "subBenchOfferDm",
  "subTentativeDm",
  "subRatingDm",
  "subReminderDm",
] as const;

export type DmSubField = (typeof DM_SUB_FIELDS)[number];

/** A partial patch over the sub* flags — any subset may be set at once. */
export type DmSubPatch = Partial<Record<DmSubField, boolean>>;

export type DmSubCommandKind =
  | "opt-out-all" // silence everything except payment
  | "opt-out-ratings" // silence only rating / MoM DMs
  | "opt-in-all" // re-subscribe to everything
  | "opt-in-ratings"; // re-subscribe to rating / MoM DMs only

/**
 * The command a DM gives, from the ONE DM read (`dm-intent.ts`, 2026-10-30).
 * The word lists that used to decide this (`parseDmSubscriptionCommand`:
 * STOP verbs, rating nouns, a "but payment" marker, the Turkish set) are
 * deleted: the model reads the message against what MatchTime last sent
 * them, so "stop" answering a fee question, or "no more" in a chat, is not
 * an opt-out, and "do not message me on any topic but payment" still is.
 * Null for every other intent: the DM goes on to the steps below.
 */
export function subscriptionCommandOf(intent: string): DmSubCommandKind | null {
  switch (intent) {
    case "stop_messages":
      return "opt-out-all";
    case "stop_ratings":
      return "opt-out-ratings";
    case "resume_messages":
      return "opt-in-all";
    case "resume_ratings":
      return "opt-in-ratings";
    default:
      return null;
  }
}

/** The flag patch a command applies. opt-out-all / opt-in-all touch every
 *  category; the ratings commands touch only subRatingDm. */
export function dmSubPatchForCommand(kind: DmSubCommandKind): DmSubPatch {
  switch (kind) {
    case "opt-out-all":
      return Object.fromEntries(DM_SUB_FIELDS.map((f) => [f, false])) as DmSubPatch;
    case "opt-in-all":
      return Object.fromEntries(DM_SUB_FIELDS.map((f) => [f, true])) as DmSubPatch;
    case "opt-out-ratings":
      return { subRatingDm: false };
    case "opt-in-ratings":
      return { subRatingDm: true };
  }
}

/** Player-facing acknowledgement copy for a command. Only ever sent AFTER
 *  the DB write succeeds (see the fast-path's GOLDEN RULE). `lang` is the
 *  language of the org the reply is routed through; each ack quotes the
 *  command that undoes it, in that language (the DM reader's prompt has
 *  both as examples). */
export function dmSubAckMessage(kind: DmSubCommandKind, lang?: Lang | string | null): string {
  return t(lang).dm_sub_ack({ kind });
}

/**
 * Data-migration backfill rule, extracted so it can be asserted in a unit
 * test alongside the SQL in
 * prisma/migrations/*_dm_subscription_preferences/migration.sql.
 *
 * Old `ratingDmOptOut` has OPT-OUT semantics (true = suppressed); new
 * `subRatingDm` has SUBSCRIPTION semantics (true = receives). So
 * subRatingDm = NOT ratingDmOptOut — anyone opted out of ratings STAYS
 * opted out.
 */
export function subRatingDmFromLegacy(ratingDmOptOut: boolean): boolean {
  return !ratingDmOptOut;
}
