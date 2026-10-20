/**
 * WHICH FEATURE A SCHEDULER INSTRUCTION BELONGS TO, FROM ITS KEY.
 *
 * Lifted out of `computeDueInstructions` (bot-scheduler.ts) on 2026-10-18
 * so it has two readers and one definition:
 *
 *   - the scheduler's per-org feature gate, which drops any instruction
 *     whose capability is switched off for the org;
 *   - the chat context a DM classifier reads (`reply-context.ts`, read by
 *     the payment-claim and match-availability classifiers), which needs to
 *     know what a scheduler DM was about. Those DMs (the daily pay chase,
 *     the rating reminder) are recorded as a `SentNotification` key; until
 *     2026-10-20 (slice S0) never with their text (Feroz, FNF 2026-10-18).
 *
 * Unknown, meta and org-scoped keys (bot-intro, admin DMs, ad-hoc BotJobs,
 * retro-reactions) are NOT classified, so the gate always allows them
 * (fail-open; they are not user-facing match features). This is how
 * Amir's group runs MoM + ratings only.
 */
import type { OrgFeatures } from "./org-features";

export type DueKeyFeature = Extract<
  keyof OrgFeatures,
  | "attendance"
  | "bench"
  | "momVoting"
  | "badgeAnnouncements"
  | "playerRating"
  | "paymentTracking"
  | "paymentCollection"
  | "teamBalancing"
>;

export function featureForDueKey(key: string): DueKeyFeature | null {
  const seg = key.includes(":") ? key.slice(key.indexOf(":") + 1) : key;
  if (
    seg.startsWith("announce-match") ||
    seg.startsWith("rolling-announce") ||
    seg.startsWith("dropout-reminder") ||
    seg.startsWith("list-published") ||
    seg.startsWith("evening-update") ||
    seg.startsWith("chase-") ||
    seg.startsWith("pre-kickoff") ||
    seg.startsWith("cancel-nudge") ||
    seg.startsWith("switch-nudge") ||
    seg.startsWith("football-gear-reminder")
  )
    return "attendance";
  // The recruit chase-up says "still after N players", which is only
  // meaningful where capacity is tracked. A ratings-only org has zero
  // CONFIRMED rows by construction, so its squad would read as
  // permanently short and every invited player would be chased.
  if (seg.startsWith("recruit-chase")) return "attendance";
  // The month's list (slice 5) is the squad, so it follows attendance.
  if (seg.startsWith("month-list")) return "attendance";
  // So is the month's sign-up list (slice 3).
  if (seg.startsWith("msu:list")) return "attendance";
  if (seg.startsWith("bench-prompt")) return "bench";
  if (seg.startsWith("mom-")) return "momVoting";
  if (seg.startsWith("badges")) return "badgeAnnouncements";
  if (seg.startsWith("rate-")) return "playerRating";
  if (seg.startsWith("payment-")) return "paymentTracking";
  if (seg.startsWith("unpaid-")) return "paymentTracking";
  if (seg.startsWith("fee-ask")) return "paymentCollection";
  if (seg.startsWith("pay-chase")) return "paymentCollection";
  // ask-score is the "what was the final score?" prompt. Its sole
  // consumer is ELO recomputation, which only runs when teams were
  // generated — i.e. when teamBalancing is on. For rating-only orgs
  // (Sutton Lads 2026-05-28) the prompt's "I'll use it to update
  // everyone's rating for next week" is literally false — peer
  // ratings come from teammates, not from the score. Gate the
  // prompt out unless team balancing is enabled.
  if (seg.startsWith("ask-score")) return "teamBalancing";
  // Everything else: infrastructure / meta → allow.
  return null;
}

/**
 * What a MatchTime message was about, from its key: its feature, or the
 * tentative follow-up ("can you play?"), whose key the feature gate
 * deliberately leaves unclassified (it is never gated off). Null for an
 * ad-hoc BotJob or an infrastructure key.
 *
 * One definition (quoted-reply context, slice S0, 2026-10-20), read by
 * the quoted-reply resolver and the chat context (`reply-context.ts`:
 * "the message they swipe-replied to", "MatchTime's recent messages").
 */
export type DueKeyTopic = DueKeyFeature | "tentativeFollowup" | "feeQuestion";

export function topicOfDueKey(key: string): DueKeyTopic | null {
  if (key.includes(":tentative-followup:")) return "tentativeFollowup";
  // The money collector's fee question: the scheduler's ask ("how much?",
  // or a monthly club's "£8 each, yes?") and the confirm question queued
  // when he types an amount (`<matchId>:fee-confirm`, a BotJob's
  // `aboutKey`). Its own topic, not "paymentCollection" (paying a fee one
  // owes): a ✅ answers it, and only it (review of #339). The feature gate
  // (`featureForDueKey`) still classifies the ask as paymentCollection.
  const seg = key.includes(":") ? key.slice(key.indexOf(":") + 1) : key;
  if (seg.startsWith("fee-ask") || seg.startsWith("fee-confirm")) return "feeQuestion";
  return featureForDueKey(key);
}
