/**
 * THE FRIEND LINK'S WHOLE MESSAGES (2026-10-31): pure, assembled from the
 * words in `src/lib/i18n/friend-link.*.ts`. Every value is a fact the code
 * already holds (club, kick-off, venue, fee, names on file), never text a
 * model produced. Exact outputs are pinned in `__tests__/copy.test.ts`.
 */
import { dayCommaTimeLabel } from "../i18n/dates";
import { friendLinkCopy } from "../i18n/friend-link";
import type { Lang } from "../i18n/lang";
import type { PoolFee } from "../pool/offer-copy";
import { friendShortName, type FriendNotBooked } from "./rules";

const firstName = (name: string): string => name.trim().split(/\s+/)[0] ?? "";

export interface MemberLink {
  /** The friend's name as written, or null. */
  friend: string | null;
  url: string;
}

/** The DM to the member: his link (or links), forward it, how it works. */
export function memberLinkDm(lang: Lang, p: { club: string; kickoff: Date; venue: string | null; links: MemberLink[]; capped: boolean }): string {
  const c = friendLinkCopy(lang);
  const day = dayCommaTimeLabel(lang, p.kickoff);
  const numbered = p.links.map((l, i) => c.member_link_line({ n: i + 1, friend: l.friend, link: l.url })).join("\n");
  if (p.capped) return [c.member_cap({ club: p.club, day }), numbered, c.member_how].join("\n\n");
  if (p.links.length === 1) {
    const [only] = p.links;
    return [c.member_one({ friend: only.friend, club: p.club, day, venue: p.venue }), only.url, c.member_how].join("\n\n");
  }
  return [c.member_many({ club: p.club, day, venue: p.venue }), numbered, c.member_how].join("\n\n");
}

/** The one group reply when the member has no number to DM (D7). */
export function memberNoPhoneLine(lang: Lang, p: { member: string }): string {
  return friendLinkCopy(lang).member_no_phone({ member: firstName(p.member) });
}

export type FriendPlace = "in" | "bench";

/** The friend's DM once he is booked. */
export function friendBookedDm(
  lang: Lang,
  p: { club: string; kickoff: Date; venue: string | null; member: string; status: FriendPlace; organiserPicks: boolean; fee: PoolFee; monthly: boolean; newToPool: boolean; manageLink: string },
): string {
  const c = friendLinkCopy(lang);
  const game = { club: p.club, day: dayCommaTimeLabel(lang, p.kickoff), venue: p.venue, member: firstName(p.member) };
  const head = p.status === "in" ? c.booked_in(game) : p.organiserPicks ? c.booked_bench_pick(game) : c.booked_bench(game);
  const fee = p.fee?.kind === "amount" ? (p.monthly ? c.booked_fee_payg({ amount: p.fee.amount }) : c.booked_fee({ amount: p.fee.amount })) : null;
  return [[head, fee].filter(Boolean).join("\n"), p.newToPool ? c.booked_pool : null, c.footer({ link: p.manageLink })].filter(Boolean).join("\n\n");
}

/** The friend's DM when his code confirmed him but he is not booked. */
export function friendNotBookedDm(lang: Lang, p: { reason: FriendNotBooked; newToPool: boolean; manageLink: string }): string {
  const c = friendLinkCopy(lang);
  const why: Record<FriendNotBooked, string> = {
    used: c.not_used,
    started: c.not_started,
    "called-off": c.not_called_off,
    "already-on-match": c.not_already,
    issuer: c.not_issuer,
    blocked: c.not_other,
    elsewhere: c.not_other,
    failed: c.not_other,
  };
  return [[p.newToPool ? c.not_booked_pool : null, why[p.reason]].filter(Boolean).join("\n"), c.footer({ link: p.manageLink })].join("\n\n");
}

/** The players' group line once he is booked. */
export function friendGroupLine(lang: Lang, p: { displayName: string; member: string; kickoff: Date; status: FriendPlace; organiserPicks: boolean }): string {
  const c = friendLinkCopy(lang);
  const args = { name: friendShortName(p.displayName), member: firstName(p.member), day: dayCommaTimeLabel(lang, p.kickoff) };
  if (p.status === "in") return c.group_in(args);
  return p.organiserPicks ? c.group_bench_pick(args) : c.group_bench(args);
}

/** The friend's DM when an organiser takes him off the game. */
export function friendRemovedDm(lang: Lang, p: { club: string; kickoff: Date }): string {
  return friendLinkCopy(lang).removed({ club: p.club, day: dayCommaTimeLabel(lang, p.kickoff) });
}
