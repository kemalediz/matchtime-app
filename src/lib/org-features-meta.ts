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

export type ToggleableKey = FeatureKey | "paymentTracking";

export const FEATURE_META: Array<{
  key: ToggleableKey;
  label: string;
  blurb: string;
}> = [
  { key: "attendance", label: "Attendance tracking", blurb: "Reads IN/OUT messages, keeps the squad list, chases when short." },
  { key: "bench", label: "Bench management", blurb: "Standby list; when someone drops, asks the next bencher to step up." },
  { key: "teamBalancing", label: "Team generation", blurb: "Builds balanced Red vs Yellow teams on request." },
  { key: "momVoting", label: "Man of the Match", blurb: "Posts the MoM vote after the match and announces the winner." },
  { key: "playerRating", label: "Player ratings", blurb: "DMs each player a quick post-match rating link." },
  { key: "reminders", label: "Personal reminders", blurb: '"@MatchTime remind me Monday" — bot DMs you later.' },
  { key: "statsQa", label: "Stats answers", blurb: "Answers history questions (top attenders, past MoMs, scores)." },
  { key: "paymentTracking", label: "Payment tracking", blurb: "Tracks who has paid and chases the unpaid (opt-in)." },
];
