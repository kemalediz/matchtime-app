/**
 * WHAT MATCHTIME DOES FOR THIS CLUB, FROM ITS SWITCHES (club summary, slice B7).
 *
 * One pure description, read by everything that tells people what MatchTime
 * does for a club: the players' group hello (`group-hello.ts`) and the admin
 * group's introduction (`admin-group-help.ts`). Before B7 they each worked it
 * out (plan D11): the hello said ratings were on only when the rating DMs can
 * reach anyone, the introduction whenever the rating switch was on; the hello
 * said "say IN each week" only for a weekly club without a carried squad or a
 * pasted list, the introduction "I keep track of IN and OUT" for any weekly
 * club with attendance on, including one whose squad comes from a pasted list
 * (whose messages are never read for IN and OUT).
 *
 * Facts, not decisions: each field is something an organiser can check on the
 * settings page. Each consumer still words it its own way.
 */

/** The switches and settings the description reads. Every field is the
 *  club's own column, as `OrgFeatures` carries it. */
export interface ClubDescriptionInput {
  attendance: boolean;
  squadFromList: boolean;
  rollingSquad: boolean;
  /** A monthly squad (the month's regulars are in every game). */
  monthly: boolean;
  playerRating: boolean;
  momVoting: boolean;
  /** `momChosenBy` "organisers" (mom-chooser.ts). */
  momByOrganisers: boolean;
}

export interface ClubDescription {
  /** MatchTime reads IN and OUT in the players' group for each weekly game:
   *  attendance on, a weekly club, and the squad not taken from a pasted
   *  list (`featureSquadFromList`: the analyze route stores those messages
   *  and never reads them for IN and OUT). A monthly club's list is the
   *  month's (monthly-paste.ts), so it is not this. */
  readsInAndOut: boolean;
  /** Players say IN for each game: MatchTime reads IN and OUT and does not
   *  carry last week's squad over (rolling squad). */
  signsUpEachWeek: boolean;
  /** The post-match rating DMs reach someone: they go to the match's
   *  confirmed players (bot-scheduler.ts), which a club has only while it
   *  tracks attendance or reads a pasted squad. */
  ratings: boolean;
  /** Man of the Match runs: the organisers pick it, or the players vote on
   *  their rating link (so a players' vote needs the rating DMs). */
  mom: boolean;
}

export function describeClub(c: ClubDescriptionInput): ClubDescription {
  const readsInAndOut = c.attendance && !c.squadFromList && !c.monthly;
  const ratings = c.playerRating && (c.attendance || c.squadFromList);
  return {
    readsInAndOut,
    signsUpEachWeek: readsInAndOut && !c.rollingSquad,
    ratings,
    mom: c.momByOrganisers ? c.momVoting : c.momVoting && ratings,
  };
}
