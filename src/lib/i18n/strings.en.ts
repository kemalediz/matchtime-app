/**
 * THE ENGLISH STRING TABLE, and the TYPE every other language must satisfy.
 *
 * `type Strings = typeof en` (in ./t.ts). `strings.tr.ts` is declared
 * `const tr: Strings`, so a key missing from Turkish is a `tsc` error and
 * the build fails. That is the "missing key fails the build" rule, with
 * no runtime machinery.
 *
 * Every entry with parameters is a FUNCTION `(p) => string`, never a
 * `"{name}"` interpolation string. Turkish attaches case suffixes to the
 * thing it names ("Salı'ya", "Sim Arena'da") and vowel harmony decides
 * the suffix, so a placeholder dropped into a fixed sentence is wrong for
 * half the venues and names. A function lets the native speaker write
 * the sentence so the interpolated value sits in a suffix-free position.
 *
 * ── WHAT IS HERE ────────────────────────────────────────────────────
 *
 * Phase 2, slice 1 (2026-09-17): the week-one group subset. The posts a
 * new group reads most in its first week: the announcement, the 17:00
 * evening update in all its shapes, squad complete, the teams post, a
 * slot opening, the bench offer, the rating promo, the match-day chase
 * fallback, the payment poll and its chase tail. Every entry's English
 * is the composer's original wording, moved BYTE FOR BYTE; the golden
 * snapshot (`__tests__/copy-golden.test.ts`) proves it.
 *
 * Keys are grouped by the composer that reads them and labelled with
 * the design's inventory row (MDs/multi-language-design-2026-09-16.md
 * section 1). A composer does `const s = t(lang)` once and reads
 * `s.key(...)`; the structural parts (numbering, line breaks, the
 * 🥁 placeholder rows) stay in the composer because they are the same
 * in every language.
 *
 * ── WHEN YOU ADD AN ENTRY ───────────────────────────────────────────
 *
 *   - WhatsApp formatting, not markdown: `*bold*`, no headings.
 *   - Keep the emoji the English copy uses, in the same positions.
 *   - No time-of-day greeting and no send-time stamp
 *     (`no-time-of-day-greeting.test.ts` scans this directory too).
 *   - The English wording is moved BYTE FOR BYTE. If the current English
 *     contains an em dash, it keeps it: the golden snapshot decides,
 *     not house style. Cleaning it up is a separate, visible change.
 *   - Add the Turkish in the same PR (`strings.tr.ts`) and a sample
 *     argument in `__tests__/strings.test.ts`; both are enforced.
 *
 * See MDs/multi-language-design-2026-09-16.md section 4.2.
 */
import { joinList } from "./text";

