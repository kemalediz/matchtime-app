/**
 * The players' group post about a PARTNER club's guest joining or leaving
 * the asking club's game, for a club whose only group is its players' group
 * (Kemal, 2026-10-29, the same rule as a pool guest: `pool/offer-copy.ts`
 * `poolGuestGroupNotice`). Worded for everyone and naming the partner club.
 * It leaves out what only organisers read in HQ: his standing at his own
 * club (another club's data) and "for you to pick". On an organiser-pick
 * club's bench it says how an organiser puts him in.
 *
 * PURE and client-safe.
 */
import { t } from "./i18n/t";

/** What a partner guest's place means, in a notice. */
export type PartnerGuestNoticeKind = "in" | "bench" | "out";

export function partnerGuestGroupNotice(
  lang: string | null | undefined,
  p: { name: string; partner: string; day: string; kind: PartnerGuestNoticeKind; organiserPicks: boolean },
): string {
  const s = t(lang);
  const args = { name: p.name, partner: p.partner, day: p.day };
  if (p.kind === "out") return s.xask_group_notice_out(args);
  if (p.kind === "in") return s.xask_group_notice_in(args);
  return p.organiserPicks ? s.xask_group_notice_bench_pick(args) : s.xask_group_notice_bench(args);
}
