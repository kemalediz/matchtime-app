/**
 * The admin DM for somebody being added to a club's WhatsApp group
 * (group-join), in the club's language. Pure.
 *
 * Three shapes, decided by what the MEMBERSHIP did, not the user:
 *   new       a number MatchTime has never seen: a placeholder was made;
 *   first     a known MatchTime user got their FIRST membership here;
 *   rejoined  a membership that had left (`leftAt`) was re-activated.
 *
 * Before 2026-09-29 "first" fell through to "rejoined", and Sutton's admin
 * was told Hamzah's membership had been "re-activated" on his first join.
 *
 * `link` appends one line when the joiner was merged with, or might be,
 * a placeholder a third party's "X in" created (`placeholder-link.ts`).
 */
import { t } from "./i18n/t";
import { dayOfMonthLabel } from "./i18n/dates";
import type { Lang } from "./i18n/lang";

export type JoinLinkNote =
  | { kind: "linked"; placeholderName: string; addedAt: Date }
  | { kind: "suggest"; names: string[] };

export type JoinDmInput =
  | { kind: "new"; club: string; phone: string; link?: JoinLinkNote }
  | { kind: "first" | "rejoined"; club: string; name: string; link?: JoinLinkNote };

export function composeJoinDm(lang: Lang | string | null | undefined, input: JoinDmInput): string {
  const s = t(lang);
  const head =
    input.kind === "new"
      ? s.dm_admin_join_new({ club: input.club, phone: input.phone })
      : input.kind === "first"
        ? s.dm_admin_join_first({ name: input.name, club: input.club })
        : s.dm_admin_join_rejoined({ name: input.name, club: input.club });
  if (!input.link) return head;
  const line =
    input.link.kind === "linked"
      ? s.dm_admin_join_linked({
          placeholder: input.link.placeholderName,
          addedOn: dayOfMonthLabel(lang, input.link.addedAt),
        })
      : s.dm_admin_join_possible_duplicate({ names: input.link.names });
  return `${head}\n\n${line}`;
}
