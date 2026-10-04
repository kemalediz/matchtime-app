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
import type { StatsPeriod } from "../pipeline/types";
import type { BadgeKey, BadgeNumbers } from "../badge-rules";

/** The tables whose answer says it cannot be cut to a period. */
type UncutTable = "elo" | "team_of_season" | "mr_reliable" | "chemistry" | "generic";

/** "the last year" / "the last 3 months" / "this month": the period as a
 *  noun phrase. */
function spanEn(p: StatsPeriod): string {
  switch (p.kind) {
    case "last":
      return p.count === 1 ? `the last ${p.unit}` : `the last ${p.count} ${p.unit}s`;
    case "this":
      return `this ${p.unit}`;
    case "season":
      return "this season";
    case "all_time":
      return "all time";
  }
}

/** The period after "Results" or "Last 5 results": "in the last 3
 *  months", "this month", "this season", "on record". */
function resultsWhenEn(p: StatsPeriod): string {
  switch (p.kind) {
    case "last":
      return `in ${spanEn(p)}`;
    case "this":
      return spanEn(p);
    case "season":
      return "this season";
    case "all_time":
      return "on record";
  }
}

/** "*A*", "*A* and *B*", "*A*, *B* and *C*": names in bold, for a group post. */
function boldNamesEn(names: string[]): string {
  const b = names.map((n) => `*${n}*`);
  return b.length <= 1 ? (b[0] ?? "") : `${b.slice(0, -1).join(", ")} and ${b[b.length - 1]}`;
}

