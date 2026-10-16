/**
 * Client-safe feature metadata (no DB import). Split from
 * org-features.ts so "use client" components (admin settings, and
 * Phase 2's in-group feature menu) can import the labels without
 * pulling server-only Prisma.
 */
import { totalOnTenPounds } from "./payments";
export type FeatureKey =
  | "attendance"
  | "bench"
  | "teamBalancing"
  | "momVoting"
  | "playerRating"
  | "reminders"
  | "statsQa";

export type ToggleableKey =
  | FeatureKey
  | "paymentTracking"
  | "paymentCollection"
  | "payByBank"
  | "payCard"
  | "payDirect"
  /// Badge announcements (2026-10-01). Switchable on /admin/settings, in
  /// the Bot features section with its own EN/TR row, but deliberately NOT
  /// in `FEATURE_META`: that list is also the numbered in-group setup menu,
  /// and inserting an entry would renumber the payment picks. Default ON.
  | "badgeAnnouncements"
  /// The match-day gear reminder (2026-10-15). Its own row on
  /// /admin/settings like the badges, not in `FEATURE_META`. Default OFF
  /// for a new club, ON for clubs that existed before it.
  | "gearReminder";

/// Features shown in the admin Settings toggles + the in-group onboarding
/// menu. `squadFromList` is INTENTIONALLY NOT here — it's a derived
/// behaviour the onboarding completion sets automatically (when momVoting
/// or playerRating is on AND attendance is off), not a user-pickable
/// toggle. Surfacing it would confuse non-technical admins (they'd have
/// to understand why it's only valid for a specific feature combination).
/// It IS readable as a field on `OrgFeatures` for code that needs to
/// gate on it.
export const FEATURE_META: Array<{
  key: ToggleableKey;
  label: string;
  blurb: string;
}> = [
  { key: "attendance", label: "Attendance tracking", blurb: "Reads IN/OUT messages, keeps the squad list, chases when short." },
  { key: "bench", label: "Bench management", blurb: "Runs the bench; when someone drops, asks the next bencher to step up." },
  { key: "teamBalancing", label: "Team generation", blurb: "Builds two balanced teams on request." },
  { key: "momVoting", label: "Man of the Match", blurb: "Announces the winner in the group. Players vote on their rating link." },
  { key: "playerRating", label: "Player ratings", blurb: "DMs each player a quick post-match rating link." },
  { key: "reminders", label: "Personal reminders", blurb: '"@MatchTime remind me Monday" and the bot DMs you then.' },
  { key: "statsQa", label: "Stats answers", blurb: "Answers history questions (top attenders, past MoMs, scores)." },
  { key: "paymentTracking", label: "Payment tracking", blurb: "Tracks who has paid and chases the unpaid (opt-in)." },
  { key: "paymentCollection", label: "Collect match fees (Stripe)", blurb: "After each match, DM each player a link to pay. Needs a connected bank (below)." },
  { key: "payByBank", label: "  ↳ Pay by Bank", blurb: `Cheapest way to pay by link: ${totalOnTenPounds("pay_by_bank")} on a £10 fee. The recommended default.` },
  { key: "payCard", label: "  ↳ Card and Apple Pay", blurb: `Card, Apple Pay or Google Pay: ${totalOnTenPounds("card")} on a £10 fee.` },
  { key: "payDirect", label: "  ↳ Pay organiser directly", blurb: "Cash/transfer; the money collector confirms receipt. No fee." },
];

/// Switches hidden for now (Kemal, 2026-10-16). Payment tracking (the old
/// WhatsApp payment poll and the group unpaid summary) confused clubs:
/// players get pay-link DMs from "Collect match fees" and the money
/// collector has the payments page. It is not offered anywhere: not on
/// /admin/settings, not in the in-group setup menu, not by any setup flow,
/// and `setOrgFeature` refuses to switch it on. Its column and the
/// scheduler code stay, so a club that still has it on keeps working and
/// it can come back by emptying this set.
export const HIDDEN_FEATURE_KEYS: ReadonlySet<ToggleableKey> = new Set<ToggleableKey>(["paymentTracking"]);

export function isFeatureOffered(key: string): boolean {
  return !HIDDEN_FEATURE_KEYS.has(key as ToggleableKey);
}

/// `FEATURE_META` without the hidden switches: what the settings page and
/// the in-group setup menu show.
export const OFFERED_FEATURE_META = FEATURE_META.filter((m) => isFeatureOffered(m.key)) as Array<{
  key: Exclude<ToggleableKey, "paymentTracking">;
  label: string;
  blurb: string;
}>;
