/**
 * THE POOL'S OFFER COPY, ENGLISH (slice L5a, 2026-10-24). Every word a pool
 * offer, its replies, the organisers' notice, the match page's pool line
 * and the offer page say. Kept out of the flat `strings.*.ts` tables (as
 * the privacy policy is) because it is one feature's long copy; the house
 * rules still hold and are unit tested (`__tests__/pool-offer-copy.test.ts`):
 * no em or en dashes, "bench" never "waiting list", no time-of-day
 * greeting, Turkish never equal to English.
 *
 * Facts only, never a person: no group name, no member or organiser name,
 * no phone number (approved spec, "Offer"). WhatsApp bold is *one star*.
 */
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export const poolOfferEn = {
  // ── The offer DM ──────────────────────────────────────────────────────
  offer_head: (p: { club: string; places: number; game: string }) =>
    `⚽ *${p.club}* needs ${p.places} ${plural(p.places, "player", "players")} for a ${p.game}`,
  game_with_format: (p: { format: string; sport: string }) => `${p.format} ${p.sport.toLowerCase()} game`,
  game_plain: (p: { sport: string }) => `${p.sport.toLowerCase()} game`,
  offer_when: (p: { day: string; mins: number }) => `📅 *${p.day}* (${p.mins} mins)`,
  distance: (p: { miles: string; one: boolean }) => `${p.miles} ${p.one ? "mile" : "miles"} from you`,
  map: (p: { url: string }) => `Map: ${p.url}`,
  style_casual: "Casual, friendly game",
  style_competitive: "Competitive game",
  style_mixed: "Mixed levels, everyone welcome",
  club_weekly: (p: { members: number }) => `A regular group of ${p.members} players, playing every week`,
  club_games: (p: { members: number; games: number }) =>
    `A group of ${p.members} players, ${p.games} ${plural(p.games, "game", "games")} in the last 8 weeks`,
  club_size: (p: { members: number }) => `A group of ${p.members} players`,
  fee: (p: { amount: string }) => `💷 ${p.amount} match fee`,
  free: "💷 Free, no match fee",
  offer_cta: (p: { link: string }) => `Would you like the place? Tap to say yes or no: ${p.link}`,
  footer: (p: { link: string }) => `You get these because you joined the MatchTime player pool. Stop or change them: ${p.link}`,

  // ── After he says yes ─────────────────────────────────────────────────
  placed_in: (p: { club: string; day: string; venue: string }) => `✅ You're in: *${p.club}*, ${p.day}, ${p.venue}.`,
  placed_bench: (p: { club: string; day: string; venue: string }) =>
    `📝 You're on the bench for *${p.club}*, ${p.day}, ${p.venue}. The organisers pick from the bench, and you'll hear if you play.`,
  placed_fee: (p: { amount: string }) => `The match fee is ${p.amount}. You'll get a pay link after the game.`,
  placed_pull_out: (p: { link: string }) => `Can't make it after all? Give the place back here: ${p.link}`,

  // ── Replies in words (L6 reads them; until then one line) ─────────────
  reply_tap: (p: { link: string }) => `To answer the offer, tap the link: ${p.link}`,
  reply_gone: (p: { club: string }) => `Thanks. That place with ${p.club} has gone now. I'll message you about the next game near you.`,

  // ── Paused after offers went unanswered ───────────────────────────────
  paused: (p: { n: number; link: string }) =>
    `I've paused game offers because the last ${p.n} went unanswered. Want them again? Tap here: ${p.link}`,

  // ── The organisers' notice (the club's language) ──────────────────────
  notice_in: (p: { name: string; day: string; turnUp: string }) =>
    `🙋 ${p.name} from the MatchTime player pool took a place for ${p.day}. ${p.turnUp}`,
  notice_bench: (p: { name: string; day: string; turnUp: string }) =>
    `🙋 ${p.name} from the MatchTime player pool is on the bench for ${p.day}, for you to pick. ${p.turnUp}`,
  notice_out: (p: { name: string; day: string }) =>
    `${p.name} from the MatchTime player pool can no longer play on ${p.day}. The place is open again.`,
  turnup_new: "New to MatchTime.",
  turnup_all: (p: { n: number }) =>
    p.n === 1 ? "Played 1 MatchTime game and turned up to it." : `Played ${p.n} MatchTime games, turned up to all of them.`,
  turnup_some: (p: { played: number; n: number }) => `Turned up to ${p.played} of ${p.n} MatchTime games.`,
  /** The short-squad notice's extra line (the organisers' language). */
  notice_offer_line: (p: { band: string; link: string }) => `🔎 Or ask nearby players from the MatchTime pool (${p.band}). Open the match page: ${p.link}`,

  // ── The match page's pool line (organisers) ───────────────────────────
  pool_label: "MatchTime player pool",
  band_none: "no pool players near this venue yet",
  band_few: "a few near you",
  band_many: "5+ near you",
  panel_no_venue: "Confirm your venue on the match page to ask nearby players from the MatchTime pool.",
  panel_partners_first: "Pool players are asked an hour after your partner clubs, if places are still open.",
  panel_asked: (p: { asked: number; declined: number }) =>
    `Asked ${p.asked} nearby ${plural(p.asked, "player", "players")}${p.declined > 0 ? `, ${p.declined} said no` : ""}.`,
  panel_waiting: "Waiting to ask nearby players.",
  toast_asked: (p: { places: number }) => `Asking nearby players from the MatchTime pool for ${p.places} ${plural(p.places, "player", "players")}.`,
  refused_closed: "The MatchTime player pool is not open for your club.",
  refused_no_venue: "Confirm your venue first: nearby players are found by the pitch.",
  refused_too_late: "It is too close to kickoff to ask nearby players now.",
  refused_round_open: "Nearby players are already being asked for this game.",
  refused_week_cap: "Your club has asked the pool 3 times this week already.",
  refused_no_places: "There are no open places to fill.",
  refused_bad_number: (p: { max: number }) => `Choose between 1 and ${p.max} ${plural(p.max, "player", "players")}.`,
  refused_none_near: "There are no pool players near this venue for this game yet.",
  refused_generic: "Nearby players could not be asked just now. Try again in a minute.",

  // ── The offer page (the player's language) ────────────────────────────
  page_title: "A game for you",
  page_yes: "Yes, I'll play",
  page_no: "No thanks",
  page_map: "Open in maps",
  page_manage: "Stop or change these messages",
  page_declined: "Thanks for letting us know. We'll message you about the next game near you.",
  page_gone: "Sorry, this place has gone. We'll message you about the next game near you.",
  page_expired: "This offer has ended. We'll message you about the next game near you.",
  page_invalid: "This link does not work. It may be old or copied wrongly.",
  page_off: "This game is off. Sorry about that.",
  page_pull_out: "I can't make it any more",
  page_pulled_out: "Done, your place is free again. Thanks for telling us.",
  page_try_again: "Something went wrong. Please try again in a minute.",
  page_busy: "You already have a place with this club for another game. Once that game is played you can take another.",
  page_verify_label: "Is this your offer? Type the last 4 digits of the WhatsApp number it came to",
  page_confirm: "Show my offer",
  page_verify_wrong: "Those digits do not match. Please try again.",
  page_verify_locked: "Too many tries. Open the 'Stop or change' link in your WhatsApp message to sign in, then open this offer again.",
};

export type PoolOfferStrings = typeof poolOfferEn;
