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
 *
 * 2026-09-30: every page it points at is a signed-in link (`url`), never
 * a bare path, and a new number whose WhatsApp name is known is named.
 */
import { t } from "./i18n/t";
import { dayOfMonthLabel } from "./i18n/dates";
import type { Lang } from "./i18n/lang";

export type JoinLinkNote =
  | { kind: "linked"; placeholderName: string; addedAt: Date }
  | { kind: "suggest"; names: string[] };

export type JoinDmInput =
  | { kind: "new"; club: string; phone: string; name?: string | null; link?: JoinLinkNote }
  | { kind: "first" | "rejoined"; club: string; name: string; link?: JoinLinkNote };

/**
 * The admin page a DM of this shape links to, or null when it links to
 * none. The caller mints ONE signed-in link per admin for it
 * (`buildAdminLink`), because a bare path is not tappable on WhatsApp.
 */
export function joinDmPath(input: JoinDmInput): string | null {
  if (input.kind === "new") return input.name ? "/admin/players" : "/admin/players/phones";
  if (input.link?.kind === "suggest") return "/admin/players";
  return null;
}

export function composeJoinDm(
  lang: Lang | string | null | undefined,
  input: JoinDmInput,
  /** The admin's own signed-in link to `joinDmPath(input)`. */
  url = "",
): string {
  const s = t(lang);
  const head =
    input.kind === "new"
      ? input.name
        ? s.dm_admin_join_new_named({ name: input.name, club: input.club, phone: input.phone, url })
        : s.dm_admin_join_new({ club: input.club, phone: input.phone, url })
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
      : s.dm_admin_join_possible_duplicate({ names: input.link.names, url });
  return `${head}\n\n${line}`;
}
