/**
 * THE SAFE-YES RULE'S QUESTIONS, IN THE CLUB'S LANGUAGE (2026-10-16; one
 * home since local player pool L10). When `decideApproval`
 * (`admin-group-confirm-rules.ts`) cannot tell what a YES was for, MatchTime
 * asks once: "Is that YES to ...?" about the one item waiting, or "Which one
 * is that YES for: ...?" naming every item waiting, whatever their kinds
 * (before L10 that question named the teams and the pasted list whatever
 * was waiting). Pure: strings only.
 */
import { t } from "./i18n/t";
import type { PendingWithLabel } from "./admin-group-context";

/** @param items what is waiting, in the order `loadPending` gives it (one or more). */
export function confirmQuestion(lang: string | null, items: PendingWithLabel[]): string {
  const s = t(lang);
  if (items.length === 1) {
    const i = items[0];
    switch (i.kind) {
      case "teams":
        return s.hq_confirm_teams({ day: i.day ?? "" });
      case "partner-ask":
        return s.hq_confirm_partner_ask({ asker: i.club ?? "", day: i.day ?? "" });
      case "pairing":
        return s.hq_confirm_pairing({ club: i.ownClub ?? "", other: i.club ?? "" });
      case "fee":
        return s.hq_confirm_fee({ names: i.names ?? "", day: i.day ?? "" });
      case "pool-ask":
        return s.hq_confirm_pool_ask({ day: i.day ?? "" });
      case "join-request":
        return s.hq_confirm_join_request({ name: i.names ?? "" });
      case "list":
        return s.hq_confirm_list;
    }
  }
  return s.hq_confirm_which({ items: items.map((i) => whichLabel(lang, i)) });
}

function whichLabel(lang: string | null, i: PendingWithLabel): string {
  const s = t(lang);
  switch (i.kind) {
    case "teams":
      return s.hq_which_teams({ day: i.day ?? "" });
    case "partner-ask":
      return s.hq_which_partner_ask({ asker: i.club ?? "", day: i.day ?? "" });
    case "pairing":
      return s.hq_which_pairing({ club: i.ownClub ?? "", other: i.club ?? "" });
    case "fee":
      return s.hq_which_fee({ names: i.names ?? "", day: i.day ?? "" });
    case "pool-ask":
      return s.hq_which_pool_ask({ day: i.day ?? "" });
    case "join-request":
      return s.hq_which_join_request({ name: i.names ?? "" });
    case "list":
      return s.hq_which_list;
  }
}
