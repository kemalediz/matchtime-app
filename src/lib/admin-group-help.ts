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
import { organisersAnnounce } from "./list-announcer";
import { effectiveTeamsReadyTime } from "./team-proposal-rules";

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

/**
 * Which HQ commands a club gets, the ONE place the help (`answerHqHelp`,
 * admin-group.ts, which asks only for a live club) and the introduction
 * below read them from, so the two never disagree: the squad and team
 * commands for a weekly club, the graphics for any club, the pick line for
 * organiser pick, PAID for a monthly club.
 */
export function hqHelpGates(org: { squadMode?: string | null; benchPickMode?: string | null }): {
  squad: boolean;
  graphics: boolean;
  picks: boolean;
  paid: boolean;
} {
  const monthly = org.squadMode === "monthly";
  return { squad: !monthly, graphics: true, picks: org.benchPickMode === "organiser", paid: monthly };
}

/** What the introduction reads: Organisation columns plus the weekdays of
 *  the club's active games. A missing feature column reads as its database
 *  default (on). */
export interface AdminGroupIntroClub {
  name: string;
  language: string | null;
  whatsappBotEnabled: boolean | null;
  squadMode?: string | null;
  benchPickMode?: string | null;
  listAnnouncer?: string | null;
  teamsReadyTime?: string | null;
  featureAttendance?: boolean | null;
  featureMomVoting?: boolean | null;
  featurePlayerRating?: boolean | null;
  featureBadgeAnnouncements?: boolean | null;
  /** `Activity.dayOfWeek` of each active activity (0 = Sunday). */
  activityDays: number[];
}

/**
 * MATCHTIME'S INTRODUCTION IN A NEWLY LINKED ADMIN GROUP (2026-10-15).
 *
 * Replaces the bare "Linked as the admin group" line (FNF HQ, 2026-10-15:
 * another organiser asked "Whats this?"). Posted once per club and group
 * (`admin-group-intro.ts`). Every clause is true for THIS club:
 *
 *   the weekday           every active Activity on one `dayOfWeek`; else "games"
 *   not switched on       `whatsappBotEnabled` false (a club setting up):
 *                         the lines describe what happens once it is on
 *   IN and OUT            a weekly club with `featureAttendance` (the
 *                         attendance engine; a monthly club's list is
 *                         monthly-paste.ts's, so not claimed)
 *   balanced teams at T   team-proposal.ts `teamProposalJobs`: weekly only,
 *                         at `effectiveTeamsReadyTime` (10:00 when the
 *                         organisers announce and nothing is set, else off)
 *   poster, team sheet    admin-group-graphics.ts (the help's `graphics`
 *                         gate), and the team sheet on approval
 *   MoM, ratings          `featureMomVoting`, `featurePlayerRating`
 *                         (bot-scheduler.ts `featureForKey`: mom-, rate-)
 *   list stays here       `listAnnouncer` "organisers" (list-announcer.ts;
 *                         bot-scheduler.ts `toOrganisers`), weekly + attendance
 *   list in main chat     `listAnnouncer` "matchtime", weekly + attendance;
 *                         with a teams time, YES posts the teams there
 *                         (team-proposal.ts `answerTeamsYes`)
 *   who plays             the help's `picks` gate (organiser-pick.ts)
 *   PAID                  the help's `paid` gate (month-payment.ts)
 *   notices here          linking sets `adminChannelMode` "admin-group"
 *                         (admin-channel.ts `sendAdminNotice`)
 *   rating notice, badges organisers mode relays the rate promo and the
 *                         badges post (bot-scheduler.ts `relayToOrganisers`,
 *                         badge relay), each behind its own feature
 *   help                  `isHqHelpRequest`, answered for a live club only
 */
export function buildAdminGroupIntro(club: AdminGroupIntroClub): string {
  const gates = hqHelpGates(club);
  const weekly = club.squadMode !== "monthly";
  const organisers = organisersAnnounce(club);
  const attendance = club.featureAttendance !== false;
  const ratings = club.featurePlayerRating !== false;
  const badges = club.featureBadgeAnnouncements !== false;
  const days = [...new Set(club.activityDays)];
  const time = effectiveTeamsReadyTime(club.teamsReadyTime, organisers);
  const teamsAt = weekly && time !== "off" ? time : null;
  const lists = weekly && attendance;
  return t(club.language).admin_group_intro({
    club: club.name,
    live: club.whatsappBotEnabled === true,
    dow: days.length === 1 ? days[0] : null,
    tracks: lists,
    teamsAt,
    graphics: gates.graphics,
    mom: club.featureMomVoting !== false,
    ratings,
    organisersShare: lists && organisers,
    mainChatList: lists && !organisers,
    teamsPosted: !organisers && teamsAt !== null,
    picks: gates.picks,
    paid: gates.paid,
    relayRatings: organisers && ratings,
    relayBadges: organisers && badges,
  });
}