export const en = {
  // ── shared fragments ─────────────────────────────────────────────

  /** A roster row whose user has no name on record. */
  unnamed: "(unnamed)",

  /** A team-sheet line whose holder is no longer playing and whose slot
   *  nobody has inherited yet (2026-09-29). Printed in place of the
   *  dropped player's name: a sheet never lists somebody who is out. */
  team_sheet_open_slot: "(open slot)",

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

  //   `day` is `dayUnlessToday()` (i18n/dates.ts): null on match day,
  //   which keeps "tonight", and the match day ("Tue 6 Oct") on any other
  //   day. Until 2026-10-03 these hard-coded "tonight", and a Saturday
  //   offer for a Tuesday match said "tonight".

  bench_offer_context_team: (p: { teamLabel: string; replacingName: string; activityName: string; day: string | null }): string =>
    `on *${p.teamLabel}* (replacing ${p.replacingName}) for *${p.activityName}* ${p.day ? `on ${p.day}` : "tonight"}`,
  bench_offer_context_team_plain: (p: { teamLabel: string; replacingName: string; activityName: string; day: string | null }): string =>
    `on ${p.teamLabel} (replacing ${p.replacingName}) for ${p.activityName} ${p.day ? `on ${p.day}` : "tonight"}`,
  bench_offer_context_fixture: (p: { activityName: string; day: string | null }): string =>
    `for *${p.activityName}* ${p.day ? `on ${p.day}` : "tonight"}`,
  bench_offer_context_fixture_plain: (p: { activityName: string; day: string | null }): string =>
    `for ${p.activityName} ${p.day ? `on ${p.day}` : "tonight"}`,

  // ── row 3: buildRatePromoPost (group-copy.ts) ────────────────────

  rate_promo: (p: { activityName: string; matchDateLabel: string }): string =>
    `🎯 Just DM'd every player from the *${p.activityName}* on ${p.matchDateLabel} ` +
    `a personal rating link. The more ratings we get, the better-balanced the ` +
    `teams get next week. Check your DMs from me 👇`,

  // ── row 4: buildMatchDayChaseFallback (group-copy.ts) ────────────

  match_day_chase_fallback: (p: { need: number; activityName: string }): string =>
    `☀️ Still *${p.need} short* for tonight's *${p.activityName}*. Any takers? 👀`,

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
    `No score reported for ${p.kickoffLabel} yet. Tell me the result and I'll record it.`,
  answer_score_result: (p: { kickoffLabel: string; redLabel: string; red: number; yellow: number; yellowLabel: string; winnerLabel: string | null }): string =>
    `⚽ ${p.kickoffLabel}: ${p.redLabel} ${p.red} - ${p.yellow} ${p.yellowLabel}. ${p.winnerLabel === null ? "A draw." : `${p.winnerLabel} won.`}`,
  // ── recent results (2026-09-29), rendered by `pipeline/results-answer.ts` ──
  // Bulleted, never numbered: a numbered run of two lines reads as the
  // squad list to `displaysSquadState`.
  /** The header. `byCount` is "Last N results"; otherwise the period
   *  heads it ("Results this month"). */
  results_head: (p: { n: number; period: StatsPeriod | null; byCount: boolean }): string => {
    const when = p.period ? resultsWhenEn(p.period) : "";
    if (!p.byCount) return `⚽ Results ${when}:`;
    const what = p.n === 1 ? "Last result" : `Last ${p.n} results`;
    return `⚽ ${what}${when ? ` ${when}` : ""}:`;
  },
  results_row: (p: { dayLabel: string; redLabel: string; red: number; yellow: number; yellowLabel: string; winnerLabel: string | null }): string =>
    `• ${p.dayLabel}: ${p.redLabel} ${p.red} - ${p.yellow} ${p.yellowLabel}. ${p.winnerLabel === null ? "A draw." : `${p.winnerLabel} won.`}`,
  /** Asked for more than the record holds. */
  results_all_i_have: "That's every scored match I have on record.",
  /** Asked for more than the group cap. */
  results_capped: (p: { max: number }): string => `I post up to ${p.max} results in the group.`,
  /** A period holding more than the cap. */
  results_latest: (p: { n: number }): string => `These are the latest ${p.n}.`,
  results_none: "I haven't got a scored match on record for this group yet.",
  results_none_when: (p: { period: StatsPeriod }): string => `No scored matches ${resultsWhenEn(p.period)}.`,
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
  // ── the period (2026-09-23): what every table says about its span ──
  // NEVER A DIFFERENT PERIOD WITHOUT SAYING SO (Kemal). `stats_when` is
  // the span a table covers, as it reads after the table's name; `since`
  // is the month the club's records begin, read from the data.
  stats_when: (p: { period: StatsPeriod | null; since: string | null }): string => {
    const q = p.period;
    if (q === null) return p.since ? `since my records began in ${p.since}` : "";
    if (q.kind === "last") return `in ${spanEn(q)}`;
    if (q.kind === "this") return spanEn(q);
    if (q.kind === "season") return p.since ? `this season, since ${p.since}` : "this season";
    return p.since ? `of all time, since my records began in ${p.since}` : "of all time";
  },
  stats_span: (p: { period: StatsPeriod }): string => spanEn(p.period),
  /** Asked further back than the records go. */
  stats_period_unreached: (p: { since: string; span: string }): string =>
    `My records for this club start in ${p.since}, so for ${p.span} this is everything I have.`,
  /** A table the data cannot cut to a period says what it shows, and why. */
  stats_period_not_cut: (p: { table: UncutTable; since: string | null; span: string }): string => {
    const every = p.since ? `every match since ${p.since}` : "every match";
    switch (p.table) {
      case "elo":
        return `Elo is a running rating, so this is the table as it stands now, not one for ${p.span}.`;
      case "team_of_season":
        return `Team of the Season is picked from ${every}, so I can't cut it to ${p.span}.`;
      case "mr_reliable":
        return `Mr Reliable is the stats page badge, earned over ${every}, so I can't cut it to ${p.span}.`;
      case "chemistry":
        return `Chemistry is worked out over ${every}, so I can't cut it to ${p.span}.`;
      case "generic":
        return `These figures cover ${every}, not only ${p.span}.`;
    }
  },
  // The appearances table (2026-09-23), which replaced the 30-day
  // `answer_stats_*` answer and its em-dash row.
  stats_apps_head: (p: { when: string }): string => (p.when ? `Most appearances ${p.when}:` : "Most appearances:"),
  stats_apps_row: (p: { rank: number; name: string; matches: number }): string =>
    `${p.rank}. ${p.name}: ${p.matches} ${p.matches === 1 ? "match" : "matches"}`,
  stats_apps_empty: (p: { when: string }): string =>
    p.when ? `I have no completed matches ${p.when} to count.` : "I have no completed matches to count yet.",
  stats_ratings_head: (p: { n: number; minGames: number; when?: string }): string =>
    p.when
      ? `Top ${p.n} club ratings ${p.when} (players with ${p.minGames}+ rated matches):`
      : `Top ${p.n} club ratings (players with ${p.minGames}+ rated matches):`,
  stats_ratings_row: (p: { rank: number; name: string; avg: string; games: number }): string =>
    `${p.rank}. ${p.name}: ${p.avg} (${p.games} ${p.games === 1 ? "match" : "matches"})`,
  stats_ratings_empty: (p: { minGames: number; url: string; when?: string }): string =>
    p.when
      ? `Nobody has ${p.minGames} rated matches ${p.when}, so there's no ratings table to share for that. The full stats are on the website: ${p.url}`
      : `Nobody has ${p.minGames} rated matches yet, so there's no ratings table to share. The full stats are on the website: ${p.url}`,
  stats_capped: (p: { cap: number; url: string }): string =>
    `I list the top ${p.cap} in the group. The full table is on the website: ${p.url}`,
  stats_bottom: (p: { url: string }): string =>
    `I only share the top of the tables in the group, never the bottom. The full tables are on the website: ${p.url}`,
  stats_mom_head: "Most Man of the Match wins:",
  stats_mom_row: (p: { rank: number; name: string; wins: number }): string =>
    `${p.rank}. ${p.name}: ${p.wins} ${p.wins === 1 ? "win" : "wins"}`,
  stats_mom_empty: "Nobody has won Man of the Match yet.",
  stats_mom_head_when: (p: { when: string }): string => `Most Man of the Match wins ${p.when}:`,
  stats_mom_empty_when: (p: { when: string }): string => `Nobody has won Man of the Match ${p.when}.`,
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
  /** ONE group post when payment collection goes live (2026-09-30,
   *  `payments-live-announce.ts`). Follows the club's pay methods;
   *  `collector` is the collector's first name, or null. */
  payments_live_announcement: (p: { collector: string | null; card: boolean; bank: boolean; direct: boolean }): string => {
    const who = p.collector ?? "the organiser";
    const lines = [
      "💳 *Match fees now go through MatchTime*",
      "",
      "Here's how it works:",
      "• After each game I'll DM everyone who played a link to pay their share.",
    ];
    if (p.card || p.bank) {
      lines.push(
        p.card && p.bank
          ? "• You can pay by card, Apple Pay, Google Pay or straight from your bank."
          : p.card
            ? "• You can pay by card, Apple Pay or Google Pay."
            : "• You can pay straight from your bank.",
      );
      const fee = p.card && p.bank ? "card or bank fee" : p.card ? "card fee" : "bank fee";
      lines.push(`• The amount is the match fee split between the players, with the ${fee} added on top.`);
    }
    lines.push("• If you haven't paid, I'll send you a reminder.");
    if (p.direct) lines.push(`• Paying ${who} directly is fine too. Just DM me *Paid* and ${who} will confirm it.`);
    return lines.join("\n");
  },
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

  /** A third-party claim named only a WhatsApp mention nobody could put
   *  a name to (2026-09-30). Once per batch. */
  ask_who_mentioned: "I couldn't tell who that is, can you say their name?",

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

  // ── row 164: buildStatsLinkSentLine (group-copy.ts), 2026-09-23 ─────
  //   The group's acknowledgement of "@Match Time my stats". It replaced a
  //   bare 📊 react that an admin read as nothing happening. "I'm sending"
  //   and not "I've sent": the DM is a queued job the Pi sends a moment
  //   later, so at the time this posts it has not been delivered. No
  //   number, rating or stat ever goes in it; those stay in the DM.

  stats_link_sent: (p: { firstName: string | null }): string =>
    p.firstName
      ? `📊 ${p.firstName}, I'm sending your stats to you privately by DM.`
      : `📊 I'm sending your stats to you privately by DM.`,

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

  // ── row R170 (2026-09-29): teams only on request, on match day, and
  //    an admin can clear them. The Sutton FC incident of 24 Sep: a
  //    pairing joke built the teams five days early and "delete these
  //    teams" was met with silence. See lib/team-requests.ts.

  team_ops_not_match_day: "I'll build the teams on match day, just ask me then.",
  team_ops_not_a_build_request: "I only build the teams on match day, when someone asks me to generate them.",
  team_ops_say_generate: `Say "@Match Time generate the teams" and I'll build them.`,
  teams_cleared: "Teams cleared. I'll build new ones on match day when asked.",
  teams_clear_nothing: "There are no teams to clear.",
  teams_clear_admin_only: "Only an admin can clear the teams.",
  request_not_handled: "Sorry, I can't do that one yet.",
  /** The same, for an ADMIN (2026-09-30): schedule and settings changes
   *  live in the admin screens, so point there instead of a dead end.
   *  Posted in the group, so `url` is the public URL, never a sign-in. */
  request_not_handled_admin: (p: { url: string }): string =>
    `I can't change that by message, but you can do it on the admin page in a few taps: ${p.url}\n` +
    `Or ask me: *@Match Time help schedule*`,

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
    `👋 Hi, I'm *MatchTime*. I take care of the weekly admin for football groups, right here in WhatsApp:\n\n` +
    `✅ *Who's in:* just say *In* or *Out*. I keep the list and tick your message.\n` +
    `🪑 *The bench:* once you're full, anyone who says *In* late goes on the bench, and the bench gets first dibs if someone drops.\n` +
    `📣 *Chasing:* short of players? I remind the group, and stop once you're full.\n` +
    `⚖️ *Fair teams:* tag me and I pick balanced teams from player ratings.\n` +
    `⭐ *Ratings and Man of the Match* after every game.\n` +
    `📊 *Stats:* ask me anything, and everyone gets their own stats page.\n` +
    `💷 *Match fees:* card or bank pay links, if you want them.\n\n` +
    `I stay quiet during the banter and only reply to In, Out or a tag.\n\n` +
    `*Want me to run this group?* Whoever organises it, reply *YES* and I'll ask two quick questions. ` +
    `Not for you? Ignore me and I'll stay quiet. 🤐`,

  /** The admins question, asked right after consent. */
  onbAdminQuestion: (): string =>
    `Who else helps run this group? Reply with their name + number (or @mention). ` +
    `you can list a few, separated by commas. Or say *just me* if it's only you.`,

  /** The reply to a consent answer: a short lead, then the admins question. */
  onbConsentAck: (p: { adminCaptured: boolean; adminQuestion: string }): string =>
    `${p.adminCaptured ? "Done, you're the admin 🎽" : "Done ✅"} ${p.adminQuestion}`,

  /** The reply to the admins answer: an optional lead, then the details question. */
  onbAdminsAck: (p: { added: number; detailsQuestion: string }): string =>
    (p.added > 0
      ? `Got it, I'll set up ${p.added === 1 ? "that admin" : `those ${p.added} admins`} once we're live. `
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
    return `Almost there, I just need ${parts.join(" and ")}.`;
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
      ? `${adminName || "Admin"}, I've sent you a private link to your admin page, where player names, ratings and payments live. `
      : `Whoever runs this group can claim the admin page any time at matchtime.ai. `;
    return (
      `✅ *All set!* I'm live for *${p.groupName || "this group"}* with: *${p.onLabels.join(", ")}*.\n\n` +
      `📅 First match: *${p.dayName} ${p.kickoffTime}* at *${p.venue}*` +
      `${p.weekly ? ", every week" : ""}.\n` +
      (p.rosterCount > 0
        ? `👥 I've added the *${p.rosterCount} ${p.rosterCount === 1 ? "person" : "people"}* in this group to the squad, no need to type anyone in.\n`
        : ``) +
      (p.adminsAdded > 0
        ? `👮 Added *${p.adminsAdded} co-admin${p.adminsAdded === 1 ? "" : "s"}*, I've DM'd them their admin link.\n`
        : ``) +
      `\n` +
      `${adminLine}Everyone else: just chat normally, say *"in"* when you're playing, and I'll handle the rest. ⚽` +
      `\n\n*How to use me* 👇\n${p.howToUseMe}`
    );
  },

  /** The magic-link DM to the captured admin at completion. */
  onbAdminDm: (p: {
    groupName: string | null;
    url: string;
    payments: boolean;
    /** Signed-in link to the seed editor; null leaves the line out (team
     *  generation off: nothing reads a seed). */
    seedUrl?: string | null;
    blockBookingsUrl?: string | null;
    matchesUrl?: string | null;
  }): string =>
    `👋 You're the admin of *${p.groupName || "your club"}* on MatchTime.\n\n` +
    `Here's your private link to the admin page, where player names, ratings` +
    `${p.payments ? ", payments" : ""} and settings live:\n${p.url}` +
    // 2026-09-30: the club-scoped ratings design offers a new club's
    // admin the seed editor at setup; this DM never said so.
    (p.seedUrl
      ? `\n\n⭐ *Starting ratings:* give each player a rough score out of 10 so my first teams are balanced. ` +
        `Players never see these, and the real ratings take over once players rate each other after games:\n${p.seedUrl}`
      : ``) +
    // Schedule changes live in the admin screens, not WhatsApp commands
    // (Kemal, 2026-09-30).
    (p.blockBookingsUrl ? `\n\n📅 Got a block booking for the season? Add the dates here:\n${p.blockBookingsUrl}` : ``) +
    (p.matchesUrl
      ? `\n\n🗓️ Need to cancel one week or switch its format? Open that match from your match list:\n${p.matchesUrl}`
      : ``) +
    (p.payments
      ? `\n\nWant me to *collect* the money too? Connect a bank from your admin page, takes 2 minutes.`
      : ``),

  /** The magic-link DM to each additional admin named at the admins stage. */
  onbCoAdminDm: (p: { groupName: string | null; url: string }): string =>
    `👋 You've been made an admin of *${p.groupName || "the club"}* on MatchTime.\n\n` +
    `Here's your private link to the admin page:\n${p.url}`,

  /** The DM that points the admin at the enrichment review page. */
  onbEnrichmentDm: (p: { messagesAnalyzed: number; groupName: string | null; playerCount: number; url: string }): string =>
    `📋 I read ${p.messagesAnalyzed} past messages from *${p.groupName || "your group"}* ` +
    `and drafted positions + seed ratings for ${p.playerCount} players.\n\n` +
    `Nothing's applied yet. Review and finish setup here:\n${p.url}`,

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
    paymentCollection?: boolean;
  }): string => {
    const lines: string[] = [];
    if (f.attendance) {
      lines.push(`✅ Say *"In"* or *"Out"* to mark your own availability, no need to tag me.`);
      lines.push(`🤔 Not sure? Just say *"maybe"* and I'll check with you ~24h before.`);
    } else {
      lines.push(`📋 Paste your squad list and I'll read who's playing, no need to tag me.`);
    }
    const caps: string[] = [];
    if (f.attendance) caps.push(`see who's in / how many we've got`);
    if (f.teamBalancing) caps.push(`make / show the teams`);
    if (f.statsQa) caps.push(`who won last week? / past stats`);
    lines.push(`💬 Tag *@Match Time* when you want me to do or tell you something:`);
    for (const c of caps) lines.push(`   • ${c}`);
    lines.push(`🤐 I stay quiet the rest of the time: banter and jokes are safe, I won't butt in.`);
    if (f.momVoting) lines.push(`🏆 After the game I'll run a quick *Man of the Match* vote.`);
    if (f.playerRating) lines.push(`⭐ I'll DM you a one-tap *rating* link after the match.`);
    // Reworded 2026-09-30: "and I'll nudge you" left people guessing what
    // the command was for. It is a personal DM at the time you name.
    if (f.reminders) lines.push(`⏰ Need a nudge? Say *"@Match Time remind me Thursday"* and I'll DM you then.`);
    // Payments are off after setup (2026-09-30): the off state now points
    // the organiser at how fee collection works instead of saying nothing.
    // Players learn they can pay through MatchTime (2026-09-30); an
    // organiser whose club does not collect yet learns that it can.
    if (f.paymentCollection) lines.push(`💷 After each game I'll DM you a pay link: card, Apple or Google Pay, or bank.`);
    if (f.paymentTracking) lines.push(`💳 I keep track of who's *paid*.`);
    if (!f.paymentTracking && !f.paymentCollection) lines.push(`💷 Want to collect match fees? Ask me: *@Match Time help payments*`);
    lines.push(`\nType *"@Match Time help"* any time to see this again.`);
    return lines.join("\n");
  },

  /** Bare "@Match Time help": the lead line above the topic list. */
  onbHelpHead: (): string => `ℹ️ *MatchTime help*: here's what I can explain. Tag me with one of these:`,

  /** One line of the bare-help topic list. `word` is what the player
   *  types after "help" in this language; `label` names the topic. */
  onbHelpTopicLine: (p: { word: string; label: string }): string =>
    `   • *@Match Time help ${p.word}*: ${p.label}`,

  /** The word a player types after "help" for each topic, in this language. */
  onbHelpTopicWord: (p: { topic: "availability" | "teams" | "mom" | "ratings" | "reminders" | "payments" | "schedule" | "badges" }): string =>
    p.topic,

  /** Human label for each topic, used in the bare-help topic menu. */
  onbHelpTopicLabel: (p: { topic: "availability" | "teams" | "mom" | "ratings" | "reminders" | "payments" | "schedule" | "badges" }): string =>
    ({
      schedule: "schedule & bookings",
      badges: "badges and how to earn them",
      availability: "squad & availability",
      teams: "fair teams",
      mom: "Man of the Match",
      ratings: "player ratings",
      reminders: "reminders",
      payments: "payment tracking",
    })[p.topic],

  /** "help <topic>" for a topic whose feature is off. Unused since
   *  2026-09-30 (an off topic now explains itself, see onbHelpOffLead);
   *  kept because the Turkish table mirrors this one key for key. */
  onbHelpNotOn: (): string =>
    `That one isn't switched on for this group. Type *@Match Time help* to see what is.`,

  /** "help <topic>" for a topic whose feature is OFF (2026-09-30): the
   *  line above the explainer. */
  /** "help schedule" (2026-09-30): schedule changes are made in the admin
   *  screens, not by WhatsApp command (Kemal). Labels are the screens' own
   *  (verified against src/app/admin/activities, block-bookings,
   *  matches/bulk and matches/[id]/switch-format). A single week's
   *  kick-off cannot be moved anywhere in the UI, and this says so. */
  onbHelpSchedule: (p: {
    audience: "group" | "admin" | "player";
    activities: string;
    blockBookings: string;
    bulk: string;
    matches: string;
  }): string => {
    if (p.audience === "player") {
      return `🗓️ Match days, kick-off times, cancellations and block bookings are set by your organiser on the admin page. Ask them if something needs changing.`;
    }
    return (
      `🗓️ *Changing the schedule*\n` +
      `Schedule changes are made on the admin page, not by message. Each takes a few taps.\n\n` +
      `1️⃣ *Weekly game (day, kick-off time, venue):* on *Activities*, tap *Edit* on the game, change it, then *Save changes*. Only future matches change. The group isn't told.\n${p.activities}\n\n` +
      `2️⃣ *Block booking for the season:* on *Block bookings*, tap *New block booking*, pick the start date and an end date or a number of matches, tap *Preview dates*, then *Create block*. The group isn't told.\n${p.blockBookings}\n\n` +
      `3️⃣ *Cancel one week (or a run of dates):* on *Block bookings*, tap *Bulk cancel / restore*, set *From* and *To* to the date, tap *Find matches*, tick *Announce to the group* if you want me to post it, then confirm. Restoring works the same way.\n${p.bulk}\n\n` +
      `4️⃣ *Switch one match to another format:* open the match from your match list, tap *Switch format*, pick the format, then *Confirm switch*. I post the new line-up in the group.\n${p.matches}\n\n` +
      `One week's kick-off time can't be moved on its own yet: change the weekly game instead, for the weeks ahead.` +
      (p.audience === "group"
        ? `\nAdmins: DM me *help schedule* and I'll send these as links that sign you straight in.`
        : ``)
    );
  },

  onbHelpOffLead: (): string => `ℹ️ This isn't switched on for this group yet, but here's how it works.`,

  /** The setting's name on the admin Settings page (an English-only page,
   *  so both languages quote these words as they appear there). */
  onbHelpSettingLabel: (p: { topic: "availability" | "teams" | "mom" | "ratings" | "reminders" | "payments" }): string =>
    ({
      availability: "Attendance tracking",
      teams: "Team generation",
      mom: "Man of the Match",
      ratings: "Player ratings",
      reminders: "Personal reminders",
      payments: "Payment tracking",
    })[p.topic],

  /** How fee collection works, for "help payments" while it is off. The
   *  on-state explainer (onbHelpExplainer) is about tracking; this is the
   *  thing an organiser has not got yet. */
  onbHelpPaymentsOff: (): string =>
    `💷 *Match fees: how it works*\n` +
    `After each game I ask your money collector for the fee per player, then DM everyone who played a link to pay their share, by card or bank. The money goes straight to the money collector's bank.\n` +
    `I chase anyone who hasn't paid with a daily reminder, so nobody has to chase their mates for cash.\n` +
    `Paid in cash or by transfer instead? The player tells me *"paid"* and I ask the money collector to confirm it landed.`,

  /** How to switch an off topic on, worded for who asked. `url` is the
   *  public settings URL (group) or the admin's signed-in link (admin).
   *  `word` is the topic word in this language. */
  onbHelpSwitchOn: (p: {
    topic: "availability" | "teams" | "mom" | "ratings" | "reminders" | "payments";
    audience: "group" | "admin" | "player";
    url: string;
    word: string;
    label: string;
  }): string => {
    if (p.audience === "player") {
      return p.topic === "payments"
        ? `🔧 Your organiser switches this on from the admin page. Ask them if you'd like to pay this way.`
        : `🔧 Your organiser can switch this on from the admin page. Ask them if you'd like it.`;
    }
    if (p.audience === "admin") {
      const what =
        p.topic === "payments"
          ? `turn on *Payment tracking* and *Collect match fees* under Bot features, pick the money collector, then connect their bank with Stripe once (about 2 minutes)`
          : `turn on *${p.label}* under Bot features`;
      return `🔧 To switch it on, open *Settings* on your admin page and ${what}:\n${p.url}`;
    }
    const what =
      p.topic === "payments"
        ? `turns on *Payment tracking* and *Collect match fees* under Bot features, picks the money collector, then connects their bank with Stripe once (about 2 minutes)`
        : `turns on *${p.label}* under Bot features`;
    return (
      `🔧 To switch it on, an admin opens *Settings* on the admin page (${p.url}) and ${what}.\n` +
      `Admins: DM me *help ${p.word}* and I'll send you a link that signs you straight in.`
    );
  },

  /** An admin's DM help: where a topic's settings live (topic ON). */
  onbHelpAdminSettings: (p: { url: string }): string => `⚙️ Its settings are on your admin page:\n${p.url}`,

  /** An admin's DM help: bare help's closing link. */
  onbHelpAdminPage: (p: { url: string }): string => `⚙️ Your club's settings, signed in:\n${p.url}`,

  /** DM help for somebody in more than one club: which club it answers for. */
  onbHelpForClub: (p: { club: string }): string => `🏟️ For *${p.club}*:`,

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
        `⭐ *Player ratings: how it works*\n` +
        `After each match I DM every player who turned out a private link. You rate the other players out of 10 (you can't rate yourself, and your scores stay private).\n` +
        `I combine everyone's scores into a form rating for each player at this club, updated after every game, and that is what I use to build *balanced teams*. Ratings stay inside the club: if you also play for another group, their scores never touch this one. So the more people rate, the fairer the teams.\n` +
        `You'll get the link the morning after the game. Type *@Match Time my stats* for yours anytime.`,
      teams:
        `🟥🟦 *Fair teams: how it works*\n` +
        `Once the squad's locked in, any admin can tag *@Match Time generate the teams* and I'll split everyone into two balanced sides using their form ratings, so games stay even.\n` +
        `I post the line-ups straight into the chat. Not happy with a pairing? Tag me to *swap two players* (e.g. _"@Match Time swap Sam and Alex"_), or ask me to *"@Match Time show the teams"* again any time.\n` +
        `Want a bit of fun? Ask me to give the teams names and I'll sort it. Tag *@Match Time generate the teams* when you're ready.`,
      mom:
        `🏆 *Man of the Match: how it works*\n` +
        `After the final whistle I post a quick *Man of the Match* vote in the group. Everyone just taps who they thought was the standout player.\n` +
        `I tally the votes, announce the winner, and it counts towards everyone's season stats, so the MoM race builds up over the year.\n` +
        `Nothing to set up: I'll start the vote myself once the game's done. Type *@Match Time my stats* to see your MoM tally.`,
      availability:
        `⚽ *Squad & availability: how it works*\n` +
        `Just say *In* or *Out* in the group to mark yourself for the next game. No need to tag me, I read it automatically.\n` +
        `I keep a live, numbered squad list. When it's full, extra players go on the *bench/reserve* list in order. Not sure yet? Say *"maybe"* and I'll DM you ~24h before kick-off for a final answer.\n` +
        `If you drop out, I can nudge the bench to step in so we're never short. Say *Out* any time and I'll sort the rest.`,
      reminders:
        `⏰ *Reminders: how it works*\n` +
        `I gently nudge anyone who hasn't said *In* or *Out* yet, then remind the whole squad before kick-off so nobody forgets.\n` +
        `Want a personal nudge? Say *"@Match Time remind me Thursday"* and I'll DM you then.\n` +
        `It all happens automatically, so you don't need to chase anyone yourself.`,
      payments:
        `💳 *Payment tracking: how it works*\n` +
        `I keep track of who's paid the match fee. The organiser sets the fee, and I show who's paid and who still owes at a glance.\n` +
        `I send friendly reminders to anyone outstanding. Players can pay by card, or the organiser can mark cash and bank transfers as received.\n` +
        `This only runs when payment tracking is switched on. Tag *@Match Time who still owes?* to see the latest.`,
    })[p.topic],

  // ── "help badges" (2026-10-01) ──────────────────────────────────────
  // Deterministic, no model. Every number comes from `BadgeNumbers`,
  // built from the constants the stats page awards the badges with
  // (src/lib/badge-rules.ts, src/lib/mr-reliable.ts). Badge names stay
  // as the stats page prints them.

  /** "help badges": the line above the list. */
  onbHelpBadgesHead: (): string => `🏅 *Badges: how to earn them*`,

  /** One badge in the list: its emoji, name and rule in one line. */
  onbHelpBadgeLine: (p: { key: BadgeKey; emoji: string; label: string; n: BadgeNumbers }): string => {
    const n = p.n;
    const rule = ({
      "first-game": `play your first game.`,
      "ten-games": `play ${n.regularMinGames} or more games.`,
      ironman: `play every match since joining, with at least ${n.ironManMinMatches} matches played.`,
      "first-mom": `win the Man of the Match vote once.`,
      "mom-machine": `win the Man of the Match vote ${n.momMachineMinWins} or more times.`,
      masterclass: `average ${n.masterclassMinGameAvg} or more in a single game.`,
      reliable: `get rated in at least ${n.mrReliableMinGames} games, average ${n.mrReliableMinAvg} or more, and stay steady from game to game.`,
      "above-field": `get rated in at least ${n.aboveCurveMinRatedGames} games and average above the club average.`,
    } as Record<BadgeKey, string>)[p.key];
    return `${p.emoji} *${p.label}*: ${rule}`;
  },

  /** Below the list: where badges come from, which can be lost, and how
   *  to ask about one. `dm`: the asker is in a private chat (no tag). */
  onbHelpBadgesFoot: (p: { dm: boolean; example: string }): string =>
    `Badges are worked out from all finished games at this club. Most stay once earned. ` +
    `Iron Man, Mr Reliable and Above the Curve can be lost: Mr Reliable and Above the Curve come back when the ratings do, and Iron Man ends with the first missed match.\n` +
    `For the full rules of one badge: *${p.dm ? "" : "@Match Time "}help badges ${p.example}*`,

  /** "help badges <name>" for a name that is no badge: the line above the list. */
  onbHelpBadgesUnknown: (p: { query: string }): string => `🤔 I don't know a badge called "${p.query}". Here they all are:`,

  /** Closes one badge's rules. */
  onbHelpBadgesClubNote: (): string => `Badges are worked out from all finished games at this club.`,

  /** "help badges <name>": that badge's full rules. */
  onbHelpBadgeDetail: (p: { key: BadgeKey; emoji: string; label: string; n: BadgeNumbers }): string => {
    const n = p.n;
    const points = (x: number) => `${x} point${x === 1 ? "" : "s"}`;
    const kept = `Once earned, it stays.`;
    const body = ({
      "first-game":
        `Earned by playing a first game at this club. A game counts once it's finished and the player was in the confirmed squad or on the team sheet.\n${kept}`,
      "ten-games":
        `Earned by playing ${n.regularMinGames} or more games at this club. Every finished game the player was in the confirmed squad or on the team sheet for counts.\n${kept}`,
      ironman:
        `Earned when both are true:\n` +
        `1. Played every match at this club since joining. Matches from before they joined don't count against them.\n` +
        `2. At least ${n.ironManMinMatches} matches have been played in that time.\n` +
        `It ends with the first missed match, and that match always counts, so it doesn't come back.`,
      "first-mom":
        `Earned by winning the Man of the Match vote once. If two or more players tie on the most votes, they all win it.\n${kept}`,
      "mom-machine":
        `Earned by winning the Man of the Match vote ${n.momMachineMinWins} or more times. A tie on the most votes counts as a win for everyone in the tie.\n${kept}`,
      masterclass:
        `Earned with one game where the ratings the other players gave average ${n.masterclassMinGameAvg} or more. One game is enough.\n${kept}`,
      reliable:
        `Earned when all three are true:\n` +
        `1. Rated in at least ${n.mrReliableMinGames} games.\n` +
        `2. An average rating of ${n.mrReliableMinAvg} or more across all their ratings.\n` +
        `3. Steady from game to game: their game-by-game averages don't swing much. In numbers, the spread (standard deviation) is under ${points(n.mrReliableMaxSpread)}. ` +
        `A player who scores ${n.mrReliableSteady.join(", ")} qualifies. One who scores ${n.mrReliableSwinging.join(", ")} doesn't, even if the average is similar.\n` +
        `It can be lost if the ratings drop or start to swing, and comes back when they settle again.`,
      "above-field":
        `Earned when both are true:\n` +
        `1. Rated in at least ${n.aboveCurveMinRatedGames} games.\n` +
        `2. Their average rating (every rating they've received) is higher than the club average (every rating given to every player in the club's games).\n` +
        `It can be lost if their average drops to the club average or below, and comes back when it climbs above it again.`,
    } as Record<BadgeKey, string>)[p.key];
    return `${p.emoji} *${p.label}*\n${body}`;
  },

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

  /** Row 103: the bench DM's one clarification. `day` as in the row 81
   *  context clause: null on match day ("tonight"), else "Tue 6 Oct". */
  dm_bench_unclear: (p: { day: string | null }): string =>
    `Want the open slot for ${p.day ?? "tonight"}? Reply *YES* to grab it. ` +
    `If not, no worries, you stay on the bench either way 🙏`,

  /** Row 104: the bench DM's ack, from what the claim did. */
  dm_bench_ack: (p: { kind: "declined" | "confirmed" | "taken" | "other"; day: string | null }): string =>
    ({
      declined: `👍 No worries, you're still on the bench, nothing changes.`,
      confirmed: `✅ You got it, you're in for ${p.day ?? "tonight"}! ⚽`,
      taken: `Ah, someone just grabbed that one first. You're still first in line on the bench if another opens 🙏`,
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

  /** Row 157: the collector's notice that a player is settling directly.
   *  Sent once per player per match, by `markDirectPaymentPending`, from
   *  either the pay page's button (`claimedPaid: false`, "they'll pay") or
   *  a player DMing "Paid" (`claimedPaid: true`, "they've paid"). Nothing
   *  is marked paid until the collector taps the link and confirms.
   *  Moved from app/actions/payments.ts on 2026-09-23; the one English
   *  change is ":" where it had a dash. */
  dm_direct_pay_notice: (p: {
    playerName: string | null;
    activityName: string;
    amount: string;
    quantity: number;
    url: string;
    claimedPaid: boolean;
  }): string =>
    `💸 *${p.playerName ?? "A player"}* ${p.claimedPaid ? "says they've paid you directly" : "says they'll pay you directly"} ` +
    `for *${p.activityName}*: *${p.amount}*${p.quantity > 1 ? ` (${p.quantity} players)` : ""}.\n\n` +
    `Mark it paid once it lands:\n${p.url}`,

  /** Row 158: the player's reply when their "Paid" DM was passed to the
   *  collector. `collectorName` is the collector's first name. */
  dm_paid_claim_ack: (p: { firstName: string | null; collectorName: string | null; amount: string; activityName: string }): string =>
    `Thanks${p.firstName ? ` ${p.firstName}` : ""}, I've told ${p.collectorName ?? "the organiser"} you've paid ` +
    `*${p.amount}* for *${p.activityName}*. ${p.collectorName ?? "The organiser"} will confirm once it lands 👍`,

  /** Row 159: the same, when the collector already knew (a second "paid",
   *  or a "paid" after tapping "Pay the collector directly"). */
  dm_paid_claim_already: (p: { firstName: string | null; collectorName: string | null; amount: string; activityName: string }): string =>
    `Already done${p.firstName ? ` ${p.firstName}` : ""}: ${p.collectorName ?? "the organiser"} knows about your ` +
    `*${p.amount}* for *${p.activityName}* and will confirm once it lands 👍`,

  /** Row 160: "paid for me and my mate". Nothing is recorded (MatchTime
   *  does not guess how many people a payment covered); the pay page has
   *  the guest count and the "Pay the collector directly" button. */
  dm_paid_for_others: (p: { firstName: string | null; collectorName: string | null; url: string }): string =>
    `Thanks${p.firstName ? ` ${p.firstName}` : ""}! So ${p.collectorName ?? "the organiser"} gets the right amount to confirm, ` +
    `open your pay link, set how many people you paid for and choose *Pay the collector directly*:\n${p.url}`,

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
    `👋 *Hey, I'm MatchTime*, the automatic organiser for your football group. ` +
    `I take the weekly admin off your hands so you can just turn up and play.\n\n` +
    `Here's what I do:\n` +
    `⚽ *Attendance:* players just say "in" or "out" right here; I keep the squad list live and chase the stragglers\n` +
    `⚖️ *Fair teams:* auto-balanced sides every week from real player ratings\n` +
    `🪑 *Smart bench:* squad full? I offer the spot to the whole bench, first to claim it plays. Nobody's ever dropped for being asleep\n` +
    `🏆 *Man of the Match & ratings:* a quick post-match vote and a one-tap rating link, no app to install\n` +
    `⏰ *Reminders & stats:* "@MatchTime remind me Thursday", or ask me "who got MoM last week?"\n\n` +
    `No spreadsheets, no chasing, no admin headaches. ⚡\n\n` +
    `Let's get you set up, it takes about a minute:`,

  /** The seven setup questions; `groupName` is only printed by "side". */
  onb_legacy_question: (p: {
    field: "name" | "side" | "day" | "time" | "venue" | "recurrence" | "date";
    groupName: string;
  }): string =>
    ({
      name: "👋 Let's get MatchTime set up for this group! First, what should I call your club/group? (e.g. *Thursday Ballers*)",
      side: `Great, *${p.groupName}* it is. How many players per side? (e.g. *7* for 7-a-side, *5* for 5-a-side)`,
      day: "Which *day of the week* do you usually play? (e.g. Thursday)",
      time: "What *kickoff time*? (e.g. 9:30pm)",
      venue: "Where do you play? The *venue* name, please.",
      recurrence: "Is this a *weekly* fixture or a *one-off* match?",
      date: "What *date* is the one-off match? (e.g. 2026-05-28)",
    })[p.field],

  /** The numbered feature menu under a lead line. */
  onb_legacy_menu: (p: { lead: string; items: Array<{ label: string; blurb: string }> }): string => {
    const lines = p.items.map((f, i) => `${i + 1}. *${f.label}*: ${f.blurb}`);
    return (
      `${p.lead}:\n\n${lines.join("\n")}\n\n` +
      `Reply with the ones you want, e.g. "Man of the Match and player ratings", ` +
      `"everything", or "all except payments".`
    );
  },

  /** A feature's one-line description in the menu. */
  onb_legacy_feature_blurb: (p: { key: string; englishBlurb: string }): string => p.englishBlurb,

  onb_legacy_menu_retry_lead: "I didn't catch which ones. Reply with the features you want",

  onb_legacy_provisioned_lead: (p: {
    groupName: string;
    playersPerTeam: number;
    dayName: string;
    kickoffTime: string | null;
    venue: string | null;
  }): string =>
    `Nice, *${p.groupName}* is set up for *${p.playersPerTeam}-a-side* on *${p.dayName}s ${p.kickoffTime}* at *${p.venue}*.\n\nLast step: which features do you want? Here's everything I can do`,

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

  /** THE ONE LINE A CLUB HEARS AT ITS DAILY AI CAP (2026-09-29). Sent at
   *  most once per club per London day, and only to a message that tags
   *  MatchTime; see `ai-budget.ts`. It names no limit and no money: a
   *  player has no reason to know there is a budget, only that tomorrow
   *  works. Plain IN and OUT keep working all day, so it must not suggest
   *  MatchTime has stopped. */
  ai_daily_cap_reached: (): string => "I've answered a lot of questions today, ask me again tomorrow.",

  // ── /profile/stats: the squad leaderboard and Team of the Season panels
  // (2026-09-30). Kemal: "i like the rule for the leaderboard, implement
  // it and update the info button description on the panel." Both
  // panels now apply ONE rule, so both info buttons state it from ONE
  // string (`stats_table_rule`) and cannot contradict each other. New
  // copy, house style: plain, no em dashes.
  stats_leaderboard_title: "Squad leaderboard",
  stats_leaderboard_info_lead: "Everyone in the table, ranked by their average rating this season.",
  stats_leaderboard_info_arrows_lead: "The arrow shows how each player moved since last week's match:",
  stats_leaderboard_arrow_up: "climbed",
  stats_leaderboard_arrow_down: "dropped",
  stats_leaderboard_arrow_same: "no change",
  stats_leaderboard_new: "new",
  stats_leaderboard_you: " (you)",
  stats_leaderboard_not_ranked: "not ranked",
  /** The rule, once, for both info buttons. The minimum is the one
   *  constant `GROUP_RATINGS_MIN_GAMES`, passed in, never typed here. */
  stats_table_rule: (p: { minGames: number }): string =>
    `The squad leaderboard and Team of the Season use the same rule: a player needs at least ${p.minGames} rated matches and a match in the last three months. Anyone away for longer drops out until they play again, then comes straight back with the same rating, because it is never reduced while they are away.`,
  /** The viewer's own row when they have fewer rated matches than the
   *  table needs. `games` is at least 1: a player never rated gets no
   *  row at all. */
  stats_leaderboard_join: (p: { minGames: number; games: number }): string =>
    `Play ${p.minGames} rated matches to join the table. You have ${p.games} so far, so ${p.minGames - p.games} more to go.`,
  /** The viewer's own row when three months away took them out. */
  stats_leaderboard_away: (p: { avg: string; lastPlayed?: string }): string =>
    `You're not in the rankings at the moment${p.lastPlayed ? `: your last game was ${p.lastPlayed}` : ""}. Your ${p.avg} is untouched, and one more game puts you straight back in the table with it.`,
  stats_tots_title: "Team of the Season",
  stats_tots_info_lead: (p: { sportName: string }): string =>
    `The best line-up of the season so far: the player with the highest season average rating in each position (${p.sportName}).`,

  // ── /profile/stats: share cards as an image (2026-10-01). The season
  //    card and each earned badge open the phone's share sheet with the
  //    PNG attached; where that is not possible the PNG is downloaded and
  //    `stats_share_saved` says what to do next. Badge labels themselves
  //    are English in both languages (they come from player-stats.ts). ──
  stats_share_card: "Share card",
  stats_share_badge_label: (p: { label: string }): string => `Share ${p.label}`,
  stats_share_saved: "Image saved. Send it in WhatsApp.",
  stats_share_failed: "Couldn't make the image. Try again.",
  stats_share_badge_text: (p: { emoji: string; label: string; orgName: string }): string =>
    `I just earned ${p.emoji} ${p.label} at ${p.orgName} on MatchTime`,
  stats_share_season_text: (p: { orgName: string }): string => `My season at ${p.orgName} on MatchTime`,

  // ── Badge announcements (2026-10-01): the group post two days after a
  //    match (badge-announcements.ts) and its switch on /admin/settings.
  //    NEW copy, house style, no em dashes. One line per badge; players
  //    who earned the same badge share its line. Badge names stay English
  //    in both languages, as on the stats page. "them", never "him". ──
  badges_post_header: "🏅 *New badges this week*",
  // No URL: links in the group would be personal. The stats link rides
  // on each player's own rating DM (`dm_rating`).
  badges_post_footer:
    "Well played all! 👏\n📊 See your own stats and badges any time: tap the stats link in my rating DM after each match.",
  badges_line_first_game: (p: { emoji: string; label: string; names: string[] }): string =>
    p.names.length === 1
      ? `${p.emoji} *${p.label}*: welcome ${boldNamesEn(p.names)}, first game for the club! 🎉`
      : `${p.emoji} *${p.label}*: welcome ${boldNamesEn(p.names)}, first games for the club! 🎉`,
  /** `shared`: groups of first-timers who co-won the same match; `solo`:
   *  first-timers who did not share theirs with another first-timer. */
  badges_line_first_mom: (p: { emoji: string; label: string; shared: string[][]; solo: string[] }): string => {
    const clauses = p.shared.map(
      (g) => `${boldNamesEn(g)} shared it, ${g.length === 2 ? "a first for both" : "a first for all of them"}`,
    );
    if (p.solo.length > 0) clauses.push(`${boldNamesEn(p.solo)} won it for the first time`);
    return `${p.emoji} *${p.label}*: ${clauses.join("; ")} ⭐`;
  },
  badges_line_mom_machine: (p: { emoji: string; label: string; names: string[] }): string =>
    `${p.emoji} *${p.label}*: ${boldNamesEn(p.names)} ${p.names.length === 1 ? "has" : "have"} now been Man of the Match 3 times 🔥`,
  badges_line_masterclass: (p: { emoji: string; label: string; names: string[] }): string =>
    `${p.emoji} *${p.label}*: ${boldNamesEn(p.names)} averaged 9+ in a game, top class 🎯`,
  badges_line_ten_games: (p: { emoji: string; label: string; names: string[] }): string =>
    `${p.emoji} *${p.label}*: ${boldNamesEn(p.names)} ${p.names.length === 1 ? "has" : "have"} now played 10 games 💪`,
  badges_line_reliable: (p: { emoji: string; label: string; names: string[] }): string =>
    `${p.emoji} *${p.label}*: ${boldNamesEn(p.names)}, strong ratings week after week, you can count on them 🔒`,
  badges_feature_label: "Badge announcements",
  badges_feature_blurb:
    "Two days after each match, posts the new badges in the group: first game, Regular, Man of the Match, MoM Machine, Masterclass, Mr Reliable.",

  // ── Self-join, slice 4: the organiser web (2026-09-29) ────────────
  // MDs/self-join-and-approval-plan-2026-09-28.md sections 5.1 to 5.3.
  // The website a new organiser reads while creating a club and
  // connecting MatchTime to WhatsApp: the club setup form (with the
  // weekly game, decision 2), the prefilled connect message and the
  // status card on the club's admin home. NEW copy, not a move, so it
  // follows house style: plain, friendly, no em dashes.

  /** The weekly game's name, which the group reads in every post
   *  ("Football 7-a-side"). Also the size picker's option label. */
  sj_activity_name: (p: { perSide: number }): string => `Football ${p.perSide}-a-side`,
  sj_per_side_option: (p: { perSide: number }): string => `${p.perSide}-a-side`,

  sj_form_title: "Set up your club",
  sj_form_lead: "Tell us about your club and your weekly game. Then you'll connect MatchTime to your WhatsApp group.",
  sj_form_club_name: "Club name",
  sj_form_club_name_placeholder: "e.g. Riverside FC",
  sj_form_language: "Language MatchTime speaks in your group",
  sj_form_game_heading: "Your weekly game",
  sj_form_day: "Day",
  sj_form_time: "Kick-off time",
  sj_form_venue: "Venue",
  sj_form_venue_placeholder: "e.g. Goals Wembley",
  sj_form_per_side: "Players per side",
  sj_form_submit: "Create club",
  sj_form_submitting: "Creating...",

  sj_err_invalid: "Please fill in every field.",
  sj_err_verify_phone: "Please confirm your WhatsApp number first, so MatchTime knows it's you.",
  sj_verify_phone_link: "Confirm my number",
  sj_err_one_club: "You already have a club on MatchTime. Open it from your profile.",
  sj_open_my_club: "Open my club",
  sj_err_site_cap: "We're taking on a few new clubs each day. Please try again tomorrow.",
  sj_err_generic: "Something went wrong. Please try again.",

  /** The message WhatsApp opens with. The server reads only the code
   *  after "code", so an organiser who edits the rest still gets in. */
  sj_connect_prefill: (p: { club: string; code: string }): string => `Connect ${p.club}, code ${p.code}`,

  sj_card_title: "Connect MatchTime to WhatsApp",
  sj_button: "Add MatchTime to WhatsApp",
  sj_button_again: "Open WhatsApp again",
  sj_card_draft: "Tap the button below. WhatsApp opens with a short message ready to send to MatchTime.",
  sj_card_issued: "Step 1: send the message that opens in WhatsApp. This code works for 60 minutes.",
  sj_card_code: (p: { code: string }): string => `Your code: ${p.code}`,
  sj_card_wrong_number: (p: { seen: string; expected: string }): string =>
    `We got your code from ${p.seen}. Please send it from ${p.expected}, the number you signed up with.`,
  sj_card_dm_verified:
    "Step 2: add MatchTime to your football group. Save the number below as a contact called MatchTime, then open the group, tap Add participant and pick MatchTime.",
  sj_card_number_label: "MatchTime's WhatsApp number",
  sj_card_pending:
    "Step 3: we're checking your club, usually within a day. MatchTime stays quiet in the group until your club is approved, and messages you on WhatsApp when it's live.",
  sj_card_pending_other: (p: { group: string }): string =>
    `MatchTime was added to "${p.group}" by someone else. We'll check it before switching on.`,
  sj_card_approved: (p: { group: string }): string => `You're live. MatchTime said hello in "${p.group}".`,
  sj_card_rejected: "We can't take this group on right now.",
  sj_card_expired: "That code expired. Tap the button again for a new one.",
  sj_card_code_cap: "You've used today's codes. Please try again tomorrow.",
  sj_card_unavailable: "MatchTime can't take new groups at the moment. Please check back soon.",
  sj_card_already_connected: "You're already connected. Now just add MatchTime to your group.",

  // ── /admin/players (2026-09-29) ─────────────────────────────────────
  /** Heading of the banner over auto-added members. */
  admin_players_new_heading: (p: { count: number }): string =>
    `${p.count} new ${p.count === 1 ? "player" : "players"} joined via WhatsApp`,
  /** Its body. ONE string with the names inside it, so the space after
   *  the last name cannot be lost the way JSX lost it ("Hamzahposted"). */
  admin_players_new_body: (p: { names: string[] }): string =>
    `${p.names.length > 0 ? p.names.join(", ") : "They"} posted in the group and got auto-added. ` +
    `Review phone, position and seed rating below, then hit ✓ to confirm, or ✕ to remove if they're not a player.`,
  /** Column beside the seed: the club's rating of the player, the same
   *  number the player sees on their own page. */
  admin_players_club_rating_header: "Club rating",
  admin_players_club_rating_hint:
    "The average of the ratings this club's players have given them, the same number they see on their own page. The team balancer also leans on the seed until more ratings come in.",
  admin_players_not_rated_yet: "Not rated yet",
  admin_players_rated_games: (p: { count: number }): string =>
    `${p.count} rated ${p.count === 1 ? "game" : "games"}`,
  /** Cap 6 (plan section 7): new groups linked across the whole site. The
   *  same line on the card and, once, in WhatsApp. */
  sj_site_cap_groups: "We're taking on a few new groups each day. Please try again tomorrow.",

  // ── Self-join slice 5: the replies to the connect DM (plan 5.3, 5.4) ──
  /** After the organiser's connect DM, from the number they signed up with. */
  sj_dm_connected: (p: { name: string | null; club: string }): string =>
    `Hi${p.name ? ` ${p.name}` : ""}, got it: ${p.club} is connected to this chat.\n` +
    "Next, add me to your football group. Save this number as a contact called MatchTime first, then open the group, tap Add participant and pick MatchTime.\n" +
    "I'll stay quiet in the group until your club is approved, usually within a day. I'll message you here when it's live.",
  sj_dm_already_connected: "You're already connected. Now just add me to your group.",
  sj_dm_code_expired: "That code has expired. Open your club on matchtime.ai and tap Add MatchTime to WhatsApp again.",

  // ── Self-join slice 6: the organiser's ack after a matched group add (plan 5.4) ──
  /** Sent only when the adder WAS the organiser (matched by phone or by the
   *  connect DM's WhatsApp id). `group` is the group's subject, when read. */
  sj_dm_in_group: (p: { group: string | null }): string =>
    `Thanks, I'm in ${p.group ? `"${p.group}"` : "your group"}. I'll stay quiet there until your club is approved, usually within a day. I'll message you here when it's live.`,

  // ── Self-join slice 7: the decision (plan 5.4, 6.3) ──
  /** The first thing MatchTime ever says in a newly approved group
   *  (2026-10-01: the full feature intro, modelled on `onbIntro`, without
   *  its consent and setup questions: the club is already approved).
   *  Static apart from the organiser's first name, like `onbIntro`.
   *  Payments are only ever something the organiser CAN switch on. */
  sj_group_hello: (p: { organiser: string | null }): string =>
    `👋 Hi everyone, I'm *MatchTime*. ${p.organiser ? `${p.organiser} has set me up to run this group's games.` : "I'm here to run this group's games."} ` +
    `Here's what I do, right here in WhatsApp:\n\n` +
    `✅ *Who's in:* just say *In* or *Out*. I keep the list and tick your message.\n` +
    `🪑 *The bench:* once we're full, anyone who says *In* late goes on the bench, and the bench gets first dibs if someone drops.\n` +
    `⏰ *Remind me:* say *"@Match Time remind me Thursday"* and I'll DM you then.\n` +
    `⚖️ *Fair teams:* tag me and I pick balanced teams from player ratings.\n` +
    `⭐ *Man of the Match and ratings* after every game.\n` +
    `📊 *Stats:* ask me anything, and everyone gets their own stats page.\n` +
    `💷 *Match fees:* your organiser can switch on card or bank pay links.\n\n` +
    `I stay quiet during the banter and only reply to In, Out or a tag. Anything else, tag me: *@Match Time help*`,
  /** To the organiser, once, when the owner approves (2026-10-01: a short
   *  checklist). Each URL is the organiser's own signed-in link to that
   *  page, so this DM goes to the organiser only. Without billing the one
   *  pricing sentence is "Your first month is free.", never an amount, and
   *  it ends the DM. For a BILLED club (club fee billing slice B2:
   *  BILLING_ENABLED on and the plan not Free) `tip` is the
   *  `sj_dm_approved_tip` paragraph, which follows that sentence. */
  sj_dm_approved: (p: {
    club: string;
    group: string | null;
    scheduleUrl: string;
    ratingsUrl: string;
    settingsUrl: string;
    tip?: string | null;
  }): string =>
    `Good news: ${p.club} is live. I've said hello in ${p.group ? `"${p.group}"` : "your group"}.\n\n` +
    `A few things to set up when you have a minute:\n\n` +
    `📅 *Your weekly game:* check the day, time and venue, or change them:\n${p.scheduleUrl}\n\n` +
    `⭐ *Starting ratings:* give each player a rough score out of 10 so the first teams are fair:\n${p.ratingsUrl}\n\n` +
    `⚙️ *Settings:* switch on payments, rolling squad, weekly deadlines, admin messages, organiser picks and badge announcements:\n${p.settingsUrl}\n\n` +
    `❓ *Help any time:* message me here, for example *help payments* or *help badges*.\n\n` +
    `Your first month is free.` +
    (p.tip ? `\n\n${p.tip}` : ""),
  /** To the organiser, once, when the owner rejects. MatchTime has left the
   *  group without a word in it (decision 1). */
  sj_dm_rejected: (p: { group: string | null }): string =>
    `Thanks for trying MatchTime. We can't take ${p.group ? `"${p.group}"` : "your group"} on right now, so I've left the group. We'll be in touch if that changes.`,

  // ── Admin DM: somebody was added to the club's WhatsApp group (2026-09-29) ──
  /** A number MatchTime has never seen, name unknown. `url` is the admin's
   *  own signed-in link (2026-09-30: this ended in a bare
   *  "/admin/players/phones", which WhatsApp does not make tappable). The
   *  name is filled in from their WhatsApp name when they first post
   *  (`resolve-sender.ts`). */
  dm_admin_join_new: (p: { club: string; phone: string; url: string }): string =>
    `🆕 New player joined *${p.club}* on WhatsApp.\n\nPhone: ${p.phone}\n` +
    `I've added them to your player list. I'll fill in their WhatsApp name when they first post in the group, or you can set it now:\n${p.url}`,
  /** A number MatchTime has never seen, whose WhatsApp name the bot knew. */
  dm_admin_join_new_named: (p: { name: string; club: string; phone: string; url: string }): string =>
    `🆕 *${p.name}* joined *${p.club}* on WhatsApp and is on your player list.\n\nPhone: ${p.phone}\nTap to check their details:\n${p.url}`,
  /** A known MatchTime user's FIRST membership of this club. Never
   *  "rejoined": Sutton's admin read that for Hamzah's first join. */
  dm_admin_join_first: (p: { name: string; club: string }): string =>
    `🆕 *${p.name}* joined *${p.club}*'s WhatsApp group and is now on your player list.`,
  /** Only when a membership that had LEFT was re-activated. */
  dm_admin_join_rejoined: (p: { name: string; club: string }): string =>
    `🔁 *${p.name}* rejoined *${p.club}*'s WhatsApp group.\n\nTheir membership has been re-activated. No further action needed.`,
  /** The joiner was merged with the placeholder a third party's "X in"
   *  created. `addedOn` is already a date label. */
  dm_admin_join_linked: (p: { placeholder: string; addedOn: string }): string =>
    `🔗 Linked to the *${p.placeholder}* added on ${p.addedOn}, so their games and team place carry over.`,
  /** More than one placeholder, or only a partial name match: not merged. */
  dm_admin_join_possible_duplicate: (p: { names: string[]; url: string }): string =>
    `❓ They might be the same person as ${joinList("en", p.names.map((n) => `*${n}*`))}, added earlier by name. If so, merge them here:\n${p.url}`,

  // ── /admin/players: possible duplicates (2026-09-29) ──
  admin_players_duplicates_heading: "Possible duplicates",
  admin_players_duplicate_row: (p: { placeholder: string; keeper: string }): string =>
    `${p.placeholder}, added by name, may be the same person as ${p.keeper}.`,
  admin_players_duplicate_merge: (p: { keeper: string }): string => `Merge into ${p.keeper}`,

  // ── Rolling squad (2026-09-30), slice 1 of
  //    MDs/friday-group-features-plan-2026-09-30.md. New copy, house
  //    style: no em or en dashes. Rows RSQ1 to RSQ5 in copy-golden. ──

  /** RSQ1: the morning announcement over a squad carried over from the
   *  last match. `deadline` is `weekdayTimeLabel` ("Monday 21:00"). */
  rolling_announce_lead: (p: { activityName: string; dateLabel: string; venue: string; deadline: string }): string =>
    `📅 *${p.activityName}*, *${p.dateLabel}*, ${p.venue}.\n\n` +
    `Everyone who played last time is in again. Drop-out deadline: *${p.deadline}*. Until then, you're in unless you say *OUT*.`,
  rolling_in_header: (p: { confirmed: number; maxPlayers: number }): string =>
    `*In (${p.confirmed}/${p.maxPlayers}):*`,
  rolling_waiting_header: (p: { count: number }): string => `*Waiting list (${p.count}):*`,
  rolling_tail_open: (p: { open: number }): string =>
    `${p.open === 1 ? "1 place open" : `${p.open} places open`}: say *IN* to take one.`,
  /** For a club where the organisers pick who plays (slice 2 wires it). */
  rolling_tail_open_organiser: (p: { open: number }): string =>
    `${p.open === 1 ? "1 place open" : `${p.open} places open`}: say *IN* to go on the waiting list, and the organisers will pick who plays.`,
  rolling_tail_full: "The squad is full. Say *IN* to go on the waiting list.",
  /** RSQ2: the extra line on the 17:00 post while the deadline is ahead. */
  rolling_deadline_line: (p: { deadline: string }): string =>
    `Drop-out deadline: *${p.deadline}*. Until then, you're in unless you say *OUT*.`,
  /** RSQ3: replaces `intro_attendance` in the day-one intro. */
  intro_rolling_squad:
    "🔁 *Rolling squad*: if you played last time, you're in next time too. Say *OUT* if you can't make it, before the drop-out deadline.",
  /** RSQ4: the DM to the club's admins when an OUT lands after the
   *  deadline. `time` is when the player SENT it. */
  late_drop_admin_notice: (p: {
    name: string;
    activityName: string;
    whenLabel: string;
    time: string;
    deadline: string;
    confirmed: number;
    maxPlayers: number;
  }): string =>
    `Late drop-out: *${p.name}* said OUT for *${p.activityName}* (${p.whenLabel}) at ${p.time}, after the ${p.deadline} deadline. Squad is now ${p.confirmed}/${p.maxPlayers}.`,

  // ── RSQ5: /admin/settings "Weekly routine" and the match page's
  //    "Carry over last squad" button (web). ──
  wr_section_title: "Weekly routine",
  wr_section_lead: "How your squad is put together each week. Each setting stays off until you turn it on.",
  wr_rolling_label: "Rolling squad",
  wr_rolling_blurb: "Everyone who played last time is in again, unless they say OUT.",
  wr_rolling_info:
    "When this is on, everyone who played the last match is automatically in for the next one, and only needs to say OUT if they can't make it. " +
    "Players who were on the waiting list, guests without a phone number and anyone who has left the group are not carried over. " +
    "The squad is carried over at 08:00 the morning after each match, so you have the night to remove anyone who didn't turn up. " +
    "Anyone still on the list at the final whistle counts as having played, for payments and ratings.",
  wr_rolling_on: "Rolling squad is on",
  wr_rolling_off: "Rolling squad is off",
  wr_save_failed: "Couldn't save the setting",
  carry_over_button: "Carry over last squad",
  carry_over_hint: (p: { dateLabel: string }): string =>
    `Puts everyone who played on ${p.dateLabel} into this match. They can still say OUT.`,
  carry_over_done: (p: { count: number }): string =>
    p.count === 1 ? "1 player carried over" : `${p.count} players carried over`,
  carry_over_nothing: "Nobody to carry over",

  // ── Weekly deadlines (2026-09-30), slice 3 of
  //    MDs/friday-group-features-plan-2026-09-30.md. New copy, house
  //    style: no em or en dashes. Rows WDL1 to WDL4 in copy-golden. ──

  /** WDL1 (D1): the group reminder 3 hours before the drop-out deadline.
   *  `time` is the deadline's London time, `rosterBlock` the squad. */
  dropout_reminder_post: (p: { activityName: string; whenLabel: string; time: string; rosterBlock: string }): string =>
    `⏰ *${p.activityName}*, ${p.whenLabel}: the drop-out deadline is *today at ${p.time}*. If you can't play, say *OUT* before then.\n\n${p.rosterBlock}`,
  /** WDL2 (D2): to the organisers once the deadline has passed. The
   *  "Said maybe" and "places open" lines only when there is something
   *  to say. */
  deadline_summary_admin: (p: {
    activityName: string;
    whenLabel: string;
    confirmed: number;
    maxPlayers: number;
    out: string[];
    maybe: string[];
    waiting: string[];
    open: number;
  }): string =>
    [
      `Drop-out deadline passed for *${p.activityName}* (${p.whenLabel}). Squad ${p.confirmed}/${p.maxPlayers}.`,
      `Out this week: ${p.out.length > 0 ? p.out.join(", ") : "nobody"}.`,
      ...(p.maybe.length > 0 ? [`Said maybe: ${p.maybe.join(", ")}.`] : []),
      `Waiting list: ${p.waiting.length > 0 ? p.waiting.join(", ") : "empty"}.`,
      ...(p.open > 0 ? [p.open === 1 ? "1 place open." : `${p.open} places open.`] : []),
    ].join("\n"),
  /** WDL3 (D3): the final list at publish time. */
  list_published_head: (p: { activityName: string; dateLabel: string; venue: string }): string =>
    `📋 *${p.activityName}* list, *${p.dateLabel}*, ${p.venue}`,
  list_published_playing_header: (p: { confirmed: number; maxPlayers: number }): string =>
    `*Playing (${p.confirmed}/${p.maxPlayers}):*`,
  list_published_open: (p: { open: number }): string =>
    p.open === 1 ? "1 place still open." : `${p.open} places still open.`,
  list_published_footer: "Can't make it now? Say *OUT* as soon as you can so a replacement can be brought in.",

  // ── WDL4: /admin/settings "Weekly routine", the two deadline rows. ──
  wd_dropout_label: "Drop-out deadline",
  wd_dropout_blurb: "The last day and time players can pull out without it counting as late.",
  wd_dropout_info:
    "The last time players can pull out without it counting as late. MatchTime reminds the group 3 hours before, " +
    "then messages the admins with who is out and who is waiting. An OUT after the deadline still counts, and the admins are told it was late.",
  wd_publish_label: "List published",
  wd_publish_blurb: "When MatchTime posts the final list in the group.",
  wd_publish_info:
    "When MatchTime posts the final list in the group: who is playing and who is on the waiting list. " +
    "With this and a drop-out deadline set, MatchTime stops the daily 17:00 post, except on match day.",
  wd_day_label: "Day",
  wd_time_label: "Time",
  wd_not_set: "Not set",
  /** `dow`: 0 = Sunday. */
  wd_weekday: (p: { dow: number }): string =>
    ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][p.dow] ?? "",
  wd_save: "Save",
  wd_clear: "Clear",
  wd_saved: "Weekly deadlines saved",
  wd_err_incomplete: "Pick both a day and a time, or neither.",
  wd_err_bad_value: "That day or time is not valid.",
  wd_err_outside_hours: "Pick a time between 08:00 and 21:30.",
  wd_err_order: "The drop-out deadline has to come before the list is published.",
  wd_err_after_kickoff: "On match day, pick a time before kickoff.",
  // ── Slice 2a: the admin channel (2026-09-30) ──
  // MDs/friday-group-features-plan-2026-09-30.md, sections 2.3 and 5.
  /** L1. Posted in the group that has just been linked. */
  admin_group_linked: (p: { club: string }): string => `✅ Linked as the admin group for *${p.club}*.`,
  /** L2. A wrong or expired code, from an owner or admin of an approved club. */
  admin_group_bad_code:
    "That code isn't valid any more. Open Settings on the website and press *Link admin group* for a new one.",
  /** L3. The code was sent in the club's own community group. */
  admin_group_main_group: (p: { club: string }): string =>
    `This is *${p.club}*'s main group, so it can't be the admin group. Add me to a separate group for the admins.`,
  /** L4. To the owner, by DM, after MatchTime was removed from the admin group. */
  admin_group_removed_dm: (p: { club: string }): string =>
    `I was removed from *${p.club}*'s admin group, so admin messages now come to you by DM. You can link a group again in Settings.`,
  settings_admin_channel_heading: "Admin messages go to",
  settings_admin_channel_info:
    "Where MatchTime sends messages only admins should see: the waiting list to pick from, the drop-out summary, late drop-outs, who hasn't paid and new players to check. One person: a DM to the person you choose. Admin WhatsApp group: one message in your admins' group, and admins can reply there with a number, a name or a tag to pick a player. MatchTime reads nothing else in that group. Each admin by DM: every admin gets their own copy.",
  settings_admin_channel_mode_one_person: "One person",
  settings_admin_channel_mode_admin_group: "Admin WhatsApp group",
  settings_admin_channel_mode_each_admin: "Each admin by DM",
  settings_admin_channel_person_label: "Who",
  settings_admin_channel_person_owner: (p: { name: string }): string => `${p.name} (owner)`,
  settings_admin_channel_link_button: "Link admin group",
  settings_admin_channel_link_again: "New code",
  settings_admin_channel_link_info_title: "Link admin group",
  settings_admin_channel_link_info:
    "Press the button, then add MatchTime to your admins' WhatsApp group and send the code shown here in that group. The code works once and lasts 48 hours. MatchTime will not start a club setup in that group.",
  settings_admin_channel_step_code: (p: { code: string }): string => `Keep this page open. Your code: ${p.code}`,
  settings_admin_channel_step_add: "Add MatchTime to your admins' WhatsApp group.",
  settings_admin_channel_step_send: "In that group, send:",
  settings_admin_channel_command: (p: { code: string }): string => `@Match Time admin group ${p.code}`,
  settings_admin_channel_validity: "The code works once and lasts 48 hours.",
  settings_admin_channel_linked: (p: { group: string }): string => `Linked: ${p.group}`,
  settings_admin_channel_unlink: "Unlink",
  settings_admin_channel_pending_note:
    "Until a group is linked, admin messages keep going where they go now.",
  settings_admin_channel_saved: "Saved",
  settings_admin_channel_unlinked: "Unlinked. Admin messages now go to the owner by DM.",


  // ── Organiser pick (2026-10-01), slice 2b of
  //    MDs/friday-group-features-plan-2026-09-30.md, sections 2.7 to 2.13.
  //    New copy, house style: no em or en dashes. Rows OPK1 to OPK9 in
  //    copy-golden. ──

  /** P13: the engine's "a place just opened" post for an organiser-pick
   *  club with an empty waiting list. */
  slot_opened_organiser: (p: { kickoffLabel: string }): string =>
    `A place just opened for ${p.kickoffLabel}. Say *IN* to go on the waiting list, and the organisers will pick who plays.`,
  /** P1 first line: one or more drops (`late`: after the drop-out deadline). */
  pick_lead_drop: (p: { names: string[]; activityName: string; whenLabel: string; late: boolean }): string =>
    `${joinList("en", p.names.map((n) => `*${n}*`))} dropped out of *${p.activityName}* (${p.whenLabel})${p.late ? " after the deadline" : ""}.`,
  /** P1 first line: the deadline summary opens the first round (slice 3). */
  pick_lead_deadline: (p: { activityName: string; whenLabel: string }): string =>
    `Drop-out deadline passed for *${p.activityName}* (${p.whenLabel}).`,
  /** P1 first line: a place that was never filled. */
  pick_lead_open_place: (p: { open: number; activityName: string; whenLabel: string; confirmed: number; maxPlayers: number }): string =>
    p.open === 1
      ? `There is 1 place open in *${p.activityName}* (${p.whenLabel}), squad ${p.confirmed}/${p.maxPlayers}.`
      : `There are ${p.open} places open in *${p.activityName}* (${p.whenLabel}), squad ${p.confirmed}/${p.maxPlayers}.`,
  /** P1: the count, after a drop or deadline lead. */
  pick_places_line: (p: { open: number; confirmed: number; maxPlayers: number }): string =>
    `${p.open === 1 ? "1 place open" : `${p.open} places open`}, squad ${p.confirmed}/${p.maxPlayers}.`,
  pick_waiting_header: "Waiting list:",
  /** P1: one numbered row. `rating` is the club rating players see, or null. */
  pick_list_row: (p: { n: number; name: string; position: string | null; rating: string | null }): string =>
    `${p.n}. ${p.name} (${p.position ?? "no position"}, ${p.rating ?? "new"})`,
  pick_instructions_dm:
    "Reply with a number or a name to bring someone in, e.g. *2*, or *2 3* for two. Reply *NONE* to leave it open.",
  pick_instructions_group:
    "Reply here with a number, a name or an @tag, e.g. *2*, or *2 3* for two. *NONE* leaves it open.",
  pick_fallback_offer: (p: { when: string }): string =>
    `If nobody picks by ${p.when}, I'll offer the place to the whole waiting list.`,
  pick_fallback_leave: (p: { when: string }): string => `If nobody picks by ${p.when}, the place stays open.`,
  /** A1: to the admin channel. `pickerName` null in a DM to the picker himself. */
  pick_done_admin: (p: { name: string; replacedName: string | null; pickerName: string | null }): string =>
    `✅ Done: *${p.name}* is in${p.replacedName ? `, replacing *${p.replacedName}*` : ""}${p.pickerName ? ` (picked by ${p.pickerName})` : ""}.`,
  /** A2: to the community group, one per picked player. */
  pick_group_post: (p: { name: string; replacedName: string | null; team: string | null; confirmed: number; maxPlayers: number }): string =>
    `✅ *${p.name}* is in${p.replacedName ? `, replacing *${p.replacedName}*${p.team ? ` on *${p.team}*` : ""}` : ""}. Squad *${p.confirmed}/${p.maxPlayers}*.`,
  /** A3: DM to the picked player. `dayTime` e.g. "Friday 20:30". */
  pick_player_dm: (p: { dayTime: string; venue: string }): string =>
    `You're in for ${p.dayTime} at ${p.venue} ⚽ Can't make it after all? Just say *OUT*.`,
  /** E1 */
  pick_not_on_list: (p: { name: string }): string =>
    `*${p.name}* isn't on the waiting list. Bring them in anyway? Reply *YES*.`,
  /** E2 */
  pick_already_in: (p: { name: string }): string => `*${p.name}* is already in. Pick someone else?`,
  /** E3 */
  pick_already_filled: (p: { name: string; pickerName: string }): string =>
    `Already filled: *${p.name}* is in (picked by ${p.pickerName}).`,
  /** E3, when the place was filled some other way. */
  pick_already_filled_full: (p: { confirmed: number; maxPlayers: number }): string =>
    `Already filled: the squad is full (${p.confirmed}/${p.maxPlayers}).`,
  /** E4 */
  pick_unresolved_tag: "I couldn't tell who that is, can you type their name?",
  /** E5 */
  pick_ambiguous: (p: { first: string; names: string[] }): string =>
    `${p.names.length === 2 ? "Two" : p.names.length === 3 ? "Three" : String(p.names.length)} players are called *${p.first}*: ${joinList("en", p.names.map((n) => `*${n}*`))}. Which one? Reply with the full name.`,
  /** P5 lead; the list and the instructions follow. */
  pick_list_changed: "The waiting list has changed since my last message. Here it is again:",
  /** P6 (DM only) */
  pick_not_understood:
    "I couldn't match that to the waiting list. Reply with a number from the list (e.g. *2*) or a full name. *NONE* leaves the place open.",
  /** P7 */
  pick_only_k: (p: { k: number; names: string[] }): string =>
    `Only ${p.k} ${p.k === 1 ? "place was" : "places were"} open, so I brought in your first ${p.names.length === 1 ? "pick" : "picks"}: ${joinList("en", p.names.map((n) => `*${n}*`))}.`,
  /** P8 */
  pick_none_ack: "OK, I'll leave the place open. You can still pick from the waiting list on the match page.",
  /** P11 */
  pick_fallback_offered: (p: { activityName: string }): string =>
    `Nobody picked for *${p.activityName}*, so I've offered the place to the waiting list: the first to say IN gets it.`,
  /** P12 */
  pick_fallback_left: (p: { activityName: string; confirmed: number; maxPlayers: number }): string =>
    `Nobody picked for *${p.activityName}*, so the place stays open. Squad ${p.confirmed}/${p.maxPlayers}.`,
  /** D7: the line at the end of the in-group setup. */
  onb_weekly_routine_tip:
    "Tip: to carry the squad over each week, to pick replacements from a waiting list yourself, or to get admin messages in your admins' group, open Settings on the website.",

  // ── OPK8: /admin/settings "Weekly routine", who fills an open place. ──
  wr_pick_label: "Who fills an open place",
  wr_pick_blurb: "First to say IN, or the organisers pick from the waiting list.",
  wr_pick_info:
    "First to say IN: when a place opens, MatchTime offers it to the waiting list and the first to say IN gets it. " +
    "The organisers pick: MatchTime never fills a place by itself. Anyone who says IN goes on the waiting list, and your admin messages " +
    "(see Admin messages go to) get the waiting list with positions and club ratings. The first admin to reply with a number, a name or a tag brings that player in.",
  wr_pick_first_come: "First to say IN",
  wr_pick_organiser: "The organisers pick",
  wr_fallback_label: "If nobody picks in time",
  wr_fallback_info:
    "If no admin replies within a day, or 4 hours before kickoff at the latest, MatchTime either offers the place to the whole waiting list " +
    "(first to say IN gets it) or leaves it open.",
  wr_fallback_offer: "Offer it to the waiting list",
  wr_fallback_leave: "Leave it open",
  wr_pick_saved: "Saved",

  // ── OPK9: the waiting list on the match page (organiser-pick clubs). ──
  wl_title: (p: { count: number }): string => `Waiting list (${p.count})`,
  wl_hint: "The organisers pick who plays. Reorder the list, or bring someone in.",
  wl_bring_in: "Bring in",
  wl_move_up: "Move up",
  wl_move_down: "Move down",
  wl_no_position: "no position",
  wl_new: "new",
  wl_brought_in: (p: { name: string }): string => `${p.name} is in`,
  wl_full: "The squad is full",
  wl_failed: "Couldn't save that. Try again.",

  // ── OPK10: the bench promises, in an organiser-pick club (review fix).
  //    First-come clubs keep their rows unchanged. ──
  /** The squad-complete post's closing line. */
  squad_complete_bench_invite_organiser:
    "🪑 *Waiting list is open.* Say *IN* to go on the waiting list, and the organisers will pick who plays.",
  /** The day-one intro's bench line. */
  bench_intro_line_organiser:
    "🔁  *Waiting list:* say *IN* to go on the waiting list. When a place opens, the organisers pick who plays.",
  /** The answer to a recruit ask when the squad is full. */
  full_squad_bench_invite_organiser: (p: { matchName: string; confirmed: number; maxPlayers: number }): string =>
    `*${p.matchName}* is full at ${p.confirmed} of ${p.maxPlayers}, but the waiting list is open. ` +
    `Say *IN* to go on the waiting list, and the organisers will pick who plays. 🙏`,
  /** The recruit invite DM's "playing?" line. */
  dm_recruit_invite_play_organiser: "Want to play? Reply *IN* to go on the waiting list, and the organisers will pick who plays.",
  /** The recruit chase DM. */
  dm_recruit_chase_organiser: (p: { firstName: string | null; count: number; activityName: string; matchWhen: string }): string =>
    `👋 ${p.firstName ?? "there"}, still after ${p.count} ${p.count === 1 ? "player" : "players"} for *${p.activityName}* on ${p.matchWhen}. ` +
    `Reply *IN* to go on the waiting list and the organisers will pick who plays, or *OUT* and I'll stop asking 🙏`,
  /** The private ack of an IN that went on the waiting list. */
  dm_self_ack_waiting_organiser: (p: { matchName: string; matchWhen: string }): string =>
    `📋 I've put you on the waiting list for *${p.matchName}* on ${p.matchWhen}. The organisers pick who plays, and I'll message you if you're picked 🙏`,

  // ── UNP1 (2026-10-01): U1 of MDs/friday-group-features-plan-2026-09-30.md
  //    (2.12), the organisers' unpaid list, 10:00 two days after the
  //    match. `names` are the players not marked paid; `paid` of `n` uses
  //    the group tail's rule (holder left out, bulk credits count). ──
  unpaid_list_admin: (p: { activityName: string; whenLabel: string; names: string[]; paid: number; n: number }): string =>
    `💷 Unpaid for *${p.activityName}* (${p.whenLabel}): ${p.names.join(", ")}. ${p.paid} of ${p.n} paid.`,
  // ── UNP2 (2026-10-01): the unpaid reminder posted ON ITS OWN in the
  //    group of a weekly-rhythm club, two days after the match. Not row 73
  //    (`unpaid_tail`, the 17:00 tail): that says "last week's match" and
  //    "the poll above", and by now the poll is two days up. `dayName` is
  //    the match's weekday (`weekdayLabel`). ──
  unpaid_group_reminder: (p: { unpaid: number; dayName: string }): string =>
    p.unpaid === 1
      ? `💳 1 payment still pending for ${p.dayName}'s match. If you've already paid, tick your team in the payment poll to clear it 🙏`
      : `💳 *${p.unpaid}* payments still pending for ${p.dayName}'s match. If you've already paid, tick your team in the payment poll to clear it 🙏`,
  // ── The daily AI cap, told to the club's admins once a day (2026-10-01).
  //    Sent through the admin channel when the club reaches its allowance.
  //    Every claim is what the code does at the cap: the router floor still
  //    records a bare In or Out in the group, model-backed replies are
  //    skipped, scheduled posts go out (the chase falls back to its static
  //    copy), and the allowance is per London calendar day. `more` is the
  //    "how to get more" line: today the contact email, later a Buy more
  //    link (`ai_cap_more_buy`). ──
  ai_cap_admin_notice: (p: { club: string; more: string }): string =>
    `⚠️ MatchTime has used today's AI allowance for *${p.club}*. ` +
    `Until midnight (UK time) I'll still record a plain In or Out in the group, but I won't answer questions ` +
    `or other requests that need the AI. Scheduled posts carry on as normal. ` +
    `The allowance resets at midnight. ${p.more}`,
  ai_cap_more_contact: "Need more? Email hello@matchtime.ai and we can raise your club's daily allowance.",
  ai_cap_more_buy: (p: { url: string }): string => `Need more? Buy extra AI allowance here: ${p.url}`,
  // ── Club fee billing, slice B2 (2026-10-01). Plan:
  //    MDs/club-fee-billing-plan-2026-10-01.md, sections 7.2 and 8. The
  //    numbers come from `clubFeeTip` (club-billing-rules.ts) and are
  //    formatted by club-billing-view.ts: `price`, `fee` and `feePlus` like
  //    "£9.99" and "£8.25", `share` like "25p" (or "£1.05"), `format` from
  //    `sj_per_side_option`. The tip only ever says what to CHARGE, never
  //    how players pay, so it reads right for a club that pays by bank
  //    transfer. Nothing here goes to players. ──
  /** The club fee tip paragraph (billing page, settings card; the B4 DMs
   *  and the admin channel reuse it). `mode`: "example" when the club has
   *  no fee of its own (the GBP 8 example), "known" when it has one,
   *  "split" when it splits the pitch cost. */
  club_fee_tip: (p: {
    format: string;
    players: number;
    games: number;
    price: string;
    share: string;
    fee: string;
    feePlus: string;
    mode: "example" | "known" | "split";
  }): string =>
    `💷 *Club fee tip:* your weekly ${p.format} is ${p.players} players and about ${p.games} games a month, ` +
    `so ${p.price} works out at about *${p.share} a player per game*. ` +
    (p.mode === "split"
      ? `When you split the pitch cost, add about ${p.share} to each player's share.`
      : p.mode === "known"
        ? `Your game is ${p.fee} each, so charging *${p.feePlus}* covers it.`
        : `If your game costs ${p.fee} each, charge *${p.feePlus}* and the club fee is covered.`),
  /** The short tip after "Your first month is free." in `sj_dm_approved`,
   *  only for a club that is billed. */
  sj_dm_approved_tip: (p: {
    players: number;
    games: number;
    price: string;
    share: string;
    fee: string;
    feePlus: string;
    split: boolean;
  }): string =>
    `💷 *Club fee tip:* after that it's ${p.price} a month for the group, paid by card by whoever collects the match fees. ` +
    `With ${p.players} players and about ${p.games} games a month, that's about *${p.share} a player per game*` +
    (p.split ? `, to add to each player's share of the pitch cost.` : `, so a ${p.fee} game could be charged at *${p.feePlus}*.`),
  billing_page_title: "Club fee",
  billing_state_trial: (p: { date: string; price: string }): string =>
    `Free month until ${p.date}. Then ${p.price} a month for the whole group.`,
  billing_state_grace: (p: { date: string }): string =>
    `The free month has ended. MatchTime stops on ${p.date} unless a card is added.`,
  billing_state_subscribed: (p: { price: string; date: string }): string => `${p.price} a month. Next payment ${p.date}.`,
  billing_state_subscribed_ending: (p: { price: string; date: string }): string => `${p.price} a month. Ends on ${p.date}.`,
  billing_state_card: (p: { brand: string; last4: string }): string => `Card ${p.brand} ending ${p.last4}.`,
  billing_state_paid_with_other: (p: { price: string; holder: string; date: string }): string =>
    `${p.price} a month, paid with ${p.holder}'s card until you put yours on. Next payment ${p.date}.`,
  billing_state_past_due: (p: { date: string }): string =>
    `Last payment didn't go through. Stripe is retrying. MatchTime stops on ${p.date} if it can't be taken.`,
  billing_state_paused: "MatchTime is paused. All the data is kept. Add a card to switch it back on.",
  billing_state_paused_removed:
    "MatchTime was removed from the club's WhatsApp group, so it is paused. All the data is kept. To carry on, add MatchTime back to the group.",
  billing_card_holder_note: (p: { club: string; contact: string }): string =>
    `Your card still pays ${p.club}'s MatchTime fee until ${p.contact} adds theirs.`,
  billing_who_collector: (p: { name: string }): string => `${p.name} looks after the card.`,
  billing_who_owner: "No money collector set: the owner is asked for the card.",
  billing_who_none: "No money collector or owner with a phone number, so nobody can be asked for the card yet.",
  billing_card_on_file: (p: { yes: boolean }): string => (p.yes ? "Card on file: yes." : "Card on file: no."),
  billing_btn_add_card: "Add a card",
  billing_btn_change_card: "Change card",
  billing_btn_use_mine: "Use my card instead",
  billing_btn_update_card: "Update card and pay",
  billing_btn_remove_mine: "Remove my card",
  billing_btn_stop_paying: "Stop paying",
  billing_btn_keep_paying: "Keep paying",
  billing_exempt: (p: { club: string }): string => `${p.club} has no club fee. MatchTime is free for this club.`,
  billing_open: "Open billing",
  billing_choose_collector: "Choose a money collector",
  billing_banner_grace: (p: { date: string }): string =>
    `The free month has ended. Add a card before ${p.date} to keep MatchTime running.`,
  billing_banner_past_due: (p: { date: string }): string =>
    `This month's club fee didn't go through. MatchTime stops on ${p.date} if it can't be taken.`,
  billing_banner_paused: "MatchTime is paused for this club. Add a card to switch it back on.",
  billing_banner_paused_removed:
    "MatchTime was removed from this club's WhatsApp group, so it is paused. Add it back to the group to carry on.",
  billing_banner_link: "See billing",
  // Club fee billing, slice B3: the billing page's notices after a card
  // action, and the webhook's DMs (card added, card replaced, resumed,
  // billed again after Free). No dashes, EN and TR.
  billing_notice_done: "Thanks, your card is being saved. This page shows it within a minute.",
  billing_notice_replaced: "Thanks, your card is being put on. This page shows it within a minute.",
  billing_notice_removed: "Your card has been removed and won't be charged for this club again.",
  billing_notice_not_set_up: "Card payments aren't open yet. Please try again later.",
  billing_notice_already: "A card is already paying for this club.",
  billing_notice_re_add: "MatchTime isn't in the club's WhatsApp group. Add it back to the group first.",
  billing_notice_failed: "Something went wrong. Please try again.",
  billing_notice_stopped:
    "Done. Billing ends when this month ends: this month is charged for its games as usual, then nothing more. MatchTime keeps running until then.",
  billing_notice_stopped_free: "Done. Your card has been removed and nothing has been charged. The free month carries on until it ends.",
  billing_notice_kept: "Done. MatchTime keeps running, and each month is charged only for the games played.",
  billing_notice_past_due: "A payment is overdue. Update the card and pay it first.",
  billing_dm_card_added: (p: {
    name: string | null;
    club: string;
    price: string;
    date: string;
    paidNow: boolean;
    resumed: boolean;
    link: string;
  }): string =>
    `Thanks${p.name ? ` ${p.name}` : ""}, your card is saved. ` +
    (p.resumed
      ? `MatchTime is back on for ${p.club} and picks things up again in the group within a few minutes. Anyone who said IN while it was paused should say it again. `
      : `MatchTime keeps running in the ${p.club} WhatsApp group. `) +
    (p.paidNow
      ? `The first ${p.price} has been taken today, then it's monthly, and Stripe emails you each invoice.`
      : `The first ${p.price} is taken on ${p.date}, then monthly, and Stripe emails you each invoice.`) +
    ` To change your card or cancel: ${p.link}`,
  billing_dm_card_replaced: (p: { name: string | null; newName: string; club: string }): string =>
    `Hi${p.name ? ` ${p.name}` : ""}, ${p.newName} now pays the MatchTime fee for ${p.club}. Your card has been removed and won't be charged for it again.`,
  billing_dm_resumed: (p: { club: string }): string =>
    `MatchTime is back on for ${p.club}. I'll pick things up again in the group within a few minutes. Anyone who said IN while I was paused should say it again.`,
  billing_dm_plan_billed: (p: { name: string | null; club: string; price: string; date: string; link: string }): string =>
    `Hi${p.name ? ` ${p.name}` : ""}, ${p.club} is on the MatchTime plan again at ${p.price} a month. ` +
    `The free month has already been used, so MatchTime keeps running in the group until ${p.date}. ` +
    `Add a card before then to keep it going: ${p.link}`,
  // Club fee billing, slice B4: the scheduled card reminders (day 21, 28,
  // 30), the pause, the payment problems and the new collector, all by
  // platform DM to the billing contact, plus the admin channel's "no money
  // collector yet" line. No dashes, EN and TR. Plan 7.2, 7.3.
  billing_dm_trial_21: (p: { name: string | null; club: string; date: string; price: string; link: string; collector: boolean }): string =>
    `Hi${p.name ? ` ${p.name}` : ""}, ${p.club}'s free month on MatchTime ends on ${p.date}. ` +
    (p.collector ? `As the person who collects the match fees, you're the one I'll ask for the card. ` : "") +
    `To keep MatchTime running in the ${p.club} WhatsApp group, add a card here: ${p.link}\n` +
    `It's ${p.price} a month for the whole group, and nothing is taken before ${p.date}.`,
  billing_dm_trial_28: (p: { name: string | null; club: string; date: string; link: string }): string =>
    `Hi${p.name ? ` ${p.name}` : ""}, a quick reminder: ${p.club}'s free month ends on ${p.date}. ` +
    `Add a card to keep MatchTime running in the ${p.club} WhatsApp group: ${p.link}`,
  billing_dm_trial_ended: (p: { name: string | null; club: string; date: string; link: string }): string =>
    `Hi${p.name ? ` ${p.name}` : ""}, ${p.club}'s free month has ended. ` +
    `MatchTime will keep running in the ${p.club} WhatsApp group for one more week, until ${p.date}. ` +
    `Add a card any time before then: ${p.link}`,
  billing_dm_set_collector:
    "Tip: if someone else collects the match fees, make them the money collector in Settings and they'll look after the card instead.",
  billing_dm_paused: (p: { name: string | null; club: string; price: string; link: string; kind: "no-card" | "payment-failed" | "cancelled" }): string =>
    (p.kind === "payment-failed"
      ? `Hi${p.name ? ` ${p.name}` : ""}, we couldn't take the ${p.price} for ${p.club}, so MatchTime is now paused. `
      : p.kind === "cancelled"
        ? `Hi${p.name ? ` ${p.name}` : ""}, the MatchTime plan for ${p.club} has ended, so MatchTime is now paused. `
        : `Hi${p.name ? ` ${p.name}` : ""}, MatchTime is now paused for ${p.club}. `) +
    `I'm still in the ${p.club} WhatsApp group, but I won't post or reply there, and nothing has been said in the group. ` +
    `The players, matches and stats are all kept. To switch MatchTime back on, add a card here and it restarts within a few minutes: ${p.link}`,
  billing_dm_payment_failed: (p: { name: string | null; club: string; price: string; link: string; ownCard: boolean }): string =>
    `Hi${p.name ? ` ${p.name}` : ""}, this month's ${p.price} for ${p.club} didn't go through. ` +
    `Stripe will try again over the next few days, and MatchTime keeps running meanwhile. ` +
    (p.ownCard ? `To update the card: ${p.link}` : `To put your own card on instead: ${p.link}`),
  billing_dm_payment_action: (p: { name: string | null; club: string; price: string; link: string }): string =>
    `Hi${p.name ? ` ${p.name}` : ""}, your bank wants you to confirm this month's ${p.price} for ${p.club} before it can go through. ` +
    `Please confirm it here: ${p.link}\nMatchTime keeps running meanwhile.`,
  /** The 3DS DM when the card being charged is NOT the recipient's own
   *  (a collector change still in progress). */
  billing_dm_payment_action_other: (p: { name: string | null; club: string; price: string; link: string; billingLink: string }): string =>
    `Hi${p.name ? ` ${p.name}` : ""}, the card on file for ${p.club} needs the bank to confirm this month's ${p.price} before it can go through. ` +
    `You can confirm and pay it here: ${p.link}\nOr put your own card on instead: ${p.billingLink}\nMatchTime keeps running meanwhile.`,
  billing_dm_payer_changed_card: (p: { name: string | null; club: string; price: string; oldName: string; link: string }): string =>
    `Hi${p.name ? ` ${p.name}` : ""}, you're now the money collector for ${p.club}, so you look after MatchTime's ${p.price} a month for the group. ` +
    `${p.oldName}'s card keeps paying until you put yours on, whenever suits you: ${p.link}`,
  billing_dm_payer_changed_no_card: (p: { name: string | null; club: string; price: string; date: string; link: string }): string =>
    `Hi${p.name ? ` ${p.name}` : ""}, you're now the money collector for ${p.club}, so you look after MatchTime's ${p.price} a month for the group. ` +
    `Add a card before ${p.date} to keep it running: ${p.link}`,
  billing_dm_payer_changed_paused: (p: { name: string | null; club: string; price: string; link: string }): string =>
    `Hi${p.name ? ` ${p.name}` : ""}, you're now the money collector for ${p.club}, so you look after MatchTime's ${p.price} a month for the group. ` +
    `Add a card to switch it back on: ${p.link}`,
  /** Paused because MatchTime was taken out of the group (slice B5): the
   *  way back is adding MatchTime back, not a card. */
  billing_dm_payer_changed_removed: (p: { name: string | null; club: string; price: string; link: string }): string =>
    `Hi${p.name ? ` ${p.name}` : ""}, you're now the money collector for ${p.club}, so you look after MatchTime's ${p.price} a month for the group. ` +
    `MatchTime was taken out of the ${p.club} WhatsApp group, so it is paused. To switch it back on, add MatchTime back to the group. The club fee page: ${p.link}`,
  billing_admin_no_collector: (p: { link: string }): string =>
    `Nobody is set as the money collector yet. Choose one in Settings: they'll look after the card for the club fee and get this tip too.${p.link ? ` ${p.link}` : ""}`,
};
