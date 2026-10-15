/**
 * "help" IN A CLUB'S ADMIN GROUP (2026-10-15).
 *
 * Before this, "@Match Time help" in a linked admin group (HQ) had no
 * reader of its own. In a live weekly club, from an owner or admin, it
 * went down the route's chain (admin-group.ts): not PAID, not a poster
 * command, not a pick (with a round open), not YES, not a team command, not
 * a pasted list, so it reached the squad change (admin-group-squad-change.ts),
 * whose first step is the router (`gateBatch`, a model call unless the
 * club's AI cap is reached). Anything the router did not route to
 * attendance was then ignored with no reply. So organisers had nowhere to
 * see what HQ takes.
 *
 * Now a whole-message "help" / "yardım" (after an optional tag of MatchTime)
 * from an owner or admin of a live club is answered here, BEFORE every other
 * reader, with the commands HQ really takes. Deterministic: no model, and
 * nothing here imports a model path (`admin-group-no-model.source.test.ts`).
 *
 * WHICH FILE READS EACH LINE (and `admin-group-help.test.ts` feeds every
 * quoted command to that parser):
 *
 *   squad list pasted, YES       admin-group-paste.ts proposeSquadPaste /
 *                                answerSquadPasteYes (30 minutes:
 *                                PASTE_PROPOSAL_TTL_MS)
 *   "put Bilal in", "Sam out"    admin-group-squad-change.ts
 *                                handleAdminSquadChange (the router, then
 *                                the attendance engine)
 *   teams / reshuffle / swap / move, YES to teams
 *                                team-proposal.ts handleTeamCommand,
 *                                answerTeamsYes (parser:
 *                                team-proposal-rules.ts parseTeamCommand)
 *   poster / team sheet          admin-group-graphics.ts
 *                                handleAdminGraphicsCommand
 *   pick: numbers, names, ALL, NONE
 *                                organiser-pick.ts handlePickReply
 *                                (organiser-pick-rules.ts parsePickReply)
 *   PAID ALL / PAID 1 3 / PAID NONE
 *                                month-payment.ts handleCollectorPaidReply
 *                                (month-payment-rules.ts readCollectorReply)
 *
 * Which lines a club gets follows the same gates admin-group.ts applies:
 * the squad and team commands for a live weekly club (`readsSquad`), the
 * graphics for a live club, the pick line for organiser pick, PAID for a
 * monthly club.
 */
import { t } from "./i18n/t";

/** "@Match Time", "MatchTime,", or a raw tag ("@447700900999") in front:
 *  the same address `parseGraphicsCommand` strips. */
const ADDRESS = /^(?:@?\s*match\s*time\b|@[\p{L}\p{N}_]+)[\s,:]*/u;

/**
 * Is this WHOLE message a request for help? Only the keyword, after an
 * optional tag of MatchTime, with trailing punctuation. "can someone help
 * with the list" is the organisers talking to each other, and "help teams"
 * is left alone too: in HQ every message is read as addressed to MatchTime,
 * so only the bare keyword is taken.
 */
export function isHqHelpRequest(text: string): boolean {
  if (typeof text !== "string" || text.includes("\n")) return false;
  for (const lower of [text.toLowerCase(), text.toLocaleLowerCase("tr")]) {
    let s = lower.trim();
    for (let i = 0; i < 3 && ADDRESS.test(s); i++) s = s.replace(ADDRESS, "");
    s = s.replace(/[\s.!?]+$/u, "").trim();
    if (s === "help" || s === "yardım" || s === "yardim") return true;
  }
  return false;
}

/** The HQ command list, in the club's language. */
export function buildHqHelp(p: {
  lang: string | null | undefined;
  /** A live weekly club: the pasted list, one change, the team commands. */
  squad: boolean;
  /** A live club: the poster and the team sheet. */
  graphics: boolean;
  /** `benchPickMode = "organiser"`: the pick replies. */
  picks: boolean;
  /** A monthly club: the collector's PAID reply. */
  paid: boolean;
}): string {
  return t(p.lang).hq_help({ squad: p.squad, graphics: p.graphics, picks: p.picks, paid: p.paid });
}
