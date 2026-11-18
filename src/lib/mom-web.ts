/**
 * MAN OF THE MATCH ON THE WEB PAGES (review of #608, round 2).
 *
 * The dashboard (`app/page.tsx`), the matches list (`app/matches/page.tsx`),
 * the match page (`app/matches/[matchId]/page.tsx`) and the admin stats
 * (`app/admin/stats/page.tsx`) used to show each match's CURRENT vote leader
 * and counts, open votes included. They now read the same decision as the
 * group (`decideMom`, through `loadMomDecisions`):
 *
 *   decided    the credited winner(s); the announced votes, and who else got
 *              votes, only when the post's tally is stored; a pick says so;
 *   open       "Voting open": no leader, no counts;
 *   closed     "Voting closed" (with "the result will be posted" only when
 *              a post is coming): no leader, no counts;
 *   posted     posted before MatchTime kept the result, vote still open:
 *              the post has it, no name here;
 *   picked     an organisers' pick still to be posted: no name until then.
 *
 * Strings in English and Turkish (`i18n/mom-web.*.ts`).
 */
import { momWebCopy } from "./i18n/mom-web";
import type { Lang } from "./i18n/lang";
import type { MomMatchDecision } from "./mom-records";

export type MomWebView =
  | { kind: "decided"; winners: string[]; picked: boolean; votes: { top: number; total: number } | null; others: Array<{ name: string; votes: number }> }
  | { kind: "open" }
  | { kind: "closed"; toBePosted: boolean }
  | { kind: "posted" }
  | { kind: "picked" };

/** PURE. What a page may show for one match; null when it has no votes. */
export function momWebView(d: MomMatchDecision | undefined): MomWebView | null {
  if (!d) return null;
  const v = d.decision;
  if (v.kind === "none") return null;
  if (v.kind === "pending") {
    // An organisers' pick still to be posted: there is no vote to call open.
    if (v.state === "picked") return { kind: "picked" };
    return v.state === "closed" ? { kind: "closed", toBePosted: v.toBePosted } : { kind: "open" };
  }
  if (v.mom.told === "posted-unrecorded") return { kind: "posted" };
  const winners = d.credit.map((w) => w.name);
  const ids = new Set(d.credit.map((w) => w.userId));
  return {
    kind: "decided",
    winners,
    picked: v.mom.pickedByOrganisers,
    votes: v.mom.votes,
    others: v.mom.votes ? v.mom.tally.filter((t) => !ids.has(t.userId)).map((t) => ({ name: t.name, votes: t.votes })) : [],
  };
}

/** PURE. Names joined "A, B and C" in the page's language. */
export function joinNames(names: string[], lang: Lang | string | null | undefined): string {
  const and = momWebCopy(lang).and;
  return names.length <= 2 ? names.join(and) : `${names.slice(0, -1).join(", ")}${and}${names[names.length - 1]}`;
}

/** PURE. The status line of a match whose result cannot be shown. */
export function momWebStatus(v: MomWebView, lang: Lang | string | null | undefined): string | null {
  const s = momWebCopy(lang);
  if (v.kind === "open") return s.open;
  if (v.kind === "closed") return v.toBePosted ? s.closedToBePosted : s.closedPlain;
  if (v.kind === "posted") return s.posted;
  if (v.kind === "picked") return s.pickedToBePosted;
  return null;
}

/** PURE. One line for a list ("Pete (3 of 5 votes)", "Voting open"). */
export function momWebLine(v: MomWebView | null, lang: Lang | string | null | undefined): string | null {
  if (!v) return null;
  if (v.kind !== "decided") return momWebStatus(v, lang);
  const s = momWebCopy(lang);
  const who = v.winners.length > 1 ? s.shared({ names: joinNames(v.winners, lang) }) : v.winners[0];
  if (v.picked) return `${who} ${s.picked}`;
  if (!v.votes) return who;
  return `${who} ${v.winners.length > 1 ? s.votesEach({ top: v.votes.top }) : s.votesOf(v.votes)}`;
}