export const en = {
  // ── shared fragments ─────────────────────────────────────────────

  /** A roster row whose user has no name on record. */
  unnamed: "(unnamed)",

  /** What `state.kickoffLabel` says when the group has no upcoming
   *  match to put a day and time on (load-state.ts). */
  no_match_label: "the next match",

  // ── row 1: composeSquadStatusPost (group-copy.ts) ────────────────

  squad_status_lead: (p: { withBench: boolean; confirmed: number; maxPlayers: number; need: number }): string => {
    const count = `*${p.confirmed}/${p.maxPlayers}*`;
    return (
      `📋 Based on all the messages I've picked up, here's the latest squad${p.withBench ? " and bench" : ""} — ` +
      (p.need > 0 ? `${count}, need *${p.need} more* 🙏` : `${count} ✅ full squad.`)
    );
  },
  playing_header: "*Playing:*",
  bench_header: (p: { count: number }): string => `*Bench (${p.count}):*`,

  // ── row 2: formatTeamsPost (group-copy.ts) ───────────────────────

  teams_post_header: (p: { kickoff: string; venue: string }): string =>
    `⚽ *Teams for tonight* — ${p.kickoff} at ${p.venue}`,
  teams_post_footer: "Objections? Reply `@Match Time swap X with Y` and an admin will confirm.",

  // ── row 2b: replacement_teams_post (pipeline/compose.ts) ─────────
  //   NEW copy, 2026-09-15, for the Wasim/Shahrokh incident: a
  //   replacement arrived an hour after the teams had been announced
  //   and the sheet was never touched, so the last line-up standing in
  //   the group named a man who was at home with a fever.
  //
  //   The lead says who left and who took their place; `formatTeamsPost`
  //   prints the sheet under it with `replacement_note` marking the line
  //   it happened on, and `teams_post_footer_after_replacement` replaces
  //   the standing footer, because "reply swap X with Y" is the wrong
  //   instruction on a post whose whole subject is a swap already made.
  //
  //   It names the team LABEL, never the colour: this club renames its
  //   sides and `resolveTeamLabels` is what decides.

  replacement_note: (p: { from: string }): string => `replacing ${p.from}`,
  replacement_lead: (p: {
    /** Only those who actually went OUT. A confirmed player demoted to
     *  the bench vacates a slot without being out, and this must not say
     *  otherwise. Empty is a normal case. */
    outNames: string[];
    swaps: { inName: string; outName: string; teamLabel: string }[];
  }): string => {
    if (p.swaps.length === 1 && p.outNames.length === 1) {
      return (
        `🔁 *${p.outNames[0]} is out* — *${p.swaps[0].inName}* takes his place ` +
        `and his spot in *${p.swaps[0].teamLabel}*.`
      );
    }
    const head =
      p.outNames.length > 0
        ? `🔁 *${joinList("en", p.outNames)} ${p.outNames.length === 1 ? "is" : "are"} out* — `
        : "🔁 ";
    return (
      head +
      p.swaps
        .map((x) => `*${x.inName}* takes ${x.outName}'s spot in *${x.teamLabel}*`)
        .join(", ") +
      "."
    );
  },
  teams_post_footer_after_replacement:
    "Objections? An admin can ask me to regenerate the teams.",

  // ── row 43: buildSquadCompletePost (group-copy.ts) ───────────────

  squad_complete_header: (p: { maxPlayers: number; activityName: string; kickoffLabel: string }): string =>
    `✅ *Squad complete — ${p.maxPlayers}/${p.maxPlayers}* for *${p.activityName}* on ${p.kickoffLabel} 🙌`,
  squad_complete_signoff: "See you all there ⚽",

  // ── rows 52, 53, 54: the bench-promotion promise (bench-offer-copy.ts)

  /** How a bench place turns into a game, as one clause. Shared by the
   *  day-one intro, the full-squad recruit answer and the squad-complete
   *  invite, so the promise cannot say different things in different
   *  places. `reactions` is BENCH_PROMPT_MENTION_REACTIONS. */
  bench_promotion_how: (p: { reactions: boolean }): string =>
    p.reactions
      ? "the first to react 👍 or reply *IN* takes the slot"
      : "the first to reply *IN* takes the slot",
  /** The closing line of the squad-complete post when the bench feature
   *  is on. `how` is `bench_promotion_how`. */
  squad_complete_bench_invite: (p: { how: string }): string =>
    `🪑 *Bench is open.* Say *IN* and I'll put you on the bench. ` +
    `If someone drops out I tag the bench here and ${p.how}.`,
  /** The group post that offers an open slot to the whole bench at once. */
  bench_offer_group_post: (p: { context: string; tagList: string; reactions: boolean }): string => {
    const claim = p.reactions
      ? "React 👍 here or reply *IN* to take it."
      : "Just reply *IN* here to take it.";
    return (
      `🎟 A slot just opened ${p.context}. *First to claim it plays.*\n\n` +
      `${p.tagList}\n\n` +
      `${claim} No rush and no timeout, whoever is free first gets it ` +
      `and everyone else stays on the bench. 🙏`
    );
  },

  // ── row 81: the bench offer's context clause (scheduler-copy.ts) ──
  //   `_plain` twins are for the DM (row 85), which stays English in
  //   Phase 2; they are here so the pair moves together in Phase 3.

  bench_offer_context_team: (p: { teamLabel: string; replacingName: string; activityName: string }): string =>
    `on *${p.teamLabel}* (replacing ${p.replacingName}) for *${p.activityName}* tonight`,
  bench_offer_context_team_plain: (p: { teamLabel: string; replacingName: string; activityName: string }): string =>
    `on ${p.teamLabel} (replacing ${p.replacingName}) for ${p.activityName} tonight`,
  bench_offer_context_fixture: (p: { activityName: string }): string => `for *${p.activityName}* tonight`,
  bench_offer_context_fixture_plain: (p: { activityName: string }): string => `for ${p.activityName} tonight`,

  // ── row 3: buildRatePromoPost (group-copy.ts) ────────────────────

  rate_promo: (p: { activityName: string; matchDateLabel: string }): string =>
    `🎯 Just DM'd every player from the *${p.activityName}* on ${p.matchDateLabel} ` +
    `a personal rating link. The more ratings we get, the better-balanced the ` +
    `teams get next week. Check your DMs from me 👇`,

  // ── row 4: buildMatchDayChaseFallback (group-copy.ts) ────────────

  match_day_chase_fallback: (p: { need: number; activityName: string }): string =>
    `☀️ Still *${p.need} short* for tonight's *${p.activityName}*. Any takers? 👀`,

  // ── row 38: bench_offer_open (compose.ts) ────────────────────────

  bench_offer_open: (p: { benchNames: string[] }): string =>
    `A slot just opened 🎟 ${joinList("en", p.benchNames)}, first to say IN takes it. Nobody gets dropped.`,

  // ── row 39: slot_opened (compose.ts) ─────────────────────────────
  //   "13 of 14", never "13/14", and "slot", never "spot": both are
  //   load-bearing for the composition guards (see compose.ts).

  slot_opened: (p: { outFirstNames: string[]; confirmed: number; maxPlayers: number; kickoffLabel: string; open: number }): string => {
    const names = p.outFirstNames;
    const lead =
      names.length === 0
        ? "That's"
        : `${joinList("en", names)} ${names.length === 1 ? "is" : "are"} out,`;
    const slots =
      p.open === 1
        ? "One slot open, say *IN* to take it."
        : `${p.open} slots open, say *IN* to take one.`;
    return `${lead} ${p.confirmed} of ${p.maxPlayers} for ${p.kickoffLabel}. ${slots}`;
  },

  // ── row 68: buildAnnounceMatchPost (scheduler-copy.ts) ───────────

  announce_match: (p: { activityName: string; dateLabel: string; venue: string; maxPlayers: number }): string =>
    `📅 *${p.activityName}* — *${p.dateLabel}* at ${p.venue}.\n\nSay *IN* to join. First ${p.maxPlayers} confirmed play.`,

  // ── row 71: buildSquadRosterBlock (scheduler-copy.ts) ────────────

  roster_confirmed_header: (p: { confirmed: number; maxPlayers: number }): string =>
    `*Confirmed (${p.confirmed}/${p.maxPlayers}):*`,
  roster_nobody_yet: "_nobody yet_",

  // ── row 71b: buildSquadFullEveningPost (scheduler-copy.ts) ───────

  /** The lead of the 17:00 post when the squad is already full. New
   *  copy (2026-09-17), so it follows house style rather than its
   *  neighbour `daily_in_list_fallback_lead`: no em dash. It states the
   *  count because the post below it lists the names, and the group
   *  should be able to check one against the other. */
  squad_full_evening_lead: (p: { activityName: string; confirmed: number; maxPlayers: number }): string =>
    `🗓 *${p.activityName}*: squad is full, *${p.confirmed}/${p.maxPlayers}* ✅`,

  // ── rows 69, 70: the match-day 17:00 posts (scheduler-copy.ts) ───

  match_day_header: (p: { timeLabel: string; activityName: string; venue: string }): string =>
    `⚽ *Tonight at ${p.timeLabel}* — *${p.activityName}* at ${p.venue}`,
  match_day_teams_signoff: "See you tonight 🙌",
  match_day_locked_line:
    "Squad is locked. Say *@Match Time generate the teams* in the chat to lock in tonight's lineup 👇",

  // ── row 72: buildDailyInListFallback (scheduler-copy.ts) ─────────

  daily_in_list_fallback_lead: (p: { activityName: string; need: number }): string =>
    `🗓 *${p.activityName}* — need *${p.need} more*.`,

  // ── row 73: buildUnpaidTailText (scheduler-copy.ts) ──────────────

  unpaid_tail: (p: { unpaid: number }): string =>
    p.unpaid === 1
      ? `💳 1 payment still pending for last week's match — if you've already paid, tick your team in the poll above to clear it 🙏`
      : `💳 *${p.unpaid}* payments still pending for last week's match — if you've already paid, just tick your team in the poll above to clear it 🙏`,

  // ── row 78: buildPaymentPollQuestion (scheduler-copy.ts) ─────────

  payment_poll_question: (p: { activityName: string }): string =>
    `💳 Payments for *${p.activityName}* — tick when you've paid`,

  // ═══════════════════════════════════════════════════════════════════
  // Phase 2, slice 2: the rest of the group-facing deterministic copy.
  // ═══════════════════════════════════════════════════════════════════

  // ── row 5: the name a pushname that is a phone number prints as ────

  fallback_player: "a player",

  // ── rows 6 to 30: the batch answers (compose.ts) ───────────────────

  answer_count: (p: { stated: boolean; confirmed: number; maxPlayers: number; kickoffLabel: string; need: number }): string => {
    const head = p.stated
      ? `Not quite, we're ${p.confirmed}/${p.maxPlayers} for ${p.kickoffLabel}`
      : `We're ${p.confirmed}/${p.maxPlayers} for ${p.kickoffLabel}`;
    const tail = p.need > 0 ? `, need ${p.need} more 🙏` : " ✅ full squad.";
    return `${head}${tail}`;
  },
  answer_fixture: (p: { kickoffLabel: string; venue: string }): string =>
    p.venue ? `⚽ ${p.kickoffLabel} at ${p.venue}.` : `⚽ ${p.kickoffLabel}.`,
  answer_score_no_match: "I haven't got a played match on record for this group yet.",
  answer_score_no_score: (p: { kickoffLabel: string }): string =>
    `No score reported for ${p.kickoffLabel} yet — tell me the result and I'll record it.`,
  answer_score_result: (p: { kickoffLabel: string; redLabel: string; red: number; yellow: number; yellowLabel: string; winnerLabel: string | null }): string =>
    `⚽ ${p.kickoffLabel}: ${p.redLabel} ${p.red} - ${p.yellow} ${p.yellowLabel}. ${p.winnerLabel === null ? "A draw." : `${p.winnerLabel} won.`}`,
  answer_payments_not_tracked: "I don't track payments for this group, so I can't say who's settled up.",
  answer_payments_no_settled: "There's no settled match for me to check payments against yet.",
  answer_payments_no_signal: (p: { kickoffLabel: string }): string =>
    `No payments have reached me for ${p.kickoffLabel} — that could mean nobody's paid, or that I'm just not seeing them, so I'd rather not put a number on it.`,
  answer_payments_all_settled: (p: { kickoffLabel: string }): string => `💳 All settled for ${p.kickoffLabel} 🙌`,
  answer_payments_unpaid: (p: { unpaid: number; chargeable: number; kickoffLabel: string }): string =>
    `💳 ${p.unpaid} of ${p.chargeable} still to pay for ${p.kickoffLabel}. I don't put names to that in the group.`,
  answer_bench_empty: "Nobody's on the bench right now.",
  answer_bench_list: (p: { names: string[] }): string => `On the bench: ${joinList("en", p.names)}.`,
  answer_person_not_down: (p: { who: string; kickoffLabel: string }): string => `${p.who} isn't down for ${p.kickoffLabel} yet.`,
  answer_person_bench: (p: { who: string; kickoffLabel: string }): string => `${p.who} is on the bench for ${p.kickoffLabel}.`,
  answer_person_confirmed: (p: { who: string; kickoffLabel: string }): string => `Yes, ${p.who} has a slot for ${p.kickoffLabel}.`,
  answer_phones_none: "Everyone in the squad has a number on record.",
  answer_phones_missing: (p: { names: string[] }): string => `No number on record for ${joinList("en", p.names)}.`,
  answer_stats_empty: (p: { windowDays: number }): string =>
    `I don't have any completed matches in the last ${p.windowDays} days to go on, so I can't call anyone the most consistent.`,
  answer_stats_head: (p: { windowDays: number }): string => `Most appearances in the last ${p.windowDays} days:`,
  /** ⚠️ The em dash separator is load-bearing: `isLeaderboardLine`
   *  (group-copy.ts) keys on it so a stats answer is never mistaken
   *  for a roster. Any language's row must carry one of that function's
   *  markers. */
  answer_stats_row: (p: { rank: number; name: string; matches: number }): string =>
    `${p.rank}. ${p.name} — ${p.matches} ${p.matches === 1 ? "match" : "matches"}`,
  answer_options_lead: (p: { confirmed: number; maxPlayers: number; need: number }): string =>
    p.need > 0
      ? `We're ${p.confirmed} of ${p.maxPlayers}, need ${p.need} more 🙏`
      : `We're ${p.confirmed} of ${p.maxPlayers} ✅ full squad.`,
  answer_options_no_formats: "There's no smaller format set up for this group, so it's more players or nothing.",
  answer_options_none_viable: "No smaller format would be filled by the squad we have, so it's more players.",

  // ── the stats tables (2026-09-23), rendered by `pipeline/stats-answer.ts` ──
  // Every row carries one of `isLeaderboardLine`'s markers ("matches",
  // "wins", "%"), so none of these is ever mistaken for the squad list;
  // the route also skips them by intent (`skipsSquadComposition`).
  stats_ratings_head: (p: { n: number; minGames: number }): string =>
    `Top ${p.n} club ratings (players with ${p.minGames}+ rated matches):`,
  stats_ratings_row: (p: { rank: number; name: string; avg: string; games: number }): string =>
    `${p.rank}. ${p.name}: ${p.avg} (${p.games} ${p.games === 1 ? "match" : "matches"})`,
  stats_ratings_empty: (p: { minGames: number; url: string }): string =>
    `Nobody has ${p.minGames} rated matches yet, so there's no ratings table to share. The full stats are on the website: ${p.url}`,
  stats_capped: (p: { cap: number; url: string }): string =>
    `I list the top ${p.cap} in the group. The full table is on the website: ${p.url}`,
  stats_bottom: (p: { url: string }): string =>
    `I only share the top of the tables in the group, never the bottom. The full tables are on the website: ${p.url}`,
  stats_mom_head: "Most Man of the Match wins:",
  stats_mom_row: (p: { rank: number; name: string; wins: number }): string =>
    `${p.rank}. ${p.name}: ${p.wins} ${p.wins === 1 ? "win" : "wins"}`,
  stats_mom_empty: "Nobody has won Man of the Match yet.",
  stats_elo_head: (p: { n: number; minMatches: number }): string =>
    `Top ${p.n} by Elo (${p.minMatches}+ matches played):`,
  stats_elo_row: (p: { rank: number; name: string; rating: number; matches: number }): string =>
    `${p.rank}. ${p.name}: ${p.rating} (${p.matches} ${p.matches === 1 ? "match" : "matches"})`,
  stats_elo_empty: (p: { minMatches: number }): string =>
    `Nobody has played ${p.minMatches} matches yet, so there's no Elo table to share.`,
  stats_tots_head: (p: { sportName: string; minGames: number }): string =>
    `Team of the Season (${p.sportName}), the best average rating in each position (${p.minGames}+ rated matches):`,
  stats_tots_row: (p: { n: number; name: string; position: string | null; avg: string; games: number }): string =>
    `${p.n}. ${p.name}${p.position ? ` (${p.position})` : ""}: ${p.avg} (${p.games} ${p.games === 1 ? "match" : "matches"})`,
  stats_tots_empty: (p: { minGames: number }): string =>
    `There's no Team of the Season yet: nobody has ${p.minGames} rated matches.`,
  stats_movers_head:
    "I track rating movement match by match, so these are the biggest climbers in the club ratings since the last match:",
  /** `rank` is null outside the top ten: the group is never told a
   *  position below the top of the table, even a climber's. */
  stats_movers_row: (p: { n: number; name: string; delta: number; rank: number | null; games: number }): string =>
    `${p.n}. ${p.name}: up ${p.delta} ${p.delta === 1 ? "place" : "places"}${p.rank !== null ? ` to no. ${p.rank}` : ""} (${p.games} ${p.games === 1 ? "match" : "matches"})`,
  stats_movers_empty: "Nobody climbed the club ratings table after the last match.",
  stats_reliable_head: (p: { minAvg: string; minGames: number }): string =>
    `Mr Reliable, the badge on the stats page (an average of ${p.minAvg} or more, little variation, ${p.minGames}+ rated matches), most consistent first:`,
  stats_reliable_row: (p: { n: number; name: string; avg: string; games: number }): string =>
    `${p.n}. ${p.name}: ${p.avg} average (${p.games} ${p.games === 1 ? "match" : "matches"})`,
  stats_reliable_empty: (p: { minAvg: string; minGames: number }): string =>
    `Nobody holds the Mr Reliable badge yet (an average of ${p.minAvg} or more, little variation, ${p.minGames}+ rated matches).`,
  stats_chem_head: (p: { name: string }): string => `${p.name}'s best team-mates:`,
  stats_chem_winrate: (p: { partner: string; wins: number; games: number; pct: number }): string =>
    `• By win rate: ${p.partner}, ${p.wins} ${p.wins === 1 ? "win" : "wins"} in ${p.games} matches together (${p.pct}%)`,
  stats_chem_rating: (p: { partner: string; player: string; avg: string }): string =>
    `• By rating: ${p.partner}, ${p.player} averages ${p.avg} alongside them`,
  stats_chem_nemesis: (p: { name: string; player: string; wins: number; games: number }): string =>
    `• Nemesis: ${p.name}, ${p.player} has won ${p.wins} of ${p.games} against them`,
  stats_chem_empty: (p: { name: string }): string =>
    `${p.name} hasn't played 2 matches with the same team-mate yet, so there's no chemistry to show.`,
  stats_generic_safe: (p: { url: string }): string =>
    `I can't answer that one exactly from here. All the stats are on the website: ${p.url}`,
  stats_ask_unknown: (p: { asker: string | null; ref: string }): string =>
    `${p.asker ? `${p.asker}, I` : "I"} don't have a ${p.ref} in the squad. Who do you mean?`,
  stats_ask_ambiguous: (p: { asker: string | null; choices: string }): string =>
    `${p.asker ? `${p.asker}, do` : "Do"} you mean ${p.choices}?`,

  // ── rows 32 to 42: the acks (compose.ts) ───────────────────────────

  teams_not_generated: "No teams generated yet. Say '@Match Time generate the teams' and I'll sort them.",
  score_ack: (p: { redLabel: string; red: number; yellow: number; yellowLabel: string }): string =>
    `Got it 👍 ${p.redLabel} ${p.red} - ${p.yellow} ${p.yellowLabel}, recorded.`,
  payment_ack: (p: { firstName: string; count: number }): string =>
    `Noted 🙌 ${p.firstName} covered ${p.count} ${p.count === 1 ? "player" : "players"}.`,
  reminder_ack_resolved: (p: { whenLabel: string }): string => `👍 Got it — I'll DM you ${p.whenLabel}.`,
  reminder_ack_unresolved: (p: { phrase: string }): string => `Will do 👍 I'll give you a nudge ${p.phrase}.`,
  needs_tag_for_rest: (p: { dropped: string[]; benched: string[] }): string => {
    const parts: string[] = [];
    if (p.dropped.length > 0) parts.push(`taken ${joinList("en", p.dropped)} out`);
    if (p.benched.length > 0) parts.push(`moved ${joinList("en", p.benched)} to the bench`);
    return (
      `One thing I've left alone: I've not ${parts.join(" or ")}. ` +
      `That bit needs an @Match Time tag, so tag me and I'll sort it 👍`
    );
  },
  bench_claim_too_late: (p: { firstName: string; confirmed: number; maxPlayers: number }): string =>
    `Thanks ${p.firstName} 🙏 someone got there first, so the squad is back to ` +
    `${p.confirmed}/${p.maxPlayers}. You're still on the bench and ` +
    `first in line if another slot opens.`,
  pending_confirmed_ack: (p: { names: string[]; kickoffLabel: string }): string =>
    `Got it 🙌 ${joinList("en", p.names)} ${p.names.length === 1 ? "is" : "are"} down for ${p.kickoffLabel}.`,

  // ── row 44: renderGuestNameAsk (guest-name-ask.ts) ─────────────────

  guest_name_ask: (p: { firstName: string | null; plural: boolean }): string => {
    const opener = p.firstName ? `Nice one ${p.firstName} 🙌` : "Nice one 🙌";
    return p.plural
      ? `${opener} What are their names? Reply with them and I'll add them to the squad.`
      : `${opener} What's their name? Reply with it and I'll add them to the squad.`;
  },

  // ── row 45: buildMomAnnouncement (mom-announcement.ts) ─────────────

  mom_header: (p: { mvpLabel: string; activityName: string }): string => `🏆 *${p.mvpLabel} — ${p.activityName}*`,
  mom_winner: (p: { name: string; top: number; total: number }): string =>
    `Congrats *${p.name}* (${p.top}/${p.total} vote${p.total === 1 ? "" : "s"}) 🎉`,
  mom_shared: (p: { names: string; top: number; total: number }): string =>
    `Shared between *${p.names}* (${p.top} vote${p.top === 1 ? "" : "s"} each, ${p.total} total) 🎉`,
  mom_votes_header: "Votes:",
  mom_vote_row: (p: { name: string; votes: number }): string => `• ${p.name} — ${p.votes}`,
  mom_trophy_line: "Your trophy awaits next match.",

  // ── row 46: the format-switch proposal (format-switch.ts) ──────────
  //   The model is told to paste this line VERBATIM into a chase, so
  //   the words come from here in both paths.

  format_switch_proposal: (p: { shortBy: number; formatName: string; total: number; confirmed: number; benched: string[] }): string => {
    const lead =
      `If we don't find ${p.shortBy} more, we could switch to ` +
      `${p.formatName} (${p.total} players) — `;
    const tail = " Admins can rebook and flip it in the portal.";
    return p.benched.length === 0
      ? `${lead}all ${p.confirmed} of you still play, nobody goes on the bench.${tail}`
      : `${lead}${p.benched.join(" + ")} ${p.benched.length === 1 ? "goes" : "go"} on the bench.${tail}`;
  },

  // ── row 47: renderKickoffMoveLine (format-switch-time.ts) ──────────

  kickoff_move_line: (p: { newTime: string; oldTime: string }): string =>
    `⏰ *Kickoff moves to ${p.newTime}* (was ${p.oldTime}).`,

  // ── row 48: buildOutOfBandAttendanceLine (out-of-band-attendance.ts)

  oob_player_fallback: "A player",
  oob_in: (p: { name: string; source: "dm" | "app" | "reaction"; confirmed: number; maxPlayers: number }): string => {
    const how = p.source === "reaction" ? "👍 on their invite" : p.source === "dm" ? "replied by DM" : "from the app";
    return `✅ *${p.name}* is IN (${how}). Squad *${p.confirmed}/${p.maxPlayers}*.`;
  },
  oob_bench: (p: { name: string; source: "dm" | "app" | "reaction"; confirmed: number; maxPlayers: number }): string => {
    const how =
      p.source === "reaction"
        ? "gave a 👍 on their invite"
        : p.source === "dm"
          ? "replied IN by DM"
          : "marked IN on the app";
    return `📋 *${p.name}* ${how} and goes to the bench. Squad *${p.confirmed}/${p.maxPlayers}*.`;
  },
  oob_out: (p: { name: string; source: "dm" | "app" | "reaction"; confirmed: number; maxPlayers: number }): string => {
    const how = p.source === "reaction" ? "👎 on their invite" : p.source === "dm" ? "replied by DM" : "from the app";
    return `❌ *${p.name}* is OUT (${how}). Squad *${p.confirmed}/${p.maxPlayers}*.`;
  },

  // ── row 49: buildBenchClaimAnnouncement (bench-offer-copy.ts) ──────

  bench_claim_team: (p: { claimer: string; dropped: string; teamLabel: string }): string =>
    `🎟 *${p.claimer}* grabbed the slot — taking *${p.dropped}*'s place on *${p.teamLabel}* 🙌\n\n` +
    `_Say "@Match Time regenerate the teams" if you want to rebalance with the new line-up._`,
  bench_claim_replacing: (p: { claimer: string; dropped: string; confirmed: number; maxPlayers: number }): string =>
    `✅ *${p.claimer}* is in, replacing *${p.dropped}* — squad *${p.confirmed}/${p.maxPlayers}* 🙌`,
  bench_claim_open: (p: { claimer: string; confirmed: number; maxPlayers: number }): string =>
    `✅ *${p.claimer}* grabbed the open slot — squad *${p.confirmed}/${p.maxPlayers}* 🙌`,

  // ── rows 53, 54, 55: the rest of bench-offer-copy.ts ───────────────

  bench_intro_line: (p: { how: string }): string =>
    `🔁  *Bench promotion* — If someone drops, I tag the bench here and ` +
    `${p.how}. No timeout, and nobody loses their place for missing it.`,
  full_squad_bench_invite: (p: { matchName: string; confirmed: number; maxPlayers: number; how: string }): string =>
    `*${p.matchName}* is full at ${p.confirmed} of ${p.maxPlayers}, but the bench is open. ` +
    `Say *IN* and I'll put you on the bench. If someone drops out I tag the bench in the group ` +
    `and ${p.how}. 🙏`,
  bench_asked_line: (p: { benchName: string; confirmed: number; maxPlayers: number; reactions: boolean }): string => {
    const how = p.reactions
      ? "they've been tagged here with a 👍 prompt"
      : "they're tagged here and just need to reply *IN*";
    return (
      `Asking *${p.benchName}* to step up, ${how}. ` +
      `Squad is *${p.confirmed}/${p.maxPlayers}* until they confirm.`
    );
  },

  // ── row 50: planUnresolvedNudge (unresolved-nudge.ts) ──────────────

  unresolved_nudge_named: (p: { verb: "join" | "drop out"; pushname: string }): string =>
    `Heads up — I got a message to *${p.verb}* from *${p.pushname}*, but that name isn't ` +
    `matching anyone on the squad list, so I haven't changed anything yet. ` +
    `Could *${p.pushname}* reply with the name they're registered under, or an admin can link it on the dashboard? 🙏`,
  unresolved_nudge_anonymous: (p: { verb: "join" | "drop out" }): string =>
    `Heads up — I got a message to *${p.verb}* from someone I don't recognise, ` +
    `so I haven't changed anything yet. Could they reply with the name they're ` +
    `registered under, or an admin can link it on the dashboard? 🙏`,

  // ── row 51: composeStatsBlastReply (stats-blast.ts) ────────────────

  stats_blast_reply: (p: { queued: number }): string =>
    `📊 Done — DM'd ${p.queued} player${p.queued === 1 ? "" : "s"} their personal stats link. ` +
    `They'll arrive over the next few minutes.`,

  // ── row 58: buildAttendanceFailureReply (attendance-write-outcome.ts)

  attendance_failure: (p: { firstName: string | null; self: "IN" | "OUT" | null; others: string[] }): string => {
    const greeting = p.firstName ? `Sorry ${p.firstName}, ` : "Sorry, ";
    let clause: string;
    if (p.self === "OUT") {
      clause = "I couldn't save that just now, so you're still down as playing";
    } else if (p.self === "IN") {
      clause = "I couldn't save that just now, so you're not on the list yet";
    } else {
      clause = `I couldn't save that change for ${joinList("en", p.others)} just now, so the squad hasn't changed`;
    }
    const extra = p.self && p.others.length > 0 ? ` I couldn't update ${joinList("en", p.others)} either.` : "";
    return `${greeting}${clause}.${extra} Please send it again in a minute and I'll sort it 🙏`;
  },

  // ── rows 59, 60: rating progress (rating-progress-answer.ts) ───────

  rating_progress_failed: "Couldn't check that right now.",
  rating_progress_no_match: "There's no recent completed match to check yet.",
  rating_progress_header: (p: { matchName: string; matchWhen: string }): string =>
    `📋 *${p.matchName}* (${p.matchWhen}) — rating progress:`,
  rating_progress_rated: (p: { rated: number; confirmed: number }): string => `• Rated: ${p.rated}/${p.confirmed}`,
  rating_progress_mom: (p: { mom: number; confirmed: number }): string => `• Picked MoM: ${p.mom}/${p.confirmed}`,
  rating_progress_still_to_rate: (p: { names: string[] }): string =>
    `• Still to rate (${p.names.length}): ${p.names.join(", ")}`,
  rating_progress_everyone_rated: "• Everyone's rated ✅",
  rating_progress_no_mom_pick: (p: { names: string[] }): string =>
    `• Rated but no MoM pick (${p.names.length}): ${p.names.join(", ")}`,

  // ── rows 61, 62: the recruit refusals (recruit.ts) ─────────────────

  recruit_no_match: "There's no upcoming match to invite players to.",
  recruit_full_squad: (p: { matchName: string }): string =>
    `The squad for *${p.matchName}* is already full — no open spots to recruit for.`,

  // ── row 63: buildBulkCancelAnnouncement (block-booking.ts) ─────────

  bulk_cancel: (p: { activityName: string; dateLabels: string[] }): string => {
    const list = p.dateLabels.map((d) => `• ${d}`).join("\n");
    const plural = p.dateLabels.length === 1 ? "match is" : "matches are";
    return (
      `❌ *Schedule update* — the following *${p.activityName}* ${plural} OFF:\n\n` +
      `${list}\n\n` +
      `See you at the next one! 👋`
    );
  },

  // ── rows 64, 65: the admin actions (app/actions/matches.ts) ────────

  format_switch_header: (p: { sportName: string; maxPlayers: number }): string =>
    `🔁 *Match switched* — now *${p.sportName}* (${p.maxPlayers} players).`,
  format_switch_playing_header: (p: { confirmed: number; maxPlayers: number }): string =>
    `*Playing (${p.confirmed}/${p.maxPlayers}):*`,
  format_switch_bench_header: "*Bench:*",
  match_cancelled: (p: { activityName: string; whenLabel: string }): string =>
    `❌ *Match cancelled* — ${p.activityName} on ${p.whenLabel}.\n\n` +
    `Not enough players this week. See you next week!`,

  // ── rows 66, 134: team-ops-engine.ts and the balancer's reasons ────

  team_ops_no_match: "No match lined up to build teams for.",
  balancer_refusal: (p: { reason: string }): string => `Can't build teams right now — ${p.reason}.`,
  team_gen_reason_not_found: "match not found",
  team_gen_reason_status: (p: { status: string }): string => `match is ${p.status.toLowerCase()}`,
  team_gen_reason_not_enough: (p: { confirmed: number; needed: number }): string =>
    `not enough confirmed players — ${p.confirmed}/${p.needed}`,
  team_gen_note_including: (p: { names: string[] }): string =>
    `_Including ${p.names.join(", ")} as CONFIRMED per the request._`,
  team_gen_note_pinned: (p: { pinned: string[] }): string => `_Pinned per the request: ${p.pinned.join(", ")}._`,
  team_gen_note_unmatched_includes: (p: { names: string[] }): string =>
    `_(couldn't find ${p.names.join(", ")} in the roster — ignored)_`,
  team_gen_note_unmatched_pins: (p: { names: string[] }): string =>
    `_(couldn't find ${p.names.join(", ")} for team pinning — ignored)_`,

  // ── row 133: composePaymentAck (admin-ops-engine.ts) ───────────────

  payment_credit_ack: (p: { payerName: string; credited: string[]; count: number; matchName: string; unpaid: number; confirmed: number; unmatched: number }): string => {
    const credited =
      p.credited.length > 0 ? p.credited.join(", ") : `${p.count} payment${p.count === 1 ? "" : "s"}`;
    const tail =
      p.unmatched > 0
        ? `\n\n_(couldn't find ${p.unmatched} of those names on the squad — ` +
          `those were ignored)_`
        : "";
    return (
      `💳 Got it — credited *${p.payerName}* with ${credited} for *${p.matchName}*. ` +
      `Unpaid: ${p.unpaid}/${p.confirmed}.${tail}`
    );
  },

  // ── rows 123 to 131: the analyze route's group literals ────────────

  recruit_failed: "Couldn't do that right now.",
  recruit_invited: (p: { invited: number; matchName: string; need: number | null }): string =>
    `📣 On it — DM'd ${p.invited} recent player${p.invited === 1 ? "" : "s"} who hadn't replied, asking them to fill *${p.matchName}*${p.need ? ` (${p.need} spot${p.need === 1 ? "" : "s"} left)` : ""}. I'll add anyone who taps in. 🙏`,
  recruit_already_pinged: (p: { matchName: string }): string =>
    `Already pinged the recent players for *${p.matchName}* — just waiting on their replies. 🙏`,
  recruit_nobody_new: (p: { matchName: string }): string =>
    `No new players to ask for *${p.matchName}* right now. 👍`,
  swap_deferred: (p: { a: string; b: string }): string =>
    `Both *${p.a}* and *${p.b}* are already in — nobody's dropped. ` +
    `Teams aren't generated yet; say *@Match Time generate the teams* and I'll build them (then I can put them on opposite sides).`,
  team_swap_done: (p: { a: string; b: string }): string =>
    `🔁 Swapped *${p.a}* and *${p.b}* — nobody dropped. Updated teams:`,
  slot_transfer_done: (p: { to: string; from: string; teamLabel: string }): string =>
    `🔁 *${p.to}* takes *${p.from}*'s place on *${p.teamLabel}* — ` +
    `same teams otherwise, nothing regenerated, nobody's attendance changed. Updated teams:`,
  colour_swap_done: "🎨 Swapped the colours — same teams, sides flipped:",
  // A swap MatchTime could not apply (2026-09-17). Before this the owner
  // heard nothing, and the message went on to be read as a drop.
  swap_refused: (p: { a: string; b: string; why: string }): string =>
    `I haven't swapped *${p.a}* and *${p.b}*. ${p.why} Nothing changed and nobody was dropped.`,
  swap_refused_unknown: (p: { name: string }): string =>
    `I can't find a player called *${p.name}* for this match. Use the name they're registered under.`,
  swap_refused_ambiguous: (p: { name: string; candidates: string[] }): string =>
    `*${p.name}* could be more than one player (${p.candidates.join(", ")}). Use their full name.`,
  swap_refused_teams_not_generated:
    "The teams aren't generated yet. Say *@Match Time generate the teams* first.",
  swap_refused_same_player: "Both names point to the same player.",
  swap_refused_nobody_playing: "Neither of them is in the squad.",
  swap_refused_not_in_squad: (p: { name: string }): string =>
    `*${p.name}* isn't in the squad, so there's no team place to give them.`,
  swap_refused_both_hold_slots: (p: { name: string }): string =>
    `*${p.name}* isn't in the squad but still has a team place, and so does the other player, so I can't tell which move you mean.`,
  swap_refused_no_slot: (p: { name: string }): string =>
    `*${p.name}* isn't in the squad and has no team place to hand over.`,

  // ── row 67: the bot intro (scheduler-copy.ts) ──────────────────────

  intro_opener: "👋 Hi all — MatchTime bot is live for this group.",
  intro_what_i_do: "Here's what I do:",
  intro_attendance: `🗓  *Attendance* — Say "IN" / "OUT" here (or on the app) and I log you in/out. I react with ✅ to confirm — no extra messages from me.`,
  intro_daily: `🗒  *Daily reminders* — Every day at 5pm while the squad isn't full, I'll repost the IN list so we all see how many we need.`,
  intro_teams: `⚽  *Teams* — Say "@Match Time generate the teams" and I post auto-balanced sides. Objections? Reply \`@Match Time swap X with Y\` and an admin will apply it.`,
  intro_rating_bit: "I DM everyone a rating link after each match (no sign-up, just tap)",
  intro_mom_bit: "vote MoM in-app or in the poll I post — winner announced once everyone's voted (or 5 days after the match at the latest)",
  intro_ratings_line: (p: { bits: string[] }): string => `🏆  *Ratings & MoM* — ${p.bits.join("; ")}.`,
  intro_reminders: `⏰  *Reminders* — Say "@MatchTime remind me Monday" and I'll DM you then.`,
  intro_stats: `📊  *Stats* — Ask me things like "who got MoM last week?" or "who's our most consistent player?"`,
  intro_payments: `💳  *Payments* — I auto-post "paid?" polls right after each match.`,
  intro_closer: "Questions? Just ask here. Let's go.",

  // ── rows 74 to 77: the remaining scheduler posts ───────────────────

  chase_pre_kickoff_fallback: (p: { need: number; activityName: string; timeLabel: string }): string =>
    `⏳ Still *${p.need} short* for *${p.activityName}* at ${p.timeLabel}. Anyone free tonight?`,
  pre_kickoff_short_fallback: (p: { timeLabel: string; venue: string; confirmed: number; maxPlayers: number; need: number }): string =>
    `⏰ Tonight *${p.timeLabel}* at *${p.venue}* · ${p.confirmed}/${p.maxPlayers} — *still need ${p.need}*, last chance to jump in. 🙏`,
  gear_reminder: (p: { timeLabel: string; venue: string }): string =>
    `⚽ *${p.timeLabel} at ${p.venue}* — see you there!\n\n` +
    `Quick reminder: if you've got them, please bring your *goalie gloves*, a *ball*, and *spare bibs*.`,
  ask_score: (p: { activityName: string }): string =>
    `🏁 *${p.activityName}* — hope it was a good one. What was the final score? ` +
    `I'll use it to keep next week's teams balanced.`,

  // ═══════════════════════════════════════════════════════════════════
  // Phase 2, slice 3: the chase model's server-computed headers.
  // ═══════════════════════════════════════════════════════════════════
  //   The chase system prompt orders the model to copy these verbatim
  //   ("Use roster header:"), so a Turkish chase copies a Turkish header
  //   the server chose. `buildMatchClockBlock` and `computeProximity`
  //   (message-analyzer.ts) read them. English is byte for byte what
  //   those functions carried inline.

  roster_header_past: "*Squad:*",
  roster_header_tonight: "*Playing tonight:*",
  roster_header_tomorrow: "*Playing tomorrow:*",
  roster_header_day: (p: { dayLabel: string }): string => `*Playing ${p.dayLabel}:*`,
  /** The line the model writes below the roster for a dropped player who
   *  may still turn up; the system prompt quotes the English one. */
  chase_tentative_line: (p: { name: string }): string => `Tentative: ${p.name} (will play if nobody steps in)`,
  /** The scene-setting opener the daily chase is shown as an example. */
  chase_opener_example: "🗓 Squad update",

  // ── onboarding (self-setup) ──────────────────────────────────────────
  // The group-add flow (bot added to a group → intro → consent → admins →
  // when and where → live), its completion post, its DMs and the
  // "@Match Time help" block. Composers in src/lib/onboarding-conversation.ts
  // and the details question in src/lib/onboarding-parse.ts read these.
  // The English here is byte for byte what those composers produced
  // before the move (copy-golden.test.ts), except `onbIntro`, which was
  // rewritten on purpose on 2026-09-17 (the 1,300-character pitch became
  // one line and one question).

  /** The first thing the bot says in a group it was just added to. One
   *  line on what it is, one question. The consent keyword is load
   *  bearing: parseBundleReply reads it. */
  onbIntro: (): string =>
    `👋 Hi, I'm *MatchTime*. I run the weekly admin for a football group: who's in, who's out, fair teams, reminders.\n\n` +
    `*Want me to run this group?* Whoever organises it, reply *YES* and I'll ask two quick questions. ` +
    `Not for you? Ignore me and I'll stay quiet. 🤐`,

  /** The admins question, asked right after consent. */
  onbAdminQuestion: (): string =>
    `Who else helps run this group? Reply with their name + number (or @mention) — ` +
    `you can list a few, separated by commas. Or say *just me* if it's only you.`,

  /** The reply to a consent answer: a short lead, then the admins question. */
  onbConsentAck: (p: { adminCaptured: boolean; adminQuestion: string }): string =>
    `${p.adminCaptured ? "Done — you're the admin 🎽" : "Done ✅"} ${p.adminQuestion}`,

  /** The reply to the admins answer: an optional lead, then the details question. */
  onbAdminsAck: (p: { added: number; detailsQuestion: string }): string =>
    (p.added > 0
      ? `Got it — I'll set up ${p.added === 1 ? "that admin" : `those ${p.added} admins`} once we're live. `
      : "") + p.detailsQuestion,

  /** The combined "when and where" question, or the follow-up for the gaps. */
  onbDetailsQuestion: (p: { missing: Array<"day" | "time" | "venue"> }): string => {
    if (p.missing.length === 3) {
      return (
        "One thing I need: *when and where do you play?* One message is fine, " +
        "like: _\"Thursdays 9pm at PowerLeague Shoreditch, 7-a-side\"_."
      );
    }
    const parts: string[] = [];
    if (p.missing.includes("day")) parts.push("which *day of the week* you play");
    if (p.missing.includes("time")) parts.push("the *kickoff time* (e.g. 9pm)");
    if (p.missing.includes("venue")) parts.push("the *venue* name");
    return `Almost there — I just need ${parts.join(" and ")}.`;
  },

  /** The "All set" post for the group-add flow. `dayName` and `onLabels`
   *  are already in this language; `howToUseMe` is the block below. */
  onbCompletionPost: (p: {
    groupName: string | null;
    onLabels: string[];
    dayName: string;
    kickoffTime: string | null;
    venue: string | null;
    weekly: boolean;
    rosterCount: number;
    adminsAdded: number;
    adminDmQueued: boolean;
    adminName: string | null;
    howToUseMe: string;
  }): string => {
    const adminName = p.adminName?.trim();
    const adminLine = p.adminDmQueued
      ? `${adminName || "Admin"}, I've sent you a private link to your admin page — player names, ratings and payments live there. `
      : `Whoever runs this group can claim the admin page any time at matchtime.ai. `;
    return (
      `✅ *All set!* I'm live for *${p.groupName || "this group"}* with: *${p.onLabels.join(", ")}*.\n\n` +
      `📅 First match: *${p.dayName} ${p.kickoffTime}* at *${p.venue}*` +
      `${p.weekly ? ", every week" : ""}.\n` +
      (p.rosterCount > 0
        ? `👥 I've added the *${p.rosterCount} ${p.rosterCount === 1 ? "person" : "people"}* in this group to the squad — no need to type anyone in.\n`
        : ``) +
      (p.adminsAdded > 0
        ? `👮 Added *${p.adminsAdded} co-admin${p.adminsAdded === 1 ? "" : "s"}* — I've DM'd them their admin link.\n`
        : ``) +
      `\n` +
      `${adminLine}Everyone else: just chat normally, say *"in"* when you're playing, and I'll handle the rest. ⚽` +
      `\n\n*How to use me* 👇\n${p.howToUseMe}`
    );
  },

  /** The magic-link DM to the captured admin at completion. */
  onbAdminDm: (p: { groupName: string | null; url: string; payments: boolean }): string =>
    `👋 You're the admin of *${p.groupName || "your club"}* on MatchTime.\n\n` +
    `Here's your private link to the admin page — player names, ratings` +
    `${p.payments ? ", payments" : ""} and settings live there:\n${p.url}` +
    (p.payments
      ? `\n\nWant me to *collect* the money too? Connect a bank from your admin page — takes 2 minutes.`
      : ``),

  /** The magic-link DM to each additional admin named at the admins stage. */
  onbCoAdminDm: (p: { groupName: string | null; url: string }): string =>
    `👋 You've been made an admin of *${p.groupName || "the club"}* on MatchTime.\n\n` +
    `Here's your private link to the admin page:\n${p.url}`,

  /** The DM that points the admin at the enrichment review page. */
  onbEnrichmentDm: (p: { messagesAnalyzed: number; groupName: string | null; playerCount: number; url: string }): string =>
    `📋 I read ${p.messagesAnalyzed} past messages from *${p.groupName || "your group"}* ` +
    `and drafted positions + seed ratings for ${p.playerCount} players.\n\n` +
    `Nothing's applied yet — review & finish setup here:\n${p.url}`,

  /** The reply when someone tagged the bot and asked it to stop the setup. */
  onbCancelled: (): string =>
    `Okay, I've stopped the setup and I'll stay quiet. Add me to the group again, or tag *@Match Time setup*, to start over.`,

  /** The feature label in a completion post ("I'm live with: ..."). */
  onbFeatureLabel: (p: { key: string; englishLabel: string }): string => p.englishLabel,

  /** Day of week, 0 = Sunday. */
  onbDayName: (p: { dow: number }): string =>
    ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][p.dow] ?? "Tuesday",

  /** The feature-aware "how to use me" block (completion post and bare help). */
  onbHowToUseMe: (f: {
    attendance: boolean;
    teamBalancing: boolean;
    momVoting: boolean;
    playerRating: boolean;
    statsQa: boolean;
    reminders: boolean;
    bench: boolean;
    paymentTracking: boolean;
  }): string => {
    const lines: string[] = [];
    if (f.attendance) {
      lines.push(`✅ Say *"In"* or *"Out"* to mark your own availability — no need to tag me.`);
      lines.push(`🤔 Not sure? Just say *"maybe"* and I'll check with you ~24h before.`);
    } else {
      lines.push(`📋 Paste your squad list and I'll read who's playing — no need to tag me.`);
    }
    const caps: string[] = [];
    if (f.attendance) caps.push(`see who's in / how many we've got`);
    if (f.teamBalancing) caps.push(`make / show the teams`);
    if (f.statsQa) caps.push(`who won last week? / past stats`);
    lines.push(`💬 Tag *@Match Time* when you want me to do or tell you something:`);
    for (const c of caps) lines.push(`   • ${c}`);
    lines.push(`🤐 I stay quiet the rest of the time — banter and jokes are safe, I won't butt in.`);
    if (f.momVoting) lines.push(`🏆 After the game I'll run a quick *Man of the Match* vote.`);
    if (f.playerRating) lines.push(`⭐ I'll DM you a one-tap *rating* link after the match.`);
    if (f.reminders) lines.push(`⏰ Say *"@Match Time remind me Thursday"* and I'll nudge you.`);
    if (f.paymentTracking) lines.push(`💳 I keep track of who's *paid*.`);
    lines.push(`\nType *"@Match Time help"* any time to see this again.`);
    return lines.join("\n");
  },

  /** Bare "@Match Time help": the lead line above the topic list. */
  onbHelpHead: (): string => `ℹ️ *MatchTime help* — here's what I can explain. Tag me with one of these:`,

  /** One line of the bare-help topic list. `word` is what the player
   *  types after "help" in this language; `label` names the topic. */
  onbHelpTopicLine: (p: { word: string; label: string }): string =>
    `   • *@Match Time help ${p.word}* — ${p.label}`,

  /** The word a player types after "help" for each topic, in this language. */
  onbHelpTopicWord: (p: { topic: "availability" | "teams" | "mom" | "ratings" | "reminders" | "payments" }): string =>
    p.topic,

  /** Human label for each topic, used in the bare-help topic menu. */
  onbHelpTopicLabel: (p: { topic: "availability" | "teams" | "mom" | "ratings" | "reminders" | "payments" }): string =>
    ({
      availability: "squad & availability",
      teams: "fair teams",
      mom: "Man of the Match",
      ratings: "player ratings",
      reminders: "reminders",
      payments: "payment tracking",
    })[p.topic],

  /** "help <topic>" for a topic whose feature is off. */
  onbHelpNotOn: (): string =>
    `That one isn't switched on for this group. Type *@Match Time help* to see what is.`,

  /** The per-topic explainers. */
  onbHelpExplainer: (p: { topic: "availability" | "teams" | "mom" | "ratings" | "reminders" | "payments" }): string =>
    ({
      // Third line CHANGED 2026-09-19, deliberately, and the golden
      // snapshot is re-recorded with it. The old line promised "a form
      // rating for each player" built from "everyone's scores" with no
      // club boundary at all. Since the ratings became club-scoped that
      // sentence is false for anybody who plays for two groups, and
      // false in the direction that matters: it implies their other
      // club's scores count here. They do not. Lines 1, 2 and 4 are
      // untouched. See section 8.5 of
      // MDs/club-scoped-ratings-design-2026-09-18.md.
      ratings:
        `⭐ *Player ratings — how it works*\n` +
        `After each match I DM every player who turned out a private link. You rate the other players out of 10 (you can't rate yourself, and your scores stay private).\n` +
        `I combine everyone's scores into a form rating for each player at this club, updated after every game, and that is what I use to build *balanced teams*. Ratings stay inside the club: if you also play for another group, their scores never touch this one. So the more people rate, the fairer the teams.\n` +
        `You'll get the link the morning after the game. Type *@Match Time my stats* for yours anytime.`,
      teams:
        `🟥🟦 *Fair teams — how it works*\n` +
        `Once the squad's locked in, any admin can tag *@Match Time generate the teams* and I'll split everyone into two balanced sides using their form ratings, so games stay even.\n` +
        `I post the line-ups straight into the chat. Not happy with a pairing? Tag me to *swap two players* (e.g. _"@Match Time swap Sam and Alex"_), or ask me to *"@Match Time show the teams"* again any time.\n` +
        `Want a bit of fun? Ask me to give the teams names and I'll sort it. Tag *@Match Time generate the teams* when you're ready.`,
      mom:
        `🏆 *Man of the Match — how it works*\n` +
        `After the final whistle I post a quick *Man of the Match* vote in the group. Everyone just taps who they thought was the standout player.\n` +
        `I tally the votes, announce the winner, and it counts towards everyone's season stats — so the MoM race builds up over the year.\n` +
        `Nothing to set up — I'll start the vote myself once the game's done. Type *@Match Time my stats* to see your MoM tally.`,
      availability:
        `⚽ *Squad & availability — how it works*\n` +
        `Just say *In* or *Out* in the group to mark yourself for the next game — no need to tag me, I read it automatically.\n` +
        `I keep a live, numbered squad list. When it's full, extra players go on the *bench/reserve* list in order. Not sure yet? Say *"maybe"* and I'll DM you ~24h before kick-off for a final answer.\n` +
        `If you drop out, I can nudge the bench to step in so we're never short. Say *Out* any time and I'll sort the rest.`,
      reminders:
        `⏰ *Reminders — how it works*\n` +
        `I gently nudge anyone who hasn't said *In* or *Out* yet, then remind the whole squad before kick-off so nobody forgets.\n` +
        `Want a personal nudge? Say *"@Match Time remind me Thursday"* and I'll ping you then.\n` +
        `It all happens automatically — you don't need to chase anyone yourself.`,
      payments:
        `💳 *Payment tracking — how it works*\n` +
        `I keep track of who's paid the match fee. The organiser sets the fee, and I show who's paid and who still owes at a glance.\n` +
        `I send friendly reminders to anyone outstanding. Players can pay by card, or the organiser can mark cash and bank transfers as received.\n` +
        `This only runs when payment tracking is switched on. Tag *@Match Time who still owes?* to see the latest.`,
    })[p.topic],

  // ── private messages (Phase 3) ──────────────────────────────────────
  // Everything a player (or the money collector) receives PRIVATELY,
  // moved byte for byte from `dm-copy.ts` and from the modules that
  // already had pure DM builders. The language is the language of the
  // org the message is ABOUT (the match's org), never a per-user setting.
  //
  // `firstName: string | null` means "no usable name": each language
  // decides what to say instead (English keeps its old "there" / "mate").

  /** Row 91: the rating-link DM, the morning after. */
  dm_rating: (p: { activityName: string; dateLabel: string; mvpLabel: string; rateUrl: string; statsUrl: string }): string =>
    `🏆 *${p.activityName}* — ${p.dateLabel}\n\n` +
    `Rate your teammates and pick ${p.mvpLabel}. Takes ~1 minute.\n\n` +
    `Your personal link:\n${p.rateUrl}\n\n` +
    `Link expires in 5 days.\n\n` +
    `📊 Your season stats (ratings, MoM, badges, share card) — any time:\n${p.statsUrl}`,

  /** Row 92: the daily rating reminder, five day-toned variants
   *  (`dayNum` 1 to 5; anything above 4 is the last call). */
  dm_rating_reminder: (p: { dayNum: number; firstName: string | null; activityName: string; mvpLabel: string; url: string }): string => {
    const first = p.firstName ?? "mate";
    const sig = `\n${p.url}`;
    switch (p.dayNum) {
      case 1:
        return (
          `Hey ${first} 👋 — hope last night's *${p.activityName}* was a good one.\n\n` +
          `When you have a sec, tap here to rate your teammates and pick ${p.mvpLabel}. ` +
          `The more of us vote, the better the teams balance next week 🙌${sig}`
        );
      case 2:
        return (
          `${first}, friendly nudge 🙂 — still waiting on your ratings for *${p.activityName}*.\n\n` +
          `Literally 30 seconds, promise. Helps everyone get fairer teams next week ⚽${sig}`
        );
      case 3:
        return (
          `Halfway through the rating window, ${first} ⏳\n\n` +
          `Your vote for *${p.activityName}* actually moves ratings a lot when half the squad has voted ` +
          `and you haven't. Quick tap:${sig}`
        );
      case 4:
        return (
          `${first} — two days left to rate *${p.activityName}* and lock in ${p.mvpLabel} 🏆\n\n` +
          `30 seconds, then you're done:${sig}`
        );
      default:
        return (
          `Last call ${first} 🔔 — the rating window for *${p.activityName}* closes tomorrow.\n\n` +
          `Drop a rating + ${p.mvpLabel} pick before it shuts. Your voice counts:${sig}`
        );
    }
  },

  /** Row 83: the tentative ("maybe") follow-up, ~24h before kickoff.
   *  Its answer is read back by the dm-reply route's fast path, then the
   *  match-availability classifier. */
  dm_tentative_followup: (p: { firstName: string | null; activityName: string; whenLabel: string }): string =>
    `Hi ${p.firstName ?? "there"} 👋 You were a *maybe* for *${p.activityName}* on ${p.whenLabel}.\n\n` +
    `Are you in or out? Just reply *IN* or *OUT* and I'll sort the squad 🙏`,

  /** Row 105: the tentative follow-up's one re-ask. */
  dm_tentative_reask: "No worries — just reply *IN* if you can play or *OUT* if you can't, and I'll update the squad 🙏",

  /** Row 102: the tentative follow-up's ack, built from what the write did. */
  dm_tentative_ack: (p: { decision: "in" | "out"; failed: boolean }): string => {
    if (p.failed) {
      return (
        "Sorry, I couldn't update the squad just now. An admin will sort it, " +
        "try again in a bit if you like 🙏"
      );
    }
    return p.decision === "in"
      ? "✅ Brilliant, you're in! See you there ⚽"
      : "👋 No worries, thanks for letting me know. Maybe next time!";
  },

  /** Row 85: the bench-slot offer DM. `context` is the `_plain` context
   *  clause above; `firstName` is "" when there is no name on record.
   *  `reactions` is BENCH_PROMPT_MENTION_REACTIONS. */
  dm_bench_offer: (p: { firstName: string; context: string; reactions: boolean }): string => {
    const hi = p.firstName ? ` ${p.firstName}` : "";
    const claim = p.reactions
      ? "Reply *YES* here, tap 👍 on the message I tagged you in, or reply *IN* there."
      : "Reply *YES* here, or *IN* on the message I tagged you in, in the group.";
    return (
      `👋 Hi${hi}, a slot just opened ${p.context} and you're on the bench.\n\n` +
      `Want it? ${claim} First to claim plays. No timeout, and if you're ` +
      `not free no worries, you stay on the bench. 🙏`
    );
  },

  /** Row 103: the bench DM's one clarification. */
  dm_bench_unclear:
    `Want the open slot for tonight? Reply *YES* to grab it. ` +
    `If not, no worries — you stay on the bench either way 🙏`,

  /** Row 104: the bench DM's ack, from what the claim did. */
  dm_bench_ack: (p: { kind: "declined" | "confirmed" | "taken" | "other" }): string =>
    ({
      declined: `👍 No worries — you're still on the bench, nothing changes.`,
      confirmed: `✅ You got it — you're in for tonight! ⚽`,
      taken: `Ah — someone just grabbed that one first. You're still first in line on the bench if another opens 🙏`,
      other: `👍 Got it.`,
    })[p.kind],

  /** Rows 93, 94: the recruit invite. `spotsLeft` 0 omits the count;
   *  `link` null omits the app line; `reactions` is
   *  RECRUIT_DM_MENTION_REACTIONS. */
  dm_recruit_invite: (p: {
    firstName: string | null;
    matchName: string;
    matchWhen: string;
    spotsLeft: number;
    link: string | null;
    reactions: boolean;
  }): string => {
    const spots =
      p.spotsLeft > 0 ? ` ${p.spotsLeft} ${p.spotsLeft === 1 ? "spot" : "spots"} left.` : "";
    const lines = [
      `👋 ${p.firstName ?? "there"}, we're putting the squad together for *${p.matchName}* on ${p.matchWhen}.${spots}`,
      "",
      p.reactions ? "Playing? Reply *IN* or tap 👍 on this message." : "Playing? Just reply *IN*.",
      p.reactions
        ? "Can't make it? Reply *OUT* or tap 👎 and I'll stop asking 🙌"
        : "Can't make it? Reply *OUT* and I'll stop asking 🙌",
    ];
    if (p.link) lines.push("", `Prefer the app? ${p.link}`);
    return lines.join("\n");
  },
  dm_recruit_group_invite: (p: { firstName: string | null; matchName: string; matchWhen: string }): string =>
    `👋 ${p.firstName ?? "there"}, we're putting the squad together for *${p.matchName}* on ${p.matchWhen}. ` +
    `Fancy it? Just reply *IN* in the group and you're sorted 🙌`,

  /** Row 84: the one recruit chase. `count` is already at least 1. */
  dm_recruit_chase: (p: { firstName: string | null; count: number; activityName: string; matchWhen: string }): string =>
    `👋 ${p.firstName ?? "there"}, still after ${p.count} ${p.count === 1 ? "player" : "players"} for *${p.activityName}* on ${p.matchWhen}. ` +
    `Reply *IN* if you fancy it, or *OUT* and I'll stop asking 🙏`,

  /** Row 101: the ack to a DM "IN"/"OUT" or an invite reaction. `status`
   *  is what the write left behind (null: no row). */
  dm_self_ack: (p: {
    failed: boolean;
    status: "CONFIRMED" | "BENCH" | "DROPPED" | null;
    matchName: string;
    matchWhen: string;
  }): string => {
    const { matchName, matchWhen } = p;
    if (p.failed) {
      return (
        `Sorry, I couldn't update the squad just now. An admin will sort it — ` +
        `try again in a bit if you like 🙏`
      );
    }
    if (p.status === "CONFIRMED") {
      return `✅ You're in for *${matchName}* on ${matchWhen}. See you there ⚽`;
    }
    if (p.status === "BENCH") {
      return (
        `📋 Squad's full for *${matchName}* on ${matchWhen}, so I've put you ` +
        `first on the bench. I'll message you the moment a spot opens 🙏`
      );
    }
    if (p.status === "DROPPED") {
      return `👋 No worries, you're marked out for *${matchName}* on ${matchWhen}. Thanks for letting me know.`;
    }
    return `👍 Noted. You weren't down for *${matchName}* on ${matchWhen} anyway, so nothing's changed.`;
  },

  /** Row 99: the DM-subscription acks. Each quotes the command that
   *  undoes it, and `dm-subscriptions.ts` must accept that command. */
  dm_sub_ack: (p: { kind: "opt-out-all" | "opt-out-ratings" | "opt-in-all" | "opt-in-ratings" }): string =>
    ({
      "opt-out-all":
        'Done — I\'ll only message you about payments from now on. ' +
        'Text "start messages" anytime to turn the rest back on.',
      "opt-out-ratings":
        'Done — no more rating or Man-of-the-Match messages from me 👍 ' +
        'Text "start ratings" anytime to turn them back on.',
      "opt-in-all": "Great — you're back on for all my messages 👍",
      "opt-in-ratings": "Great — I'll send you rating and Man-of-the-Match links again 👍",
    })[p.kind],

  /** Row 132: the personal reminder a player asked for. */
  dm_reminder: (p: { firstName: string | null; note: string }): string =>
    `⏰ Reminder, ${p.firstName ?? "there"} — you asked me to nudge you:\n\n` +
    `_${p.note}_\n\n` +
    `(reply in the group when you're ready 👍)`,

  /** Row 100: the stats-blast DM (the link does not expire). */
  dm_stats_blast: (p: { firstName: string | null; url: string }): string =>
    `📊 Hi ${p.firstName ?? "there"} — here are your MatchTime stats: your ratings over time, ` +
    `Man-of-the-Match games, how you stack up against the squad, your badges and a ` +
    `shareable season card.\n\n${p.url}\n\nKeep this link — it doesn't expire.`,

  /** Row 122: the "@Match Time my stats" DM (a 48h link). */
  dm_stats_link: (p: { firstName: string | null; url: string }): string =>
    `📊 Hey ${p.firstName ?? "there"} — here are your MatchTime stats: ratings over time, your ` +
    `Man-of-the-Match games, how you compare to the squad, your badges, and a ` +
    `shareable season card.\n\n${p.url}\n\nLink works for 48h.`,

  /** Row 111: the DM Q&A's fallback when the model gave nothing usable. */
  dm_qa_apology: "Sorry, I couldn't work that one out — try asking again? 🙂",

  /** Row 88: the fee ask to the money collector at match end. The reply
   *  is parsed by `parseFeeReply` (a £ amount, "each" / "total"). */
  dm_fee_ask: (p: { firstName: string | null; activityName: string; headcount: number }): string =>
    `💷 ${p.firstName ?? "there"} — how much should each player pay for *${p.activityName}*` +
    (p.headcount > 0 ? ` (${p.headcount} played)` : "") +
    `?\n\n` +
    `Just reply with the amount — e.g. "£8 each" or "£80 total to split". ` +
    `I'll confirm, then send everyone their pay link.`,

  /** Row 98: the collector's confirm step. `fee` is formatted (`gbp`).
   *  `headcount` "N" is the placeholder `fee-confirm.ts` renders when it
   *  quotes this very question to the model, so that prompt is built
   *  from this entry and cannot drift from what the collector was sent. */
  dm_fee_confirm_prompt: (p: { fee: string; headcount: number | "N"; matchName: string; wasTotal: boolean }): string => {
    const players = (n: number | "N") => `${n} player${n === 1 ? "" : "s"}`;
    const split = p.wasTotal ? ` (split across ${players(p.headcount)})` : "";
    const charge = p.headcount === "N" || p.headcount > 0;
    return (
      `Got it — *${p.fee}* per player${split} for *${p.matchName}*` +
      (charge ? `, ${players(p.headcount)} to charge` : "") +
      `.\n\nReply *✅* (or "yes") to send everyone their pay link, or send a different amount to change it.`
    );
  },

  /** Row 96: the collector's ack once the links went out. */
  dm_fee_released: (p: { released: number; fee: string; matchName: string }): string =>
    `✅ Done — sent ${p.released} pay link${p.released === 1 ? "" : "s"} at *${p.fee}* each for *${p.matchName}*. ` +
    `Players can pay by bank, card, Apple or Google Pay, or settle with you directly. I'll chase anyone who hasn't paid.`,

  /** Row 97: the collector's ack to a cancel. */
  dm_fee_cancelled: `No problem — cancelled. Just tell me the amount per player when you're ready.`,

  /** Row 95: the pay link to each confirmed player. */
  dm_pay_link: (p: { firstName: string | null; activityName: string; fee: string; url: string }): string =>
    `💷 ${p.firstName ?? "there"} — match fee for *${p.activityName}* is *${p.fee}*.\n\n` +
    `Tap to pay (bank, card, Apple or Google Pay, or pay the organiser directly):\n${p.url}\n\n` +
    `You can also pay for anyone you brought along.`,

  /** Row 89: the daily pay chase; `dayNum` picks the opener. */
  dm_pay_chase: (p: { firstName: string | null; dayNum: number; fee: string; activityName: string; url: string }): string => {
    const first = p.firstName ?? "there";
    const opener =
      p.dayNum <= 1 ? `Quick one ${first}` : p.dayNum === 2 ? `${first}, gentle nudge` : `${first}, still owed`;
    return (
      `💷 ${opener} — your *${p.fee}* for *${p.activityName}* is still outstanding.\n\n` +
      `Pay by bank, card, Apple or Google Pay, or settle directly:\n${p.url}`
    );
  },

  /** Row 90: the collector's daily "tick off the direct payers" nudge. */
  dm_direct_pay_nudge: (p: { count: number; activityName: string; url: string }): string =>
    `🤝 ${p.count} player${p.count === 1 ? "" : "s"} said they'd pay you directly for *${p.activityName}*. ` +
    `Tick off whoever's settled up:\n${p.url}`,

  /** Rows 106, 107: the admin recruit-by-DM reply (the failure is
   *  `recruit_failed`, shared with the group reply). */
  dm_admin_recruit_done: (p: { invited: number; matchName: string; matchWhen: string; need: number | null }): string =>
    `📣 Done — DM'd ${p.invited} recent player${p.invited === 1 ? "" : "s"} who hadn't replied, asking them to fill *${p.matchName}* on ${p.matchWhen}${p.need ? ` (${p.need} spot${p.need === 1 ? "" : "s"} left)` : ""}. I'll add anyone who taps in. 🙏`,
  dm_admin_recruit_nobody_new: (p: { matchName: string }): string =>
    `Everyone who played recently has already responded to *${p.matchName}* — nobody new to invite. 👍`,

  /** Row 109: the roster check-in's one clarification. The probe is the
   *  message's opening, and the route's one-per-person dedupe query
   *  looks for it (in every language). */
  dm_survey_clarify_probe: (p: { firstName: string | null }): string =>
    `Sorry ${p.firstName ?? "mate"} — wasn't sure if that was a reply to the roster check-in`,
  dm_survey_clarify: (p: { firstName: string | null; orgName: string }): string =>
    [
      `Sorry ${p.firstName ?? "mate"} — wasn't sure if that was a reply to the roster check-in for *${p.orgName}*.`,
      ``,
      `Was your answer:`,
      `• yes / I'm in`,
      `• maybe / sometimes`,
      `• not for now / out`,
      ``,
      `Quick word back is enough — otherwise no worries, an admin will sort it 🙏`,
    ].join("\n"),

  /** Row 110: the roster check-in confirmations. */
  dm_survey_confirm: (p: { category: "in" | "maybe" | "out"; firstName: string | null }): string => {
    const firstName = p.firstName ?? "mate";
    if (p.category === "in") return `Got it ${firstName}, marked you as in 👍 — thanks!`;
    if (p.category === "maybe") {
      return `Got it ${firstName}, marked you as maybe 👍 — just say *IN* in the group whenever you want to play that week, no need to confirm in advance.`;
    }
    return `No worries ${firstName}, noted you're stepping back. The admins will tidy up the roster at the end of the week. If you change your mind before then, just message back here 🙏`;
  },

  /** The roster check-in itself (scripts/start-roster-survey.ts). The
   *  English names Sutton's Tuesday game: it was written for them. */
  dm_survey_invite: (p: { firstName: string | null; orgName: string }): string =>
    [
      `Hey ${p.firstName ?? "mate"} 👋`,
      ``,
      `This is *Match Time*, the bot that coordinates your *${p.orgName}* WhatsApp group (the Tuesday football one).`,
      ``,
      `Quick check-in — attendance's been thin lately, so we're asking everyone if they're still up for Tuesday football going forward.`,
      ``,
      `Just reply here with a word or two:`,
      `• "yes" / "I'm in" — keep me on the roster`,
      `• "maybe" / "depends" — only when I confirm`,
      `• "not for now" / "out" — step me back`,
      ``,
      `Whatever you pick stays between you and the group admin. No drama 🙏`,
    ].join("\n"),
  // ── the legacy "@Match Time setup" flow (Phase 3c) ──
  // Group-facing, so the Turkish is in the group's plural register.

  onb_legacy_intro:
    `👋 *Hey, I'm MatchTime* — the automatic organiser for your football group. ` +
    `I take the weekly admin off your hands so you can just turn up and play.\n\n` +
    `Here's what I do:\n` +
    `⚽ *Attendance* — players just say "in" or "out" right here; I keep the squad list live and chase the stragglers\n` +
    `⚖️ *Fair teams* — auto-balanced sides every week from real player ratings\n` +
    `🪑 *Smart bench* — squad full? I offer the spot to the whole bench, first to claim it plays. Nobody's ever dropped for being asleep\n` +
    `🏆 *Man of the Match & ratings* — a quick post-match vote and a one-tap rating link, no app to install\n` +
    `⏰ *Reminders & stats* — "@MatchTime remind me Thursday", or ask me "who got MoM last week?"\n\n` +
    `No spreadsheets, no chasing, no admin headaches. ⚡\n\n` +
    `Let's get you set up — takes about a minute:`,

  /** The seven setup questions; `groupName` is only printed by "side". */
  onb_legacy_question: (p: {
    field: "name" | "side" | "day" | "time" | "venue" | "recurrence" | "date";
    groupName: string;
  }): string =>
    ({
      name: "👋 Let's get MatchTime set up for this group! First — what should I call your club/group? (e.g. *Thursday Ballers*)",
      side: `Great, *${p.groupName}* it is. How many players per side? (e.g. *7* for 7-a-side, *5* for 5-a-side)`,
      day: "Which *day of the week* do you usually play? (e.g. Thursday)",
      time: "What *kickoff time*? (e.g. 9:30pm)",
      venue: "Where do you play — the *venue* name?",
      recurrence: "Is this a *weekly* fixture or a *one-off* match?",
      date: "What *date* is the one-off match? (e.g. 2026-05-28)",
    })[p.field],

  /** The numbered feature menu under a lead line. */
  onb_legacy_menu: (p: { lead: string; items: Array<{ label: string; blurb: string }> }): string => {
    const lines = p.items.map((f, i) => `${i + 1}. *${f.label}* — ${f.blurb}`);
    return (
      `${p.lead}:\n\n${lines.join("\n")}\n\n` +
      `Reply with the ones you want — e.g. "Man of the Match and player ratings", ` +
      `"everything", or "all except payments".`
    );
  },

  /** A feature's one-line description in the menu. */
  onb_legacy_feature_blurb: (p: { key: string; englishBlurb: string }): string => p.englishBlurb,

  onb_legacy_menu_retry_lead: "I didn't catch which ones — reply with the features you want",

  onb_legacy_provisioned_lead: (p: {
    groupName: string;
    playersPerTeam: number;
    dayName: string;
    kickoffTime: string | null;
    venue: string | null;
  }): string =>
    `Nice — *${p.groupName}* is set up for *${p.playersPerTeam}-a-side* on *${p.dayName}s ${p.kickoffTime}* at *${p.venue}*.\n\nLast step: which features do you want? Here's everything I can do`,

  /** The legacy flow's "All set" post. */
  onb_legacy_completion: (p: {
    onLabels: string[];
    dayName: string;
    kickoffTime: string | null;
    venue: string | null;
    weekly: boolean;
    howToUseMe: string;
  }): string =>
    `✅ *All set!* I'm now running for this group with: *${p.onLabels.join(", ")}*.\n\n` +
    `First match: *${p.dayName} ${p.kickoffTime}* at *${p.venue}*` +
    `${p.weekly ? " (every week)" : ""}.\n\n` +
    `*How to use me* 👇\n${p.howToUseMe}`,

  // ── the two ratings, on the WEB (slice 6, 2026-09-19) ───────────────
  //
  // The first strings in this table that are read by a browser rather
  // than by WhatsApp, so: no `*bold*`, no emoji, plain sentences. They
  // belong here all the same. The dashboard and `/profile/stats` are
  // server components that already hold the membership, so they can do
  // `t(org.language)` like any composer, and a Turkish club should not
  // have to read its own ratings in English.
  //
  // They exist because there are now TWO ratings and a player who is
  // shown a bare number cannot tell which one they are looking at:
  //
  //   the CLUB rating    built only from ratings given inside one club.
  //                      This is what the balancer uses and what picks
  //                      the teams. Visible to the club, admins
  //                      included.
  //   the OVERALL rating the simple mean of every rating the player has
  //                      ever received anywhere, each counted once.
  //                      Visible to that player and to nobody else,
  //                      ever. Enforced in `player-stats.ts`, pinned by
  //                      `__tests__/overall-rating-visibility.test.ts`.
  //
  // Sections 8.1, 8.2 and 8.5 of
  // MDs/club-scoped-ratings-design-2026-09-18.md.

  /** The dashboard's stat tile has room for two words, so the club name
   *  goes in the tooltip (`rating_club_note`) rather than the label. It
   *  says "club" because the tile used to say "Rating" while showing a
   *  number computed across every club the player was in. */
  rating_club_tile: "Club rating",

  /** Headline for the club rating, wherever it is shown. The club name
   *  is interpolated after a colon so Turkish needs no case suffix on
   *  a proper noun it has never seen. */
  rating_club_label: (p: { orgName: string }): string => `Your rating at ${p.orgName}`,

  /** The one sentence that makes the boundary visible. Without it the
   *  club rating and the overall are two unexplained numbers on the
   *  same screen. */
  rating_club_note: "From this club's ratings only. Other clubs never count here.",

  rating_overall_label: "Your overall rating",

  /** Says both halves of decision 1 and decision 4 in a breath: every
   *  rating counts once whichever club it came from, and nobody else
   *  can see this number. The second half is not decoration; it is the
   *  only place the product tells the player the rule it enforces. */
  rating_overall_note:
    "Every rating you have ever had, from every club, counted once each. Only you can see this.",

  /** A player this club has never rated. Shown INSTEAD of a number
   *  whenever the only things available are the club's own average and
   *  the admin's seed. Both are usable priors for the balancer and both
   *  would be a lie on the player's own dashboard, the seed doubly so:
   *  it is a guess typed before anybody had played, and read under
   *  "your rating" it sounds like a verdict from team-mates who have
   *  not spoken yet.
   *
   *  The sentence is deliberately unchanged from the version that
   *  covered only the unseeded case, because it was already true of the
   *  seeded one: there are no ratings, and team-mates do set this after
   *  the first game. Kemal, 2026-09-19: "i prefer them to see nothing,
   *  better not to show seed". */
  rating_club_empty: "No ratings at this club yet. Your team-mates set this after your first game.",

  /** Admin seed editor. The seed is one club's opinion and the editor
   *  gives no other hint of that. */
  rating_seed_club_hint:
    "Seed ratings apply to this club only. A player who also turns out somewhere else keeps a separate rating there, and nothing you type here changes it.",

  /** One or two ratings in, the number above is a real average of a
   *  very small number of scores, so the next one moves it a long way.
   *
   *  CHANGED 2026-09-19 with Kemal's answer to open question 2. It used
   *  to read "so it sits close to the club average until more arrive",
   *  which described a shrinking that is no longer applied to the
   *  figure on the screen: the player now sees their own raw average.
   *  The old line was not stale, it was false, and false in the
   *  direction that matters (it told a player their number had been
   *  moved when it had not). The caveat is about confidence now. */
  rating_club_provisional: (p: { count: number }): string =>
    `Provisional: ${p.count} rating${p.count === 1 ? "" : "s"} so far, so this number will move a lot as more arrive.`,

  /** The sentence that pre-empts "it says I'm 9, why am I on the weaker
   *  team". The player's number is theirs and is not shrunk; the team
   *  sheet is built from a shrunk one while the evidence is this thin,
   *  and saying so once in plain words is cheaper than the question.
   *  One sentence, no jargon, and the word "Bayesian" is never going to
   *  appear on a football club's dashboard. */
  rating_club_balance_note:
    "While you have only a rating or two, MatchTime is careful with it when picking teams, so one early score does not decide a side.",

  /** The settled case. Wording moved byte for byte from the dashboard
   *  tile it replaces. */
  rating_club_peers: (p: { count: number }): string =>
    `${p.count} peer rating${p.count === 1 ? "" : "s"}`,
};
