/**
 * Man of the Match on the web pages (review of #608, round 2): the line a
 * decided match shows, and the status an undecided one shows instead of a
 * leader (`mom-web.ts` composes them). One object per language, typed by
 * `MomWebCopy`, so a line missing in either language is a `tsc` error. No
 * em or en dashes, no slash as a separator.
 */
import { normaliseLang, type Lang } from "./lang";
import { MOM_WEB_EN } from "./mom-web.en";
import { MOM_WEB_TR } from "./mom-web.tr";

export interface MomWebCopy {
  /** The vote is open: no leader, no counts. */
  open: string;
  /** The vote is over and its result will be posted in the group. */
  closedToBePosted: string;
  /** The vote is over; no post is promised. */
  closedPlain: string;
  /** Posted before MatchTime kept the result: the post has it. */
  posted: string;
  /** An organisers' pick that will be posted: no name until then. */
  pickedToBePosted: string;
  /** Two or more winners, names already joined. */
  shared: (p: { names: string }) => string;
  /** One winner's announced votes, out of the votes cast. */
  votesOf: (p: { top: number; total: number }) => string;
  /** Each shared winner's announced votes. */
  votesEach: (p: { top: number }) => string;
  /** The organisers picked: no vote. */
  picked: string;
  /** Before the other players who got votes, as announced. */
  alsoReceived: string;
  /** Joins the last two names: "A, B and C". */
  and: string;
  /** A player's Man of the Match wins, counted on decided results. */
  wins: (n: number) => string;
  /** What that count counts. */
  winsNote: string;
}

const BY_LANG: Record<Lang, MomWebCopy> = { en: MOM_WEB_EN, tr: MOM_WEB_TR };

export function momWebCopy(lang: Lang | string | null | undefined): MomWebCopy {
  return BY_LANG[normaliseLang(lang)];
}
