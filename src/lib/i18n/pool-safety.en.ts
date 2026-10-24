/**
 * THE POOL'S NO-SHOW, BLOCK AND REPORT COPY, ENGLISH (slice L7, 2026-10-24).
 * Every word the no-show marking, the turn-up record, the pauses MatchTime
 * decides, blocks and reports say: the DMs to a pool player, the match
 * page and guest card for organisers, his manage page and offer page. Kept
 * out of the flat `strings.*.ts` tables as the offer copy is; the house
 * rules are unit tested (`__tests__/pool-safety-copy.test.ts`): no em or
 * en dashes, "bench" never "waiting list", no time-of-day greeting,
 * Turkish never equal to English.
 *
 * NEUTRAL BY RULE. A block or a report is never told to the other side,
 * and nothing here names who reported, who blocked or why a club no longer
 * needs him. WhatsApp bold is *one star*.
 */
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export const poolSafetyEn = {
  // ── DMs to the pool player (platform channel) ────────────────────────
  dm_paused_no_shows: (p: { n: number; games: number; days: number; link: string }) =>
    `I've paused game offers because you didn't turn up to ${p.n} of your last ${p.games} games. You can start them again in ${p.days} days, or ask a person to look at it now: ${p.link}`,
  dm_paused_reports: (p: { link: string }) => `I've paused game offers while the MatchTime team looks at your profile. You can ask about it here: ${p.link}`,
  dm_removed: (p: { club: string; day: string }) =>
    `Plans changed for *${p.club}* on ${p.day}: they don't need a player for that game any more. Nothing for you to do.`,
  dm_resumed: (p: { link: string }) => `Game offers are on again. Your settings: ${p.link}`,

  // ── Match page: did the guests turn up? (organisers) ─────────────────
  mark_title: "Did your guests turn up?",
  mark_hint: (p: { until: string }) => `Mark a guest who didn't come by ${p.until}. A guest you don't mark counts as played.`,
  mark_final: "These results are final.",
  mark_turned_up: "Turned up",
  mark_no_show: "Didn't turn up",
  mark_failed: "That could not be saved. Reload the page and try again.",
  result_due: "Result due",

  // ── Guest card: block and report (organisers) ────────────────────────
  card_block: "Don't offer this player our games again",
  card_blocked: "Not offered your games any more",
  card_unblock: "Offer our games again",
  card_block_hint: "The player is not told.",

  // ── Reports (both sides) ─────────────────────────────────────────────
  report_open: "Report a problem",
  report_label_club: "What happened? Only the MatchTime team reads this. The player is not told.",
  report_label_player: "What happened? Only the MatchTime team reads this. The club is not told.",
  report_send: "Send to MatchTime",
  report_cancel: "Cancel",
  report_sent: "Thanks. The MatchTime team will look at it.",
  report_too_short: "Please say a little more about what happened.",
  report_failed: "That could not be sent. Reload the page and try again.",

  // ── His manage page ──────────────────────────────────────────────────
  record_heading: "Your turn-up record",
  record_line: (p: { played: number; games: number }) => `You turned up to ${p.played} of ${p.games} ${plural(p.games, "game", "games")} you said yes to.`,
  record_new: "No games yet.",
  paused_no_shows: (p: { from: string }) => `Paused because you didn't turn up to some games you said yes to. You can start game offers again from ${p.from}.`,
  paused_no_shows_ready: "Paused because you didn't turn up to some games you said yes to. You can start game offers again now.",
  paused_reports: "Paused while the MatchTime team looks at your profile.",
  paused_admin: "Paused by the MatchTime team.",
  review_ask: "Ask a person to look at this",
  review_asked: "Asked. A person from the MatchTime team will look at it.",
  clubs_heading: "Clubs that offered you games",
  clubs_hint: "Don't want games from a club? Stop its offers here. The club is not told.",
  club_block: "Stop this club's offers",
  club_blocked: "You don't get this club's offers",
  club_unblock: "Get its offers again",
  failed: "That did not work. Reload the page and try again.",

  // ── His offer page ───────────────────────────────────────────────────
  offer_block: (p: { club: string }) => `Don't offer me games from ${p.club}`,
  offer_blocked: (p: { club: string }) => `Done. You won't get offers from ${p.club} again.`,
};

export type PoolSafetyStrings = { [K in keyof typeof poolSafetyEn]: (typeof poolSafetyEn)[K] };
