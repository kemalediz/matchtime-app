/**
 * JOINING A CLUB'S GROUP, ENGLISH (local player pool L8, 2026-10-24). Every
 * word of the after-game question, the Invite to club DM, the invite link
 * DM, the organisers' notices, the guest card's invite states, the settings
 * card for the group's invite link and the player's My invitations page.
 *
 * Kept out of the flat `strings.*.ts` tables, as the offer copy is
 * (decision L5a.5): one feature's copy, typed, a missing Turkish key is a
 * tsc error, and the house rules are unit tested
 * (`__tests__/pool-invite-copy.test.ts`): no em or en dash, no greeting,
 * Turkish never equal to English, every argument used.
 *
 * PRIVACY. A DM to the guest names the club only, never an organiser, a
 * member or a number. The invite link appears in ONE message: `link_dm`,
 * to the one guest both sides approved. Nothing here shows it to anyone
 * else; the settings card shows it to the club's own organisers.
 */
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export const poolInviteEn = {
  // ── To the guest (his language) ───────────────────────────────────────
  ask_after_game: (p: { club: string; day: string; link: string }) =>
    `Enjoyed the game with *${p.club}* on ${p.day}? Want to join their group for future games? Answer here: ${p.link}`,
  ask_organiser: (p: { club: string; link: string }) =>
    `*${p.club}* would like you to join their group for future games. Want to join? Answer here: ${p.link}`,
  link_dm: (p: { club: string; link: string }) =>
    `🎉 Welcome to *${p.club}*. Join their WhatsApp group here: ${p.link}`,
  closed_dm: (p: { club: string }) =>
    `Thanks for saying yes. *${p.club}* is not adding new players to their group right now. You can still get games near you through MatchTime.`,

  // ── To the organisers (the club's language) ───────────────────────────
  notice_wants_join: (p: { name: string; day: string; link: string }) =>
    `🙋 ${p.name} played with you on ${p.day} as a guest and wants to join your group. To send them the group's invite link, tap Send the invite link on their card: ${p.link}`,
  /** The guest when he has no name on MatchTime. */
  /** The same notice in the admin group, where a YES sends the link (L10). */
  notice_wants_join_hq: (p: { name: string; day: string; link: string }) =>
    `🙋 ${p.name} played with you on ${p.day} as a guest and wants to join your group. Say *@Match Time YES* here to send them the group's invite link, or tap Send the invite link on their card: ${p.link}`,
  notice_someone: "A guest",
  /** The organisers' YES in the admin group (L10), one line back. */
  hq_link_sending: (p: { name: string }) => `✅ Sending ${p.name} the players' group's invite link.`,
  hq_link_waiting: (p: { name: string; link: string }) =>
    `✅ Approved. ${p.name} gets the invite link as soon as MatchTime has your group's link: make MatchTime an admin of your WhatsApp group, or paste the link in Settings: ${p.link}`,
  hq_join_already: (p: { name: string }) => `${p.name} has already been sent the invite link.`,
  hq_join_closed: (p: { name: string }) => `${p.name}'s request to join is no longer open.`,
  notice_no_link: (p: { link: string }) =>
    `First let MatchTime send your group's link: make MatchTime an admin of your WhatsApp group, or paste the link in Settings: ${p.link}`,
  notice_link_failed: (p: { name: string; link: string }) =>
    `I could not get your group's invite link for ${p.name}. Paste the link in Settings and I'll send it to them: ${p.link}`,

  // ── The guest card (organisers) ───────────────────────────────────────
  card_requested: "Wants to join your group",
  card_send_link: "Send the invite link",
  card_not_now: "Not now",
  card_link_sent: "Invite link sent. Not in the group yet.",
  card_approved: "Approved, waiting for the group link.",
  card_declined: "Said no thanks to joining lately.",
  card_no_link: "To invite guests, make MatchTime an admin of your WhatsApp group, or paste your group's invite link in Settings.",
  card_no_link_cta: "Open Settings",
  card_invited_toast: "Invited. MatchTime asks them privately.",
  card_link_sent_toast: "Done. MatchTime is sending them the invite link.",
  card_closed_toast: "Done. They will not be invited for now.",

  // ── The settings card (organisers) ────────────────────────────────────
  set_title: "Group invite link",
  set_blurb:
    "When a guest and your club both say yes, MatchTime sends the guest your WhatsApp group's invite link privately. Players never see it otherwise.",
  set_option_bot: "Option A (recommended): make MatchTime an admin of your WhatsApp group. It then gets the link itself for each guest you approve.",
  set_option_paste: "Option B: paste your group's invite link below. In WhatsApp, open the group's info, then Invite via link, then Copy link.",
  set_status_bot: "MatchTime is an admin of your group, so it gets the link itself.",
  set_status_pasted: "Your pasted link is used.",
  set_status_none: "Not set up yet: guests cannot be invited to your group.",
  set_label: "Your group's invite link",
  set_save: "Save link",
  set_remove: "Remove",
  set_saved: "Saved. MatchTime sends it only to guests both sides approved.",
  set_removed: "Removed.",
  set_invalid: "That is not a WhatsApp group invite link. It starts with https://chat.whatsapp.com/",
  set_not_hq: "Paste the link of your players' group, not of your admin group.",
  set_sent_waiting: (p: { n: number }) => `Sent to ${p.n} approved ${plural(p.n, "guest", "guests")} who were waiting for it.`,

  // ── My invitations (the player's language) ────────────────────────────
  inv_title: "My invitations",
  inv_intro: "Clubs that would like you to join their group, and games offered to you.",
  inv_clubs: "Club invitations",
  inv_offers: "Game offers",
  inv_none_clubs: "No club invitations right now.",
  inv_none_offers: "No open game offers right now.",
  inv_games_here: (p: { n: number }) => `You played ${p.n} ${plural(p.n, "game", "games")} with them.`,
  inv_join: "Join",
  inv_no: "No thanks",
  inv_waiting_club: "Thanks. Waiting for the club to say yes.",
  inv_link_sent: "Done. The invite link is on its way to you on WhatsApp.",
  inv_declined: "Thanks for letting us know.",
  inv_member: "You are already in this club.",
  inv_open_offer: "Open the offer",
  inv_offer_until: (p: { time: string }) => `Answer by ${p.time}`,
  inv_try_again: "Something went wrong. Please try again in a minute.",
  inv_settings: "Your player pool settings",
};

export type PoolInviteStrings = typeof poolInviteEn;
