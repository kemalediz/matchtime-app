/**
 * What MatchTime says when an organiser asks it to DM the people tagged in
 * a message ("@Match Time DM these people", "@Match Time yukarıdakilere
 * özelden yaz"; Vets MNF, 2026-11-09, `named-invite-rules.ts`).
 *
 * One object per language, typed by `NamedInviteCopy`, so a line missing in
 * either language is a `tsc` error. House rules (unit tested in
 * `__tests__/named-invite-rules.test.ts`): no em or en dashes, no slash, never
 * "waiting list", Turkish never equal to English. Names arrive already
 * joined ("A, B and C"), by `joinList` in the reader's language.
 */
import { normaliseLang, type Lang } from "./lang";
import { NAMED_INVITE_EN } from "./named-invite.en";
import { NAMED_INVITE_TR } from "./named-invite.tr";

export interface NamedInviteCopy {
  /** The invite went out to these people. */
  sent: (p: { names: string; matchName: string; when: string }) => string;
  alreadyHad: (p: { names: string; count: number }) => string;
  answered: (p: { names: string; count: number }) => string;
  optedOut: (p: { names: string; count: number }) => string;
  overCap: (p: { names: string; cap: number }) => string;
  /** Numbers MatchTime has no record of. `names` may end with `more`. */
  unknown: (p: { names: string }) => string;
  /** "one more person", "2 more people" (after named ones), or "one
   *  person", "2 people" (alone). */
  more: (p: { count: number; alone: boolean }) => string;
  nobodyTagged: string;
  noMatch: string;
  full: (p: { matchName: string }) => string;
}

const BY_LANG: Record<Lang, NamedInviteCopy> = { en: NAMED_INVITE_EN, tr: NAMED_INVITE_TR };

export function namedInviteCopy(lang: Lang | string | null | undefined): NamedInviteCopy {
  return BY_LANG[normaliseLang(lang)];
}
