/**
 * Client-safe feature metadata (no DB import). Split from
 * org-features.ts so "use client" components (admin settings, and
 * Phase 2's in-group feature menu) can import the labels without
 * pulling server-only Prisma.
 */
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
  | "payDirect";

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
  { key: "bench", label: "Bench management", blurb: "Standby list; when someone drops, asks the next bencher to step up." },
  { key: "teamBalancing", label: "Team generation", blurb: "Builds two balanced teams on request." },
  { key: "momVoting", label: "Man of the Match", blurb: "Posts the MoM vote after the match and announces the winner." },
  { key: "playerRating", label: "Player ratings", blurb: "DMs each player a quick post-match rating link." },
  { key: "reminders", label: "Personal reminders", blurb: '"@MatchTime remind me Monday" — bot DMs you later.' },
  { key: "statsQa", label: "Stats answers", blurb: "Answers history questions (top attenders, past MoMs, scores)." },
  { key: "paymentTracking", label: "Payment tracking", blurb: "Tracks who has paid and chases the unpaid (opt-in)." },
  { key: "paymentCollection", label: "Collect match fees (Stripe)", blurb: "After each match, DM each player a link to pay. Needs a connected bank (below)." },
  { key: "payByBank", label: "  ↳ Pay by Bank", blurb: "Cheapest method (~10p). The recommended default." },
  { key: "payCard", label: "  ↳ Card / Apple Pay", blurb: "Card payments (~35p on £10)." },
  { key: "payDirect", label: "  ↳ Pay organiser directly", blurb: "Cash/transfer; the money collector confirms receipt. No fee." },
];
