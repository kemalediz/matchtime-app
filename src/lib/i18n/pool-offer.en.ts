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
  offer_cta: (p: { link: string }) => `Would you like the place? Reply here, or tap to answer: ${p.link}`,
  footer: (p: { link: string }) => `You get these because you joined the MatchTime player pool. Stop or change them: ${p.link}`,

  // ── After he says yes ─────────────────────────────────────────────────
  placed_in: (p: { club: string; day: string; venue: string }) => `✅ You're in: *${p.club}*, ${p.day}, ${p.venue}.`,
  placed_bench: (p: { club: string; day: string; venue: string }) =>
    `📝 You're on the bench for *${p.club}*, ${p.day}, ${p.venue}. The organisers pick from the bench, and you'll hear if you play.`,
  placed_fee: (p: { amount: string }) => `The match fee is ${p.amount}. You'll get a pay link after the game.`,
  placed_pull_out: (p: { link: string }) => `Can't make it after all? Give the place back here: ${p.link}`,

  // ── Replies in words (L6: the reader; one line each) ──────────────────
  reply_tap: (p: { link: string }) => `To answer the offer, tap the link: ${p.link}`,
  reply_gone: (p: { club: string }) => `Thanks. That place with ${p.club} has gone now. I'll message you about the next game near you.`,
  reply_facts_head: "Here's everything I know about this game:",
  reply_reask: (p: { link: string }) => `Sorry, I didn't quite get that. Would you like the place? Reply yes or no, or tap to answer: ${p.link}`,
  reply_which: (p: { n: number; list: string }) =>
    `You have ${p.n} game offers open. Which one do you mean? Swipe-reply to its message, or tap its link:\n${p.list}`,
  reply_stopped: (p: { link: string }) => `Done, I've stopped game offers. You can start them again here: ${p.link}`,
  reply_profile_off: (p: { link: string }) =>
    `Your game offers are switched off, so I haven't booked anything. You can switch them back on here: ${p.link}`,

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
  // ── The players' group post, for a club with no admin group (Kemal,
  //    2026-10-29): for everyone, never the turn-up record. Giving the
  //    place back is `notice_out`, already worded for everyone. ──────────
  group_notice_in: (p: { name: string; day: string }) => `🙋 ${p.name} from the MatchTime player pool has joined the squad for ${p.day}.`,
  group_notice_bench: (p: { name: string; day: string }) => `🙋 ${p.name} from the MatchTime player pool is on the bench for ${p.day}.`,
  group_notice_bench_pick: (p: { name: string; day: string }) =>
    `🙋 ${p.name} from the MatchTime player pool is on the bench for ${p.day}. The organisers pick who plays from the bench. Organisers, to put ${p.name} in, tag me and say so, for example *@Match Time put ${p.name} in*`,
  turnup_new: "New to MatchTime.",
  turnup_all: (p: { n: number }) =>
    p.n === 1 ? "Played 1 MatchTime game and turned up to it." : `Played ${p.n} MatchTime games, turned up to all of them.`,
  turnup_some: (p: { played: number; n: number }) => `Turned up to ${p.played} of ${p.n} MatchTime games.`,
  /** The short-squad notice's extra line (the organisers' language). */
  notice_offer_line: (p: { band: string; link: string }) => `🔎 Or ask nearby players from the MatchTime pool (${p.band}). Open the match page: ${p.link}`,
  /** The same line in the admin group, where a YES asks the pool (L10). */
  notice_offer_line_hq: (p: { band: string; link: string }) =>
    `🔎 Or I can ask nearby players from the MatchTime pool (${p.band}): reply YES here, or open the match page: ${p.link}`,
  /** The automatic ask asked the pool (slice L9): one line to the organisers. */
  notice_auto: (p: { day: string; partnersFirst: boolean }) =>
    p.partnersFirst
      ? `🔎 Your automatic ask: a place is still open for ${p.day} and nobody is on your bench, so I'll ask nearby players from the MatchTime player pool if your partner clubs have not filled it within the hour. I'll tell you when one takes a place.`
      : `🔎 Your automatic ask: a place is still open for ${p.day} and nobody is on your bench, so I'm asking nearby players from the MatchTime player pool. I'll tell you when one takes a place.`,

  // ── Asking the pool in the organisers' group (L10) ────────────────────
  /** An organiser asked in words, or said YES to the short-squad notice.
   *  `inHq`: said in the admin group, where the organisers hear the rest;
   *  in the players' group they are told the way they always are.
   *  `withPartners`: partner clubs are asked in the same round; the pool is
   *  asked now all the same (Kemal, 2026-10-29: both at once, no waiting). */
  hq_asked: (p: { places: number; day: string; withPartners: boolean; inHq: boolean }) =>
    `🔎 Asking nearby players from the MatchTime player pool for ${p.places} ${plural(p.places, "place", "places")} on ${p.day}${
      p.withPartners ? ", at the same time as your partner clubs" : ""
    }. ${p.inHq ? "I'll tell you here when one takes a place." : "I'll let you know when one takes a place."}`,
  /** Asked for the pool where it is not open for the club: what it can do instead. */
  hq_closed: "*Player pool:* the MatchTime player pool is not open for your club yet. I can ask your players' group if anyone can play instead.",
  /** The ask in words refused (L10, 2026-10-28): what happened, why, and
   *  what to do next, with the exact link when a setting fixes it. Each
   *  starts with what it is about, so it reads on its own next to the
   *  partner clubs' line. The match page keeps its own `refused_*`. */
  ask_refused_club_off: (p: { link: string }) =>
    `*Player pool:* I didn't ask nearby players: the MatchTime player pool is switched off for your club. An owner or admin can switch it on here, or I can ask your players' group instead: ${p.link}`,
  ask_refused_not_organiser: "*Player pool:* only an owner or admin of the club can ask nearby players. Ask one of them to tag me.",
  ask_refused_match_not_open: (p: { day: string }) =>
    `*Player pool:* I didn't ask nearby players: the game on ${p.day} has started, is over or is off, so there's no place to fill.`,
  /** `retry`: the ask is kept and asked again by itself once the venue is
   *  set (pool-ask-retry.ts, asks in words only). */
  ask_refused_no_venue: (p: { club: string; link: string; retry: boolean }) =>
    `*Player pool:* I couldn't ask nearby players yet: MatchTime doesn't know where ${p.club} plays, and pool players are found by how close they live to the pitch. ${p.retry ? "Set the venue on your weekly game here and I'll ask the pool straight away" : "Set the venue on your weekly game, then ask me again"}: ${p.link}`,
  ask_refused_no_sport: (p: { link: string }) =>
    `*Player pool:* I couldn't ask nearby players yet: your weekly game has no sport set, and pool players are matched by sport. Set it on your weekly game, then ask me again: ${p.link}`,
  ask_refused_too_late: (p: { hours: number; link: string }) =>
    `*Player pool:* it's too late to ask nearby players for this game: the last ask goes out ${p.hours === 1 ? "1 hour" : `${p.hours} hours`} before kickoff, as your settings say. You can change that here: ${p.link}`,
  ask_refused_no_places: "*Player pool:* I didn't ask nearby players: every place in this game is taken, so there's nobody to find.",
  ask_refused_round_open: "*Player pool:* nearby players are already being asked for this game, so I haven't asked again. I'll let you know when one takes a place.",
  ask_refused_week_cap:
    "*Player pool:* I didn't ask nearby players: your club has asked the pool 3 times in the last 7 days, the most allowed. You can ask again once the oldest of those asks is a week old.",
  ask_refused_none_near:
    "*Player pool:* I didn't ask anyone: no pool player near your pitch is free to be asked for this game right now. I can ask your players' group instead.",
  ask_refused_generic: "*Player pool:* I couldn't ask nearby players just now. Please try again in a minute.",
  /** Pool players near the venue, but none could be asked: why, as counts
   *  grouped by reason (`why_*`, joined), never who. */
  ask_refused_nobody_new: (p: { near: string; reasons: string; clubTail: boolean }) =>
    `*Player pool:* nobody new to ask. Of the pool players ${p.near}, ${p.reasons}. ${p.clubTail ? "The pool only reaches players outside your club." : "I can ask your players' group instead."}`,
  near_venue: (p: { venue: string }) => `near ${p.venue}`,
  near_pitch: "near your pitch",
  why_club: (p: { n: number; club: string }) => `${p.n} ${p.n === 1 ? "is" : "are"} already in ${p.club}`,
  why_time: (p: { n: number }) => `${p.n} ${p.n === 1 ? "isn't" : "aren't"} free at that time`,
  why_far: (p: { n: number }) => `${p.n} ${p.n === 1 ? "lives" : "live"} further away than they travel`,
  why_format: (p: { n: number }) => `${p.n} ${p.n === 1 ? "plays" : "play"} a different format or level`,
  why_busy: (p: { n: number }) => `${p.n} ${p.n === 1 ? "has" : "have"} another game then`,
  why_on_match: (p: { n: number }) => `${p.n} ${p.n === 1 ? "is" : "are"} already down for this game`,
  why_offered: (p: { n: number }) => `${p.n} ${p.n === 1 ? "has" : "have"} already been offered this game`,
  why_caps: (p: { n: number }) => `${p.n} ${p.n === 1 ? "has" : "have"} had enough offers for now`,

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
