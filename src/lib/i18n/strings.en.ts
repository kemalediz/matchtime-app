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
import { firstMonthsFree } from "./free-period";
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
/** One result, winner first: "*Yellow* won 9 - 6 against Red", or
 *  "a draw, Red 7 - 7 Yellow". Shared by the three score replies. */
function resultEn(p: { redLabel: string; red: number; yellow: number; yellowLabel: string }): string {
  if (p.red === p.yellow) return `a draw, ${p.redLabel} ${p.red} - ${p.yellow} ${p.yellowLabel}`;
  return p.red > p.yellow
    ? `*${p.redLabel}* won ${p.red} - ${p.yellow} against ${p.yellowLabel}`
    : `*${p.yellowLabel}* won ${p.yellow} - ${p.red} against ${p.redLabel}`;
}

/** "Yellow 7, Red 4": the winner first, a draw in the match's order. */
function sidesEn(p: { redLabel: string; red: number; yellow: number; yellowLabel: string }): string {
  return p.yellow > p.red
    ? `${p.yellowLabel} ${p.yellow}, ${p.redLabel} ${p.red}`
    : `${p.redLabel} ${p.red}, ${p.yellowLabel} ${p.yellow}`;
}

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
      `📋 Based on all the messages I've picked up, here's the latest squad${p.withBench ? " and bench" : ""}: ` +
      (p.need > 0 ? `${count}, need *${p.need} more* 🙏` : `${count} ✅ full squad.`)
    );
  },
  playing_header: "*Playing:*",
  bench_header: (p: { count: number }): string => `*Bench (${p.count}):*`,

  // ── row 2: formatTeamsPost (group-copy.ts) ───────────────────────

  teams_post_header: (p: { kickoff: string; venue: string }): string =>
    `⚽ *Teams for tonight*: ${p.kickoff} at ${p.venue}`,
  teams_post_footer: "Objections? Tag me and say what to change, in your own words (for example @Match Time swap Sam with Alex), and an admin will confirm.",

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
        `🔁 *${p.outNames[0]} is out*. *${p.swaps[0].inName}* takes his place ` +
        `and his spot in *${p.swaps[0].teamLabel}*.`
      );
    }
    const head =
      p.outNames.length > 0
        ? `🔁 *${joinList("en", p.outNames)} ${p.outNames.length === 1 ? "is" : "are"} out*. `
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
    `✅ *Squad complete (${p.maxPlayers}/${p.maxPlayers})* for *${p.activityName}* on ${p.kickoffLabel} 🙌`,
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
  /** The same post when SEVERAL slots opened at once (an organiser-pick
   *  club's fallback, a monthly club's open places): one post for all of
   *  them, never one each (2026-10-06). `count` is 2 or more. `details`
   *  is one `bench_offer_slot_detail` line per slot that has a team and
   *  a replaced player to name, and empty when none has. */
  bench_offer_group_post_many: (p: { count: number; context: string; details: string[]; tagList: string; reactions: boolean }): string => {
    const claim = p.reactions
      ? "React 👍 here or reply *IN* to take one."
      : "Just reply *IN* here to take one.";
    return (
      `🎟 ${p.count} slots just opened ${p.context}. *First to claim them play.*\n` +
      p.details.map((d) => `${d}\n`).join("") +
      `\n` +
      `${p.tagList}\n\n` +
      `${claim} No rush and no timeout, the slots go to whoever replies first ` +
      `and anyone who misses out stays on the bench. 🙏`
    );
  },

  /** One line per slot under the several-slots post: which team the
   *  place is on and who it replaces. `_plain` is the DM's twin. */
  bench_offer_slot_detail: (p: { teamLabel: string; replacingName: string }): string =>
    `• on *${p.teamLabel}*, replacing ${p.replacingName}`,
  bench_offer_slot_detail_plain: (p: { teamLabel: string; replacingName: string }): string =>
    `• on ${p.teamLabel}, replacing ${p.replacingName}`,

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
    `📅 *${p.activityName}*: *${p.dateLabel}* at ${p.venue}.\n\nSay *IN* to join. First ${p.maxPlayers} confirmed play.`,

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
    `⚽ *Tonight at ${p.timeLabel}*: *${p.activityName}* at ${p.venue}`,
  match_day_teams_signoff: "See you tonight 🙌",
  match_day_locked_line:
    "Squad is locked. To lock in tonight's lineup, tag me and ask for the teams in your own words (for example *@Match Time generate the teams*) 👇",

  // ── row 72: buildDailyInListFallback (scheduler-copy.ts) ─────────

  daily_in_list_fallback_lead: (p: { activityName: string; need: number }): string =>
    `🗓 *${p.activityName}*: need *${p.need} more*.`,

  // ── row 73: buildUnpaidTailText (scheduler-copy.ts) ──────────────

  unpaid_tail: (p: { unpaid: number }): string =>
    p.unpaid === 1
      ? `💳 1 payment still pending for last week's match. If you've already paid, tick your team in the poll above to clear it 🙏`
      : `💳 *${p.unpaid}* payments still pending for last week's match. If you've already paid, just tick your team in the poll above to clear it 🙏`,

  // ── row 78: buildPaymentPollQuestion (scheduler-copy.ts) ─────────

  payment_poll_question: (p: { activityName: string }): string =>
    `💳 Payments for *${p.activityName}*: tick when you've paid`,

  // ═══════════════════════════════════════════════════════════════════
  // Phase 2, slice 2: the rest of the group-facing deterministic copy.
  // ═══════════════════════════════════════════════════════════════════

  // ── row 5: the name a pushname that is a phone number prints as ────

  fallback_player: "a player",

  // ── rows 6 to 30: the batch answers (compose.ts) ───────────────────

  /** `bench` is `benchClause` (squad-count-line.ts), "" with nobody on it. */
  answer_count: (p: { stated: boolean; confirmed: number; maxPlayers: number; kickoffLabel: string; need: number; bench: string }): string => {
    const head = p.stated
      ? `Not quite, we're ${p.confirmed}/${p.maxPlayers} for ${p.kickoffLabel}${p.bench}`
      : `We're ${p.confirmed}/${p.maxPlayers} for ${p.kickoffLabel}${p.bench}`;
    const tail = p.need > 0 ? `, need ${p.need} more 🙏` : " ✅ full squad.";
    return `${head}${tail}`;
  },
  answer_fixture: (p: { kickoffLabel: string; venue: string }): string =>
    p.venue ? `⚽ ${p.kickoffLabel} at ${p.venue}.` : `⚽ ${p.kickoffLabel}.`,
  /** The club's setup (2026-10-16, `QuestionTopic.club`), in either group.
   *  `admins` is already joined; `fee` is "6" or "6.50", null when none is
   *  set; `teamsReady` is "HH:MM" or "off". The teams line names the
   *  setting for the organisers and says it plainly to the players. */
  answer_club: (p: { admins: string; collector: string | null; fee: string | null; feeSplit: boolean; teamsReady: string; forOrganisers: boolean }): string =>
    [
      `👥 Admins: ${p.admins || "none"}`,
      `💷 Money collector: ${p.collector ?? "not set"}`,
      `💷 Match fee: ${p.fee !== null ? `£${p.fee} a player` : p.feeSplit ? "the pitch cost split between who played" : "not set"}`,
      p.forOrganisers
        ? `⚽ Teams ready: ${p.teamsReady === "off" ? "off" : `${p.teamsReady} on match day`}`
        : `⚽ Teams: ${p.teamsReady === "off" ? "sorted by the organisers before the game" : `worked out at ${p.teamsReady} on match day`}`,
    ].join("\n"),
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
    `No payments have reached me for ${p.kickoffLabel}. That could mean nobody's paid, or that I'm just not seeing them, so I'd rather not put a number on it.`,
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

  teams_not_generated: "No teams generated yet. Tag me and ask for them in your own words (for example @Match Time generate the teams) and I'll sort them.",
  // THE SCORE REPLIES (rewritten 2026-10-07). The result is stated
  // WINNER FIRST, by name, so the group can check it at a glance: "Got it
  // 👍 Red 9 - 6 Yellow, recorded." was read as fine on 2026-10-06 when
  // Yellow had won. `resultEn` is the one place the wording lives.
  score_ack: (p: { redLabel: string; red: number; yellow: number; yellowLabel: string }): string =>
    `Got it 👍 ${resultEn(p)}. Recorded.`,
  score_corrected: (p: {
    redLabel: string;
    yellowLabel: string;
    oldRed: number;
    oldYellow: number;
    red: number;
    yellow: number;
  }): string =>
    `Corrected 👍 It was ${p.redLabel} ${p.oldRed} - ${p.oldYellow} ${p.yellowLabel}. Now ${resultEn(p)}.`,
  // Names BOTH teams and suggests neither: the first wording ended with
  // an example that named Yellow as the winner (review of PR #214).
  score_ask_team: (p: { first: number; second: number; redLabel: string; yellowLabel: string }): string =>
    `${p.first} - ${p.second}: which team won? Reply with the winning team: ${p.redLabel} or ${p.yellowLabel}.`,
  /** A correction from somebody who may not make one, or too late. */
  score_already_recorded: (p: { redLabel: string; red: number; yellow: number; yellowLabel: string }): string =>
    `That match is already recorded: ${resultEn(p)}. An admin can change it on the match page.`,
  /** A message to the bot that differs from the record and does not say
   *  the record is wrong. Says how to correct it; names no team. */
  score_recorded_hint: (p: { redLabel: string; red: number; yellow: number; yellowLabel: string }): string =>
    `That match is already recorded: ${resultEn(p)}. ` +
    `If that is wrong, just tell me in your own words, with the right score and the team that won (for example: no, it was 5-3).`,
  /** Told who won, not the score. Tagged messages only. */
  score_ask_score: "What was the final score? Tell me both numbers and the team that won.",
  /** A score saved on the dashboard for a match with no teams set. */
  score_elo_no_teams_note:
    "Score saved. No teams are set for this match, so no Elo was applied. If teams are added later, save the score again to apply it.",
  score_which_match: (p: { kickoffLabel: string }): string =>
    `I can't tell which match that corrects. For ${p.kickoffLabel}, just tell me the score and the team that won. ` +
    `An admin can change an earlier result on its match page.`,
  /** Shown to the admin on the dashboard after saving a score whose Elo
   *  could not be recalculated (`match-elo.ts`, `legacy_left`). */
  score_elo_left_note:
    "Score saved. The Elo ratings were not recalculated for this match, because what was added for its earlier result is not on record. They still reflect the earlier result.",
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
    if (p.direct) lines.push(`• Paying ${who} directly is fine too. Just DM me once you've paid, in your own words (for example *Paid*), and ${who} will confirm it.`);
    return lines.join("\n");
  },
  payment_ack: (p: { firstName: string; count: number }): string =>
    `Noted 🙌 ${p.firstName} covered ${p.count} ${p.count === 1 ? "player" : "players"}.`,
  reminder_ack_resolved: (p: { whenLabel: string }): string => `👍 Got it, I'll DM you ${p.whenLabel}.`,
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

  mom_header: (p: { mvpLabel: string; activityName: string }): string => `🏆 *${p.mvpLabel}: ${p.activityName}*`,
  mom_winner: (p: { name: string; top: number; total: number }): string =>
    `Congrats *${p.name}* (${p.top}/${p.total} vote${p.total === 1 ? "" : "s"}) 🎉`,
  mom_shared: (p: { names: string; top: number; total: number }): string =>
    `Shared between *${p.names}* (${p.top} vote${p.top === 1 ? "" : "s"} each, ${p.total} total) 🎉`,
  mom_votes_header: "Votes:",
  mom_vote_row: (p: { name: string; votes: number }): string => `• ${p.name} (${p.votes})`,
  mom_trophy_line: "Your trophy awaits next match.",
  /** The organisers picked Man of the Match (mom-chooser.ts): no votes to show. */
  mom_picked: (p: { name: string }): string => `Congrats *${p.name}* 🎉`,

  // ── row 46: the format-switch proposal (format-switch.ts) ──────────
  //   The model is told to paste this line VERBATIM into a chase, so
  //   the words come from here in both paths.

  format_switch_proposal: (p: { shortBy: number; formatName: string; total: number; confirmed: number; benched: string[] }): string => {
    const lead =
      `If we don't find ${p.shortBy} more, we could switch to ` +
      `${p.formatName} (${p.total} players): `;
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
    `🎟 *${p.claimer}* grabbed the slot, taking *${p.dropped}*'s place on *${p.teamLabel}* 🙌\n\n` +
    `_Want the teams rebalanced with the new line-up? Tag me and ask in your own words (for example "@Match Time regenerate the teams")._`,
  bench_claim_replacing: (p: { claimer: string; dropped: string; confirmed: number; maxPlayers: number }): string =>
    `✅ *${p.claimer}* is in, replacing *${p.dropped}*. Squad *${p.confirmed}/${p.maxPlayers}* 🙌`,
  bench_claim_open: (p: { claimer: string; confirmed: number; maxPlayers: number }): string =>
    `✅ *${p.claimer}* grabbed the open slot. Squad *${p.confirmed}/${p.maxPlayers}* 🙌`,

  // ── rows 53, 54, 55: the rest of bench-offer-copy.ts ───────────────

  bench_intro_line: (p: { how: string }): string =>
    `🔁  *Bench promotion*: If someone drops, I tag the bench here and ` +
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
    `Heads up: I got a message to *${p.verb}* from *${p.pushname}*, but that name isn't ` +
    `matching anyone on the squad list, so I haven't changed anything yet. ` +
    `Could *${p.pushname}* reply with the name they're registered under, or an admin can link it on the dashboard? 🙏`,
  unresolved_nudge_anonymous: (p: { verb: "join" | "drop out" }): string =>
    `Heads up: I got a message to *${p.verb}* from someone I don't recognise, ` +
    `so I haven't changed anything yet. Could they reply with the name they're ` +
    `registered under, or an admin can link it on the dashboard? 🙏`,

  // ── row 51: composeStatsBlastReply (stats-blast.ts) ────────────────

  stats_blast_reply: (p: { queued: number }): string =>
    `📊 Done, DM'd ${p.queued} player${p.queued === 1 ? "" : "s"} their personal stats link. ` +
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
    `📋 *${p.matchName}* (${p.matchWhen}), rating progress:`,
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
    `The squad for *${p.matchName}* is already full, so there are no open spots to recruit for.`,

  // ── row 63: buildBulkCancelAnnouncement (block-booking.ts) ─────────

  bulk_cancel: (p: { activityName: string; dateLabels: string[] }): string => {
    const list = p.dateLabels.map((d) => `• ${d}`).join("\n");
    const plural = p.dateLabels.length === 1 ? "match is" : "matches are";
    return (
      `❌ *Schedule update*: the following *${p.activityName}* ${plural} OFF:\n\n` +
      `${list}\n\n` +
      `See you at the next one! 👋`
    );
  },

  // ── rows 64, 65: the admin actions (app/actions/matches.ts) ────────

  format_switch_header: (p: { sportName: string; maxPlayers: number }): string =>
    `🔁 *Match switched*: now *${p.sportName}* (${p.maxPlayers} players).`,
  format_switch_playing_header: (p: { confirmed: number; maxPlayers: number }): string =>
    `*Playing (${p.confirmed}/${p.maxPlayers}):*`,
  format_switch_bench_header: "*Bench:*",
  match_cancelled: (p: { activityName: string; whenLabel: string }): string =>
    `❌ *Match cancelled*: ${p.activityName} on ${p.whenLabel}.\n\n` +
    `Not enough players this week. See you next week!`,

  // ── rows 66, 134: team-ops-engine.ts and the balancer's reasons ────

  team_ops_no_match: "No match lined up to build teams for.",
  balancer_refusal: (p: { reason: string }): string => `Can't build teams right now: ${p.reason}.`,
  team_gen_reason_not_found: "match not found",
  team_gen_reason_status: (p: { status: string }): string => `match is ${p.status.toLowerCase()}`,
  team_gen_reason_not_enough: (p: { confirmed: number; needed: number }): string =>
    `not enough confirmed players (${p.confirmed}/${p.needed})`,
  team_gen_note_including: (p: { names: string[] }): string =>
    `_Including ${p.names.join(", ")} as CONFIRMED per the request._`,
  team_gen_note_pinned: (p: { pinned: string[] }): string => `_Pinned per the request: ${p.pinned.join(", ")}._`,
  team_gen_note_unmatched_includes: (p: { names: string[] }): string =>
    `_(couldn't find ${p.names.join(", ")} in the roster, ignored)_`,
  team_gen_note_unmatched_pins: (p: { names: string[] }): string =>
    `_(couldn't find ${p.names.join(", ")} for team pinning, ignored)_`,

  // ── row R170 (2026-09-29): teams only on request, on match day, and
  //    an admin can clear them. The Sutton FC incident of 24 Sep: a
  //    pairing joke built the teams five days early and "delete these
  //    teams" was met with silence. See lib/team-requests.ts.

  team_ops_not_match_day: "I'll build the teams on match day, just ask me then.",
  team_ops_not_a_build_request: "I only build the teams on match day, when someone asks me to generate them.",
  team_ops_say_generate: `Tag me and ask for the teams in your own words (for example "@Match Time generate the teams") and I'll build them.`,
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
        ? `\n\n_(couldn't find ${p.unmatched} of those names on the squad, so ` +
          `those were ignored)_`
        : "";
    return (
      `💳 Got it, credited *${p.payerName}* with ${credited} for *${p.matchName}*. ` +
      `Unpaid: ${p.unpaid}/${p.confirmed}.${tail}`
    );
  },

  // ── rows 123 to 131: the analyze route's group literals ────────────

  recruit_failed: "Couldn't do that right now.",
  recruit_invited: (p: { invited: number; matchName: string; need: number | null }): string =>
    `📣 On it, DM'd ${p.invited} recent player${p.invited === 1 ? "" : "s"} who hadn't replied, asking them to fill *${p.matchName}*${p.need ? ` (${p.need} spot${p.need === 1 ? "" : "s"} left)` : ""}. I'll add anyone who taps in. 🙏`,
  recruit_already_pinged: (p: { matchName: string }): string =>
    `Already pinged the recent players for *${p.matchName}*, just waiting on their replies. 🙏`,
  recruit_nobody_new: (p: { matchName: string }): string =>
    `No new players to ask for *${p.matchName}* right now. 👍`,
  swap_deferred: (p: { a: string; b: string }): string =>
    `Both *${p.a}* and *${p.b}* are already in, nobody's dropped. ` +
    `Teams aren't generated yet. Tag me and ask for them in your own words (for example *@Match Time generate the teams*), then I can put them on opposite sides.`,
  team_swap_done: (p: { a: string; b: string }): string =>
    `🔁 Swapped *${p.a}* and *${p.b}*, nobody dropped. Updated teams:`,
  slot_transfer_done: (p: { to: string; from: string; teamLabel: string }): string =>
    `🔁 *${p.to}* takes *${p.from}*'s place on *${p.teamLabel}*. ` +
    `Same teams otherwise, nothing regenerated, nobody's attendance changed. Updated teams:`,
  colour_swap_done: "🎨 Swapped the colours. Same teams, sides flipped:",
  // A swap MatchTime could not apply (2026-09-17). Before this the owner
  // heard nothing, and the message went on to be read as a drop.
  swap_refused: (p: { a: string; b: string; why: string }): string =>
    `I haven't swapped *${p.a}* and *${p.b}*. ${p.why} Nothing changed and nobody was dropped.`,
  swap_refused_unknown: (p: { name: string }): string =>
    `I can't find a player called *${p.name}* for this match. Use the name they're registered under.`,
  swap_refused_ambiguous: (p: { name: string; candidates: string[] }): string =>
    `*${p.name}* could be more than one player (${p.candidates.join(", ")}). Use their full name.`,
  swap_refused_teams_not_generated:
    "The teams aren't generated yet. Tag me and ask for them first, in your own words (for example *@Match Time generate the teams*).",
  swap_refused_same_player: "Both names point to the same player.",
  swap_refused_nobody_playing: "Neither of them is in the squad.",
  swap_refused_not_in_squad: (p: { name: string }): string =>
    `*${p.name}* isn't in the squad, so there's no team place to give them.`,
  swap_refused_both_hold_slots: (p: { name: string }): string =>
    `*${p.name}* isn't in the squad but still has a team place, and so does the other player, so I can't tell which move you mean.`,
  swap_refused_no_slot: (p: { name: string }): string =>
    `*${p.name}* isn't in the squad and has no team place to hand over.`,

  // ── row 67: the bot intro (scheduler-copy.ts) ──────────────────────

  intro_opener: "👋 Hi all, MatchTime bot is live for this group.",
  intro_what_i_do: "Here's what I do:",
  intro_attendance: `🗓  *Attendance*: Say "IN" / "OUT" here (or on the app) and I log you in/out. I react with ✅ to confirm, no extra messages from me.`,
  intro_daily: `🗒  *Daily reminders*: Every day at 5pm while the squad isn't full, I'll repost the IN list so we all see how many we need.`,
  intro_teams: `⚽  *Teams*: Tag me and ask for the teams in your own words (for example "@Match Time generate the teams") and I post auto-balanced sides. Objections? Tell me what to change the same way (for example "@Match Time swap Sam with Alex") and an admin will apply it.`,
  intro_rating_bit: "I DM everyone a rating link after each match (no sign-up, just tap)",
  intro_mom_bit: "vote MoM in-app or in the poll I post, winner announced once everyone's voted (or 5 days after the match at the latest)",
  intro_ratings_line: (p: { bits: string[] }): string => `🏆  *Ratings & MoM*: ${p.bits.join("; ")}.`,
  intro_reminders: `⏰  *Reminders*: Tag me and say when, in your own words (for example "@Match Time remind me Monday"), and I'll DM you then.`,
  intro_stats: `📊  *Stats*: Ask me things like "who got MoM last week?" or "who's our most consistent player?"`,
  intro_payments: `💳  *Payments*: I auto-post "paid?" polls right after each match.`,
  intro_closer: "Questions? Just ask here. Let's go.",

  // ── rows 74 to 77: the remaining scheduler posts ───────────────────

  chase_pre_kickoff_fallback: (p: { need: number; activityName: string; timeLabel: string }): string =>
    `⏳ Still *${p.need} short* for *${p.activityName}* at ${p.timeLabel}. Anyone free tonight?`,
  pre_kickoff_short_fallback: (p: { timeLabel: string; venue: string; confirmed: number; maxPlayers: number; need: number }): string =>
    `⏰ Tonight *${p.timeLabel}* at *${p.venue}* · ${p.confirmed}/${p.maxPlayers}. *Still need ${p.need}*, last chance to jump in. 🙏`,
  gear_reminder: (p: { timeLabel: string; venue: string }): string =>
    `⚽ *${p.timeLabel} at ${p.venue}*, see you there!\n\n` +
    `Quick reminder: if you've got them, please bring your *goalie gloves*, a *ball*, and *spare bibs*.`,
  ask_score: (p: { activityName: string }): string =>
    `🏁 *${p.activityName}*: hope it was a good one. What was the final score? ` +
    `I'll use it to keep next week's teams balanced.`,
  /** The same ask in the club's admin group (2026-10-16): the organisers
   *  report the score there. */
  ask_score_hq: (p: { activityName: string }): string =>
    `🏁 *${p.activityName}*: what was the final score, and which team won? Reply here and I'll record it.`,
  /** The same ask when the organisers pick Man of the Match (2026-10-18). */
  ask_score_hq_mom: (p: { activityName: string; mvpLabel: string }): string =>
    `🏁 *${p.activityName}*: what was the final score, which team won, and who was ${p.mvpLabel}? Reply here and I'll record it.`,

  // ═══════════════════════════════════════════════════════════════════
  // Phase 2, slice 3: the server-computed day headers.
  // ═══════════════════════════════════════════════════════════════════
  //   `enforceProximity` (proximity.ts) puts the right one in place of a
  //   "*Playing …:*" header with the wrong day in any reply. The
  //   scheduled chase stopped writing its own roster on 2026-10-20, and
  //   with it the tentative line and the opener example went.

  roster_header_past: "*Squad:*",
  roster_header_tonight: "*Playing tonight:*",
  roster_header_tomorrow: "*Playing tomorrow:*",
  roster_header_day: (p: { dayLabel: string }): string => `*Playing ${p.dayLabel}:*`,

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
    /** The club's organisers share the list and teams
     *  (`Organisation.listAnnouncer = "organisers"`). Absent: off. */
    organisersAnnounce?: boolean;
    /** With payments off, end with the organiser's "Want to collect match
     *  fees?" pointer. False in bare help for the players' group and a
     *  player's DM (FNF, 2026-10-15): it is for an organiser. Absent: on. */
    feesNudge?: boolean;
  }): string => {
    const lines: string[] = [];
    if (f.attendance) {
      lines.push(`✅ Say *"In"* or *"Out"* to mark your own availability, no need to tag me.`);
      lines.push(`🤔 Not sure? Just say *"maybe"* and I'll check with you ~24h before.`);
    } else {
      lines.push(`📋 Paste your squad list and I'll read who's playing, no need to tag me.`);
    }
    // Organisers mode (2026-10-15): a squad or count question in the
    // players' group is answered "The organisers will post the list." and a
    // team request "The organisers will post the teams." (pipeline/compose.ts,
    // organisers-list-copy.ts), so neither is offered as something to ask.
    const organisers = f.organisersAnnounce === true;
    const caps: string[] = [];
    if (f.attendance && !organisers) caps.push(`see who's in / how many we've got`);
    if (f.teamBalancing && !organisers) caps.push(`make / show the teams`);
    if (f.statsQa) caps.push(`who won last week? / past stats`);
    if (organisers) {
      lines.push(
        f.attendance
          ? `📣 The organisers share the squad list and the teams. I keep track of who's in and out for them.`
          : `📣 The organisers share the squad list and the teams.`,
      );
    }
    if (!organisers || caps.length > 0) {
      lines.push(`💬 Tag *@Match Time* when you want me to do or tell you something:`);
      for (const c of caps) lines.push(`   • ${c}`);
    }
    lines.push(`🤐 I stay quiet the rest of the time: banter and jokes are safe, I won't butt in.`);
    if (f.momVoting) lines.push(`🏆 After the game I'll run a quick *Man of the Match* vote.`);
    if (f.playerRating) lines.push(`⭐ I'll DM you a one-tap *rating* link after the match.`);
    // Reworded 2026-09-30: "and I'll nudge you" left people guessing what
    // the command was for. It is a personal DM at the time you name.
    if (f.reminders) lines.push(`⏰ Need a nudge? Tag me and say when, in your own words (for example *"@Match Time remind me Thursday"*), and I'll DM you then.`);
    // Payments are off after setup (2026-09-30): the off state now points
    // the organiser at how fee collection works instead of saying nothing.
    // Players learn they can pay through MatchTime (2026-09-30); an
    // organiser whose club does not collect yet learns that it can.
    // No method list (FNF, 2026-10-16): the help cannot see which ways
    // the club takes payment, and "card, Apple or Google Pay, or bank"
    // was untrue for a club that takes direct payment only. The pay link
    // itself names the methods (`dm_pay_link`).
    if (f.paymentCollection) lines.push(`💷 After each game I'll DM you a link to pay your match fee.`);
    if (f.paymentTracking) lines.push(`💳 I keep track of who's *paid*.`);
    if (!f.paymentTracking && !f.paymentCollection && f.feesNudge !== false) lines.push(`💷 Want to collect match fees? Ask me: *@Match Time help payments*`);
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
      payments: "match fees",
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
    /** Organisers mode: a format switch's line-up goes to them
     *  (actions/matches.ts), not the group. Absent: off. */
    organisers?: boolean;
  }): string => {
    if (p.audience === "player") {
      return `🗓️ Match days, kick-off times, cancellations and block bookings are set by your organiser on the admin page. Ask them if something needs changing.`;
    }
    const switchTold = p.organisers ? `I send the new line-up to the organisers to share.` : `I post the new line-up in the group.`;
    return (
      `🗓️ *Changing the schedule*\n` +
      `Schedule changes are made on the admin page, not by message. Each takes a few taps.\n\n` +
      `1️⃣ *Weekly game (day, kick-off time, venue):* on *Activities*, tap *Edit* on the game, change it, then *Save changes*. Only future matches change. The group isn't told.\n${p.activities}\n\n` +
      `2️⃣ *Block booking for the season:* on *Block bookings*, tap *New block booking*, pick the start date and an end date or a number of matches, tap *Preview dates*, then *Create block*. The group isn't told.\n${p.blockBookings}\n\n` +
      `3️⃣ *Cancel one week (or a run of dates):* on *Block bookings*, tap *Bulk cancel / restore*, set *From* and *To* to the date, tap *Find matches*, tick *Announce to the group* if you want me to post it, then confirm. Restoring works the same way.\n${p.bulk}\n\n` +
      `4️⃣ *Switch one match to another format:* open the match from your match list, tap *Switch format*, pick the format, then *Confirm switch*. ${switchTold}\n${p.matches}\n\n` +
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
      payments: "Collect match fees",
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
          ? `turn on *Collect match fees* under Bot features, pick the money collector, then connect their bank with Stripe once (about 2 minutes)`
          : `turn on *${p.label}* under Bot features`;
      return `🔧 To switch it on, open *Settings* on your admin page and ${what}:\n${p.url}`;
    }
    const what =
      p.topic === "payments"
        ? `turns on *Collect match fees* under Bot features, picks the money collector, then connects their bank with Stripe once (about 2 minutes)`
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
        `You'll get the link the morning after the game. Ask me for yours any time, in your own words (for example *@Match Time my stats*).`,
      teams:
        `🟥🟦 *Fair teams: how it works*\n` +
        `Once the squad's locked in, any admin can tag me and ask for the teams (for example *@Match Time generate the teams*) and I'll split everyone into two balanced sides using their form ratings, so games stay even.\n` +
        `I post the line-ups straight into the chat. Not happy with a pairing? Tag me and say what to change, in your own words (e.g. _"@Match Time swap Sam and Alex"_), or ask me to show the teams again any time.\n` +
        `Want a bit of fun? Ask me to give the teams names and I'll sort it. Just tag me and ask when you're ready.`,
      mom:
        `🏆 *Man of the Match: how it works*\n` +
        `After the final whistle I post a quick *Man of the Match* vote in the group. Everyone just taps who they thought was the standout player.\n` +
        `I tally the votes, announce the winner, and it counts towards everyone's season stats, so the MoM race builds up over the year.\n` +
        `Nothing to set up: I'll start the vote myself once the game's done. Ask me for your MoM tally any time, in your own words (for example *@Match Time my stats*).`,
      availability:
        `⚽ *Squad & availability: how it works*\n` +
        `Just say *In* or *Out* in the group to mark yourself for the next game. No need to tag me, I read it automatically.\n` +
        `I keep a live, numbered squad list. When it's full, extra players go on the *bench* in order. Not sure yet? Say *"maybe"* and I'll DM you ~24h before kick-off for a final answer.\n` +
        `If you drop out, I can nudge the bench to step in so we're never short. Say *Out* any time and I'll sort the rest.`,
      reminders:
        `⏰ *Reminders: how it works*\n` +
        `I gently nudge anyone who hasn't said *In* or *Out* yet, then remind the whole squad before kick-off so nobody forgets.\n` +
        `Want a personal nudge? Tag me and say when, in your own words (for example *"@Match Time remind me Thursday"*), and I'll DM you then.\n` +
        `It all happens automatically, so you don't need to chase anyone yourself.`,
      // Rewritten 2026-10-16: payment tracking (the payment poll) is
      // hidden, so "help payments" while it is on means fees are collected
      // (onboarding-conversation.ts `topicIsOn`). Each line is what
      // "Collect match fees" does (settings-info.ts paymentCollection).
      payments:
        `💷 *Match fees: how it works*\n` +
        `After each game I ask the money collector for the fee per player, then DM everyone who played a private link to pay their share. Card and Pay by Bank payments go straight to the money collector's bank.\n` +
        `Anyone who hasn't paid, and hasn't chosen to pay the money collector directly, gets the link again each day, for up to 6 days after the match.\n` +
        `To see the latest, ask me in your own words (for example *@Match Time who still owes?*).`,
    })[p.topic],

  // ── Help for a club whose organisers announce (2026-10-15) ───────────
  // `Organisation.listAnnouncer = "organisers"` (list-announcer.ts) and
  // `benchPickMode = "organiser"`. Each line is what the code does in that
  // mode: squad and team questions in the players' group are answered
  // "the organisers will post ..." (pipeline/compose.ts,
  // organisers-list-copy.ts); squad updates before the game go to the admin
  // channel (bot-scheduler.ts `toOrganisers`); a drop opens no bench offer
  // and the organisers pick (bench-confirmation.ts, organiser-pick.ts).

  /** "help teams" / "help availability" / "help reminders" when the
   *  organisers announce. `organiserPicks`: `benchPickMode = "organiser"`. */
  onbHelpOrganisersExplainer: (p: { topic: "availability" | "teams" | "reminders"; organiserPicks: boolean }): string =>
    ({
      teams:
        `🟥🟦 *Teams: how it works*\n` +
        `The organisers sort out the teams and share them with the group themselves, so I don't post team sheets in this chat.\n` +
        `Keep an eye out for their post before the game.`,
      availability:
        `⚽ *Squad & availability: how it works*\n` +
        `Just say *In* or *Out* in the group to mark yourself for the next game. No need to tag me, I read it automatically.\n` +
        `I keep track of who's in for the organisers, and they share the list with the group. Not sure yet? Say *"maybe"* and I'll DM you ~24h before kick-off for a final answer.\n` +
        (p.organiserPicks
          ? `When the squad is full, say *In* to go on the bench. When a place opens, the organisers pick who plays.`
          : `When the squad is full, extra players go on the *bench*, and the bench gets first go at any place that opens.`) +
        ` Say *Out* any time if you can't make it.`,
      reminders:
        `⏰ *Reminders: how it works*\n` +
        `Want a personal nudge? Tag me and say when, in your own words (for example *"@Match Time remind me Thursday"*), and I'll DM you then.\n` +
        `Squad updates before the game go to the organisers, and they share the list with the group.`,
    })[p.topic],

  /** "help availability" for a club MatchTime announces for but whose
   *  organisers pick who fills a place (`benchPickMode = "organiser"`). */
  onbHelpAvailabilityOrganiserPicks:
    `⚽ *Squad & availability: how it works*\n` +
    `Just say *In* or *Out* in the group to mark yourself for the next game. No need to tag me, I read it automatically.\n` +
    `I keep a live, numbered squad list. When it's full, extra players go on the *bench*. Not sure yet? Say *"maybe"* and I'll DM you ~24h before kick-off for a final answer.\n` +
    `When a place opens, the organisers pick who plays from the bench. Say *Out* any time if you can't make it.`,

  /** An organiser's DM bare help, organisers mode with an admin group
   *  linked: where the HQ commands are. */
  onbHelpAdminOrganisers: `📣 Your organisers share the list and the teams. In your admin group, ask me what I can do there, in your own words (for example *what can you do?*).`,

  /** "help" in a club's admin group (admin-group-help.ts), asked in any
   *  words (the shared router's `help` route). Every line is something the
   *  admin group really does. `squad`: a live weekly club (pasted list,
   *  squad changes, the teams). `graphics`: a live club. `picks`:
   *  organiser pick. `paid`: a monthly club's collector. `free`: a club
   *  that takes match fees (free places, 2026-10-16). */
  hq_help: (p: { squad: boolean; graphics: boolean; picks: boolean; paid: boolean; free?: boolean }): string => {
    const lines = [`🛠️ *MatchTime in your admin group*`, `Just ask here in your own words. No need to tag me. For example:`, ``];
    if (p.squad) {
      lines.push(`📋 *Paste the whole squad list*: I show you what would change, and *YES* within 30 minutes applies it.`);
      lines.push(`✏️ *"put Bilal in"*, *"Sam can't make it"*, *"Tom to the bench"*: changes to the squad.`);
      lines.push(`🟥🟦 *"show me the teams"*, *"shuffle them again"*: the teams, built if there are none yet.`);
      lines.push(`🔁 *"swap Sam and Alex"*, *"move Sam to the other team"*: changes to the teams.`);
      lines.push(`✅ *YES* (or reply YES to my message): make the proposed teams final.`);
      lines.push(`📣 *"ask the group if anyone can play"*: when a place is open, I ask in the main chat.`);
    }
    if (p.graphics) lines.push(`🖼️ *"send the poster"*, *"team sheet please"*: the list or the teams as a graphic, ready to forward.`);
    if (p.picks) lines.push(`🙋 When I ask you to pick who plays, reply with the numbers or names from my list, or *ALL* or *NONE*.`);
    if (p.paid) lines.push(`💷 *PAID ALL*, *PAID 1 3* or *PAID NONE*: the money collector's answer to my list of payment claims.`);
    if (p.free) lines.push(`🎁 *"Bilal is free this week"*: a free place, so no pay link and no reminders to pay.`);
    lines.push(``, `Ask *what can you do?* here any time to see this again.`);
    return lines.join("\n");
  },

  // ── The safe YES in the admin group (2026-10-16, admin-group-confirm-rules.ts) ──

  /** A YES MatchTime cannot be sure was meant for the teams. */
  hq_confirm_teams: (p: { day: string }): string => `Is that YES to the proposed teams for ${p.day}?`,
  /** A YES MatchTime cannot be sure was meant for the pasted list. */
  hq_confirm_list: `Is that YES to the squad list pasted here?`,
  /** Two things waiting: which one. */
  hq_confirm_which: (p: { day: string }): string =>
    `Which one is that YES for: the proposed teams for ${p.day}, or the pasted squad list? Reply YES to that message.`,
  /** YES quoting MatchTime with nothing waiting. */
  hq_nothing_waiting: `There's nothing waiting for a YES right now.`,
  /** An admin asked MatchTime for something the admin group cannot do. */
  hq_not_here: `I can't do that from this group. Ask *what can you do?* to see what I can do here.`,
  /** A message addressed to MatchTime in the admin group (an @tag, or a
   *  reply to its own message) that it could not read as anything it does. */
  hq_not_understood: `I didn't catch what you'd like me to do. Ask *what can you do?* to see what I can do here.`,
  /** Someone in the admin group who is not an owner or admin of the club
   *  asked MatchTime to change something (2026-10-16). `names` is the
   *  club's owners and admins, joined ("Hamzah or Raihan"); empty when it
   *  has none on record. */
  hq_only_organisers: (p: { names: string }): string =>
    p.names ? `Only ${p.names} can change that.` : `Only the club's organisers can change that.`,
  // ── The match score, reported in HQ (2026-10-16, admin-group-score.ts).
  //    Winner first; a draw in the match's own order. ──
  /** A score recorded from HQ. */
  hq_score_saved: (p: { redLabel: string; red: number; yellow: number; yellowLabel: string }): string =>
    `Score saved: ${sidesEn(p)}.`,
  /** A recorded score an organiser changed from HQ. */
  hq_score_changed: (p: {
    redLabel: string;
    yellowLabel: string;
    oldRed: number;
    oldYellow: number;
    red: number;
    yellow: number;
  }): string =>
    `Score changed: ${sidesEn(p)} (it was ${sidesEn({ ...p, red: p.oldRed, yellow: p.oldYellow })}).`,
  /** More than one scoreline in the message ("7-4 or 7-5"). */
  hq_score_unclear: `I can't tell the final score from that. What was it, and which team won?`,
  /** A score in HQ with no played match waiting for one. */
  hq_score_no_match: `There's no finished match waiting for a score.`,
  /** The score write failed. Nothing was saved. */
  hq_score_failed: `I couldn't save that score just now. Please send it again in a minute.`,
  // ── Man of the Match, picked by the organisers and reported in HQ
  //    (2026-10-18, admin-group-score.ts). Appended to the score line. ──
  hq_mom_saved: (p: { mvpLabel: string; name: string }): string => `${p.mvpLabel}: ${p.name}.`,
  hq_mom_changed: (p: { mvpLabel: string; name: string; old: string }): string => `${p.mvpLabel} changed: ${p.name} (it was ${p.old}).`,
  hq_mom_ask: (p: { mvpLabel: string }): string => `Who was ${p.mvpLabel}?`,
  hq_mom_which: (p: { mvpLabel: string; ref: string; choices: string }): string =>
    `Which ${p.ref} was ${p.mvpLabel}: ${p.choices}?`,
  hq_mom_not_in_match: (p: { mvpLabel: string; ref: string }): string =>
    `I can't find ${p.ref} among the players of that match. Who was ${p.mvpLabel}?`,
  hq_mom_organisers_only: (p: { mvpLabel: string }): string => `Only the organisers can set ${p.mvpLabel}.`,
  hq_mom_failed: (p: { mvpLabel: string }): string => `I couldn't save ${p.mvpLabel} just now. Please send it again in a minute.`,
  // ── An organiser asks MatchTime, in HQ, to ask the players' group for a
  //    player (2026-10-16, admin-group-ask-group.ts). A first-come club's
  //    post is `slot_opened`, unchanged. ──
  /** The players' group post in an organiser-pick club: an IN goes on the
   *  bench and the organisers confirm who plays. The organisers announce
   *  it, so the post promises no message from MatchTime (FNF 2026-10-18). */
  group_ask_organiser: (p: { open: number; kickoffLabel: string }): string =>
    p.open === 1
      ? `We need 1 more player for ${p.kickoffLabel}. Say *IN* if you can make it and the organisers will confirm who gets the place.`
      : `We need ${p.open} more players for ${p.kickoffLabel}. Say *IN* if you can make it and the organisers will confirm who gets the places.`,
  /** Back in HQ, once the post is queued. */
  hq_group_asked: (p: { open: number }): string =>
    `Asked in the main chat for ${p.open} ${p.open === 1 ? "player" : "players"}.`,
  /** No place open: nothing is posted. "of", never a slash. */
  hq_group_ask_full: (p: { confirmed: number; maxPlayers: number; kickoffLabel: string }): string =>
    `The squad is full for ${p.kickoffLabel}: ${p.confirmed} of ${p.maxPlayers}. Nothing to ask the main chat for.`,
  /** The same opening asked about again: not posted twice unless asked once more. */
  hq_group_ask_already: (p: { open: number; at: string }): string =>
    `Already asked in the main chat at ${p.at} for ${p.open} ${p.open === 1 ? "player" : "players"}. Ask me again and I'll post it again.`,
  // ── Free places, given in HQ (2026-10-16, fee-waiver.ts). `names` is
  //    already joined ("Bilal and Tom"); `day` is `dayLabel`. ──
  hq_fee_free_done: (p: { names: string; day: string }): string =>
    `Free place for ${p.day}: ${p.names}. No pay link and no reminders to pay.`,
  hq_fee_free_already: (p: { names: string; day: string }): string => `Already a free place for ${p.day}: ${p.names}.`,
  /** Never moves money: a player who paid stays paid. */
  hq_fee_free_paid: (p: { name: string; day: string }): string =>
    `${p.name} has already paid for ${p.day}, so I've left it as paid. The money collector can refund it if they should play free.`,
  hq_fee_free_monthly: (p: { name: string; day: string }): string => `${p.name}'s place for ${p.day} is paid for by the month.`,
  hq_fee_free_not_in_squad: (p: { name: string; day: string }): string => `I can't find ${p.name} in the squad for ${p.day}.`,
  /** `choices` is joined with "or". */
  hq_fee_free_which: (p: { ref: string; choices: string }): string => `Which ${p.ref}: ${p.choices}?`,
  hq_fee_free_no_match: `There's no match to give a free place on right now.`,
  hq_fee_free_no_payments: `This club doesn't take match fees through MatchTime, so there's nothing to make free.`,
  hq_fee_free_who: `Who should play free? For example: Bilal is free this week.`,
  /** The question before anything is written (review of #301): `notes`
   *  are whole sentences ("Bilal said they'd pay Colin directly."), or "". */
  hq_fee_free_ask: (p: { names: string; day: string; notes: string }): string =>
    `Make ${p.names} free for ${p.day}?${p.notes ? ` ${p.notes}` : ""} Reply YES.`,
  hq_fee_unfree_ask: (p: { names: string; day: string }): string =>
    `Take the free place away from ${p.names} for ${p.day}? They'll be asked to pay. Reply YES.`,
  /** A player who said they would pay the collector directly. */
  hq_fee_free_direct_note: (p: { name: string; collector: string | null }): string =>
    `${p.name} said they'd pay ${p.collector ?? "the money collector"} directly.`,
  hq_fee_unfree_done: (p: { names: string; day: string }): string =>
    `No longer free for ${p.day}: ${p.names}. They'll get the usual reminders to pay.`,
  hq_fee_unfree_not_free: (p: { name: string; day: string }): string => `${p.name} isn't on a free place for ${p.day}.`,
  hq_fee_free_collector: (p: { name: string }): string => `${p.name} collects the money, so there's nothing to make free.`,
  /** `day` is the organiser's own words for the day ("next Friday"). */
  hq_fee_free_no_match_day: (p: { day: string }): string => `I can't find a game for "${p.day}".`,
  hq_fee_free_expired: `That free place question is over 30 minutes old, so I haven't changed anything. Say it again and I'll ask again.`,
  /** A YES MatchTime cannot be sure was meant for the free place question. */
  hq_confirm_fee: (p: { names: string; day: string }): string => `Is that YES to the free place for ${p.names} on ${p.day}?`,
  /** To the money collector's admin channel: money arrived from a player on
   *  a free place (a payment started before it was given). */
  admin_fee_paid_while_free: (p: { name: string; amount: string; day: string }): string =>
    `💷 ${p.name} paid ${p.amount} for ${p.day}, but they're on a free place. Refund it in Stripe if they should play free.`,
  /** A team change whose players MatchTime could not tell. */
  tp_which_players: `Which players? For example: swap Sam and Alex, or move Sam to the other team.`,
  /** "move Sam to Red" when Sam is already there. */
  tp_already_on: (p: { name: string; team: string }): string => `${p.name} is already on ${p.team}.`,

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
  dm_rating: (p: { activityName: string; dateLabel: string; mvpLabel: string; rateUrl: string; statsUrl: string; momVote?: boolean }): string =>
    `🏆 *${p.activityName}*, ${p.dateLabel}\n\n` +
    (p.momVote === false ? `Rate your teammates. Takes ~1 minute.\n\n` : `Rate your teammates and pick ${p.mvpLabel}. Takes ~1 minute.\n\n`) +
    `Your personal link:\n${p.rateUrl}\n\n` +
    `Link expires in 5 days.\n\n` +
    `📊 Your season stats (ratings, MoM, badges, share card), any time:\n${p.statsUrl}`,

  /** Row 92: the rating reminder, at most two after the first DM
   *  (Kemal, 2026-10-18; rating-reminder-schedule.ts). "first" is a
   *  friendly nudge, "last" says it is the last and that ratings close
   *  soon. `momVote: false` (organisers pick Man of the Match): ratings only. */
  dm_rating_reminder: (p: { reminder: "first" | "last"; firstName: string | null; activityName: string; mvpLabel: string; url: string; momVote?: boolean }): string => {
    const first = p.firstName ?? "mate";
    const sig = `\n${p.url}`;
    const ask = p.momVote === false ? `rate your teammates` : `rate your teammates and pick ${p.mvpLabel}`;
    if (p.reminder === "last") {
      return (
        `Last reminder, ${first} 🔔 Ratings for *${p.activityName}* close soon.\n\n` +
        `If you'd like to ${ask}, here's your link. I won't remind you again:${sig}`
      );
    }
    return (
      `Hey ${first} 👋 Friendly nudge, you haven't rated *${p.activityName}* yet.\n\n` +
      `It takes 30 seconds to ${ask}, and it helps balance next week's teams 🙌${sig}`
    );
  },

  /** Row 83: the tentative ("maybe") follow-up, ~24h before kickoff.
   *  Its answer is read back by the dm-reply route's fast path, then the
   *  match-availability classifier. */
  dm_tentative_followup: (p: { firstName: string | null; activityName: string; whenLabel: string }): string =>
    `Hi ${p.firstName ?? "there"} 👋 You were a *maybe* for *${p.activityName}* on ${p.whenLabel}.\n\n` +
    `Are you in or out? Just reply *IN* or *OUT* and I'll sort the squad 🙏`,

  /** Row 105: the tentative follow-up's one re-ask. */
  dm_tentative_reask: "No worries, just reply *IN* if you can play or *OUT* if you can't, and I'll update the squad 🙏",

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

  /** Row 85 when SEVERAL slots opened at once: one DM for all of them
   *  (2026-10-06). `count` is 2 or more; `details` as in
   *  `bench_offer_group_post_many`, from `bench_offer_slot_detail_plain`. */
  dm_bench_offer_many: (p: { count: number; firstName: string; context: string; details: string[]; reactions: boolean }): string => {
    const hi = p.firstName ? ` ${p.firstName}` : "";
    const claim = p.reactions
      ? "Reply *YES* here, tap 👍 on the message I tagged you in, or reply *IN* there."
      : "Reply *YES* here, or *IN* on the message I tagged you in, in the group.";
    return (
      `👋 Hi${hi}, ${p.count} slots just opened ${p.context} and you're on the bench.\n` +
      p.details.map((d) => `${d}\n`).join("") +
      `\n` +
      `Want one? ${claim} First to claim plays. No timeout, and if you're ` +
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
        `Sorry, I couldn't update the squad just now. An admin will sort it, or ` +
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
        'Done, I\'ll only message you about payments from now on. ' +
        'Text "start messages" anytime to turn the rest back on.',
      "opt-out-ratings":
        'Done, no more rating or Man-of-the-Match messages from me 👍 ' +
        'Text "start ratings" anytime to turn them back on.',
      "opt-in-all": "Great, you're back on for all my messages 👍",
      "opt-in-ratings": "Great, I'll send you rating and Man-of-the-Match links again 👍",
    })[p.kind],

  /** Row 132: the personal reminder a player asked for. */
  dm_reminder: (p: { firstName: string | null; note: string }): string =>
    `⏰ Reminder, ${p.firstName ?? "there"}. You asked me to nudge you:\n\n` +
    `_${p.note}_\n\n` +
    `(reply in the group when you're ready 👍)`,

  /** Row 100: the stats-blast DM (the link does not expire). */
  dm_stats_blast: (p: { firstName: string | null; url: string }): string =>
    `📊 Hi ${p.firstName ?? "there"}, here are your MatchTime stats: your ratings over time, ` +
    `Man-of-the-Match games, how you stack up against the squad, your badges and a ` +
    `shareable season card.\n\n${p.url}\n\nKeep this link, it doesn't expire.`,

  /** Row 122: the "@Match Time my stats" DM (a 48h link). */
  dm_stats_link: (p: { firstName: string | null; url: string }): string =>
    `📊 Hey ${p.firstName ?? "there"}, here are your MatchTime stats: ratings over time, your ` +
    `Man-of-the-Match games, how you compare to the squad, your badges, and a ` +
    `shareable season card.\n\n${p.url}\n\nLink works for 48h.`,

  /** Row 111: the DM Q&A's fallback when the model gave nothing usable. */
  dm_qa_apology: "Sorry, I couldn't work that one out. Try asking again? 🙂",

  /** Row 88: the fee ask to the money collector at match end. The reply
   *  is parsed by `parseFeeReply` (a £ amount, "each" / "total"). */
  dm_fee_ask: (p: { firstName: string | null; activityName: string; headcount: number }): string =>
    `💷 ${p.firstName ?? "there"}, how much should each player pay for *${p.activityName}*` +
    (p.headcount > 0 ? ` (${p.headcount} played)` : "") +
    `?\n\n` +
    `Just reply with the amount, e.g. "£8 each" or "£80 total to split". ` +
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
      `Got it: *${p.fee}* per player${split} for *${p.matchName}*` +
      (charge ? `, ${players(p.headcount)} to charge` : "") +
      `.\n\nReply *✅* (or "yes") to send everyone their pay link, or send a different amount to change it.`
    );
  },

  /** Appended to the fee question and its confirm when some players have
   *  a free place (2026-10-16): they are not in the count. */
  dm_fee_free_note: (p: { count: number }): string =>
    `(${p.count} ${p.count === 1 ? "player is" : "players are"} on a free place and not counted.)`,

  // ── Free places on the payments pages (2026-10-16) ──
  pay_free_title: `Nothing to pay`,
  pay_free_body: (p: { firstName: string; activityName: string }): string =>
    `${p.firstName}, you're on a free place for ${p.activityName}. Nothing to pay.`,
  /** Why a player on a free place cannot pay for a guest here (review of #301, item 4). */
  pay_free_guests: `Paying for a guest? Settle it with the money collector directly.`,
  /** The DM to a player made free after their pay link went out (Kemal, decision a). */
  dm_free_place: (p: { day: string }): string => `You're on a free place for ${p.day}, no need to pay.`,
  collect_nothing_changed: `Nothing to change`,
  collect_free: `Free place`,
  collect_mark_free: `Mark free`,
  collect_undo_free: `Undo free`,
  collect_marked_free: `Marked as a free place`,
  collect_unmarked_free: `Free place removed`,
  collect_free_count: (p: { count: number }): string => `${p.count} free`,

  /** Row 96: the collector's ack once the links went out. `bank`, `card`
   *  and `direct` are `availablePayMethods(org)`: it names only those
   *  (FNF, 2026-10-16). */
  dm_fee_released: (p: {
    released: number;
    fee: string;
    matchName: string;
    /** The match's day ("Tue 13 Oct"), so a collector with two matches of
     *  the same activity can tell which went out (review of #339). */
    matchWhen?: string | null;
    bank: boolean;
    card: boolean;
    direct: boolean;
  }): string => {
    const online = [p.bank && "bank", p.card && "card, Apple or Google Pay"].filter(Boolean).join(", ");
    const how =
      online && p.direct
        ? `Players can pay by ${online}, or settle with you directly. `
        : online
          ? `Players can pay by ${online}. `
          : p.direct
            ? `Players pay you directly, and I'll let you know when someone says they have. `
            : "";
    return (
      `✅ Done, sent ${p.released} pay link${p.released === 1 ? "" : "s"} at *${p.fee}* each for *${p.matchName}*${p.matchWhen ? ` on ${p.matchWhen}` : ""}. ` +
      `${how}I'll chase anyone who hasn't paid.`
    );
  },

  /** Row 97: the collector's ack to a cancel. */
  dm_fee_cancelled: `No problem, cancelled. Just tell me the amount per player when you're ready.`,

  /** Row 95: the pay link to each confirmed player. `bank`, `card` and
   *  `direct` are `availablePayMethods(org)`, the buttons the pay page
   *  shows; it names nothing else (FNF, 2026-10-16: it promised bank,
   *  card and Apple Pay to a club that takes direct payment only).
   *  `collector` is the money collector's first name, or null. */
  dm_pay_link: (p: {
    firstName: string | null;
    activityName: string;
    fee: string;
    url: string;
    bank: boolean;
    card: boolean;
    direct: boolean;
    collector: string | null;
    /** The club's payment instructions (verbatim), or null. One line,
     *  only when paying directly is offered (2026-10-16). */
    instructions: string | null;
  }): string => {
    const who = p.collector ?? "the organiser";
    const online = [p.bank && "bank", p.card && "card, Apple or Google Pay"].filter(Boolean).join(", ");
    const howTo = p.direct && p.instructions ? `\n\nHow to pay ${who}: ${p.instructions}` : "";
    const how =
      online && p.direct
        ? `Tap to pay (${online}, or pay ${who} directly):`
        : online
          ? p.card
            ? `Tap to pay (${online}):`
            : `Tap to pay by bank:`
          : p.direct
            ? `Pay ${who} directly, by cash or transfer. Tap to see what you owe and tell me once you've paid:`
            : `Tap to see what you owe:`;
    // The page's "Paying for" stepper covers every method, so the line
    // holds whenever there is a method to pay by.
    const guests = online || p.direct ? `\n\nYou can also pay for anyone you brought along.` : "";
    return `💷 ${p.firstName ?? "there"}, match fee for *${p.activityName}* is *${p.fee}*.\n\n${how}\n${p.url}${howTo}${guests}`;
  },

  /** Row 89: the daily pay chase; `dayNum` picks the opener. Names only
   *  `availablePayMethods(org)`, as the pay link does. */
  dm_pay_chase: (p: {
    firstName: string | null;
    dayNum: number;
    fee: string;
    activityName: string;
    url: string;
    bank: boolean;
    card: boolean;
    direct: boolean;
    collector: string | null;
    /** As `dm_pay_link`: one line, only when paying directly is offered. */
    instructions: string | null;
  }): string => {
    const first = p.firstName ?? "there";
    const opener =
      p.dayNum <= 1 ? `Quick one ${first}` : p.dayNum === 2 ? `${first}, gentle nudge` : `${first}, still owed`;
    const who = p.collector ?? "the organiser";
    const online = [p.bank && "bank", p.card && "card, Apple or Google Pay"].filter(Boolean).join(", ");
    const how =
      online && p.direct
        ? `Pay by ${online}, or pay ${who} directly:`
        : online
          ? `Pay by ${online}:`
          : p.direct
            ? `Pay ${who} directly, then tap here to tell me you've paid:`
            : `See what you owe:`;
    const howTo = p.direct && p.instructions ? `\n\nHow to pay ${who}: ${p.instructions}` : "";
    return `💷 ${opener}: your *${p.fee}* for *${p.activityName}* is still outstanding.\n\n${how}\n${p.url}${howTo}`;
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

  /** Row 195: the player's reply when their "I'll pay Raihan directly" DM
   *  was passed to the collector: the settle-directly button said in
   *  words (Kemal, 2026-10-18). A repeat gets `dm_paid_claim_already`. */
  dm_will_pay_direct_ack: (p: { firstName: string | null; collectorName: string | null; amount: string; activityName: string }): string =>
    `Noted${p.firstName ? ` ${p.firstName}` : ""}, I've told ${p.collectorName ?? "the organiser"} you'll pay them ` +
    `*${p.amount}* directly for *${p.activityName}*. ${p.collectorName ?? "The organiser"} will confirm once it lands 👍`,

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
    `📣 Done, DM'd ${p.invited} recent player${p.invited === 1 ? "" : "s"} who hadn't replied, asking them to fill *${p.matchName}* on ${p.matchWhen}${p.need ? ` (${p.need} spot${p.need === 1 ? "" : "s"} left)` : ""}. I'll add anyone who taps in. 🙏`,
  dm_admin_recruit_nobody_new: (p: { matchName: string }): string =>
    `Everyone who played recently has already responded to *${p.matchName}*, so there's nobody new to invite. 👍`,

  /** Row 109: the roster check-in's one clarification. The probe is the
   *  message's opening, and the route's one-per-person dedupe query
   *  looks for it (in every language). */
  dm_survey_clarify_probe: (p: { firstName: string | null }): string =>
    `Sorry ${p.firstName ?? "mate"}, I wasn't sure if that was a reply to the roster check-in`,
  dm_survey_clarify: (p: { firstName: string | null; orgName: string }): string =>
    [
      `Sorry ${p.firstName ?? "mate"}, I wasn't sure if that was a reply to the roster check-in for *${p.orgName}*.`,
      ``,
      `Was your answer:`,
      `• yes / I'm in`,
      `• maybe / sometimes`,
      `• not for now / out`,
      ``,
      `Quick word back is enough. Otherwise no worries, an admin will sort it 🙏`,
    ].join("\n"),

  /** Row 110: the roster check-in confirmations. */
  dm_survey_confirm: (p: { category: "in" | "maybe" | "out"; firstName: string | null }): string => {
    const firstName = p.firstName ?? "mate";
    if (p.category === "in") return `Got it ${firstName}, marked you as in 👍 Thanks!`;
    if (p.category === "maybe") {
      return `Got it ${firstName}, marked you as maybe 👍 Just say *IN* in the group whenever you want to play that week, no need to confirm in advance.`;
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
      `Quick check-in: attendance's been thin lately, so we're asking everyone if they're still up for Tuesday football going forward.`,
      ``,
      `Just reply here with a word or two:`,
      `• "yes" / "I'm in": keep me on the roster`,
      `• "maybe" / "depends": only when I confirm`,
      `• "not for now" / "out": step me back`,
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
  gear_feature_label: "Match-day kit reminder",
  gear_feature_blurb:
    "Two hours before a football kickoff, reminds the group to bring goalie gloves, a ball and spare bibs.",

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
  /** Its own bold paragraph on the card: without the switch MatchTime gets
   *  none of the group's past chat and the learned setup has nothing to read. */
  sj_card_history_tip:
    "Important: before you confirm, switch on \"Message history\" on that screen. It sends MatchTime your group's recent messages, so it can set itself up the way you already run things.",
  /** 2026-10-15: WhatsApp refuses an add by somebody who is not in
   *  MatchTime's contacts and offers "Invite to group" instead. MatchTime
   *  accepts the organiser's invite by itself; an invite brings no chat. */
  sj_card_invite_tip:
    "If WhatsApp says it can't add MatchTime and offers \"Invite to group\", tap that. MatchTime joins by itself. An invite doesn't bring the message history, so you'll set things up on the settings page instead.",
  sj_card_number_label: "MatchTime's WhatsApp number",
  sj_card_pending:
    "Step 3: we're checking your club, usually within a day. MatchTime stays quiet in the group until your club is approved, and messages you on WhatsApp when it's live.",
  sj_card_pending_other: (p: { group: string }): string =>
    `MatchTime was added to "${p.group}" by someone else. We'll check it before MatchTime does anything there.`,
  /** True the moment a club goes live and a week later: it does not say
   *  the hello has appeared (the Pi posts it up to a few minutes after). */
  sj_card_approved: (p: { group: string }): string => `You're live in "${p.group}".`,
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
    "Next, add me to your football group. Save this number as a contact called MatchTime first, then open the group, tap Add participant and pick MatchTime.\n\n" +
    "*Important: before you confirm, switch on \"Message history\" on that screen.* It sends me your group's recent messages, so I can set MatchTime up the way you already run things.\n\n" +
    "I'll stay quiet in the group until your club is approved, usually within a day. I'll message you here when it's live.",
  sj_dm_already_connected: "You're already connected. Now just add me to your group.",
  sj_dm_code_expired: "That code has expired. Open your club on matchtime.ai and tap Add MatchTime to WhatsApp again.",
  /** A connect message whose code names no request, from an organiser who
   *  has an open one. Never carries the right code. */
  sj_dm_wrong_code: (p: { club: string }): string =>
    `The code in your message doesn't match the one for ${p.club}. Go back to your club page on matchtime.ai, press Add MatchTime to WhatsApp again, and send the message exactly as it opens.`,

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
    `⏰ *Remind me:* tag me and say when, in your own words (for example *"@Match Time remind me Thursday"*), and I'll DM you then.\n` +
    `⚖️ *Fair teams:* tag me and I pick balanced teams from player ratings.\n` +
    `⭐ *Man of the Match and ratings* after every game.\n` +
    `📊 *Stats:* ask me anything, and everyone gets their own stats page.\n` +
    `💷 *Match fees:* your organiser can switch on card or bank pay links.\n\n` +
    `I stay quiet during the banter and only reply to In, Out or a tag. Anything else, tag me: *@Match Time help*`,

  // ════ BEGIN settings-aware group hello (go-live slice S2, 2026-10-12) ════
  // The parts `buildGroupHello` (src/lib/group-hello.ts) composes the
  // hello from, so a club is told only what its own settings do. For a
  // club on default settings, with `sj_hello_catch_up` left out, the
  // composed text equals `sj_group_hello` above byte for byte
  // (`group-hello.test.ts` pins it): change one and you must change the
  // other. Deterministic, never shown to a model. No em or en dashes.
  sj_hello_opener: (p: { organiser: string | null }): string =>
    `👋 Hi everyone, I'm *MatchTime*. ${p.organiser ? `${p.organiser} has set me up to run this group's games.` : "I'm here to run this group's games."} ` +
    `Here's what I do, right here in WhatsApp:`,
  /** A club that signs up each week. */
  sj_hello_whos_in: `✅ *Who's in:* just say *In* or *Out*. I keep the list and tick your message.`,
  /** Rolling squad: nobody is told to say In each week. `deadline` is
   *  the drop-out deadline as "Monday 21:00", or null when none is set. */
  sj_hello_rolling: (p: { deadline: string | null }): string =>
    `🔁 *Same squad each week:* if you played last time, you're in next time too. You only need to say *Out* if you can't make it${p.deadline ? `, before *${p.deadline}*` : ""}.`,
  /** Rolling squad, THE FIRST GAME (2026-10-13): MatchTime has no squad
   *  to carry over yet, so nobody is "in already" and nobody is told they
   *  are. Replaces `sj_hello_rolling` AND `sj_hello_rolling_join` while
   *  `hasSquadToCarry` is false. "organiser": the organisers pick, so an
   *  In goes on the bench (`canTakeFreePlace`, squad-capacity.ts). */
  sj_hello_rolling_first: (p: { deadline: string | null; mode: "first-come" | "organiser" }): string => {
    const before = p.deadline ? `, before *${p.deadline}*` : "";
    return p.mode === "organiser"
      ? `🔁 *Same squad each week:* this group keeps the same squad from one game to the next. For the *first game* with me, say *In*: I'll put you on the bench and the organisers pick who plays. After that, whoever played stays in each week and only needs to say *Out* if they can't make it${before}.`
      : `🔁 *Same squad each week:* this group keeps the same squad from one game to the next. For the *first game* with me, say *In* so I know who is playing. After that you stay in each week and only need to say *Out* if you can't make it${before}.`;
  },
  /** Rolling squad, THE FIRST GAME, organiser pick, in a club whose
   *  organisers share the list and teams (`listAnnouncer` "organisers",
   *  2026-10-15, FNF). An In goes on the bench (`canTakeFreePlace`), and the
   *  organisers set the first squad themselves (a pasted list in their admin
   *  group, or the website), so nobody is told to say In for it. */
  sj_hello_rolling_first_organisers: (p: { deadline: string | null }): string =>
    `🔁 *Same squad each week:* the organisers pick the squad for the *first game* with me and share the list. After that, whoever played stays in each week and only needs to say *Out* if they can't make it${p.deadline ? `, before *${p.deadline}*` : ""}.`,
  /** Organisers mode (2026-10-15): the squad list and the teams go to the
   *  organisers (bot-scheduler.ts `toOrganisers`; no team sheet in the
   *  players' group, list-announcer.ts), who share them. Replaces
   *  `sj_hello_list` and `sj_hello_teams`. Never called with both off. */
  sj_hello_organisers_share: (p: { list: boolean; teams: boolean }): string =>
    p.list && p.teams
      ? `📣 *List and teams:* the organisers share the squad list and the teams with you.`
      : p.list
        ? `📣 *The list:* the organisers share the squad list with you.`
        : `📣 *Teams:* the organisers share the teams with you.`,
  /** Rolling squad, for somebody not carried over. "organiser": the
   *  organisers pick, so an In never takes a place by itself. */
  sj_hello_rolling_join: (p: { mode: "bench" | "no-bench" | "organiser" }): string =>
    p.mode === "organiser"
      ? `✅ *Not in the squad yet?* Say *In* and I'll put you on the bench.`
      : p.mode === "bench"
        ? `✅ *Not in the squad yet?* Say *In* and I'll add you if there's a place, or put you on the bench.`
        : `✅ *Not in the squad yet?* Say *In* and I'll add you if there's a place.`,
  /** Monthly squad: the regulars' line, then the line for everyone else. */
  sj_hello_monthly: `📋 *Monthly squad:* regulars sign up and pay for the whole month, and are in every game of it. Can't make one? Say *Out*.`,
  sj_hello_monthly_join: (p: { organisersPick: boolean }): string =>
    p.organisersPick
      ? `✅ *Not a regular?* When a place is open, say *In* to go on the bench, and the organisers pick who plays.`
      : `✅ *Not a regular?* When a place is open, say *In* to take it. You pay for that game only.`,
  /** A weekly sign-up club with a drop-out deadline. `day` is `wd_weekday`. */
  sj_hello_deadline: (p: { day: string; time: string }): string =>
    `⏳ *Drop-out deadline:* ${p.day} ${p.time}. If you can't play, say *Out* before then.`,
  sj_hello_list: (p: { day: string; time: string }): string => `📋 *Final list:* I post it here on ${p.day} at ${p.time}.`,
  sj_hello_bench: `🪑 *The bench:* once we're full, anyone who says *In* late goes on the bench, and the bench gets first dibs if someone drops.`,
  /** The organisers pick: MatchTime never fills a place by itself. */
  sj_hello_bench_organiser: `🪑 *The bench:* say *In* to go on the bench, and the organisers pick who takes each open place.`,
  sj_hello_remind: `⏰ *Remind me:* tag me and say when, in your own words (for example *"@Match Time remind me Thursday"*), and I'll DM you then.`,
  sj_hello_teams: `⚖️ *Fair teams:* tag me and I pick balanced teams from player ratings.`,
  /** Never called with both off: the line is left out then. */
  sj_hello_mom: (p: { mom: boolean; ratings: boolean }): string =>
    p.mom && p.ratings
      ? `⭐ *Man of the Match and ratings* after every game.`
      : p.mom
        ? `⭐ *Man of the Match* after every game.`
        : `⭐ *Player ratings* after every game.`,
  sj_hello_stats: `📊 *Stats:* ask me anything, and everyone gets their own stats page.`,
  /** With nothing on, payments are only something the organiser CAN
   *  switch on. `mode` is the pay links: off, or the ways a link can be paid. */
  sj_hello_fees: (p: { tracking: boolean; mode: "off" | "card" | "bank" | "card-and-bank" }): string => {
    const how = p.mode === "card" ? "by card" : p.mode === "bank" ? "by bank" : "by card or bank";
    if (p.mode !== "off") {
      return `💷 *Match fees:* you can pay ${how} through a link I send you.${p.tracking ? " I keep track of who has paid and remind anyone who hasn't." : ""}`;
    }
    return p.tracking
      ? `💷 *Match fees:* I keep track of who has paid and remind anyone who hasn't.`
      : `💷 *Match fees:* your organiser can switch on card or bank pay links.`;
  },
  /** Only for a club that signs up each week: MatchTime was not listening
   *  before it went live, so an earlier In is not on the list. */
  sj_hello_catch_up: `Already said In for the next game? Say it once more so I have you on the list.`,
  /** `attendance` off: the club never says In or Out to MatchTime. */
  sj_hello_closer: (p: { attendance: boolean }): string =>
    p.attendance
      ? `I stay quiet during the banter and only reply to In, Out or a tag. Anything else, tag me: *@Match Time help*`
      : `I stay quiet during the banter and only reply when you tag me. Anything else, tag me: *@Match Time help*`,
  // ════ END settings-aware group hello ════

  // ════ BEGIN going live: replies to GO (go-live slice S4, 2026-10-12) ════
  // DMs to an owner or admin of a club that is approved but still setting
  // up (src/lib/setup-go-dm.ts). All deterministic, all sent on the
  // platform channel, because the club's own channel is off until GO.
  /** The label of the button on the settings page, so every message that
   *  names it and the page itself use one wording. */
  sj_go_button: `Go live`,
  /** GO worked: the hello is queued for the group. It is NOT there yet:
   *  the Pi posts it once its next refresh has learnt that the group is
   *  served, up to five minutes later, so this does not say "I have". */
  sj_go_done: (p: { group: string }): string =>
    `Done: I'm introducing myself in "${p.group}" now. It can take a few minutes to appear.`,
  /** GO while the group's chat is still being read (owner decision 4).
   *  True for whoever says GO: the reading can take up to two hours, and
   *  the setup message goes only to the organiser who connected the club,
   *  in the daytime. So no "in a few minutes", and no "I'll message you". */
  sj_go_still_reading: (p: { club: string }): string =>
    `I'm still reading your group's messages, which can take a while. When I've finished I'll send the setup message to the organiser who connected ${p.club}. Try *GO* again after that.`,
  /** GO failed on MatchTime's side (the server threw). Nothing changed;
   *  the Pi does not send the message again, so the organiser is asked to. */
  sj_go_failed: `Something went wrong on my side. Please reply *GO* again.`,
  /** Opens the help sent to an owner or admin of a club that is still
   *  setting up: the help below describes a group MatchTime is not
   *  listening to yet. */
  sj_go_help_not_started:
    "MatchTime hasn't started in your group yet. Nothing below works there until you reply *GO* here or press *Go live* on your settings page.",
  /** To the organiser, once, when the MatchTime team took the club live
   *  for them (the owner's "Go live now"). The free period note and the
   *  settings link follow it (src/lib/club-setup-owner-live.ts). */
  sj_go_owner_started: (p: { group: string }): string =>
    `The MatchTime team has started MatchTime in "${p.group}" for you, so you don't need to reply GO. It introduces itself in the group, which can take a few minutes to appear.`,
  /** GO after MatchTime was removed from the group. */
  sj_go_removed: (p: { group: string }): string => `I'm not in "${p.group}" any more. Add me back, then reply GO.`,
  /** GO for a club somebody else has just taken live. */
  sj_go_already_live: (p: { club: string }): string => `${p.club} is already live.`,
  /** GO from somebody who runs more than one club that is setting up. */
  sj_go_many: `You have more than one club being set up. Use the Go live button in each club's settings.`,
  /** Anything else from the organiser of a setting-up club (owner decision
   *  8). `url` is the plain settings address. */
  sj_go_not_recognised: (p: { club: string; url: string }): string =>
    `I didn't recognise that message. To go live with ${p.club}, reply *GO* here, or press *Go live* on the settings page:\n${p.url}`,
  /** The same, for somebody with more than one club setting up: GO cannot
   *  pick one. `url` is the plain settings address (PR #234 review, fix
   *  1b: no signed-in link is minted per unrecognised message). */
  sj_go_not_recognised_many: (p: { url: string }): string =>
    `I didn't recognise that message. You have more than one club being set up, so press *Go live* in each club's settings:\n${p.url}`,
  /** GO for a club that is paused for the club fee (PR #234 review, fix 2):
   *  a hello queued now would never be delivered. The settings page has
   *  the billing card, which says what the club needs. */
  sj_go_paused: (p: { club: string; url: string }): string =>
    `${p.club} is paused, so I can't go live yet. Your settings page shows what's needed:\n${p.url}`,
  /** GO for a club that went live some time ago and is paused NOW. Not
   *  `sj_go_paused`: "can't go live yet" is false for a club that is live. */
  sj_go_live_paused: (p: { club: string; url: string }): string =>
    `${p.club} is already live, but it is paused at the moment. Your settings page shows what's needed:\n${p.url}`,
  // ════ END going live: replies to GO ════

  // ════ BEGIN removed from the group while setting up (2026-10-12) ════
  /** To the organiser, once per removal, when MatchTime is taken out of the
   *  group of a club that is approved but has not gone live. On the
   *  platform channel, in the daytime. The Turkish command is BAŞLA. */
  sj_setup_removed: (p: { club: string; group: string; url: string }): string =>
    `I was removed from "${p.group}" before ${p.club} went live, so nothing has started there. ` +
    `Add me back to the group, then reply *GO* here or press *Go live* on your settings page:\n${p.url}\n` +
    `Anyone in ${p.club} can add me back.`,
  // ════ END removed from the group while setting up ════
  // ════ BEGIN the go-live pages (go-live slice S5, 2026-10-12) ════
  // The Go live banner on /admin/settings, that page's WhatsApp bot
  // section while a club is setting up, and the card on the club's admin
  // home. The button's own label is `sj_go_button`, above.
  /** The banner's heading: the club is approved and nothing has been said
   *  in its group yet. */
  sj_live_title: `Approved. MatchTime is waiting for you.`,
  /** The banner's heading while MatchTime is out of the group: it is not
   *  "waiting for you" there, it has to be added back first. */
  sj_live_title_removed: `MatchTime was removed from your group`,
  /** `group` is the WhatsApp group's own name, null when it is not known. */
  sj_live_lead: (p: { group: string | null }): string =>
    `MatchTime is in ${p.group ? `"${p.group}"` : "your WhatsApp group"} and is staying quiet until you start it. Check the settings below first, then press Go live.`,
  /** The button while the request is running. */
  sj_live_busy: `Going live...`,
  sj_live_preview_title: `What MatchTime will post in your group`,
  sj_live_preview_note: `This message follows your settings. Change a setting below and the message changes with it.`,
  sj_live_preview_loading: `Loading the message...`,
  sj_live_preview_failed: `Couldn't load the message. Reload the page to try again.`,
  /** Went live: these two replace the banner. */
  sj_live_done_title: `You're live.`,
  /** The hello is QUEUED at this moment: the bot picks a newly live club
   *  up within a few minutes, so it is not in the group yet. */
  sj_live_done: (p: { group: string }): string =>
    `MatchTime is introducing itself in "${p.group}" now. It can take a few minutes to appear.`,
  /** Heading over the hello exactly as it is queued. */
  sj_live_done_posted: `The message it is posting`,
  /** Pressed while the group's chat is still being read (owner decision 4). */
  sj_live_still_reading: `MatchTime is still reading your group's messages, which can take a while. It will send the setup message to the organiser who connected the club when it has finished. Try again after that.`,
  /** MatchTime was removed from the group while the club was setting up. */
  sj_live_removed: (p: { group: string }): string =>
    `MatchTime is not in "${p.group}" any more. Add it back to the group, then press Go live.`,
  /** The club is paused for the club fee. */
  sj_live_paused: (p: { club: string }): string =>
    `${p.club} is paused, so it can't go live yet. What's needed is further down this page.`,
  /** Somebody else took the club live first. `by` is that person's name,
   *  never a phone number; `matchTime` when it was the MatchTime owner. */
  sj_live_already: (p: { club: string; by: string | null; matchTime: boolean }): string =>
    p.matchTime
      ? `MatchTime has already taken ${p.club} live.`
      : p.by
        ? `${p.by} has already taken ${p.club} live.`
        : `${p.club} is already live.`,
  /** The club is not waiting to go live at all (turned off, say). Its own
   *  heading, never "already live". */
  sj_live_closed_title: `Go live is not available`,
  sj_live_not_setting_up: `This club is not waiting to go live any more. Reload the page to see where it stands.`,
  /** The organiser's own earlier press worked and its answer was lost. */
  sj_live_is_live: (p: { club: string }): string => `${p.club} is live.`,
  /** The rest of the page could not be refreshed after an outcome. */
  sj_live_stale: `The rest of this page could not be refreshed, so parts of it may be out of date.`,
  sj_live_reload: `Reload the page`,
  sj_live_failed: `Couldn't go live. Please try again.`,
  /** The WhatsApp bot section, in place of "Disabled". */
  sj_live_wa_badge: `Waiting for you to go live`,
  sj_live_wa_body: `MatchTime is approved and in your group. It stays quiet until you press Go live at the top of this page.`,
  sj_live_wa_link: `Go to Go live`,
  /** The same section once MatchTime has been removed from the group
   *  while the club was setting up: it is NOT in the group. */
  sj_live_wa_badge_removed: `Not in your group`,
  sj_live_wa_body_removed: `MatchTime was removed from your group before going live, so nothing has started there. Add it back to the group, then press Go live at the top of this page.`,
  /** The admin home card in that state: its heading and its body. */
  sj_card_removed_title: `MatchTime was removed from your group`,
  sj_card_setting_up_removed: (p: { group: string | null }): string =>
    `MatchTime was removed from ${p.group ? `"${p.group}"` : "your WhatsApp group"} before going live. Add it back to the group, then go live.`,
  /** The Go live button's accessible name, and the line beside it: an
   *  organiser with more than one club setting up must see which one. */
  sj_live_button_label: (p: { club: string }): string => `Go live: ${p.club}`,
  sj_live_for_club: (p: { club: string }): string => `This takes ${p.club} live.`,
  /** On /login, after opening a signed link that has expired. */
  login_link_expired: `That link has expired. Sign in with your WhatsApp number to carry on.`,
  /** The /r page, for a link that is not ours or cannot sign anyone in.
   *  It does not say "already used": no link is single-use. */
  link_invalid: `This link isn't valid.`,
  link_go_sign_in: `Go to sign in`,
  /** The card on the club's admin home, in place of "You're live". Its
   *  heading is `sj_live_title`. */
  sj_card_setting_up: (p: { group: string | null }): string =>
    `MatchTime is in ${p.group ? `"${p.group}"` : "your WhatsApp group"} and is staying quiet until you go live.`,
  sj_card_setting_up_link: `Check your settings and go live`,
  /** The WhatsApp bot section's popup while the club is setting up. */
  info_st_whatsapp_setup_title: "WhatsApp bot",
  info_st_whatsapp_setup_body:
    "MatchTime is approved and linked to your WhatsApp group. It stays quiet there until an owner or admin of the club presses Go live at the top of this page, or replies GO to MatchTime on WhatsApp.\n\n" +
    "Nothing is wrong: it is waiting for you.",
  /** The same popup once MatchTime has been removed from the group. */
  info_st_whatsapp_removed_title: "WhatsApp bot",
  info_st_whatsapp_removed_body:
    "MatchTime is approved, but it was removed from your WhatsApp group before going live, so it cannot start there.\n\n" +
    "Add MatchTime back to the group. Then an owner or admin of the club presses Go live at the top of this page, or replies GO to MatchTime on WhatsApp.",
  // ════ END the go-live pages ════

  /** To the organiser, once, when the owner approves (2026-10-01: a short
   *  checklist). Each URL is the organiser's own signed-in link to that
   *  page, so this DM goes to the organiser only. Without billing the one
   *  pricing sentence is "Your first two months are free." (the length comes
   *  from `FREE_PERIOD_MONTHS`, i18n/free-period.ts), never an amount, and
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
    `${firstMonthsFree("en")}.` +
    (p.tip ? `\n\n${p.tip}` : ""),
  /** To the organiser, once, when the owner rejects. MatchTime has left the
   *  group without a word in it (decision 1). */
  sj_dm_rejected: (p: { group: string | null }): string =>
    `Thanks for trying MatchTime. We can't take ${p.group ? `"${p.group}"` : "your group"} on right now, so I've left the group. We'll be in touch if that changes.`,

  // ════ BEGIN approval holds the club: the organiser's setup DM (go-live slice S3, 2026-10-12) ════
  // Sent only while SETUP_HOLD_ENABLED is on. An approved club stays silent
  // in its group until the organiser replies GO, and gets ONE DM composed
  // from these parts (src/lib/club-setup-dm-rules.ts). It replaces both
  // `sj_dm_approved` and the separate learned-setup DM for such a club. No
  // dashes.
  /** Opens the setup DM. */
  sj_dm_ready_head: (p: { club: string; group: string | null }): string =>
    `Good news: ${p.club} is approved. I'm in ${p.group ? `"${p.group}"` : "your group"} and I'm staying quiet there until you tell me to start.`,
  /** The chat was read and nothing is worth telling. `standard`: the club
   *  still runs on the default settings, so "standard setup" is true. */
  sj_dm_ready_nothing: (p: { group: string | null; standard: boolean }): string =>
    `I read the recent messages ${p.group ? `in "${p.group}"` : "in your group"} and found nothing that needs a setting changed, so ${p.standard ? "MatchTime is on its standard setup" : "I changed nothing"}.`,
  /** The chat could not be read: too little of it, or the reading failed. */
  sj_dm_ready_unread: (p: { standard: boolean }): string =>
    `I couldn't read your group's recent messages, so ${p.standard ? "MatchTime is on its standard setup" : "I changed nothing"}. ` +
    "That's fine: check the settings below and reply *GO* when you're happy.",
  /** What "standard setup" means. Only when the club is on it. */
  /** Under "Rolling squad is on" in the setup DM, only while there is no
   *  squad to carry yet (the same rule the group hello uses): otherwise
   *  the organiser reads "whoever played last time is in" with nobody
   *  having played. */
  sj_dm_ready_rolling_first: "For the first game everyone says In once; after that the squad carries over.",
  sj_dm_ready_standard:
    "Standard setup: players say In or Out each week, and a free place is offered to everyone on the bench: the first to say In takes it.",
  sj_dm_ready_settings: (p: { url: string }): string => `⚙️ *Check or change how your group runs:*\n${p.url}`,
  /** The same two lines as in `sj_dm_approved` (a test keeps them the same). */
  sj_dm_ready_schedule: (p: { url: string }): string =>
    `📅 *Your weekly game:* check the day, time and venue, or change them:\n${p.url}`,
  sj_dm_ready_ratings: (p: { url: string }): string =>
    `⭐ *Starting ratings:* give each player a rough score out of 10 so the first teams are fair:\n${p.url}`,
  /** The GO line. `url` is the organiser's signed-in link to /admin/settings.
   *  The GO handler takes GO, GO LIVE, BAŞLA and BASLA in any language; the
   *  Turkish DM asks for BAŞLA. */
  /** `button` is `sj_go_button`, the button's own label. */
  sj_dm_ready_go: (p: { url: string; button: string }): string =>
    `When you're happy, reply *GO* here and I'll introduce myself in the group, or press *${p.button}* on your settings page:\n${p.url}\nUntil then I say nothing in the group.`,
  /** The free period: its length (from `FREE_PERIOD_MONTHS`) and when it starts. */
  sj_dm_ready_free: `${firstMonthsFree("en")}. The free period starts when I go live in the group.`,
  /** `sj_dm_connected` under the hold: only the last paragraph differs. */
  sj_dm_connected_held: (p: { name: string | null; club: string }): string =>
    `Hi${p.name ? ` ${p.name}` : ""}, got it: ${p.club} is connected to this chat.\n` +
    "Next, add me to your football group. Save this number as a contact called MatchTime first, then open the group, tap Add participant and pick MatchTime.\n\n" +
    "*Important: before you confirm, switch on \"Message history\" on that screen.* It sends me your group's recent messages, so I can set MatchTime up the way you already run things.\n\n" +
    "I'll stay quiet in the group until your club is approved, usually within a day, and you've told me to start. I'll message you here after it's approved.",
  /** `sj_dm_in_group` under the hold. */
  sj_dm_in_group_held: (p: { group: string | null }): string =>
    `Thanks, I'm in ${p.group ? `"${p.group}"` : "your group"}. I'll stay quiet there until your club is approved, usually within a day, and you've told me to start. I'll message you here after it's approved.`,
  /** `sj_card_pending` under the hold (for the connect card, slice S5). */
  sj_card_pending_held:
    "Step 3: we're checking your club, usually within a day. MatchTime stays quiet in the group until your club is approved and you tell it to start, and messages you on WhatsApp after it's approved.",
  // ════ END approval holds the club ════

  // ════ BEGIN the setup follow-ups: reminder and admin group step (go-live slices S6 and S7, 2026-10-12) ════
  // For a club that is approved and still setting up. All deterministic,
  // all on the platform channel. No dashes.
  /** The optional admin group step of the setup DM: its own block, right
   *  before the GO line. "My next message" is `sj_dm_ready_admin_command`,
   *  sent as a separate DM straight after, so it can be forwarded whole. */
  sj_dm_ready_admin_group:
    "👥 *Admin group (optional):* if your organisers have their own WhatsApp group, add me to it and send my next message there. Admin messages will then go to that group instead of to you.",
  /** The second DM, on its own: exactly the link command, and nothing
   *  else. No tag: the words "Match Time" address it
   *  (`parseAdminGroupLinkMessage`, admin-channel-rules.ts). */
  sj_dm_ready_admin_command: (p: { code: string }): string => `Match Time admin group ${p.code}`,
  /** The ONE reminder, 24 hours after the setup DM was due. `url` is the
   *  organiser's signed-in link to /admin/settings. Never repeated, and
   *  there is no automatic go-live. */
  sj_dm_reminder: (p: { club: string; group: string | null; url: string }): string =>
    `Just checking: ${p.club} is approved, but I'm still quiet in ${p.group ? `"${p.group}"` : "your group"}. Reply *GO* when you're ready and I'll introduce myself, or check the settings first: ${p.url}\nI won't remind you again.`,
  /** By DM, to an organiser who sent the admin group command in their own
   *  players' group while the club is still setting up. Nothing is posted
   *  in that group. */
  sj_admin_group_players_group:
    "That is your players' group, so it can't be the admin group. Add me to a separate group for the admins and send the message there.",
  // ════ END the setup follow-ups ════

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
  rolling_waiting_header: (p: { count: number }): string => `*Bench (${p.count}):*`,
  rolling_tail_open: (p: { open: number }): string =>
    `${p.open === 1 ? "1 place open" : `${p.open} places open`}: say *IN* to take one.`,
  /** For a club where the organisers pick who plays (slice 2 wires it). */
  rolling_tail_open_organiser: (p: { open: number }): string =>
    `${p.open === 1 ? "1 place open" : `${p.open} places open`}: say *IN* to go on the bench, and the organisers will pick who plays.`,
  rolling_tail_full: "The squad is full. Say *IN* to go on the bench.",
  /** RSQ2: the extra line on the 17:00 post while the deadline is ahead. */
  rolling_deadline_line: (p: { deadline: string }): string =>
    `Drop-out deadline: *${p.deadline}*. Until then, you're in unless you say *OUT*.`,
  /** RSQ2b (2026-10-13): the same line for a game nobody was carried
   *  onto, a rolling club's first with MatchTime. Nobody is in by default
   *  there, so it speaks only to the players on the list. */
  rolling_deadline_line_first: (p: { deadline: string }): string =>
    `Drop-out deadline: *${p.deadline}*. If you're on the list and can't play, say *OUT* before then.`,
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
    /** `benchClause` (squad-count-line.ts), "" with nobody on the bench. */
    bench: string;
  }): string =>
    `Late drop-out: *${p.name}* said OUT for *${p.activityName}* (${p.whenLabel}) at ${p.time}, after the ${p.deadline} deadline. Squad is now ${p.confirmed}/${p.maxPlayers}${p.bench}.`,

  // ── RSQ5: /admin/settings "Weekly routine" and the match page's
  //    "Carry over last squad" button (web). ──
  wr_section_title: "Weekly routine",
  wr_section_lead: "How your squad is put together each week. Each setting stays off until you turn it on.",
  wr_rolling_label: "Rolling squad",
  wr_rolling_blurb: "Everyone who played last time is in again, unless they say OUT.",
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
   *  to say. `deadlineLabel` is the drop-out deadline, `whenLabel` the
   *  kick-off: each is named for what it is (2026-10-15, FNF read the
   *  kick-off in brackets as the deadline). */
  deadline_summary_admin: (p: {
    activityName: string;
    whenLabel: string;
    deadlineLabel: string;
    confirmed: number;
    maxPlayers: number;
    out: string[];
    maybe: string[];
    waiting: string[];
    open: number;
  }): string =>
    [
      `Drop-out deadline (${p.deadlineLabel}) passed for *${p.activityName}*, kick-off ${p.whenLabel}. Squad ${p.confirmed}/${p.maxPlayers}.`,
      `Out this week: ${p.out.length > 0 ? p.out.join(", ") : "nobody"}.`,
      ...(p.maybe.length > 0 ? [`Said maybe: ${p.maybe.join(", ")}.`] : []),
      `On the bench: ${p.waiting.length > 0 ? p.waiting.join(", ") : "nobody"}.`,
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
  wd_publish_label: "List published",
  wd_publish_blurb: "When MatchTime posts the final list in the group.",
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
  wd_err_outside_hours: "Pick a time between 09:00 and 22:30.",
  wd_err_order: "The drop-out deadline has to come before the list is published.",
  wd_err_after_kickoff: "On match day, pick a time before kickoff.",
  // ── Slice 2a: the admin channel (2026-09-30) ──
  // MDs/friday-group-features-plan-2026-09-30.md, sections 2.3 and 5.
  /** L1. Posted in a group linked again after it already had its
   *  introduction (`admin_group_intro`): the intro is said once per club
   *  and group (`hq-intro:<orgId>:<groupId>`). */
  admin_group_linked: (p: { club: string }): string => `✅ Linked as the admin group for *${p.club}*.`,
  /**
   * L1a. MatchTime's introduction in a newly linked admin group (2026-10-15),
   * built by `buildAdminGroupIntro` (admin-group-help.ts), which says which
   * code backs every clause. Each flag is a club setting already resolved:
   * `dow` the one weekday all its active games are on (else null), `tracks`
   * a weekly club tracking IN and OUT, `teamsAt` the effective "Teams ready"
   * time (null when off), `organisersShare` / `mainChatList` who posts the
   * list, `teamsPosted` YES posts the teams in the main chat, `relayRatings`
   * the rating notice organisers mode relays here (badges are not relayed:
   * they post in the players' group for every club, 2026-10-16).
   */
  admin_group_intro: (p: {
    club: string;
    live: boolean;
    dow: number | null;
    tracks: boolean;
    teamsAt: string | null;
    graphics: boolean;
    mom: boolean;
    ratings: boolean;
    organisersShare: boolean;
    mainChatList: boolean;
    teamsPosted: boolean;
    picks: boolean;
    paid: boolean;
    relayRatings: boolean;
  }): string => {
    const days = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
    const what = p.dow != null && days[p.dow] ? days[p.dow] : "games";
    const lines = [`👋 I'm MatchTime, I'll help run *${p.club}*'s ${what}.${p.live ? "" : " Once I'm switched on for the club, this is what I do."}`];
    const does: string[] = [];
    if (p.tracks) does.push(`keep track of who's *IN* and *OUT* in the main chat`);
    if (p.teamsAt) does.push(`build balanced teams here at ${p.teamsAt} on match day for you to check`);
    if (p.graphics) does.push(`make the poster and team sheet`);
    if (p.mom && p.ratings) does.push(`run Man of the Match and ratings after the game`);
    else if (p.mom) does.push(`run Man of the Match after the game`);
    else if (p.ratings) does.push(`run player ratings after the game`);
    if (does.length === 1) lines.push(`I ${does[0]}.`);
    else if (does.length === 2) lines.push(`I ${does[0]} and ${does[1]}.`);
    else if (does.length > 2) lines.push(`I ${does.slice(0, -1).join(", ")}, and ${does[does.length - 1]}.`);
    if (p.organisersShare) lines.push(`The squad list and the teams stay here for you to share with the players.`);
    if (p.mainChatList) {
      lines.push(p.teamsPosted ? `I post the squad list in the main chat, and the teams there once you say *YES* here.` : `I post the squad list in the main chat.`);
    }
    if (p.picks) lines.push(`When a place opens and someone is waiting, I ask here who plays.`);
    if (p.paid) lines.push(`Money collector: answer my list of payment claims here with *PAID ALL*, *PAID 1 3* or *PAID NONE*.`);
    const relay = p.relayRatings ? `, and so does the rating notice, for you to pass on to the players` : ``;
    lines.push(`Notices meant only for the organisers come here instead of by DM${relay}.`);
    lines.push(
      ``,
      p.live
        ? `Nothing I say here goes to the players. Ask me here any time what I can do, in your own words (for example *what can you do?*).`
        : `Nothing I say here goes to the players. Once I'm on, ask me here what I can do, in your own words (for example *what can you do?*).`,
    );
    return lines.join("\n");
  },
  /** L2. A wrong or expired code, from an owner or admin of an approved club. */
  admin_group_bad_code:
    "That code isn't valid any more. Open Settings on the website and press *Link admin group* for a new one.",
  /** L3. The code was sent in the club's own community group. */
  admin_group_main_group: (p: { club: string }): string =>
    `This is *${p.club}*'s main group, so it can't be the admin group. Add me to a separate group for the admins.`,
  /** L4. To the owner, by DM, after MatchTime was removed from the admin group. */
  admin_group_removed_dm: (p: { club: string }): string =>
    `I was removed from *${p.club}*'s admin group, so admin messages now come to you by DM. You can link a group again in Settings.`,
  // ── Squad changes typed in the admin group (2026-10-14) ──
  // src/lib/admin-group-squad-rules.ts. Said only in the admin group.
  /** One change applied: "Done: Shehryar out, Bilal in." */
  ag_sq_done: (p: { items: string }): string => `Done: ${p.items}.`,
  ag_sq_item_in: (p: { name: string }): string => `${p.name} in`,
  ag_sq_item_out: (p: { name: string }): string => `${p.name} out`,
  ag_sq_item_bench: (p: { name: string }): string => `${p.name} on the bench`,
  ag_sq_item_maybe: (p: { name: string }): string => `${p.name} a maybe`,
  /** A change that did not land. */
  ag_sq_failed: (p: { names: string }): string => `I couldn't change ${p.names}. Please check the match page.`,
  /** The admin asked for what the squad already says. */
  ag_sq_nothing: "Nothing to change: the squad already says that.",
  /** A name nobody in the club has, said in passing as coming in (2026-10-15). */
  ag_sq_unknown: (p: { name: string }): string => `I don't know ${p.name} yet. To add them, just ask me in your own words (for example put ${p.name} in).`,
  /** Said to MatchTime, read as about someone else's place, but no one named in it ("@Match Time AH back", 2026-10-19). */
  ag_sq_who: `I couldn't tell who that's about, so I haven't changed anything. To add someone or take them out, just ask me in your own words with their name (for example put Bilal in).`,
  /** The game's list is not set yet: the rolling squad carries over in the morning (2026-10-17). */
  ag_sq_not_set: (p: { when: string; day: string; time: string }): string =>
    `The list for ${p.when} isn't set yet: last week's squad carries over at ${p.time} on ${p.day}. Send it again after that.`,
  /** The sender said in conversation that they are out; nothing is written (2026-10-15). */
  ag_sq_self_hint_out: (p: { name: string; when: string }): string =>
    `If you want me to take you out of ${p.when}, just ask me in your own words (for example ${p.name} out).`,
  /** The sender said in conversation that they are in; nothing is written (2026-10-15). */
  ag_sq_self_hint_in: (p: { name: string; when: string }): string => `If you want me to put you in for ${p.when}, just ask me in your own words (for example ${p.name} in).`,
  /** The count after the change. `bench` is `benchClause` (squad-count-line.ts):
   *  ", 1 on the bench (Uncle Najib)", or "" with nobody on it. */
  ag_sq_count: (p: { confirmed: number; max: number; bench: string }): string => `${p.confirmed} of ${p.max}${p.bench}.`,
  /** The bench in a count line (squad-count-line.ts, FNF 2026-10-18).
   *  `names` empty: the count alone (more than three, or not to be named). */
  sq_bench: (p: { count: number; names: string[] }): string =>
    `${p.count} on the bench${p.names.length > 0 ? ` (${joinList("en", p.names)})` : ""}`,
  /** An organiser-pick club with a place free and someone on the bench:
   *  the admin-group command that brings one in (squad-count-line.ts). */
  sq_pick_hint: (p: { open: number; name: string }): string =>
    `${p.open === 1 ? "A place is free" : `${p.open} places are free`}. Just tell me who should come in from the bench, in your own words (for example ${p.name}).`,
  /** A pasted list: what it would change, then YES. */
  ag_paste_adding: (p: { names: string }): string => `Adding: ${p.names}.`,
  ag_paste_removing: (p: { names: string }): string => `Removing: ${p.names}.`,
  ag_paste_to_bench: (p: { names: string }): string => `To the bench: ${p.names}.`,
  ag_paste_new: (p: { names: string; many: boolean }): string =>
    !p.many
      ? `Unknown names: ${p.names} (not a member yet, I'll add them as a new player).`
      : `Unknown names: ${p.names} (not members yet, I'll add them as new players).`,
  ag_paste_unclear: (p: { names: string }): string => `Not sure who ${p.names} is, so I'll leave them out; use the full name.`,
  ag_paste_cannot_add: (p: { names: string; many: boolean }): string =>
    !p.many ? `I can't add ${p.names} as a player, so I'll leave it out.` : `I can't add ${p.names} as players, so I'll leave them out.`,
  ag_paste_over: (p: { listed: number; max: number }): string =>
    `The list has ${p.listed} names for ${p.max} places, so the last ones go on the bench.`,
  ag_paste_confirm: "Reply YES to apply.",
  ag_paste_same: "That matches the squad, nothing to change.",
  ag_paste_expired: "That list is more than 30 minutes old, so I haven't applied it. Paste it again if it still stands.",
  /** A pasted list with no game to put it on (2026-10-15): the club has a
   *  weekly game, and the nightly cron makes the next one at `time`
   *  (London wall clock of 00:00 UTC). */
  ag_paste_no_game: (p: { time: string }): string =>
    `There's no upcoming game to put this list on yet. MatchTime adds the next game every night at ${p.time} (London time). Paste the list again after that.`,
  /** A pasted list when the club has no active weekly game at all. */
  ag_paste_no_weekly_game:
    "This club has no weekly game set up yet, so there's nothing to put this list on. Add the game under Activities on the website, then paste the list again.",
  // ── Teams proposed and approved in the admin group (2026-10-14) ──
  // src/lib/team-proposal-rules.ts. Said only in the admin group.
  /** The proposal's first line. */
  tp_header_proposed: (p: { kickoff: string; venue: string }): string => `📝 *Proposed teams*: ${p.kickoff} at ${p.venue}`,
  /** The approved teams' first line. */
  tp_header_final: (p: { kickoff: string; venue: string }): string => `✅ *Final teams*: ${p.kickoff} at ${p.venue}`,
  /** After a name whose holder dropped out and nobody has the place yet. */
  tp_note_out: "out, place open",
  /** Confirmed players with no team yet. */
  tp_unseated: (p: { names: string }): string => `Not on a team yet: ${p.names}.`,
  /** How to change them, with two real first names from the teams. */
  tp_how_to_change: (p: { a: string; b: string }): string =>
    `To change them, just tell me in your own words (for example *swap ${p.a} and ${p.b}*, *move ${p.a} to the other team* or *shuffle them again*).`,
  /** The question, when the organisers announce the teams themselves. */
  tp_ask_yes_quiet: "Reply *YES* when they are final. I won't post them in the players' group.",
  /** The question, when MatchTime posts the final teams. */
  tp_ask_yes_post: "Reply *YES* when they are final and I'll post them in the players' group.",
  /** Under the final teams. */
  tp_final_footer: "These are final. You can still ask me for changes in your own words; brand new teams need approving again.",
  /** The answer to YES. */
  tp_final_reply_quiet: "Teams are final.",
  tp_final_reply_posted: "Teams are final. I've posted them in the players' group.",
  tp_no_teams: "There are no teams yet. Just ask me for them in your own words (for example *show me the teams*) and I'll build them.",
  tp_no_match: "There's no upcoming game to build teams for.",
  tp_name_unknown: (p: { name: string }): string => `I can't find ${p.name} in the teams.`,
  tp_name_ambiguous: (p: { name: string; names: string }): string => `${p.name} could be ${p.names}; use the full name.`,
  tp_same_team: (p: { a: string; b: string }): string => `${p.a} and ${p.b} are on the same team, so there's nothing to swap.`,
  /** Kickoff minus 2 hours, teams still not approved. */
  tp_reminder: (p: { kickoff: string }): string =>
    `⏰ The teams for ${p.kickoff} aren't final yet. Ask me to show them, in your own words (for example *show me the teams*), then reply *YES*.`,
  /** After approval, something changed in the teams. */
  tp_change_header: "🔄 *Team change*",
  tp_change_replaced: (p: { to: string; from: string; team: string }): string => `${p.to} replaces ${p.from} on ${p.team}`,
  tp_change_moved: (p: { name: string; team: string }): string => `${p.name} moved to ${p.team}`,
  tp_change_out: (p: { name: string; team: string }): string => `${p.name} is out, ${p.team} has a place open`,
  tp_change_back: (p: { name: string; team: string }): string => `${p.name} is back in on ${p.team}`,
  tp_change_added: (p: { name: string; team: string }): string => `${p.name} added to ${p.team}`,
  tp_change_removed: (p: { name: string; team: string }): string => `${p.name} taken off ${p.team}`,
  /** Under a pasted list's question, when teams were waiting for YES. */
  tp_teams_set_aside: "The teams still need approving: ask me for them again after this, in your own words (for example *show me the teams*).",
  /** Under a team proposal, when a pasted list was waiting for YES. */
  tp_list_superseded: "The list pasted earlier was not applied.",
  /** At "Teams ready" with a short squad (once per match), and the answer
   *  to "teams" when the squad is too short to balance. "of", no slash. */
  tp_short_squad: (p: { kickoff: string; confirmed: number; needed: number }): string =>
    `⚠️ Not enough players to make the teams for ${p.kickoff}: ${p.confirmed} of ${p.needed} in. Add players, then ask me for the teams again.`,
  /** Under a proposal whose sides differ by more than an odd total needs. */
  tp_uneven: (p: { redLabel: string; red: number; yellowLabel: string; yellow: number }): string =>
    `⚠️ The sides are uneven: ${p.redLabel} ${p.red}, ${p.yellowLabel} ${p.yellow}. Tell me who to move to even them, in your own words, or reply *YES* twice to keep them.`,
  /** The answer to the first YES on uneven sides. */
  tp_uneven_confirm: (p: { redLabel: string; red: number; yellowLabel: string; yellow: number }): string =>
    `The sides are uneven: ${p.redLabel} ${p.red}, ${p.yellowLabel} ${p.yellow}. Reply *YES* again to make them final as they are, or first tell me who to move, in your own words.`,
  // Settings: "Teams ready".
  tp_settings_label: "Teams ready",
  tp_settings_blurb: "When MatchTime proposes the teams in your admin group on match day.",
  tp_settings_default: "Not set yet, so this is your club's default.",
  tp_settings_off: "Off",
  tp_settings_saved: "Saved",
  tp_settings_bad_time: "Pick a time, or Off.",
  // Settings: "Quiet hours" (2026-10-16).
  qh_settings_label: "Quiet hours",
  qh_settings_blurb: "The hours when MatchTime holds your club's messages until they end. London time.",
  qh_settings_from: "From",
  qh_settings_to: "To",
  qh_settings_off_note: "Off: nothing waits. MatchTime sends at any hour.",
  qh_settings_saved: "Saved",
  qh_settings_bad_time: "Pick two different times.",
  settings_admin_channel_heading: "Admin messages go to",
  settings_admin_channel_mode_one_person: "One person",
  settings_admin_channel_mode_admin_group: "Admin WhatsApp group",
  settings_admin_channel_mode_each_admin: "Each admin by DM",
  settings_admin_channel_person_label: "Who",
  settings_admin_channel_person_owner: (p: { name: string }): string => `${p.name} (owner)`,
  settings_admin_channel_link_button: "Link admin group",
  settings_admin_channel_link_again: "New code",
  settings_admin_channel_step_code: (p: { code: string }): string => `Keep this page open. Your code: ${p.code}`,
  settings_admin_channel_step_add: "Add MatchTime to your admins' WhatsApp group.",
  settings_admin_channel_step_send: "In that group, send:",
  settings_admin_channel_command: (p: { code: string }): string => `@Match Time admin group ${p.code}`,
  settings_admin_channel_validity: "The code works once and lasts 48 hours.",
  /** Under a code that is on screen: its REAL expiry (2026-10-12). The
   *  code MatchTime sent in the setup DM lasts 7 days, and the Settings
   *  page shows that same code instead of replacing it. `when` is
   *  `longDayTimeLabel`: "Monday 19 October at 12:00". */
  settings_admin_channel_valid_until: (p: { when: string }): string => `The code works once and is valid until ${p.when}.`,
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
    `A place just opened for ${p.kickoffLabel}. Say *IN* to go on the bench, and the organisers will pick who plays.`,
  /** P1 first line: one or more drops (`late`: after the drop-out deadline). */
  pick_lead_drop: (p: { names: string[]; activityName: string; whenLabel: string; late: boolean }): string =>
    `${joinList("en", p.names.map((n) => `*${n}*`))} dropped out of *${p.activityName}* (${p.whenLabel})${p.late ? " after the deadline" : ""}.`,
  /** P1 first line: the deadline summary opens the first round (slice 3). */
  pick_lead_deadline: (p: { activityName: string; whenLabel: string; deadlineLabel: string }): string =>
    `Drop-out deadline (${p.deadlineLabel}) passed for *${p.activityName}*, kick-off ${p.whenLabel}.`,
  /** P1 first line: a place that was never filled. */
  pick_lead_open_place: (p: { open: number; activityName: string; whenLabel: string; confirmed: number; maxPlayers: number }): string =>
    p.open === 1
      ? `There is 1 place open in *${p.activityName}* (${p.whenLabel}), squad ${p.confirmed}/${p.maxPlayers}.`
      : `There are ${p.open} places open in *${p.activityName}* (${p.whenLabel}), squad ${p.confirmed}/${p.maxPlayers}.`,
  /** P1 first line: the open round is replaced only because somebody new
   *  is on the bench (2026-10-15). Names no drop again. */
  pick_lead_bench_update: (p: { activityName: string; whenLabel: string }): string =>
    `The bench for *${p.activityName}* (${p.whenLabel}) has changed.`,
  /** P1: the count, after a drop or deadline lead. */
  pick_places_line: (p: { open: number; confirmed: number; maxPlayers: number }): string =>
    `${p.open === 1 ? "1 place open" : `${p.open} places open`}, squad ${p.confirmed}/${p.maxPlayers}.`,
  pick_waiting_header: "Bench:",
  /** P1: one numbered row. `rating` is the club rating players see, or null. */
  pick_list_row: (p: { n: number; name: string; position: string | null; rating: string | null }): string =>
    `${p.n}. ${p.name} (${p.position ?? "no position"}, ${p.rating ?? "new"})`,
  pick_instructions_dm:
    "Reply with a number or a name to bring someone in, e.g. *2*, or *2 3* for two. Reply *NONE* to leave it open.",
  pick_instructions_group:
    "Reply here with a number, a name or an @tag, e.g. *2*, or *2 3* for two. *NONE* leaves it open.",
  pick_fallback_offer: (p: { when: string }): string =>
    `If nobody picks by ${p.when}, I'll offer the place to the whole bench.`,
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
    `*${p.name}* isn't on the bench. Bring them in anyway? Reply *YES*.`,
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
  pick_list_changed: "The bench has changed since my last message. Here it is again:",
  /** P6 (DM only) */
  pick_not_understood:
    "I couldn't match that to anyone on the bench. Reply with a number from the list (e.g. *2*) or a full name. *NONE* leaves the place open.",
  /** P7 */
  pick_only_k: (p: { k: number; names: string[] }): string =>
    `Only ${p.k} ${p.k === 1 ? "place was" : "places were"} open, so I brought in your first ${p.names.length === 1 ? "pick" : "picks"}: ${joinList("en", p.names.map((n) => `*${n}*`))}.`,
  /** P8 */
  pick_none_ack: "OK, I'll leave the place open. You can still pick from the bench on the match page.",
  /** P11 */
  pick_fallback_offered: (p: { activityName: string }): string =>
    `Nobody picked for *${p.activityName}*, so I've offered the place to the bench: the first to say IN gets it.`,
  /** P11 when more than one place is offered, or fewer places are offered
   *  than are open because fewer people are waiting (2026-10-06).
   *  `offered` is how many went to the waiting list, `stillOpen` how many
   *  places nobody is waiting for. */
  pick_fallback_offered_many: (p: { activityName: string; offered: number; stillOpen: number }): string => {
    if (p.stillOpen === 0) {
      return `Nobody picked for *${p.activityName}*, so I've offered the ${p.offered} open places to the bench: whoever says IN gets one.`;
    }
    const offered = p.offered === 1 ? "1 place" : `${p.offered} places`;
    const left = p.stillOpen === 1 ? "1 more place is" : `${p.stillOpen} more places are`;
    return (
      `Nobody picked for *${p.activityName}*, so I've offered ${offered} to the bench, one for each person waiting: ` +
      `whoever says IN gets one. ${left} still open.`
    );
  },
  /** P12 */
  /** `bench` is `benchClause` (squad-count-line.ts), "" with nobody on it. */
  pick_fallback_left: (p: { activityName: string; confirmed: number; maxPlayers: number; bench: string }): string =>
    `Nobody picked for *${p.activityName}*, so the place stays open. Squad ${p.confirmed}/${p.maxPlayers}${p.bench}.`,
  /** D7: the line at the end of the in-group setup. */
  onb_weekly_routine_tip:
    "Tip: to carry the squad over each week, to pick replacements from the bench yourself, or to get admin messages in your admins' group, open Settings on the website.",

  // ── OPK8: /admin/settings "Weekly routine", who fills an open place. ──
  wr_pick_label: "Who fills an open place",
  wr_pick_blurb: "First to say IN, or the organisers pick from the bench.",
  wr_pick_first_come: "First to say IN",
  wr_pick_organiser: "The organisers pick",
  wr_fallback_label: "If nobody picks in time",
  wr_fallback_offer: "Offer it to the bench",
  wr_fallback_leave: "Leave it open",
  wr_pick_saved: "Saved",

  // ── OPK9: the waiting list on the match page (organiser-pick clubs). ──
  wl_title: (p: { count: number }): string => `Bench (${p.count})`,
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
    "🪑 *Bench is open.* Say *IN* to go on the bench, and the organisers will pick who plays.",
  /** The day-one intro's bench line. */
  bench_intro_line_organiser:
    "🔁  *The bench:* say *IN* to go on the bench. When a place opens, the organisers pick who plays.",
  /** The answer to a recruit ask when the squad is full. */
  full_squad_bench_invite_organiser: (p: { matchName: string; confirmed: number; maxPlayers: number }): string =>
    `*${p.matchName}* is full at ${p.confirmed} of ${p.maxPlayers}, but the bench is open. ` +
    `Say *IN* to go on the bench, and the organisers will pick who plays. 🙏`,
  /** The recruit invite DM's "playing?" line. */
  dm_recruit_invite_play_organiser: "Want to play? Reply *IN* to go on the bench, and the organisers will pick who plays.",
  /** The recruit chase DM. */
  dm_recruit_chase_organiser: (p: { firstName: string | null; count: number; activityName: string; matchWhen: string }): string =>
    `👋 ${p.firstName ?? "there"}, still after ${p.count} ${p.count === 1 ? "player" : "players"} for *${p.activityName}* on ${p.matchWhen}. ` +
    `Reply *IN* to go on the bench and the organisers will pick who plays, or *OUT* and I'll stop asking 🙏`,
  /** The private ack of an IN that went on the waiting list. */
  dm_self_ack_waiting_organiser: (p: { matchName: string; matchWhen: string }): string =>
    `📋 I've put you on the bench for *${p.matchName}* on ${p.matchWhen}. The organisers pick who plays 🙏`,
  /** The web app's "I'm in" toast, from the status the write left
   *  (2026-10-16): "You're in" only for a CONFIRMED row. `organiser`:
   *  `benchPickMode = "organiser"`, so a BENCH is the waiting list. */
  web_attend_toast: (p: { status: "CONFIRMED" | "BENCH"; organiser: boolean }): string =>
    p.status === "CONFIRMED"
      ? "You're in! See you at the match 🎉"
      : p.organiser
        ? "You're on the bench. The organisers pick who plays 🙏"
        : "The squad's full, so you're on the bench. I'll message you if a spot opens 🙏",

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
    players: number;
    price: string;
    perGame: string;
    share: string;
    fee: string;
    feePlus: string;
    mode: "example" | "known" | "split";
  }): string =>
    `💷 *Club fee tip:* MatchTime only charges for the games you play, up to ${p.price} a month. ` +
    `Each game played costs the club at most ${p.perGame}, which is about *${p.share} a player per game* for your ${p.players} players. ` +
    (p.mode === "split"
      ? `When you split the pitch cost, add about ${p.share} to each player's share.`
      : p.mode === "known"
        ? `Your game is ${p.fee} each, so charging *${p.feePlus}* covers it.`
        : `If your game costs ${p.fee} each, charge *${p.feePlus}* and the club fee is covered.`) +
    ` Weeks you don't play cost nothing.`,
  /** The short tip after "Your first two months are free." in `sj_dm_approved`,
   *  only for a club that is billed. */
  sj_dm_approved_tip: (p: {
    players: number;
    price: string;
    perGame: string;
    share: string;
    fee: string;
    feePlus: string;
    split: boolean;
  }): string =>
    `💷 *Club fee tip:* after that MatchTime only charges for the games you play, up to ${p.price} a month for the group, paid by card by whoever collects the match fees. ` +
    `Each game played costs at most ${p.perGame}, about *${p.share} a player per game* with ${p.players} players` +
    (p.split ? `, to add to each player's share of the pitch cost.` : `, so a ${p.fee} game could be charged at *${p.feePlus}*.`),
  billing_page_title: "Club fee",
  billing_state_trial: (p: { date: string; price: string }): string =>
    `Free until ${p.date}. After that you only pay for the games you play, up to ${p.price} a month for the whole group.`,
  billing_state_grace: (p: { date: string }): string =>
    `The free period has ended. MatchTime stops on ${p.date} unless a card is added.`,
  /** Slice P4 (games played): no flat fee. `date` is the next charge, the
   *  morning after the current billing month ends. */
  billing_state_subscribed: (p: { price: string; date: string }): string =>
    `Only the games played are charged, up to ${p.price} a month. Next charge ${p.date}.`,
  /** A card saved inside the free period: nothing is taken until the first
   *  month after it has been charged for its games. */
  billing_state_card_saved: (p: { date: string }): string => `Card saved. Nothing is taken until ${p.date}.`,
  billing_state_nothing_until: (p: { date: string }): string => `Nothing is taken until ${p.date}.`,
  billing_state_subscribed_ending: (p: { date: string }): string =>
    `Billing ends on ${p.date}, after this month is charged for its games.`,
  billing_state_card: (p: { brand: string; last4: string }): string => `Card ${p.brand} ending ${p.last4}.`,
  /** `rest` is the line that follows: the free period's or the monthly one. */
  billing_state_paid_with_other: (p: { holder: string; rest: string }): string =>
    `Paid with ${p.holder}'s card until you put yours on. ${p.rest}`,
  /** `what`: the unpaid month ("for 1 Nov to 30 Nov") or months; `retrying`
   *  only when retries are switched on (Stripe's own, BILLING_STRIPE_RETRIES
   *  on by default, or the cron's, BILLING_CRON_RETRIES=1). */
  billing_state_past_due: (p: { amount: string; from: string; to: string; months: number; retrying: boolean; date: string }): string =>
    (p.amount
      ? p.months > 1
        ? `The ${p.amount} for ${p.months} months of games didn't go through. `
        : `The ${p.amount} for ${p.from} to ${p.to} didn't go through. `
      : `The last payment didn't go through. `) +
    (p.retrying ? `It will be tried again over the next few days. ` : `Update the card and pay it to keep MatchTime running. `) +
    `MatchTime stops on ${p.date} if it can't be taken.`,
  billing_state_paused: "MatchTime is paused. All the data is kept. Add a card to switch it back on.",
  billing_state_paused_unpaid: (p: { amount: string; months: number }): string =>
    `MatchTime is paused because ` +
    (p.amount ? (p.months > 1 ? `${p.amount} for ${p.months} months of games is unpaid. ` : `${p.amount} is unpaid. `) : `a payment is unpaid. `) +
    `All the data is kept. Update the card and pay to switch it back on.`,
  billing_state_paused_stopped: "Billing was stopped, so MatchTime is paused. All the data is kept. Press Keep paying to switch it back on.",
  // Slice P4: the billing page's month box and past months (plan 8.1).
  /** `amount` and `max` are "nothing" when no charge would be made. */
  billing_month_box: (p: {
    from: string;
    to: string;
    played: number;
    scheduled: number;
    upcoming: number;
    amount: string;
    max: string;
    date: string;
  }): string =>
    p.scheduled === 0
      ? `This month (${p.from} to ${p.to}): no games so far, so nothing to pay.`
      : p.upcoming > 0
        ? `This month (${p.from} to ${p.to}): ${p.played} of ${p.scheduled} ${p.scheduled === 1 ? "game" : "games"} played so far, ${p.upcoming} still to come. ` +
          `So far that's ${p.amount}; if every game still to come is played it's ${p.max}. Charged on ${p.date}.`
        : `This month (${p.from} to ${p.to}): ${p.played} of ${p.scheduled} ${p.scheduled === 1 ? "game" : "games"} played. That's ${p.amount}, charged on ${p.date}.`,
  billing_nothing: "nothing",
  billing_past_months: "Past months",
  billing_see_games: "See games",
  billing_receipt: "Receipt",
  /** One past month. `games` is "4 of 5 games", or "" for a month with none. */
  billing_month_line: (p: { from: string; to: string; status: string; games: string; amount: string }): string => {
    const head = `${p.from} to ${p.to}: `;
    const g = p.games ? `${p.games}, ` : "";
    switch (p.status) {
      case "paid":
        return `${head}${g}${p.amount} paid`;
      case "invoiced":
        return `${head}${g}${p.amount} being taken`;
      case "failed":
        return `${head}${g}${p.amount} not paid yet`;
      case "void":
        return `${head}${g}${p.amount} cancelled, nothing to pay`;
      case "no-games":
        return `${head}no games, nothing to pay`;
      case "below-minimum":
        return `${head}${g}under 30p, so nothing to pay`;
      case "no-card":
        return `${head}${g}not charged (no card on file)`;
      case "waived":
        return `${head}nothing to pay`;
      default:
        return `${head}being worked out`;
    }
  },
  billing_month_games: (p: { played: number; scheduled: number }): string =>
    `${p.played} of ${p.scheduled} ${p.scheduled === 1 ? "game" : "games"}`,
  billing_game_outcome: (p: { outcome: string }): string =>
    ({
      played: "played",
      cancelled: "cancelled",
      "nobody-in": "nobody said IN",
      paused: "MatchTime was paused",
      "no-match": "no match",
      "not-completed": "not played",
      upcoming: "still to come",
    })[p.outcome] ?? "not played",
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
  // Stop paying asks first (test mode fix, 2026-10-05). No dashes.
  billing_stop_confirm_title: "Stop paying for MatchTime?",
  /** After the free period: billing ends with the current month (`date`,
   *  the day it is charged), then the club is paused. */
  billing_stop_confirm_month: (p: { date: string }): string =>
    `Billing ends on ${p.date}, after this month is charged for its games. Then MatchTime pauses in the group until someone starts paying again.`,
  /** Inside the free period: the card is removed at once. */
  billing_stop_confirm_free: (p: { date: string }): string =>
    `Your card will be removed now and nothing is charged. The free period carries on until ${p.date}; after that a card is needed to keep MatchTime running.`,
  billing_btn_stop_confirm_yes: "Yes, stop paying",
  billing_btn_stop_confirm_no: "Go back",
  billing_exempt: (p: { club: string }): string => `${p.club} has no club fee. MatchTime is free for this club.`,
  /** The billing page of a club that is approved but still setting up: its
   *  free period starts when it goes live (owner decision 2, 2026-10-12).
   *  No date: there is none yet. */
  billing_exempt_setting_up: (p: { club: string }): string =>
    `${p.club} is still setting up, so its free period has not started yet. ${firstMonthsFree("en")}, counted from the day MatchTime goes live in your group. Nothing is charged before then.`,
  billing_open: "Open billing",
  billing_choose_collector: "Choose a money collector",
  billing_banner_grace: (p: { date: string }): string =>
    `The free period has ended. Add a card before ${p.date} to keep MatchTime running.`,
  /** Slice P4: the unpaid month and its amount, or the total of several. */
  billing_banner_past_due: (p: { amount: string; from: string; to: string; months: number; date: string }): string =>
    (p.amount
      ? p.months > 1
        ? `${p.amount} of club fees for ${p.months} months didn't go through. `
        : `The club fee for ${p.from} to ${p.to} (${p.amount}) didn't go through. `
      : `The last club fee payment didn't go through. `) + `MatchTime stops on ${p.date} if it can't be taken.`,
  billing_banner_paused: "MatchTime is paused for this club. Add a card to switch it back on.",
  billing_banner_paused_unpaid: "MatchTime is paused for this club because a club fee payment is unpaid. It can be paid on the billing page.",
  billing_banner_paused_stopped:
    "MatchTime is paused for this club because billing was stopped. Keep paying on the billing page switches it back on.",
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
  billing_notice_stopped_free: "Done. Your card has been removed and nothing has been charged. The free period carries on until it ends.",
  billing_notice_kept: "Done. MatchTime keeps running, and each month is charged only for the games played.",
  billing_notice_past_due: "A payment is overdue. Update the card and pay it first.",
  /** Slice P3 (games played): saving a card charges nothing; each month is
   *  charged after it ends, for its games. `first`: no month has been
   *  charged yet ("The first charge"), else "The next charge". */
  billing_dm_card_added: (p: {
    name: string | null;
    club: string;
    price: string;
    date: string;
    first: boolean;
    resumed: boolean;
    link: string;
  }): string =>
    `Thanks${p.name ? ` ${p.name}` : ""}, your card is saved. ` +
    (p.resumed
      ? `MatchTime is back on for ${p.club} and picks things up again in the group within a few minutes. Anyone who said IN while it was paused should say it again. `
      : `MatchTime keeps running in the ${p.club} WhatsApp group. `) +
    `Nothing has been taken: after each month I count the games played and charge only for those, up to ${p.price}. ` +
    `${p.first ? "The first" : "The next"} charge is on ${p.date}. You can see each charge and its receipt on your billing page, and change your card or stop there: ${p.link}`,
  billing_dm_card_replaced: (p: { name: string | null; newName: string; club: string }): string =>
    `Hi${p.name ? ` ${p.name}` : ""}, ${p.newName} now pays the MatchTime fee for ${p.club}. Your card has been removed and won't be charged for it again.`,
  /** Review M1: billed again after Free with the contact's own card on file. */
  billing_dm_billed_again_card: (p: { name: string | null; club: string; last4: string; price: string; date: string; link: string }): string =>
    `Hi${p.name ? ` ${p.name}` : ""}, ${p.club} is on the MatchTime plan again and is paid with your card ending ${p.last4}: only the games played, up to ${p.price} a month. ` +
    `The first charge is on ${p.date}. To stop paying or change the card: ${p.link}`,
  /** Review M1: a previous holder's card taken off the club instead of being billed again. */
  billing_dm_card_dropped: (p: { name: string | null; club: string }): string =>
    `Hi${p.name ? ` ${p.name}` : ""}, your card is no longer used for the MatchTime fee for ${p.club} and has been removed. It won't be charged for it again.`,
  billing_dm_resumed: (p: { club: string }): string =>
    `MatchTime is back on for ${p.club}. I'll pick things up again in the group within a few minutes. Anyone who said IN while I was paused should say it again.`,
  billing_dm_plan_billed: (p: { name: string | null; club: string; price: string; date: string; link: string }): string =>
    `Hi${p.name ? ` ${p.name}` : ""}, ${p.club} is on the MatchTime plan again: only the games played, up to ${p.price} a month. ` +
    `The free period has already been used, so MatchTime keeps running in the group until ${p.date}. ` +
    `Add a card before then to keep it going: ${p.link}`,
  // Club fee billing, slice B4: the scheduled card reminders (9 and 2 days
  // before the free period ends, and the day it ends), the pause, the payment problems and the new collector, all by
  // platform DM to the billing contact, plus the admin channel's "no money
  // collector yet" line. No dashes, EN and TR. Plan 7.2, 7.3.
  billing_dm_trial_21: (p: {
    name: string | null;
    club: string;
    date: string;
    price: string;
    firstCharge: string;
    link: string;
    collector: boolean;
  }): string =>
    `Hi${p.name ? ` ${p.name}` : ""}, ${p.club}'s free period on MatchTime ends on ${p.date}. ` +
    (p.collector ? `As the person who collects the match fees, you're the one I'll ask for the card. ` : "") +
    `To keep MatchTime running in the ${p.club} WhatsApp group, add a card here: ${p.link}\n` +
    `After that you only pay for the games you play, up to ${p.price} a month for the whole group, charged after each month ends. ` +
    `Nothing is taken when you add the card; the first charge is on ${p.firstCharge}.`,
  billing_dm_trial_28: (p: { name: string | null; club: string; date: string; price: string; link: string }): string =>
    `Hi${p.name ? ` ${p.name}` : ""}, a quick reminder: ${p.club}'s free period ends on ${p.date}. ` +
    `Add a card to keep MatchTime running in the ${p.club} WhatsApp group: ${p.link}\n` +
    `You only pay for the games you play, up to ${p.price} a month, and nothing is taken when you add the card.`,
  billing_dm_trial_ended: (p: { name: string | null; club: string; date: string; price: string; link: string }): string =>
    `Hi${p.name ? ` ${p.name}` : ""}, ${p.club}'s free period has ended. ` +
    `MatchTime will keep running in the ${p.club} WhatsApp group for one more week, until ${p.date}. ` +
    `Add a card any time before then: ${p.link}\n` +
    `You only pay for the games you play, up to ${p.price} a month, charged after each month ends.`,
  billing_dm_set_collector:
    "Tip: if someone else collects the match fees, make them the money collector in Settings and they'll look after the card instead.",
  /** `amount`: what could not be taken (the unpaid month's charge). The
   *  last sentence says what switches MatchTime back on for that reason. */
  /** `months`: how many unpaid months `amount` (their total) covers. */
  billing_dm_paused: (p: {
    name: string | null;
    club: string;
    amount: string;
    months: number;
    link: string;
    kind: "no-card" | "payment-failed" | "cancelled";
  }): string =>
    (p.kind === "payment-failed"
      ? p.months > 1
        ? `Hi${p.name ? ` ${p.name}` : ""}, we couldn't take the ${p.amount} owed for ${p.months} months of ${p.club}'s games, so MatchTime is now paused. `
        : `Hi${p.name ? ` ${p.name}` : ""}, we couldn't take the ${p.amount} for ${p.club}, so MatchTime is now paused. `
      : p.kind === "cancelled"
        ? `Hi${p.name ? ` ${p.name}` : ""}, you stopped paying for MatchTime for ${p.club}, so it is now paused. The last month was charged only for the games played, as usual. `
        : `Hi${p.name ? ` ${p.name}` : ""}, MatchTime is now paused for ${p.club}. `) +
    `I'm still in the ${p.club} WhatsApp group, but I won't post or reply there, and nothing has been said in the group. ` +
    `The players, matches and stats are all kept. ` +
    (p.kind === "payment-failed"
      ? `To switch MatchTime back on, update the card and pay here, and it restarts within a few minutes: ${p.link}`
      : p.kind === "cancelled"
        ? `To switch MatchTime back on, press Keep paying here and it restarts within a few minutes: ${p.link}`
        : `To switch MatchTime back on, add a card here and it restarts within a few minutes: ${p.link}`),
  /** Slice P3: a month's charge did not go through. `from` and `to` are
   *  the month's first and last day. */
  /** `retrying`: retries are switched on (the cron's, or Stripe's own).
   *  Without them nothing tries again, so the DM says how to pay now. */
  billing_dm_payment_failed: (p: {
    name: string | null;
    club: string;
    amount: string;
    from: string;
    to: string;
    link: string;
    ownCard: boolean;
    retrying: boolean;
  }): string =>
    `Hi${p.name ? ` ${p.name}` : ""}, the ${p.amount} for ${p.club}'s games between ${p.from} and ${p.to} didn't go through. ` +
    (p.retrying
      ? `It will be tried again over the next few days, and MatchTime keeps running meanwhile. ` +
        (p.ownCard ? `To update the card: ${p.link}` : `To put your own card on instead: ${p.link}`)
      : `MatchTime keeps running for now. ` +
        (p.ownCard ? `To pay it now, update the card and pay here: ${p.link}` : `To pay it now with your own card instead: ${p.link}`)),
  billing_dm_payment_action: (p: { name: string | null; club: string; amount: string; from: string; to: string; link: string }): string =>
    `Hi${p.name ? ` ${p.name}` : ""}, your bank wants you to confirm the ${p.amount} for ${p.club}'s games between ${p.from} and ${p.to} before it can go through. ` +
    `Please confirm it here: ${p.link}\nMatchTime keeps running meanwhile.`,
  /** The 3DS DM when the card being charged is NOT the recipient's own
   *  (a collector change still in progress). */
  billing_dm_payment_action_other: (p: {
    name: string | null;
    club: string;
    amount: string;
    from: string;
    to: string;
    link: string;
    billingLink: string;
  }): string =>
    `Hi${p.name ? ` ${p.name}` : ""}, the card on file for ${p.club} needs the bank to confirm the ${p.amount} for the games between ${p.from} and ${p.to} before it can go through. ` +
    `You can confirm and pay it here: ${p.link}\nOr put your own card on instead: ${p.billingLink}\nMatchTime keeps running meanwhile.`,
  billing_dm_payer_changed_card: (p: { name: string | null; club: string; price: string; oldName: string; link: string }): string =>
    `Hi${p.name ? ` ${p.name}` : ""}, you're now the money collector for ${p.club}, so you look after MatchTime's club fee for the ${p.club} WhatsApp group: only the games played, up to ${p.price} a month. ` +
    `${p.oldName}'s card keeps paying until you put yours on, whenever suits you: ${p.link}`,
  billing_dm_payer_changed_no_card: (p: { name: string | null; club: string; price: string; date: string; link: string }): string =>
    `Hi${p.name ? ` ${p.name}` : ""}, you're now the money collector for ${p.club}, so you look after MatchTime's club fee for the ${p.club} WhatsApp group: only the games played, up to ${p.price} a month. ` +
    `Add a card before ${p.date} to keep it running: ${p.link}`,
  billing_dm_payer_changed_paused: (p: { name: string | null; club: string; price: string; link: string }): string =>
    `Hi${p.name ? ` ${p.name}` : ""}, you're now the money collector for ${p.club}, so you look after MatchTime's club fee for the ${p.club} WhatsApp group: only the games played, up to ${p.price} a month. ` +
    `Add a card to switch it back on: ${p.link}`,
  /** Paused because MatchTime was taken out of the group (slice B5): the
   *  way back is adding MatchTime back, not a card. */
  billing_dm_payer_changed_removed: (p: { name: string | null; club: string; price: string; link: string }): string =>
    `Hi${p.name ? ` ${p.name}` : ""}, you're now the money collector for ${p.club}, so you look after MatchTime's club fee for the ${p.club} WhatsApp group: only the games played, up to ${p.price} a month. ` +
    `MatchTime was taken out of the ${p.club} WhatsApp group, so it is paused. To switch it back on, add MatchTime back to the group. The club fee page: ${p.link}`,
  billing_admin_no_collector: (p: { link: string }): string =>
    `Nobody is set as the money collector yet. Choose one in Settings: they'll look after the card for the club fee and get this tip too.${p.link ? ` ${p.link}` : ""}`,
  // Club fee billing, slice P3 (games played): the month's receipt, the
  // first month in a row with no games, and Keep paying. To the billing
  // contact by platform DM, 09:00 to 23:00 London, once each. No dashes,
  // EN and TR. Plan 7.3.
  /** After a month's invoice is PAID: its count and charge. `last4` null
   *  when the card is not known; `ownCard` false when the card on file is
   *  somebody else's (a collector change in progress). */
  billing_dm_month_charged: (p: {
    name: string | null;
    club: string;
    played: number;
    scheduled: number;
    from: string;
    to: string;
    amount: string;
    price: string;
    last4: string | null;
    ownCard: boolean;
    link: string;
  }): string =>
    `Hi${p.name ? ` ${p.name}` : ""}, ${p.club} played ` +
    (p.played === p.scheduled && p.scheduled > 1 ? `all ${p.scheduled} games` : `${p.played} of ${p.scheduled} ${p.scheduled === 1 ? "game" : "games"}`) +
    ` between ${p.from} and ${p.to}, so ${p.amount} was charged to ` +
    (p.ownCard ? "your card" : "the card on file") +
    (p.last4 ? ` ending ${p.last4}` : "") +
    ` (VAT included; a full month is ${p.price}). ` +
    (p.ownCard
      ? `Stripe has emailed you the receipt. Details: ${p.link}`
      : `You can see the month's games and charge on your billing page: ${p.link}`),
  /** A month that played no games: nothing charged. Only the FIRST such
   *  month in a row is told (a summer break sends one). */
  billing_dm_month_free: (p: { name: string | null; club: string; from: string; to: string }): string =>
    `Hi${p.name ? ` ${p.name}` : ""}, ${p.club} played no games between ${p.from} and ${p.to}, so there is nothing to pay for that month. ` +
    `MatchTime only charges for the games you play.`,
  /** Keep paying: Stop paying undone, or (`restarted`) billing started
   *  again after the stop took effect. `date` is the next charge. */
  billing_dm_keep_paying: (p: { name: string | null; club: string; price: string; date: string; restarted: boolean; link: string }): string =>
    `Hi${p.name ? ` ${p.name}` : ""}, ` +
    (p.restarted
      ? `MatchTime is back on for ${p.club} and picks things up again in the group within a few minutes. Anyone who said IN while it was paused should say it again. Each month`
      : `done: MatchTime keeps running in the ${p.club} WhatsApp group and billing carries on. As before, each month`) +
    ` is charged only for the games played, up to ${p.price}, the morning after it ends; the next charge is on ${p.date}. ` +
    `To change your card or stop: ${p.link}`,

  // ── Organiser info buttons (F1, 2026-10-05) ─────────────────────────
  // The ⓘ popups on every organiser page. Each popup is a pair:
  // `info_<key>_title` and `info_<key>_body`, read by
  // `src/components/info/section-info.tsx`. A body may hold several
  // paragraphs separated by a blank line. New copy, house style: no em or
  // en dashes, plain words, and only what the code actually does.

  /** The trigger's accessible name. */
  info_open: (p: { title: string }): string => `What is ${p.title}?`,
  info_close: "Close",

  // /finish-setup: the confidence badge and the "nothing in the chat" note.
  fs_conf_high: "Confident",
  fs_conf_med: "Fairly sure",
  fs_conf_low: "Guess: please check",
  /** Shown instead of the analyser's "No clear signal in chat, defaulting
   *  to neutral" (display side only, no prompt change). */
  fs_evidence_none: "Nothing in the chat about this player, so I've set a neutral starting point.",

  info_fs_players_title: "Proposed players",
  info_fs_players_body:
    "Everyone MatchTime found playing in your group's chat history, each with a guessed position and seed rating. Check them, change anything that's wrong, then press Apply. Nothing is saved until you apply.",
  info_fs_confidence_title: "How sure MatchTime is",
  info_fs_confidence_body:
    "How much the chat told MatchTime about this player's position and seed rating. Confident: the chat said a lot. Fairly sure: some clues. Guess: please check: little or nothing in the chat, so it's a starting guess.\n\n" +
    "It is not a judgement of the player. A guess just means you should check the position and rating yourself.",
  info_fs_position_title: "Position",
  info_fs_position_body:
    "Where this player usually plays. MatchTime uses positions to give both teams a fair mix when it makes teams. Pick None if you're not sure; you can set it later on the Players page.",
  info_fs_seed_title: "Seed rating",
  info_fs_seed_body:
    "Your starting score for this player at this club, from 1 to 10. Teams are balanced on it until players start rating each other after matches; then the real ratings take over bit by bit. Players never see it.",
  info_fs_evidence_title: "Why MatchTime guessed this",
  info_fs_evidence_body:
    "The message or summary from your chat that the guess is based on, so you can judge it. Only admins see it.",
  info_fs_phones_title: "Missing phone numbers",
  info_fs_phones_body:
    "Group members MatchTime has no phone number for. Add one, starting with the country code (for example +44), so they get private messages like rating links and reminders. You can leave any blank.",
  info_fs_schedule_title: "Schedule and format",
  info_fs_schedule_body:
    "Your weekly game as MatchTime read it from the chat. Applying sets the day, kick-off time and venue of your weekly game. Players per side sets the size of your next match.",

  // /admin dashboard
  info_dash_players_title: "Players",
  info_dash_players_body: "Everyone in your club on MatchTime. Players who have left are not counted. Tap to see and edit them.",
  info_dash_activities_title: "Activities",
  info_dash_activities_body:
    "Your regular weekly games, for example Tuesday 7-a-side. MatchTime creates the next match for each active one by itself. Tap to manage them.",
  info_dash_upcoming_title: "Upcoming",
  info_dash_upcoming_body: "Matches not played yet, including ones whose teams are already made.",
  info_dash_completed_title: "Completed",
  info_dash_completed_body:
    "Matches played since MatchTime started running your club. Past matches imported from before are not counted.",
  info_dash_ratings_title: "Rating progress",
  info_dash_ratings_body:
    "Who has rated their teammates after your last match. MatchTime sends each player who played a private rating link; players on the bench are not counted. Pending players haven't rated yet.",
  info_dash_connect_title: "Connecting MatchTime",
  info_dash_connect_body:
    "The steps to get MatchTime into your WhatsApp group: send the code from your phone, add MatchTime to the group, then we check your club, usually within a day. MatchTime says nothing in the group while we check.",

  // /admin/players
  info_pl_list_title: "Players",
  info_pl_list_body:
    "Everyone in your club. Tap a name or a phone number to change it. Tick Include former members to see players who left; their history is kept.",
  info_pl_add_title: "Add a player",
  info_pl_add_body:
    "Add someone who hasn't posted in the group yet. With a phone number MatchTime can message them privately and recognise them in the group. If the number is already on MatchTime, that player is reused rather than added twice.",
  info_pl_seed_title: "Seed rating",
  info_pl_seed_body:
    "Your starting score for a player at this club, from 1 to 10. Teams are balanced on it until players rate each other after matches; then the real ratings take over bit by bit. Players never see it, and another club's seed for the same person is separate.",
  info_pl_club_rating_title: "Club rating",
  info_pl_club_rating_body:
    "The average of the ratings this club's players have given them after matches, the same number they see on their own page. It shows Not rated yet until someone rates them.",
  info_pl_aliases_title: "Aliases",
  info_pl_aliases_body:
    "Other names MatchTime should recognise as this player in the group, like a nickname or their WhatsApp name. It helps when someone writes \"Mo is in\". Tap an alias to remove it.",
  info_pl_merge_title: "Merge",
  info_pl_merge_body:
    "Use Merge when one person has two rows, for example one added by name and one with a phone. Pick the row to keep: their attendance, ratings and messages move to it and the other row is deleted. This can't be undone.",
  info_pl_duplicates_title: "Possible duplicates",
  info_pl_duplicates_body:
    "Someone was added by name, for example when another player wrote that they're in, and a member with a phone number has a matching name. If they're the same person, tap Merge to fold the name-only row into the member with the phone.",
  info_pl_new_title: "New players",
  info_pl_new_body:
    "MatchTime adds people by itself when they post in the group. Check their phone, position and seed rating, then tap Confirm. Tap Remove if they're not a player; their history is kept.",
  info_pl_role_title: "Role",
  info_pl_role_body: "Admins can open these admin pages and manage the club. Players only see their own pages.",

  // /admin/settings
  info_st_general_title: "General",
  info_st_general_body: "Your club's name and web address on MatchTime. They can't be changed here.",
  info_st_invite_title: "Invite link",
  info_st_invite_body:
    "Send this link to someone so they can join your club on the MatchTime website. People who post in your WhatsApp group are added by themselves, so most players don't need it.",
  info_st_features_title: "Bot features",
  info_st_features_body:
    "Each switch turns one part of MatchTime on or off for your club, so you run only what you want. Changes can take a few minutes to reach the group.",
  info_st_weekly_title: "Weekly routine",
  info_st_weekly_body:
    "How your group's week runs: whether the squad carries over, who fills an open place, the weekly deadlines and where MatchTime sends messages meant for admins.",
  info_st_billing_title: "Club fee",
  info_st_billing_body:
    "What MatchTime costs your club. Each month only the games played are charged, never more than the monthly maximum, the morning after the month ends.\n\n" +
    "The money collector looks after the card on the billing page; with no money collector, the owner is asked. Other admins can see it but not change the card.",
  info_st_whatsapp_title: "WhatsApp bot",
  info_st_whatsapp_body:
    "Whether MatchTime is switched on for your WhatsApp group, and which group it is linked to. This is managed by MatchTime and can't be changed here.",

  // /admin/settings: every setting's popup lives in src/lib/settings-info.ts.

  // /admin/activities
  info_act_page_title: "Activities",
  info_act_page_body:
    "An activity is one of your regular weekly games: its day, kick-off time, venue and format. MatchTime creates the next match for every active activity by itself each night.",
  info_act_generate_title: "Generate match",
  info_act_generate_body:
    "Creates the next match for this activity now, instead of waiting for the nightly run. It won't create a second match on the same day.",
  info_act_active_title: "Active or inactive",
  info_act_active_body:
    "Active activities get their matches created by themselves. Deactivate one to stop new matches; matches already created and their history stay.",
  info_act_deadline_title: "Sign-ups close",
  info_act_deadline_body:
    "How many hours before kick-off MatchTime stops chasing for players. Players can still say IN or OUT right up to kick-off.",
  info_act_duration_title: "Match length",
  info_act_duration_body:
    "How long the game lasts. MatchTime counts a game as finished at kick-off plus this many minutes.\n\n" +
    "From then it posts the payment poll (not for a monthly squad), marks the match as played, which starts the rating messages, and an hour later asks the group for the score. A score sent in the group only counts for a game that has finished. A change applies to every game of this activity, including ones already created.",

  // /admin/block-bookings and /admin/matches/bulk
  info_bb_page_title: "Block bookings",
  info_bb_page_body:
    "A block booking matches how you book the pitch: a run of weekly games paid up front, for example 10 Tuesdays. It creates all those matches at once. MatchTime still only posts about the next match.\n\n" +
    "Cancel remaining cancels the block's future matches without posting in the group. Restore cancelled brings them back, also silently. Delete block removes the empty future matches; played matches and anything with data are kept.",
  info_bulk_page_title: "Bulk cancel or restore",
  info_bulk_page_body:
    "For holidays and mistakes. Pick the dates, check the list, then confirm. Cancelling posts nothing in the group unless you tick the announce box. Restoring is always silent.",

  // /admin/matches/[matchId]
  info_cancel_title: "Cancel match",
  info_cancel_body:
    "Use this when a match won't happen. MatchTime posts one cancellation message in the group and nothing else for this match: no reminders, no ratings, no Man of the Match. A cancelled match can be brought back from Bulk cancel or restore.",
  info_switch_title: "Switch format",
  info_switch_body:
    "Use this when the format changes for one week, for example 7-a-side to 5-a-side. The match moves to the other activity, anyone over the new size goes to the bench, and MatchTime posts the new line-up in the group. Only activities of the same sport with a different size are offered.",
  info_teams_page_title: "Team management",
  info_teams_page_body:
    "Generate teams splits the confirmed players into two even sides using club ratings and positions. Regenerate makes fresh teams. Tap two players to swap them, or use the buttons to move a player to the other side or take them off. Swap colours keeps the teams and swaps their names.",
  info_teams_unassigned_title: "Not on a team",
  info_teams_unassigned_body: "Confirmed players who aren't on a team yet, for example a late replacement. Put each one on a side.",
  info_teams_bench_title: "Bench",
  info_teams_bench_body: "Players waiting for a place. Moving one up confirms them for this match and puts them on the side you pick.",
  info_teams_publish_title: "Publish teams",
  info_teams_publish_body: "Marks these teams as final for the match. You can still swap players afterwards.",
  info_teams_score_title: "Match score",
  info_teams_score_body:
    "Enter the final score once the match is over. Saving marks the match as played and updates the Elo of each player on the teams, a strength score at this club based on results.",

  // /admin/clubs (platform owner only)
  info_clubs_waiting_title: "Waiting for you",
  info_clubs_waiting_body:
    "Clubs that added MatchTime to their group and are waiting for your decision. MatchTime stays silent there until you decide. Approve switches it on, says hello in the group and messages the organiser. Reject leaves the group and sends the organiser one polite message.",
  info_clubs_live_title: "Live clubs",
  info_clubs_live_body:
    "Clubs that joined by themselves and that you approved. New clubs have tighter daily limits for their first days. Turn off makes MatchTime leave the group and go silent; nobody is messaged.",
  info_clubs_fee_title: "Club fee",
  info_clubs_fee_body:
    "The club's plan and billing state, this month and last month, who pays, and its AI cost over the last 30 days. Plan sets the monthly maximum. Start free period starts the one free period a club gets.",
  info_clubs_unsolicited_title: "Groups nobody asked MatchTime into",
  info_clubs_unsolicited_body:
    "Groups someone added MatchTime to without a code. MatchTime stays silent there and leaves by itself after 48 hours, or press Leave to go now. Nobody in the group is messaged.",
  info_clubs_rejected_title: "Rejected",
  info_clubs_rejected_body: "Clubs you rejected, newest first. MatchTime left their groups.",
  info_clubs_suspended_title: "Turned off",
  info_clubs_suspended_body: "Live clubs you turned off, newest first. MatchTime left their groups and is silent there.",
  info_clubs_posters_title: "Poster designs",
  info_clubs_posters_body:
    "Every club with its own poster template. Share one and every other club can pick it on its Posters card, drawn with that club's own name and players, the template's brand area covered. Give it a display name without the club's name: other clubs see it. Ask the club before sharing.",
  info_clubs_limits_title: "Today's site limits",
  info_clubs_limits_body:
    "How many sign-up codes, new clubs and group connections the whole site has used today, against the daily caps. They reset at midnight, London time.",

  // /admin/health (platform owner only)
  info_health_status_title: "Current status",
  info_health_status_body:
    "One card per club with MatchTime switched on. All good: nothing open. Worth a look: a warning is open. Needs attention: something serious is open. The last line says when that club's bot last checked in.",
  info_health_alerts_title: "Recent alerts",
  info_health_alerts_body:
    "Everything flagged in the last 30 days. Still happening: seen again at the latest check. Cleared: it stopped. One-off: a single event rather than an ongoing check. Nothing here is sent to your phone or email.",

  // /billing/[orgId]
  info_bill_page_title: "How the club fee works",
  info_bill_page_body:
    "MatchTime charges your club once a month for the games it ran, never more than the monthly maximum. Cancelled games and weeks nobody played are free. The charge is taken the morning after the month ends, VAT included.",
  info_bill_card_title: "Who looks after the card",
  info_bill_card_body:
    "The money collector looks after the card, or the owner when there is no money collector. Saving a card takes no money. Admins can see this page but can't change the card.",
  info_bill_past_title: "Past months",
  info_bill_past_body: "Each finished month with what was charged. See games lists the month's games and whether each one counted.",
  // ── F3, learned setup (2026-10-05): the organiser's one DM and the
  //    /admin/settings panel. See src/lib/setup-learning/. No dashes. ──
  /** Opens the DM when at least one setting was switched. */
  sj_dm_setup_intro: (p: { group: string | null }): string =>
    `I read the recent messages ${p.group ? `in "${p.group}"` : "in your group"} to see how it runs, and set MatchTime up the same way.`,
  /** Opens the DM when nothing was switched but something is worth a look. */
  sj_dm_setup_intro_nothing: (p: { group: string | null }): string =>
    `I read the recent messages ${p.group ? `in "${p.group}"` : "in your group"} to see how it runs. I didn't change any settings, but a few things are worth a look.`,
  /** One switched setting, in the DM and on the settings page. `day` and
   *  `time` are used by the two deadlines only. */
  setup_applied_line: (p: {
    key: "rollingSquad" | "organiserPicks" | "dropOutDeadline" | "listPublish" | "paymentTracking";
    day: string;
    time: string;
  }): string =>
    p.key === "rollingSquad"
      ? `*Rolling squad is on:* whoever played last time is in next time, unless they say OUT.`
      : p.key === "organiserPicks"
        ? `*Organisers pick who fills an open place:* MatchTime asks you first, and only offers the place to the bench if nobody picks in time.`
        : p.key === "dropOutDeadline"
          ? `*Drop-out deadline:* ${p.day} ${p.time}. MatchTime reminds the group before it.`
          : p.key === "listPublish"
            ? `*Final list:* posted in the group on ${p.day} at ${p.time}.`
            : `*Payment tracking is on:* MatchTime keeps track of who has paid and sends a friendly reminder to anyone who hasn't.`,
  sj_dm_setup_from: (p: { quote: string }): string => `From messages like: "${p.quote}"`,
  /** The same line for a quote found in the GROUP DESCRIPTION (slice D3,
   *  2026-10-12): the notice an admin wrote, not a message somebody sent. */
  sj_dm_setup_from_description: (p: { quote: string }): string => `From your group description: "${p.quote}"`,
  sj_dm_setup_undo: (p: { url: string }): string => `Undo or change: ${p.url}`,
  sj_dm_setup_check_head: "Worth a check (I changed nothing here):",
  /** A difference between the chat and what the organiser entered.
   *  `current` and `detected` arrive already worded (a day name, a
   *  time, a venue, a number a side, a language name). "organiserPicks"
   *  is the one habit MatchTime never switches on from the chat: it asks.
   *  The quoted name is wr_pick_organiser, the option on /admin/settings.
   *  "matchFee" (slice D3): what each player pays for a game, in pounds
   *  ("6", "6.50"); `current` is "" when the weekly game has no fee. Never
   *  set by MatchTime: the organiser is asked. */
  setup_suggestion_line: (p: {
    key: "weeklyGameDay" | "weeklyGameTime" | "venue" | "format" | "language" | "matchFee" | "organiserPicks";
    current: string;
    detected: string;
  }): string =>
    p.key === "organiserPicks"
      ? `It looks like the organisers choose who fills an open place. If that's right, switch on "The organisers pick".`
      : p.key === "matchFee"
      ? p.current
        ? `The match fee looks like £${p.detected} a player; your weekly game says £${p.current}.`
        : `The match fee looks like £${p.detected} a player; your weekly game has no fee set.`
      : p.key === "weeklyGameDay"
      ? `The chat talks about games on ${p.detected}; your weekly game is on ${p.current}.`
      : p.key === "weeklyGameTime"
        ? `The chat says kickoff is at ${p.detected}; your weekly game is set for ${p.current}.`
        : p.key === "venue"
          ? `The chat names ${p.detected} as the pitch; your weekly game says ${p.current}.`
          : p.key === "format"
            ? `The chat talks about ${p.detected} a side; your weekly game is ${p.current} a side.`
            : `The chat is mostly in ${p.detected}; MatchTime speaks ${p.current} in this group.`,
  sj_dm_setup_check_link: (p: { url: string }): string => `Change it here: ${p.url}`,
  /** Under the "organisers pick" suggestion: the link to the setting. */
  sj_dm_setup_pick_link: (p: { url: string }): string => `Switch it on here: ${p.url}`,
  /** Under the match fee suggestion: the link to where the fee is entered. */
  sj_dm_setup_fee_link: (p: { url: string }): string => `Set it here: ${p.url}`,
  /** The monthly list pattern, in words: what was seen of it. */
  setup_monthly_pattern: (p: { prepay: boolean; payg: boolean; credits: boolean }): string => {
    const parts = [
      p.prepay ? "regulars sign up and pay for the month" : "regulars sign up for the month",
      ...(p.payg ? ["others pay as they go to fill spaces"] : []),
      ...(p.credits ? ["a game a regular misses becomes credit"] : []),
    ];
    return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
  },
  /** A SUGGESTION only: the learned setup never switches monthly squad
   *  on. "Monthly squad" is `msq_section_title`, the section's name on
   *  /admin/settings (a test keeps the two the same). */
  sj_dm_setup_monthly: (p: { pattern: string; heldPaymentTracking: boolean }): string =>
    `📋 I also noticed a monthly list: ${p.pattern}. MatchTime has a monthly squad mode for groups like this. I haven't switched it on: you can do that in Settings, under Monthly squad, if you want it. Until you do, nothing changed for it` +
    (p.heldPaymentTracking ? `, and I left payment tracking off because it works game by game` : ``) +
    `.`,
  sj_dm_setup_outro: (p: { url: string }): string =>
    `Everything is on your settings page, with the chat messages behind each one: ${p.url}`,
  setup_monthly_label: "Monthly list",
  /** A language's name in this table's language; `key` is the code. */
  setup_lang_name: (p: { key: string }): string => (p.key === "tr" ? "Turkish" : "English"),
  settings_learned_title: "Set up from your group chat",
  settings_learned_lead:
    "MatchTime read the messages WhatsApp shared when it joined your group and set these up to match. Undo any of them in one tap.",
  settings_learned_undo: "Undo",
  settings_learned_undone: "Undone",
  settings_learned_changed_since: "Changed since",
  settings_learned_undo_failed: "Couldn't undo that",
  settings_learned_from: "From messages like",
  /** The same caption for quotes found in the group description. */
  settings_learned_from_description: "From your group description",
  /** The heading of the attention block over the suggestions on
   *  /admin/settings: how many there are. */
  settings_learned_check_count: (p: { count: number }): string =>
    p.count === 1 ? `1 thing to check` : `${p.count} things to check`,
  /** Under that heading: these are suggestions, changed nowhere. */
  settings_learned_check_sub:
    "MatchTime changed nothing for these. Have a look, and change them yourself if the chat is right.",
  /** The button on each suggestion, by kind: it says what it does and
   *  goes where the organiser's DM sends them for that kind. The quoted
   *  name is wr_pick_organiser, the option on /admin/settings. */
  settings_learned_action: (p: {
    key: "weeklyGameDay" | "weeklyGameTime" | "venue" | "format" | "language" | "matchFee" | "organiserPicks";
  }): string =>
    p.key === "organiserPicks"
      ? `Switch on "The organisers pick"`
      : p.key === "matchFee"
        ? `Set the match fee`
      : p.key === "weeklyGameDay"
        ? `Change game day`
        : p.key === "weeklyGameTime"
          ? `Change kickoff time`
          : p.key === "venue"
            ? `Change the pitch`
            : p.key === "format"
              ? `Change players a side`
              : `Change the language`,
  /** The quiet line for a suggestion that no longer stands, because the
   *  club's value changed since the chat was read: what the club has
   *  now. `value` arrives worded (a day name, a time, a venue, a number
   *  a side, a language name; the pick mode as stored), or null when
   *  there is nothing to show. The quoted name is wr_pick_organiser. */
  settings_learned_resolved_line: (p: {
    key: "weeklyGameDay" | "weeklyGameTime" | "venue" | "format" | "language" | "matchFee" | "organiserPicks";
    value: string | null;
  }): string =>
    p.value === null || (p.key === "organiserPicks" && p.value !== "organiser")
      ? `This has changed since the chat was read.`
      : p.key === "matchFee"
        ? p.value === ""
          ? `Your weekly game has no fee set now.`
          : `The match fee is now £${p.value} a player.`
      : p.key === "organiserPicks"
        ? `"The organisers pick" is on.`
        : p.key === "weeklyGameDay"
          ? `Game day is now ${p.value}.`
          : p.key === "weeklyGameTime"
            ? `Kickoff time is now ${p.value}.`
            : p.key === "venue"
              ? `The pitch is now ${p.value}.`
              : p.key === "format"
                ? `Your weekly game is now ${p.value} a side.`
                : `MatchTime now speaks ${p.value} in this group.`,
  /** The name of the list of those lines, for a screen reader. */
  settings_learned_resolved_label: "Already sorted",
  /** Over the patterns the chat showed that MatchTime switched nothing
   *  for. Today that is only the monthly list, which HAS a setting
   *  (Settings, Monthly squad), so this must not say there is none. */
  settings_learned_noted_head: "Noticed, left for you to decide",
  // ── The weekly game's fee per player on /admin/activities (slice D3,
  //    2026-10-12): where the setup reading's fee suggestion sends the
  //    organiser. See src/lib/activity-fee.ts. ──
  act_fee_label: "Fee per player (£), optional",
  act_fee_hint: "What each player pays for one game. Leave it empty if it changes from week to week.",
  act_fee_invalid: "Enter a fee like 6 or 6.50, at most £100.",
  /** Under the fee field, which is switched off, for a game whose pitch
   *  cost is split between who played. */
  act_fee_split: "This game splits the pitch cost between who played, so there is no fixed fee per player.",
  /** On the list, after the day, time and venue. `fee` is "6" or "6.50". */
  act_fee_row: (p: { fee: string }): string => `£${p.fee} a player`,
  // ── Match length and sign-up deadline on /admin/activities (2026-10-15).
  //    See src/lib/activity-timings.ts. ──
  act_duration_label: "Match duration (min)",
  act_duration_invalid: "Match duration must be 20 to 180 minutes.",
  act_deadline_label: "Deadline (h before)",
  act_deadline_invalid: "The deadline must be 1 to 48 hours before kick-off.",
  /** Under the two fields on the edit form. */
  act_timings_hint:
    "A new match length applies to every game of this activity, including ones already created. A new deadline applies to matches created after you save.",
  // ── Monthly squad (2026-10-05, slice 2) ──────────────────────────
  // MDs/monthly-squad-plan-2026-10-05.md, sections 9.1, 9.2 and 4.5.
  // The "Monthly squad" section of /admin/settings (msq_) and the
  // /admin/months page (mth_). Organiser pages only: nothing here is ever
  // posted in a group. No em or en dashes, in either language.
  msq_section_title: "Monthly squad",
  msq_section_lead:
    "For groups where the regulars sign up and pay for the whole month, and pay-as-you-go (PAYG) players fill the gaps. It stays off until you switch it on.",
  msq_mode_label: "How your squad works",
  msq_mode_blurb: "Weekly is how MatchTime works today. Monthly is for a list that runs for the whole month.",
  msq_mode_weekly: "Weekly (who said IN)",
  msq_mode_monthly: "Monthly (regulars pay for the month)",
  msq_rolling_note: "Rolling squad is switched off while your squad is monthly: the month's regulars take its place.",
  msq_months_link: "Open the Months page",
  msq_payg_label: "PAYG price per game (£)",
  msq_payg_blurb: "What a pay-as-you-go player pays for one game. Leave it empty if you don't have a set price.",
  /** Slice 3: what switching to monthly makes MatchTime post. */
  msq_list_note:
    "MatchTime posts each month's list in your group a few days before its first game (see \"List opens\" below), with this month's regulars already on it.",
  msq_opens_label: "List opens",
  msq_opens_blurb: "How many days before the month's first game next month's list opens.",
  msq_opens_unit: "days before the first game",
  msq_credit_label: "Credits",
  msq_credit_blurb: "When a regular who has paid misses a game, do they get a game off next month?",
  msq_credit_any: "Every game a paid regular misses",
  msq_credit_filled: "Only when their place is filled",
  msq_credit_none: "No credits",
  msq_instructions_label: "Payment instructions",
  msq_instructions_blurb: "Your own words on how to pay, shown to players with the amount they owe. Optional.",
  msq_instructions_placeholder: "Bank details are in the group description.",
  msq_save: "Save",
  msq_saved: "Saved",
  msq_switched_monthly: "Monthly squad is on. Rolling squad is off.",
  msq_switched_weekly: "Back to a weekly squad",
  msq_err_price: "Enter a price like 8 or 7.50, up to £100.",
  msq_err_days: "Enter a whole number of days from 1 to 28.",
  msq_err_long: "Keep the payment instructions under 500 characters.",
  /** The same field for a WEEKLY club that collects match fees, under the
   *  Payments section (2026-10-16). Label, placeholder and errors are the
   *  `msq_` ones above. */
  pi_weekly_blurb:
    "Your own words on how to pay the money collector directly, for example bank details. Shown on the pay page and in the pay link and reminders, when players can pay directly. Optional.",
  /** /pay/<match>: the heading over the club's instructions. */
  pi_pay_heading: (p: { collector: string | null }): string => `How to pay ${p.collector ?? "the organiser"}`,

  mth_nav: "Months",
  mth_page_title: "Months",
  mth_page_lead: "The month's list for your monthly squad: regulars, PAYG players, who has paid and credits.",
  mth_no_fixture: "Your club has no active game yet. Add one under Activities first.",
  mth_no_players: "Your club has no players yet. They appear here once they are on your Players page.",
  mth_fixture_games: (p: { games: number; played: number }): string =>
    `Games this month: ${p.games}. Already played: ${p.played}.`,
  mth_empty_title: (p: { month: string }): string => `${p.month} hasn't been started yet`,
  mth_empty_body:
    "You can start it now, even part-way through the month. Paste your current list or tick the players, say who has paid, and add any credits they came into the month with. Games already played count as played for the regulars on the list.",
  mth_paste_label: "Paste your current list",
  mth_paste_hint:
    "Copy this month's list from your group and paste it here. MatchTime ticks the players for you, with their paid marks and PAYG. Nothing is saved until you start the month.",
  mth_paste_button: "Read the list",
  mth_paste_read: (p: { count: number }): string =>
    `Players read from your list: ${p.count}. Check them below before you start the month.`,
  mth_paste_unmatched: (p: { names: string }): string =>
    `Not matched to a player: ${p.names}. Tick them below yourself, or add them on your Players page first.`,
  mth_paste_month: "This list is headed with a different month. Check that it is this month's list.",
  mth_paste_not_list: "That doesn't look like a list. Paste the whole numbered list from your group.",
  mth_games_label: "Games this month",
  mth_played_label: "Already played",
  mth_share_label: "Regular's share per game (£)",
  mth_share_hint: "Optional. With it, MatchTime works out what each regular owes for the month.",
  mth_col_in: "On the list",
  mth_col_slot: "No.",
  mth_col_player: "Player",
  mth_col_type: "Type",
  mth_col_paid: "Paid?",
  mth_col_amount: "Amount paid (£)",
  mth_col_credits: "Credits carried in",
  mth_col_games: "Games",
  mth_col_credits_used: "Credits used",
  mth_col_due: "Due",
  mth_kind_regular: "Regular",
  mth_kind_payg: "PAYG",
  mth_paid_none: "Not paid",
  mth_paid_claimed: "Says paid",
  mth_paid_confirmed: "Paid, confirmed",
  mth_due_unknown: "Not set",
  mth_selected_count: (p: { regulars: number; payg: number }): string => `On the list: ${p.regulars} regulars, ${p.payg} PAYG`,
  mth_nothing_posts: "Starting the month posts nothing in your group.",
  mth_start_button: (p: { month: string }): string => `Start ${p.month}`,
  mth_started: (p: { month: string }): string => `${p.month} is started`,
  mth_status: (p: { status: string }): string =>
    p.status === "open" ? "Sign-up open" : p.status === "priced" ? "Priced" : p.status === "closed" ? "Closed" : "Running",
  mth_started_mid: (p: { played: number }): string =>
    `Started part-way through the month. Games already played then: ${p.played}.`,
  mth_share_line: (p: { amount: string }): string => `Share per game: ${p.amount}`,
  mth_no_share: "No share per game is set yet, so the amounts due are not worked out.",
  mth_paid_amount: (p: { state: string; amount: string }): string => `${p.state} (${p.amount})`,
  mth_start_error: (p: { key: string }): string =>
    p.key === "no-players"
      ? "Tick at least one player."
      : p.key === "bad-games"
        ? "Check the number of games. The games already played can't be more than the games this month."
        : p.key === "bad-share"
          ? "Enter the share as an amount, like 7.50."
          : p.key === "bad-amount"
            ? "Check the amounts paid. Use amounts like 30 or 22.50."
            : p.key === "bad-credits"
              ? "Credits carried in can't be more than the games this month."
              : p.key === "already-started"
                ? "This month has already been started. Reload the page to see it."
                : p.key === "not-monthly"
                  ? "Monthly squad is switched off for your club."
                  : "Couldn't start the month. Please try again.",

  info_st_monthly_title: "Monthly squad",
  info_st_monthly_body:
    "For groups where the regulars sign up and pay for the whole month, and other players pay as they go to fill the gaps. It is off until you switch it on, and nothing changes for your group until then.\n\n" +
    "With it on, a Months page appears in your admin pages. That is where you keep the month's list: who is a regular, who has paid, and any credits.",
  info_mth_page_title: "Months",
  info_mth_page_body:
    "One list a month for each weekly game. Regulars are in every game of the month and pay once. Pay-as-you-go players take the free places and pay per game.\n\n" +
    "You only see this page while Monthly squad is switched on in Settings.",
  info_mth_start_title: "Starting part-way through a month",
  info_mth_start_body:
    "You don't have to wait for the 1st. Tick who is on this month's list, say who has paid and how much, and add any credits they came into the month with.\n\n" +
    "Games already played this month count as played for the regulars you tick, so nobody gets a credit for them. Starting posts nothing in your group.",
  info_mth_paste_title: "Pasting your list",
  info_mth_paste_body:
    "Paste the list as your group writes it: numbered names, (paid) or (Paid £22.50), (PAYG), and a \"Paid but can't play\" section. A paid mark is read as \"Says paid\", never as confirmed.\n\n" +
    "Names are matched to your players. A name that fits nobody, or more than one player, is left for you to tick.",
  info_mth_paid_title: "Paid?",
  info_mth_paid_body:
    "Not paid: nothing is recorded. Says paid: the player says they have paid, but nobody has checked. Paid, confirmed: you know the money arrived.\n\n" +
    "Only choose confirmed for payments you have seen.",
  info_mth_credits_title: "Credits carried in",
  info_mth_credits_body:
    "Games of credit a regular brought into this month, for example for a game they paid for and missed last month. One credit is one game off. At £7.50 a game, one credit makes a 4 game month £22.50 instead of £30.",

  // ── Monthly squad, slice 5 (2026-10-06): the weekly flow ─────────
  // MDs/monthly-squad-plan-2026-10-05.md, sections 5.3, 5.4 and 6.2.
  // Only ever sent for a club on "monthly" with a running month. The
  // list is written the way the group writes it, so a member can copy
  // it, change a line and paste it back, and `monthly-list.ts` reads it:
  // the header and the three section titles are in that reader's
  // vocabulary and must stay in it (`monthly-week-copy.test.ts` pins the
  // round trip). No em or en dashes, in either language.
  /** `month` is the month's name, `when` the match ("Mon 12 Oct, 20:00"). */
  mwk_list_header: (p: { month: string; when: string }): string => `📋 List for ${p.month}: ${p.when}`,
  /** After a regular who has paid, or says so (decision D3). */
  mwk_list_paid: "(paid)",
  mwk_list_cant_play_paid: "Paid but can't play",
  /** Regulars who are out and have NOT paid: never listed as paid. */
  mwk_list_cant_play: "Can't play",
  mwk_list_reserves: "Reserves",
  /** Under the list while places are free. `price` is "£8", or null. */
  mwk_list_open: (p: { open: number; price: string | null }): string =>
    `${p.open} ${p.open === 1 ? "place" : "places"} open${p.price ? `, ${p.price} PAYG` : ""}: say *IN* to take ${p.open === 1 ? "it" : "one"}.`,
  /** The same, for a club whose organisers pick who fills a place. */
  mwk_list_open_organiser: (p: { open: number }): string =>
    `${p.open} ${p.open === 1 ? "place" : "places"} open. Say *IN* to go on the bench, and the organisers will pick who plays.`,
  /** A place opened and nobody is waiting: one line in the group. */
  mwk_pool_group: (p: { open: number; when: string; price: string | null }): string =>
    `🎟 ${p.open} ${p.open === 1 ? "place" : "places"} open for *${p.when}*${p.price ? `, ${p.price} PAYG` : ""}. ` +
    `First to say *IN* ${p.open === 1 ? "gets it" : "gets one"}.`,
  /** To the member who pasted a list with a name that matched nobody. */
  mwk_dm_sender_not_matched: (p: { names: string[] }): string =>
    `📋 I couldn't match ${p.names.join(", ")} on the list you pasted to a player, so I added nobody. ` +
    `To play, say *IN* in the group yourself, or ask an organiser to add them.`,
  /** To a member of the month whose numbered list was not read as the squad list. */
  mwk_dm_sender_not_list: (p: { month: string }): string =>
    `📋 I couldn't read the list you posted as the squad list for ${p.month}, so I changed nothing. ` +
    `If it was the squad list, paste it with its title line ("List for ${p.month}").`,
  /** The same offer, by DM, to each pay-as-you-go player. */
  mwk_pool_dm: (p: { firstName: string | null; activityName: string; when: string; price: string | null }): string =>
    `👋 ${p.firstName ?? "there"}, a place has opened for *${p.activityName}* on ${p.when}${p.price ? `, ${p.price} pay-as-you-go` : ""}.\n\n` +
    `Want it? Reply *IN*. The first to say so plays. Not this time? No need to reply.`,
  /** D4: somebody else's pasted list moved this player out. The undo. */
  mwk_dm_moved_out_paid: (p: { actor: string; activityName: string; when: string }): string =>
    `📋 ${p.actor} moved you to "Paid but can't play" for *${p.activityName}* on ${p.when}.\n\nWrong? Reply *IN* and I'll put you back.`,
  mwk_dm_moved_out: (p: { actor: string; activityName: string; when: string }): string =>
    `📋 ${p.actor} took you off the list for *${p.activityName}* on ${p.when}.\n\nWrong? Reply *IN* and I'll put you back.`,
  /** D4: somebody else's pasted list added this player. The undo. */
  mwk_dm_added: (p: { actor: string; activityName: string; when: string }): string =>
    `📋 ${p.actor} added you to the list for *${p.activityName}* on ${p.when}.\n\nWrong? Reply *OUT* and I'll take you off.`,
  /** To the organisers, at most once a day: an old copy was pasted. */
  mwk_admin_paste_ignored: (p: { actor: string; names: string[]; when: string }): string =>
    `📋 ${p.actor} pasted an older copy of the list for ${p.when}. I left ${p.names.join(", ")} as they were: ` +
    `a pasted list cannot bring back a player who dropped out, or take out somebody else by blanking their line. ` +
    `If the change is right, the player can say so, or you can make it on the match page.`,
  /** To the organisers (or the admin who pasted it): names on a pasted
   *  list that match no player of the month. A paste never creates a
   *  player and never guesses one. */
  mwk_admin_paste_not_added: (p: { actor: string; names: string[]; when: string }): string =>
    `📋 ${p.actor} pasted the list for ${p.when} with ${p.names.join(", ")} on it. I could not match that to a player on this month's list, ` +
    `so I added nobody. A player can say *IN* in the group themselves, or you can add them on the match page.`,
  /** To a non-regular who said IN before the month's regulars were put on
   *  the match, and whose place a regular has taken. */
  mwk_dm_bumped: (p: { firstName: string | null; activityName: string; when: string }): string =>
    `👋 ${p.firstName ?? "there"}, the regulars who have paid for the month have their places for *${p.activityName}* on ${p.when}, ` +
    `so you are on the bench for now. I'll message you if a place opens.`,

  // ── Monthly squad, slice 3 (2026-10-06): the month opens, sign-up ──
  // MDs/monthly-squad-plan-2026-10-05.md, sections 4.1 and 6.2. Only ever
  // sent for a club on "monthly". The list is written the way the group
  // writes it and `monthly-list.ts` reads it back: the header is in that
  // reader's vocabulary and must stay in it (`month-signup-copy.test.ts`
  // pins the round trip). The words a member is told to type ("IN FOR
  // NOVEMBER") are read by `readSignupMessage`, pinned in the same test.
  // No em or en dashes, in either language.
  /** `weekday` is "Monday", `days` the dates of the games: "2, 9, 16". */
  msu_list_header: (p: { month: string; games: number; weekday: string; days: string }): string =>
    `📋 List for ${p.month} (${p.games} ${p.weekday}${p.games === 1 ? "" : "s"}: ${p.days})`,
  /** `prev` is the month the regulars are carried over from. */
  msu_list_carried: (p: { prev: string }): string => `Regulars from ${p.prev} are on already.`,
  msu_list_out: (p: { month: string }): string => `Not in for ${p.month}? Say *OUT FOR ${p.month.toUpperCase()}*.`,
  msu_list_join: (p: { month: string }): string =>
    `Want a place for ${p.month}? Copy the list and add your name, or say *IN FOR ${p.month.toUpperCase()}*.`,
  /** `day` is the date of one of the month's games, as an example. */
  msu_list_payg: (p: { day: number }): string => `Playing some weeks only? Add your name with (PAYG), or (PAYG ${p.day} only).`,
  msu_list_link: (p: { url: string }): string => `Or sign up here: ${p.url}`,
  /** `when` is when sign-up ends: "Tue 27 Oct, 10:00". */
  msu_list_deadline: (p: { when: string }): string => `Names in by ${p.when}. Price and payment details follow once numbers are in.`,
  /** To somebody who asked for a regular place when every one was taken. */
  msu_dm_waiting: (p: { firstName: string | null; month: string; max: number }): string =>
    `👋 ${p.firstName ?? "there"}, all ${p.max} regular places for ${p.month} are taken, so you are waiting for one. ` +
    `The organisers have been told. You can still play pay-as-you-go when a place opens.`,
  /** To somebody who signed up as pay-as-you-go: what that means, and what
   *  happens next. `days` is the dates they named ("9, 23"), or null. */
  msu_dm_payg: (p: { firstName: string | null; month: string; days: string | null }): string =>
    `👋 ${p.firstName ?? "there"}, you are down as pay-as-you-go for ${p.month}${p.days ? `, for the games on ${p.days}` : ""}. ` +
    `You pay per game, only for the games you play. ` +
    (p.days ? `You are on the list for those dates. ` : "") +
    `When a place opens on another week I will message you, and the first to say *IN* gets it.`,
  /** To the organisers, once a month: the regular places are full. */
  msu_admin_waiting: (p: { name: string; month: string; max: number; link: string }): string =>
    `📋 ${p.month} list: all ${p.max} regular places are taken and ${p.name} has asked for one, so they are waiting. ` +
    `To make them a regular anyway, open Months: ${p.link}`,
  /** To the member whose pasted list had other people's names added. */
  msu_dm_paste_others: (p: { names: string[]; month: string }): string =>
    `📋 I read the list you pasted for ${p.month}. A pasted list only signs up the person who pastes it, so I left ${p.names.join(", ")} as they were. ` +
    `They can say *IN FOR ${p.month.toUpperCase()}* themselves, or an organiser can add them on the Months page.`,
  /** To a member who says they have paid and then asks to change their place. */
  msu_dm_locked: (p: { month: string }): string =>
    `📋 You have told me you paid for ${p.month}, so I have not changed your place. Ask an organiser if it needs changing.`,
  /** To a PAYG player who named a date with no game. `days` and `games` are lists of dates. */
  msu_dm_unknown_days: (p: { days: string; month: string; games: string }): string =>
    `📋 There is no game on ${p.days} ${p.month}. The games are on ${p.games}. Say the dates again and I will put them right.`,

  // /admin/months, the sign-up card (organiser page).
  mth_signup_open: (p: { when: string }): string =>
    `Sign-up is open until ${p.when}. The list is posted in your group, and names come in by pasted list, by message or on the sign-up page.`,
  mth_signup_ended: "Sign-up has ended. The weekly list runs this month now. You can still change who is on it here.",
  mth_signup_counts: (p: { regulars: number; max: number; payg: number; waiting: number }): string =>
    `Regulars: ${p.regulars} of ${p.max}. PAYG: ${p.payg}. Waiting for a regular place: ${p.waiting}.`,
  mth_kind_waiting: "Waiting for a regular place",
  mth_payg_days: (p: { days: string }): string => `PAYG on ${p.days}`,
  mth_act_regular: "Make regular",
  mth_act_payg: "Move to PAYG",
  mth_act_remove: "Remove for the month",
  mth_act_error: "That could not be saved. Reload the page and try again.",
  mth_add_label: "Add a player",
  mth_add_regular: "Add as regular",
  mth_add_payg: "Add as PAYG",
  mth_next_month: (p: { month: string }): string => `Next month: ${p.month}`,
  info_mth_signup_title: "Sign-up for the month",
  info_mth_signup_body:
    "MatchTime posts the list in your group a few days before the first game, with this month's regulars on it. Players join by pasting the list with their name added, by typing IN FOR and the month, or on their sign-up page. A pasted list only signs up the person who pastes it.\n\nWhen every regular place is taken, the next person waits and you are told once. You can make them a regular here. A day after the list goes out, sign-up ends and the weekly list takes over.",

  // /month, the player's own sign-up page.
  mmp_title: (p: { month: string }): string => `List for ${p.month}`,
  mmp_games: (p: { games: number; days: string }): string => `${p.games} ${p.games === 1 ? "game" : "games"}: ${p.days}`,
  mmp_none: "Your club has no monthly list open right now.",
  mmp_state: (p: { outcome: string; slot: number | null; days: string | null }): string =>
    p.outcome === "regular"
      ? `You are in for the month${p.slot != null ? `, number ${p.slot} on the list` : ""}.`
      : p.outcome === "waiting"
        ? "Every regular place is taken, so you are waiting for one."
        : p.outcome === "payg"
          ? p.days
            ? `You are pay-as-you-go on ${p.days}.`
            : "You are pay-as-you-go: you play when a place is open."
          : p.outcome === "out"
            ? "You are not on this month's list."
            : "You are not on this month's list yet.",
  mmp_btn_in: "I'm in for the month",
  mmp_btn_payg: "Pay as you go",
  mmp_btn_out: "Not this month",
  mmp_payg_pick: "Playing some weeks only? Tick the games you want, or tick none to be asked when a place opens.",
  mmp_closed: "Sign-up for this month has ended. Ask an organiser to change your place.",
  mmp_locked: "You have said you paid for this month, so your place is not changed here. Ask an organiser.",
  mmp_error: "That could not be saved. Try again.",

  // ── Monthly squad, slice 4 (2026-10-06): price, payments, reminders ─
  // MDs/monthly-squad-plan-2026-10-05.md, sections 4.2 and 4.3. Only ever
  // sent for a club on "monthly". Bank transfer only (D5): MatchTime never
  // asks for or shows account numbers; `instructions` is the club's own
  // free text. "Says paid" is a claim; only the collector confirms (D3).
  // The priced list reads back through `monthly-list.ts` (an amount in
  // brackets is ignored by the reader; "(paid £37.50)" is a paid mark).
  // No em or en dashes, in either language.
  /** `share` is "£7.50", `when` the pay-by date, `collector` a first name or null. */
  mpy_priced_header: (p: { month: string; share: string; when: string; collector: string | null }): string =>
    `📋 List for ${p.month}: ${p.share} a game, pay ${p.collector ?? "the collector"} by ${p.when}`,
  /** `full` is what a regular with no credit pays: "£37.50". */
  mpy_priced_sub: (p: { games: number; full: string }): string =>
    `(${p.games} ${p.games === 1 ? "game" : "games"} = ${p.full}. Credits are already taken off.)`,
  mpy_list_paid_amount: (p: { amount: string }): string => `(paid ${p.amount})`,
  /** The club's own payment instructions, on one line. */
  mpy_priced_instructions: (p: { text: string }): string => `Payment: ${p.text}`,
  mpy_priced_how: 'Paid? Add (paid) after your name and paste the list, or DM me "paid".',
  /** 24 hours before the pay-by date: the count only, as the collector does. */
  mpy_group_reminder: (p: { count: number; month: string; when: string }): string =>
    `💷 ${p.count} still to pay for ${p.month}, by ${p.when}.`,
  /** To one unpaid regular. `kind`: "r1" a day before, "r2" on the day, "late" after it. */
  mpy_dm_reminder: (p: {
    kind: string;
    firstName: string | null;
    month: string;
    amount: string;
    games: number;
    credits: number;
    when: string;
    collector: string | null;
    instructions: string | null;
  }): string =>
    `👋 ${p.firstName ?? "there"}, ` +
    (p.kind === "late"
      ? `${p.amount} for ${p.month} was due by ${p.when}, and I have no payment noted for you.`
      : p.kind === "r2"
        ? `a reminder: ${p.amount} for ${p.month} is due today, by ${p.when}.`
        : `your place for ${p.month} is ${p.amount}, to pay by ${p.when}.`) +
    ` That is ${p.games} ${p.games === 1 ? "game" : "games"}${p.credits > 0 ? `, with ${p.credits} ${p.credits === 1 ? "credit" : "credits"} taken off` : ""}.` +
    ` Please pay ${p.collector ?? "the collector"} by bank transfer.` +
    (p.instructions ? `\n\n${p.instructions}` : "") +
    `\n\nReply *paid* when you have.`,
  /** To a player who said "paid". A claim, never a confirmation. */
  mpy_dm_claim_ack: (p: { firstName: string | null; amount: string | null; month: string; collector: string | null }): string =>
    `✅ ${p.firstName ?? "Thanks"}, noted: you say you have paid${p.amount ? ` ${p.amount}` : ""} for ${p.month}. ` +
    `${p.collector ?? "The collector"} will confirm when it arrives.`,
  /** To the organisers when sign-up ends (or the places fill): set the price. */
  mpy_admin_price_ask: (p: { month: string; regulars: number; payg: number; link: string; tip: string | null }): string =>
    `📋 ${p.month} list: ${p.regulars} ${p.regulars === 1 ? "regular" : "regulars"}, ${p.payg} PAYG so far. Set the price: ${p.link}` +
    (p.tip ? `\n\n${p.tip}` : ""),
  /** The club fee, in month terms. Amounts are labels: "£9.99", "20p", "£1". */
  mpy_fee_tip: (p: { price: string; regulars: number; games: number; perGame: string; perMonth: string }): string =>
    `MatchTime charges the club up to ${p.price} a month, only for games played. For ${p.regulars} regulars and ${p.games} games, ` +
    `adding ${p.perGame} a game (${p.perMonth} for the month) to each regular's share covers it.`,
  /** To the collector, once a day while claims wait. `lines` are "1. Alex £37.50". */
  mpy_digest: (p: { count: number; month: string; lines: string[] }): string =>
    `💷 ${p.count} ${p.count === 1 ? "says" : "say"} they've paid for ${p.month}:\n${p.lines.join("\n")}\n\n` +
    `Reply *PAID ALL*, or *PAID* and the numbers that arrived (PAID 1 3), or *PAID NONE*.`,
  mpy_reply_confirmed: (p: { month: string; names: string[] }): string => `✅ Marked as paid for ${p.month}: ${p.names.join(", ")}.`,
  mpy_reply_declined: (p: { month: string; names: string[] }): string =>
    `Noted: nothing has arrived yet for ${p.month} from ${p.names.join(", ")}. I won't ask about these again. Confirm them on the Months page when the money arrives.`,
  /** `numbers` is "9" or "7, 9". */
  mpy_reply_unknown: (p: { numbers: string; month: string }): string =>
    `I have no "says paid" at number ${p.numbers} on the ${p.month} list, so I marked nobody. Reply *PAID* and the numbers from my last message.`,
  /** A reply to a digest more than two days old. The current list follows it. */
  mpy_reply_stale: "That list is out of date, so I marked nobody.",
  /** After a reply, when ANOTHER month has a list out too. */
  mpy_reply_other_month: (p: { month: string; other: string }): string =>
    `That was for ${p.month}. For ${p.other}, name the month: *PAID ${p.other.toUpperCase()} ALL*, or *PAID ${p.other.toUpperCase()}* and the numbers.`,
  mpy_reply_no_digest: "Nothing is waiting for your word right now. You can confirm payments on the Months page.",
  /** After the pay-by date, to the organisers. */
  mpy_summary_head: (p: { month: string }): string => `📒 ${p.month}: the pay-by date has passed.`,
  mpy_summary_confirmed: (p: { count: number; total: string }): string => `Paid and confirmed: ${p.count} (${p.total}).`,
  /** `names` is a list, or the word for nobody. */
  mpy_summary_claimed: (p: { count: number; names: string }): string => `Says paid, not confirmed: ${p.count} (${p.names}).`,
  mpy_summary_unpaid: (p: { count: number; names: string }): string => `Not paid: ${p.count} (${p.names}).`,
  mpy_summary_venue: (p: { due: string; venue: string }): string => `The month's shares come to ${p.due} against a venue cost of ${p.venue}.`,
  mpy_none: "nobody",

  // /admin/months, pricing and confirming (organiser page).
  mth_price_title: "Price for the month",
  mth_price_share: "Share per game (£)",
  mth_price_concession: "Concession share per game (£), optional",
  mth_price_venue: "Venue cost per game (£), optional",
  mth_price_payby: "Pay by (London time)",
  mth_price_suggest: (p: { amount: string }): string => `Suggested: ${p.amount} a game (the venue cost over your regulars, rounded up to 50p).`,
  mth_price_save: "Set the price",
  mth_price_update: "Update the price",
  mth_price_posts: "MatchTime posts the priced list in your group, and reminds regulars who have not paid before the pay-by date.",
  mth_price_locked: "Somebody has paid, or says so, so the share is locked. You can still move the pay-by date.",
  mth_price_error: (p: { key: string }): string =>
    p.key === "bad-share"
      ? "Enter the share per game as a price like 7.50, up to £100."
      : p.key === "bad-concession"
        ? "Enter the concession share as a price no higher than the share."
        : p.key === "bad-venue"
          ? "Enter the venue cost per game as a price like 90."
          : p.key === "bad-pay-by"
            ? "Choose a pay-by date and time that is still ahead."
            : p.key === "locked"
              ? "Somebody has paid, so the share cannot be changed."
              : "The price could not be saved. Reload the page and try again.",
  mth_payby_line: (p: { when: string }): string => `Pay by ${p.when}.`,
  mth_confirm: "Confirm paid",
  mth_unconfirm: "Undo",
  mth_confirm_error: (p: { key: string }): string =>
    p.key === "not-collector" ? "Only the club's money collector confirms payments." : "That could not be saved. Reload the page and try again.",
  info_mth_price_title: "Price for the month",
  info_mth_price_body:
    "You set the share per game. Each regular owes the share times the games in the month, minus any credits from games they paid for and missed. A concession share is optional.\n\nMatchTime posts the priced list, takes \"paid\" from players as a claim, and reminds regulars who have not paid before the pay-by date. Only the money collector confirms a payment. Payment is by bank transfer: MatchTime never sees the money.",

  // /month, the player's amount.
  mmp_due: (p: { amount: string; games: number; credits: number }): string =>
    `${p.amount} for ${p.games} ${p.games === 1 ? "game" : "games"}${p.credits > 0 ? `, with ${p.credits} ${p.credits === 1 ? "credit" : "credits"} taken off` : ""}.`,
  mmp_payby: (p: { when: string; collector: string | null }): string => `Pay ${p.collector ?? "the collector"} by bank transfer by ${p.when}.`,
  mmp_not_priced: "The price is not set yet.",
  mmp_btn_paid: "I've paid",
  mmp_paid_state: (p: { kind: string }): string =>
    p.kind === "confirmed" ? "Paid, confirmed." : "You have said you paid. The collector confirms when it arrives.",

  // ── Monthly squad, slice 6 (2026-10-06): credits, cancelled weeks, joining
  // and leaving part-way, a share changed after payments, refunds, the
  // month close. MDs/monthly-squad-plan-2026-10-05.md, 4.4, 5.2, 7 and 9.
  mcl_cancel_credit: (p: { count: number }): string =>
    p.count === 1 ? "Regulars get 1 game credit for it." : `Regulars get a game credit for each of the ${p.count} games.`,
  mcl_sum_head: (p: { month: string; games: number }): string =>
    `📒 ${p.month} summary (${p.games} ${p.games === 1 ? "game" : "games"} played)`,
  mcl_sum_regulars: (p: { count: number; confirmed: number; total: string }): string =>
    `Regulars: ${p.count}. Paid and confirmed: ${p.confirmed} (${p.total}).`,
  mcl_sum_claimed: (p: { count: number; names: string }): string => `Says paid, not confirmed: ${p.count} (${p.names}).`,
  mcl_sum_unpaid: (p: { count: number; names: string }): string => `Not paid: ${p.count} (${p.names}).`,
  mcl_sum_owes_more: (p: { names: string }): string => `Paid, and owe more now: ${p.names}.`,
  mcl_sum_owed_back: (p: { names: string }): string => `Paid, with money to come back: ${p.names}.`,
  mcl_sum_payg: (p: { games: number; total: string; paid: number }): string =>
    `PAYG: ${p.games} ${p.games === 1 ? "game" : "games"} played, ${p.total} (${p.paid} paid).`,
  mcl_sum_payg_chase: (p: { count: number; names: string }): string => `PAYG still to chase: ${p.count} (${p.names}).`,
  mcl_sum_payg_none: "PAYG: no games played.",
  mcl_sum_leavers: (p: { names: string }): string => `Left part-way and owed: ${p.names}.`,
  mcl_sum_owed_games: (p: { name: string; games: number }): string => `${p.name} ${p.games} ${p.games === 1 ? "game" : "games"}`,
  mcl_sum_carried: (p: { games: number; names: string }): string =>
    `Credits carried to a later month: ${p.games} ${p.games === 1 ? "game" : "games"} (${p.names}).`,
  mcl_sum_carried_none: "Credits carried to a later month: none.",
  mcl_sum_used: (p: { games: number }): string => `Credits used this month: ${p.games} ${p.games === 1 ? "game" : "games"}.`,
  mcl_sum_page: (p: { link: string }): string => `The full month: ${p.link}`,
  mcl_leaver_notice: (p: { name: string; month: string; games: number; amount: string | null; link: string }): string =>
    `📒 ${p.name} has left ${p.month}'s list after paying. Owed: ${p.games} ${p.games === 1 ? "game" : "games"}${p.amount ? ` (${p.amount})` : ""}.\n` +
    `MatchTime refunds nobody. Give it back your own way, then record it here: ${p.link}`,
  mcl_share_head: (p: { month: string; share: string }): string => `📋 ${p.month}: the share is now ${p.share} a game.`,
  mcl_share_owes: (p: { names: string }): string => `Paid already and now owe more: ${p.names}.`,
  mcl_share_back: (p: { names: string }): string => `Paid already and now have money to come back: ${p.names}.`,
  mcl_share_none: "Nobody who has paid is affected.",
  mcl_share_foot: (p: { link: string }): string => `Nobody's payment was changed. Settle the difference your own way: ${p.link}`,
  mcl_midjoin_dm: (p: { firstName: string | null; month: string; games: number; amount: string | null; collector: string | null }): string =>
    `👋 ${p.firstName ? `${p.firstName}, you` : "You"} are in for the rest of ${p.month}: ${p.games} ${p.games === 1 ? "game" : "games"}` +
    (p.amount ? `, ${p.amount}. Pay ${p.collector ?? "the collector"} by bank transfer, then DM me "paid".` : ". The price follows."),
  mcl_midjoin_admin: (p: { name: string; month: string; games: number; amount: string | null; link: string }): string =>
    `📋 ${p.name} joined ${p.month} part-way: ${p.games} ${p.games === 1 ? "game" : "games"}${p.amount ? `, ${p.amount} to pay` : ""}. ${p.link}`,

  mpy_reply_closed: (p: { month: string; link: string }): string =>
    `${p.month} is closed, so I marked nobody. Confirm a payment that arrived late here: ${p.link}`,
  mth_refund_too_much: "A refund cannot be more than they paid for the month.",
  mcp_title: "Payments to confirm",
  mcp_lead: "You collect the money for this club. Confirm a payment when it arrives, and record a refund when you have given money back. MatchTime moves no money.",
  mcp_link: "Confirm payments and record refunds",
  mcp_none: "No month to show here.",
  mmp_club_pick: "Your clubs:",
  mth_bal_owes: (p: { amount: string }): string => `owes ${p.amount} more`,
  mth_bal_back: (p: { amount: string }): string => `${p.amount} to give back`,
  mth_refunded: (p: { amount: string }): string => `Refunded ${p.amount}`,
  mth_leavers_title: "Left part-way through",
  mth_leavers_lead: "Regulars who paid and are no longer on the month. MatchTime refunds nobody: give the money back your own way, then record it.",
  mth_leaver_owed: (p: { games: number; amount: string | null }): string =>
    `Owed: ${p.games} ${p.games === 1 ? "game" : "games"}${p.amount ? ` (${p.amount})` : ""}`,
  mth_leaver_settled: "Nothing owed",
  mth_refund_label: "Refunded (£)",
  mth_refund_btn: "Record refund",
  mth_refund_error: "That refund could not be recorded. Check the amount and try again.",
  mth_refund_collector_only: "Only the money collector records a refund.",
  mth_share_change_title: "Change the share after payments",
  mth_share_change_lead:
    "Somebody has already paid. If you change the share now, nobody's payment is touched: each paid regular is shown as owing the difference, or having it to come back, for you to settle.",
  mth_share_change_ack: "I understand that payments already made stay as they are.",
  mth_share_change_btn: "Change the share",
  mth_summary_title: "Month summary",
  mth_credits_link: "Credits ledger",
  mth_earlier: (p: { month: string }): string => `Earlier: ${p.month}`,
  mth_back_current: "Back to this month",
  mth_viewing_past: (p: { month: string }): string => `You are looking at ${p.month}.`,

  mcr_title: "Credits",
  mcr_lead: "Every game of credit your regulars hold or have used. A credit is one game off a later month.",
  mcr_back: "Back to Months",
  mcr_add_title: "Add credit",
  mcr_add_player: "Player",
  mcr_add_games: "Games",
  mcr_add_reason: "Reason",
  mcr_add_reason_hint: "For example: missed 5 Oct, before we started here",
  mcr_add_btn: "Add credit",
  mcr_error: (p: { key: string }): string =>
    p.key === "bad-reason"
      ? "Give a reason of 3 to 200 characters."
      : p.key === "bad-games"
        ? "Games must be a whole number from 1 to 10."
        : p.key === "not-a-member"
          ? "Pick a player of your club."
          : p.key === "used"
            ? "That credit has already been used against a month, so it cannot be removed."
            : "That could not be saved. Reload the page and try again.",
  mcr_empty: "No credits yet.",
  mcr_available: (p: { games: number }): string => `${p.games} ${p.games === 1 ? "game" : "games"} available`,
  mcr_col_date: "Date",
  mcr_col_reason: "Why",
  mcr_col_state: "Where it stands",
  mcr_reason: (p: { kind: string; day: string | null }): string => {
    const on = p.day ? ` (${p.day})` : "";
    return p.kind === "missed"
      ? `Paid, could not play${on}`
      : p.kind === "cancelled-week"
        ? `Game called off${on}`
        : p.kind === "left-mid-month"
          ? `Left part-way${on}`
          : p.kind === "carried-in"
            ? `Carried in at the start${on}`
            : `Added by an organiser${on}`;
  },
  mcr_state: (p: { status: string; detail: string | null }): string =>
    p.status === "used"
      ? `Used${p.detail ? ` for ${p.detail}` : ""}`
      : p.status === "removed"
        ? `Removed by an organiser${p.detail ? ` (${p.detail})` : ""}`
        : p.status === "refunded"
          ? `Refunded${p.detail ? ` (${p.detail})` : ""}`
          : p.status === "taken-back"
            ? `Taken back${p.detail ? ` (${p.detail})` : ""}: they played after all, or the game was back on`
            : `Available${p.detail ? ` (${p.detail})` : ""}`,
  mcr_remove_btn: "Remove credit",
  mcr_remove_reason: "Why are you removing it?",
  mcr_remove_confirm: "Remove",
  mcr_cancel: "Cancel",
  info_mcr_title: "Credits",
  info_mcr_body:
    "A credit is one game. A regular earns one when they have paid and cannot play, or when a game is called off. It comes off a later month's amount, oldest first.\n\n" +
    "Add credit is for something MatchTime did not see, such as a game missed before you started here. Remove credit takes back a wrong one. Both ask for a reason. Nothing is deleted: a removed credit stays in the list, and one already used cannot be removed.",

  mmp_away_title: "Games I can't make",
  mmp_away_lead: (p: { kind: string }): string =>
    p.kind === "none"
      ? "Tick the games you will miss. Your place is offered to somebody else for those games."
      : "Tick the games you will miss. Your place is offered to somebody else for those games, and a game you paid for and miss is a credit off a later month.",
  mmp_away_save: "Save",
  mmp_away_saved: "Saved.",
  mmp_away_seeded: (p: { day: string }): string => `${p.day}: the squad is out already. Say OUT in the group, or on the game's page.`,
  mmp_away_none: "No games left to tick this month.",
  mmp_join_rest: (p: { games: number; amount: string | null }): string =>
    `The month is under way. You can still join for the rest of it: ${p.games} ${p.games === 1 ? "game" : "games"}${p.amount ? `, ${p.amount}` : ""}.`,
  mmp_btn_join_rest: "Join for the rest of the month",
  mmp_bal_owes: (p: { amount: string }): string => `What you are asked for went up after you paid: ${p.amount} more to pay.`,
  mmp_bal_back: (p: { amount: string }): string => `What you are asked for went down after you paid: ${p.amount} is yours to come back. The collector settles it.`,

  mwp_title: "This month's list",
  mwp_tag_paid: "Monthly, paid",
  mwp_tag_monthly: "Monthly",
  mwp_tag_payg: "PAYG",
  mwp_cant_paid: "Paid but can't play",
  mwp_cant: "Can't play",
  mwp_open: (p: { open: number }): string => `${p.open} ${p.open === 1 ? "place" : "places"} open`,

  // ── Venue location: the confirm line under a weekly game's venue ────
  // (2026-10-12; /admin/activities, organiser only).
  venue_loc_question: "Is this the right place?",
  venue_loc_low_lead: "We are not sure this is where you play.",
  venue_loc_yes: "Yes",
  venue_loc_change: "Change",
  venue_loc_map: "Open map",
  venue_loc_confirmed: "Place confirmed",
  venue_loc_pin: (p: { coords: string }): string => `Map pin at ${p.coords}`,
  venue_loc_not_found:
    "We couldn't find this place. Add the address or paste a map link so MatchTime knows where you play.",
  venue_loc_add: "Add the place",
  venue_loc_pending: "Looking for this place...",
  venue_loc_input_label: "Address or map link",
  venue_loc_input_placeholder: "e.g. Whiston Road, London E2 8BN",
  venue_loc_input_help:
    "Type a fuller address, or paste a link from Google Maps, Apple Maps, Yandex Maps, Waze or OpenStreetMap. This does not change the venue name your group sees.",
  venue_loc_find: "Find place",
  venue_loc_finding: "Looking...",
  venue_loc_cancel: "Cancel",
  venue_loc_err_not_found: "We couldn't find that. Try a fuller address, with the town or postcode, or paste a map link.",
  venue_loc_err_capped: "That is enough lookups for today. Try again tomorrow.",
  venue_loc_err_link:
    "MatchTime can't read that link. Paste a link that shows the place's coordinates, or a Google Maps link, or type the address.",
  venue_loc_err_w3w: "MatchTime can't read what3words links yet. Paste a Google Maps link or type the address.",
  venue_loc_err_generic: "Something went wrong. Please try again.",
  venue_loc_never: "Add where you play so MatchTime knows the location.",
  venue_loc_failed: "We couldn't check this place just now. Try again later.",
  venue_loc_retry: "Try again",
  venue_loc_retrying: "Checking...",

  // ── Venue suggestions (2026-10-13) ───────────────────────────────────
  // The list of real places under the venue box as the organiser types
  // (components/venue/venue-suggest-input.tsx): /create-org, and the new
  // game, edit game and Change boxes on /admin/activities. Suggestions
  // are a helper, never a gate: the hint says so in plain words.
  //
  // `venue_suggest_powered` is the attribution Google's terms require
  // wherever its predictions are shown without a map.
  venue_suggest_list_label: "Suggested places",
  venue_suggest_count: (p: { count: number }): string =>
    p.count === 1 ? "1 suggestion. Use the arrow keys to choose." : `${p.count} suggestions. Use the arrow keys to choose.`,
  venue_suggest_powered: "Powered by Google",
  venue_suggest_hint: "Pick your venue from the list, or keep what you typed.",
  venue_suggest_privacy: "What you type here is sent to Google to suggest places.",

  // ── "Finish connecting" mode (2026-10-13) ────────────────────────────
  // While an organiser's club is a draft or pending, /admin shows the
  // connect card and nothing else (src/lib/connect-focus.ts). These are
  // the few words around the card; the card's own copy is `sj_card_*`.
  /** Under the club name while there is something to do (a draft). */
  cf_lead_connect:
    "MatchTime can't do anything for your club until it is connected to your WhatsApp group. That is the one thing to do now.",
  /** Under the club name while the club waits for approval. */
  cf_lead_pending:
    "Nothing more for you to do right now. The rest of your club's pages open here as soon as your club is approved.",
  /** Above the card's text. The three steps are the card's own. */
  cf_step: (p: { step: number; total: number }): string => `Step ${p.step} of ${p.total}`,
  /** The one quiet link under the card. */
  cf_edit_link: "Edit club details",
  /** On the two edit pages: the way back, and the two pages. */
  cf_back: "Back to connecting MatchTime",
  cf_edit_tab_club: "Club name and settings",
  cf_edit_tab_game: "Weekly game",

  // ── A group MatchTime cannot post in (2026-10-14) ────────────────────
  // Only admins can send messages in the group (or it is a community's
  // announcements group) and MatchTime is not an admin there, so nothing
  // it posts would be seen. src/lib/group-postability-rules.ts.
  /** To the organiser who added MatchTime to such a group, by DM, while
   *  connecting: the link waits until one of the two ways out is done. */
  gp_connect_admin_only: (p: { group: string | null }): string =>
    `I'm in ${p.group ? `"${p.group}"` : "your group"}, but only admins can send messages there, so MatchTime can't post. ` +
    `Either make MatchTime a group admin (Group info, tap MatchTime, Make group admin), or add MatchTime to the group your players chat in instead. ` +
    `I'll carry on as soon as one of those is done.`,
  /** The same, for a community's announcements group. */
  gp_connect_community: (p: { group: string | null }): string =>
    `I'm in ${p.group ? `"${p.group}"` : "your group"}, which is your community's announcements group. Only admins can send messages there, so MatchTime can't post. ` +
    `Add MatchTime to the community group your players chat in instead (recommended), or make MatchTime an admin of the announcements group. ` +
    `I'll carry on as soon as one of those is done.`,
  /** To a live club's organisers (their admin channel), once per stretch:
   *  the club's group has become one MatchTime cannot post in. */
  gp_live_blocked: (p: { club: string; community: boolean }): string =>
    `MatchTime can't post in ${p.club}'s WhatsApp group any more: ` +
    (p.community ? "it is a community announcements group where only admins can send messages" : "only admins can send messages there") +
    `, and MatchTime is not an admin. Until that changes, match posts, reminders and team sheets will not go out. ` +
    (p.community
      ? "Make MatchTime an admin of that group. "
      : `Make MatchTime a group admin, or turn off "only admins can send messages" in the group settings. `) +
    "MatchTime starts posting again by itself once it can.",
  /** To a club's one person by DM, once per stretch: its admin group has
   *  become one MatchTime cannot post in. */
  gp_admin_group_blocked: (p: { club: string; group: string | null }): string =>
    `MatchTime can't post in ${p.club}'s admin group${p.group ? ` "${p.group}"` : ""} any more: only admins can send messages there. ` +
    `Admin messages will come to you by DM instead until MatchTime is made a group admin there or that setting is turned off.`,

  // ── Who announces the list and teams (2026-10-14, list-announcer.ts) ──
  //   With "The organisers", MatchTime sends the squad to the admin
  //   channel instead of the players' group (organisers-list-copy.ts).
  /** The admin list update's first line. "of", never a slash. */
  oa_header: (p: { activityName: string; whenLabel: string; confirmed: number; maxPlayers: number }): string => {
    const open = Math.max(0, p.maxPlayers - p.confirmed);
    const tail = open === 0 ? "full" : `${open} ${open === 1 ? "space" : "spaces"}`;
    return `📋 *Squad for ${p.activityName}, ${p.whenLabel}*: ${p.confirmed} of ${p.maxPlayers} in, ${tail}.`;
  },
  oa_reason_announce: "The list for this match is open. Players' In and Out are being collected in the group.",
  oa_reason_dropout: (p: { time: string }): string => `The drop-out deadline is today at ${p.time}.`,
  oa_reason_list_published: "This is the final list at your publish time.",
  oa_reason_chase: "Kickoff is getting close and the squad is still short.",
  oa_reason_squad_complete: "The squad is complete.",
  oa_unpaid: (p: { count: number }): string => `💷 ${p.count} still to pay for the last match.`,
  oa_footer: "MatchTime has not posted this in the players' group: you announce the list and the teams.",
  /** Above a player-facing post relayed to the organisers instead of the group. */
  oa_relay_lead: "📋 For the organisers, not posted in the players' group:",
  /** In the players' group, to "who's playing?" when the organisers announce. */
  oa_list_by_organisers: "The organisers will post the list.",
  /** In the players' group, to "show the teams" when the organisers announce. */
  oa_teams_by_organisers: "The organisers will post the teams.",
  /** To the organisers when a slot opens (compose.ts, `slot_opened`):
   *  the players' group hears nothing. "of", never a slash. */
  oa_slot_opened: (p: { outFirstNames: string[]; confirmed: number; maxPlayers: number; kickoffLabel: string; open: number }): string => {
    const names = p.outFirstNames;
    const lead =
      names.length === 0
        ? `A place opened for ${p.kickoffLabel}`
        : `${joinList("en", names)} ${names.length === 1 ? "is" : "are"} out of ${p.kickoffLabel}`;
    const open = `${p.open} ${p.open === 1 ? "place" : "places"} open`;
    return `📋 ${lead}: ${p.confirmed} of ${p.maxPlayers} in, ${open}. MatchTime has not posted this in the players' group.`;
  },
  // ── The "New players to review" notice (provisional-review-copy.ts) ──
  pr_header: (p: { count: number }): string =>
    `✨ *New players to review*: ${p.count} ${p.count === 1 ? "person was" : "people were"} added automatically.`,
  pr_posted: (p: { names: string }): string => `Posted in the group: ${p.names}`,
  pr_listed: (p: { names: string }): string => `Added by name, from a list or someone else's message: ${p.names}`,
  pr_more: (p: { count: number }): string => ` (+${p.count} more)`,
  pr_still_waiting: (p: { count: number }): string => `Still waiting from earlier: ${p.count}`,
  pr_tail_dm: (p: { link: string; url: string }): string =>
    `Tap to review and set phone, position and rating, or remove:\n${p.link}\n\nOr open: ${p.url}`,
  pr_tail_group: (p: { link: string }): string => `Review them and set phone, position and rating, or remove them:\n${p.link}`,
  // ── The seed-rating nudge (2026-10-15, seed-nudge-copy.ts): once per club,
  //    to its admins, when most players likely to play have no seed and the
  //    club has no peer ratings yet. The rule: seed-nudge-rules.ts.
  sn_title: (p: { weekday: string }): string => `⭐ *One thing before ${p.weekday}'s teams*`,
  sn_unknown_all:
    "I don't know anyone's level yet, so for now I'd treat every player the same and the teams could come out lopsided.",
  sn_unknown_most:
    "I don't know most players' level yet, so for now I'd treat them all the same and the teams could come out lopsided.",
  sn_ask_named: (p: { names: string; link: string }): string =>
    `${p.names}: give each player a rough rating from 1 to 10 here:\n${p.link}`,
  sn_ask: (p: { link: string }): string => `Give each player a rough rating from 1 to 10 here:\n${p.link}`,
  sn_never_seen: "Players never see these, they only help me balance the sides.",
  sn_size_week: (p: { count: number; minutes: number }): string =>
    `This week's ${p.count} is enough, about ${p.minutes} minutes.`,
  sn_size_club: (p: { count: number; minutes: number }): string =>
    `That's ${p.count} players without one, about ${p.minutes} minutes.`,
  sn_learn: "After that I learn from the ratings players give each other after every game, so this is only needed once.",
  sn_change_any_time: "You can change them any time on the same page.",
  // ── The standard welcome notices to a club's admins (2026-10-15,
  //    admin-onboarding-rules.ts, which says which code backs each line).
  //    A: "Getting <club> ready", at GO. B: "Teams for <weekday>", once the
  //    squad is first set for the club's first proposed teams.
  ao_ready_title: (p: { club: string }): string => `🧰 *Getting ${p.club} ready*`,
  /** Collect match fees on and no money collector (settings, Payments). */
  ao_ready_collector: (p: { link: string }): string =>
    `💷 Pick your *Money collector* in Settings, so I know who to ask how much each player owes after a match:\n${p.link}`,
  /** The admin group reads a pasted list (admin-group-paste.ts). */
  ao_ready_paste_now: (p: { weekday: string }): string =>
    `📋 Paste the squad list for ${p.weekday}'s game here now. I'll show you what it changes, and *YES* within 30 minutes applies it.`,
  /** No game yet: the nightly fixture run adds it (cron/generate-matches). */
  ao_ready_paste_later: (p: { weekday: string | null }): string =>
    `📋 ${p.weekday ? `${p.weekday}'s game` : "Your next game"} is added overnight. From tomorrow, paste its squad list here: I'll show you what it changes, and *YES* within 30 minutes applies it.`,
  /** `reads`: a weekly club, whose admins' every message is read
   *  (admin-group.ts `readsSquad`). `mainChat`: attendance is on. */
  ao_ready_no_tag: (p: { reads: boolean; mainChat: boolean }): string =>
    (p.reads
      ? `💬 No need to tag me here. I read every message from an admin in this group, so just say what you need in your own words. Your normal chat is fine too, I only act on clear instructions.`
      : `💬 No need to tag me here: just say what you need in your own words. Your normal chat is fine too, I only act on clear instructions.`) +
    (p.mainChat ? ` In the main chat, players say IN or OUT without tagging me, and tag me only to ask me something.` : ``),
  /** By DM (no admin group). */
  ao_ready_main_chat: `💬 In the main chat, players say IN or OUT without tagging me, and tag me only to ask me something.`,
  ao_ready_help_group: `Ask me here any time what I can do, in your own words (for example *what can you do?*).`,
  ao_ready_help_dm: `Message me *help* any time to see what I can do.`,
  ao_teams_title: (p: { weekday: string }): string => `🟥🟦 *Teams for ${p.weekday}*`,
  ao_teams_set: (p: { confirmed: number; max: number; time: string; weekday: string }): string =>
    `The squad is set, ${p.confirmed} of ${p.max}. At ${p.time} on ${p.weekday} I'll build two balanced teams and post them here for you to check.`,
  /** `organisers`: the organisers share the teams (no post in the main
   *  chat); otherwise YES posts them there (team-proposal.ts answerTeamsYes).
   *  Either way the team sheet graphic comes here on YES. */
  ao_teams_approve: (p: { organisers: boolean }): string =>
    p.organisers
      ? `Reply *YES* to make them final, or say *swap*, *move* or *reshuffle* if you want changes. Once they're final I send the team sheet here, a graphic to share with the players, and *team sheet* sends it again any time.`
      : `Reply *YES* to make them final and I'll post them in the main chat, or say *swap*, *move* or *reshuffle* if you want changes.`,
  ao_teams_seed: (p: { anySeeded: boolean; time: string; weekday: string; link: string }): string =>
    `⭐ ${p.anySeeded ? "Most of this squad have no rating yet" : "No one in this squad has a rating yet"}, so the teams could come out lopsided. Before ${p.time} on ${p.weekday}, give each player a rough rating from 1 to 10 here:\n${p.link}\nPlayers never see these.`,
  /** "Hamzah", "Hamzah or Raihan", "Hamzah, Raihan or Ali". */
  sn_names: (p: { names: string[] }): string =>
    p.names.length <= 1 ? (p.names[0] ?? "") : `${p.names.slice(0, -1).join(", ")} or ${p.names[p.names.length - 1]}`,
  /** In the players' group, a bench claim that lost the race, without the
   *  squad count (`bench_claim_too_late` carries one). */
  oa_bench_claim_too_late: (p: { firstName: string }): string =>
    `Thanks ${p.firstName} 🙏 someone got there first. You're still on the bench and first in line if another slot opens.`,
  // /admin/settings, "Weekly routine".
  wr_announce_label: "Who announces the list and teams",
  wr_announce_blurb: "MatchTime posts them in the group, or your organisers do.",
  wr_announce_matchtime: "MatchTime",
  wr_announce_organisers: "The organisers",
  // ── Who chooses Man of the Match (2026-10-18, mom-chooser.ts) ──
  mom_chooser_label: "Man of the Match chosen by",
  mom_chooser_blurb: "The players vote on their rating link, or your organisers pick and tell MatchTime with the score.",
  mom_chooser_players: "Players vote",
  mom_chooser_organisers: "Organisers pick",
  // /admin/settings, the "Posters" card (2026-10-14).
  gp_title: "Posters",
  gp_lead: "The list poster and the team sheet MatchTime sends to your admin group, ready to forward to the players.",
  gp_list_caption: "List poster",
  gp_teams_caption: "Team sheet",
  gp_alt_list: (p: { club: string }): string => `List poster: ${p.club}`,
  gp_alt_teams: (p: { club: string }): string => `Team sheet: ${p.club}`,
  gp_sample_note: "Sample names: your real names show here once enough players are in or the teams are made.",
  gp_preview_loading: "Drawing the preview",
  gp_preview_failed: "The preview could not be drawn. Try again later.",
  gp_design_heading: "Design",
  gp_design_matchtime: "MatchTime design",
  gp_design_own_measured: "Your club's design",
  gp_design_own_background: "Your background",
  gp_design_shared: (p: { n: number }): string => `Shared design ${p.n}`,
  gp_design_in_use: "In use",
  gp_use_label: (p: { name: string }): string => `Use this design: ${p.name}`,
  gp_saved: "Design saved. MatchTime uses it from now on.",
  gp_save_failed: "Could not save. Please try again.",
  gp_upload_heading: "Your own background",
  gp_upload_blurb: "A portrait or square picture (not wider than it is tall), at least 540 by 675 pixels, JPEG, PNG or WebP, up to 4 MB. MatchTime draws its board over it.",
  gp_upload_button: "Upload a background",
  gp_upload_replace: "Upload a new background",
  gp_uploading: "Uploading",
  gp_uploaded: "Background saved and in use.",
  gp_remove: "Remove background",
  gp_removing: "Removing",
  gp_removed: "Background removed.",
  gp_problem_empty: "No picture was chosen.",
  gp_problem_too_large: "That picture is over 4 MB. Please choose a smaller one.",
  gp_problem_bad_type: "That is not a JPEG, PNG or WebP picture.",
  gp_problem_bad_bytes: "That picture could not be read. It may be damaged; please try another.",
  gp_problem_too_small: "That picture is too small. Please use one at least 540 pixels wide and 675 tall.",
  gp_problem_not_portrait: "That picture is wider than it is tall. Please use a portrait one.",
  gp_problem_made_by_matchtime: "Your club's design was made by MatchTime. Ask MatchTime to change it.",
  gp_problem_failed: "Something went wrong. Please try again.",

  // ── /admin/settings: the page's own words (2026-10-15). Were hardcoded
  //    English; every setting's ⓘ is in src/lib/settings-info.ts. ──
  st_loading: "Loading…",
  st_not_found: "Organisation not found.",
  st_general_title: "General",
  st_org_name: "Organisation name",
  st_save_name: "Save name",
  st_saving_name: "Saving...",
  st_name_saved: "Name saved",
  st_name_save_failed: "Couldn't save the name. Please try again.",
  st_name_editable_note: "You can change the name until you add MatchTime to your WhatsApp group.",
  st_name_locked: "The name can no longer be changed here. MatchTime approves a club by its name.",
  st_url_slug: "URL slug",
  st_members: (p: { count: number }): string => `${p.count} members`,
  st_team_names_title: "Team names",
  st_team_names_lead: (p: { first: string; second: string }): string =>
    `What the two sides are called in lineups, score messages and match pages. Leave a field empty to use the default (“${p.first}” and “${p.second}”).`,
  st_first_team: "First team",
  st_second_team: "Second team",
  st_save_team_names: "Save team names",
  st_saving: "Saving…",
  st_team_names_saved: (p: { first: string; second: string }): string => `Teams will be called ${p.first} and ${p.second}`,
  st_team_names_reset: "Back to the default team names",
  st_team_names_failed: "Couldn't save team names",
  st_language_title: "Bot language",
  st_language_lead: "The language MatchTime speaks in this group: its posts in the group, its private messages to players and admins, and the posters.",
  st_language_saved: (p: { language: string }): string => `MatchTime will speak ${p.language} in this group`,
  st_language_failed: "Couldn't save the language",
  st_invite_title: "Invite link",
  st_invite_lead: "Share this link with players to join your organisation.",
  st_copy: "Copy",
  st_invite_copied: "Invite link copied!",
  st_features_title: "Bot features",
  st_features_lead:
    "Turn individual capabilities on or off. A group can run just the bits it wants, e.g. only Man of the Match and player ratings. Changes take effect on the bot's next cycle.",
  st_switch_enable: "Click to enable",
  st_switch_disable: "Click to disable",
  st_feature_on: (p: { label: string }): string => `${p.label} is on`,
  st_feature_off: (p: { label: string }): string => `${p.label} is off`,
  st_save_failed: "Failed",
  st_bank_title: "Money collector's bank",
  st_collector: "Money collector",
  st_choose_member: "Choose a member…",
  st_unnamed: "Unnamed",
  st_collector_help:
    "Gets the “how much per player?” prompt after each match, receives “pay you directly” confirmations, and is whose connected bank the card payouts settle to. Only members with a phone number are listed.",
  st_collector_saved: (p: { name: string }): string => `Money collector set to ${p.name}`,
  st_collector_that_member: "that member",
  st_collector_failed: "Couldn't change collector",
  st_bank_lead:
    "Card payments go straight to the money collector's bank (via Stripe). Connect it once and Stripe handles the rest. (“Pay directly” needs no bank.)",
  st_bank_stripe_help:
    "Stripe will ask you to confirm a few identity details and add your bank account. Choose Individual when asked; the business details are already filled in for you. Takes about 2 minutes.",
  st_bank_connected: "Bank connected, ready to take payments",
  st_bank_not_finished: "Onboarding not finished yet",
  st_manage_bank: "Manage bank and payouts",
  st_disconnect: "Disconnect and start over",
  st_disconnecting: "Disconnecting…",
  st_connect_bank: "Connect bank",
  st_finish_bank: "Finish bank setup",
  st_opening_stripe: "Opening Stripe…",
  st_refresh_status: "Refresh status",
  st_start_over: "Start over",
  st_resetting: "Resetting…",
  st_bank_reset_confirm:
    "Disconnect the current Stripe account so you can connect a fresh one?\n\nThis only clears the link in MatchTime. It won't affect any payments already taken. You'll need to complete bank setup again.",
  st_bank_reset_done: "Disconnected. Tap “Connect bank” to set up a fresh account",
  st_bank_start_failed: "Couldn't start bank connect",
  st_bank_refresh_failed: "Couldn't refresh",
  st_bank_open_failed: "Couldn't open the bank dashboard",
  st_bank_reset_failed: "Couldn't reset",
  st_wa_title: "WhatsApp bot",
  st_wa_enabled: "Enabled",
  st_wa_disabled: "Disabled",
  st_wa_group_id: "WhatsApp group ID",
  st_wa_managed: "Bot configuration is managed server-side. Contact your administrator to enable or reconfigure.",
  // ─── Partner clubs (cross-club ask, slice S1, 2026-10-16) ───────────
  // MDs/cross-club-player-ask-plan-2026-10-16.md, sections 3.1 and 3.2.
  // The settings section and the notice when the platform owner pairs two
  // clubs. Read by src/components/settings/partner-clubs-section.tsx and
  // src/lib/club-partnership.ts.
  pc_paired_notice_asker: (p: { club: string; other: string; link: string }) =>
    `🤝 MatchTime has paired *${p.club}* with *${p.other}*: when you are short of players, MatchTime can ask ${p.other} for one, with their organisers' OK. Nothing happens until both clubs' owners accept. Your owner can accept or decline here: ${p.link}`,
  pc_paired_notice_partner: (p: { club: string; other: string; link: string }) =>
    `🤝 MatchTime has paired *${p.club}* with *${p.other}*: when ${p.other} are short of players, MatchTime can ask your group if anyone can play for them. Your organisers approve each ask first, unless you choose otherwise. Nothing happens until both clubs' owners accept. Your owner can accept or decline here: ${p.link}`,
  pc_section_title: "Partner clubs",
  pc_section_lead:
    "Clubs MatchTime may ask for a player when you are short, and clubs that may ask you. Only the MatchTime team pairs two clubs; each club's owner then accepts.",
  pc_list_label: "Your partner clubs",
  pc_row_we_ask: (p: { other: string }) => `You may ask ${p.other} for players`,
  pc_row_they_ask: (p: { other: string }) => `${p.other} may ask you for players`,
  pc_status_waiting_both: "Waiting for both owners to accept",
  pc_status_waiting_us: "Waiting for your owner to accept",
  pc_status_waiting_them: (p: { other: string }) => `Waiting for ${p.other}'s owner to accept`,
  pc_status_active: "Active",
  pc_status_paused_us: "Paused by you",
  pc_status_paused_them: (p: { other: string }) => `Paused by ${p.other}`,
  pc_accept: "Accept",
  pc_decline: "Decline",
  pc_pause: "Pause",
  pc_resume: "Resume",
  pc_remove: "Remove",
  pc_remove_confirm: (p: { other: string }) =>
    `Remove the partnership with ${p.other}? Only the MatchTime team can pair the two clubs again.`,
  pc_owner_only: "Only your club's owner can accept, decline or remove a partner club.",
  pc_when_label: "Ask partner clubs for players",
  pc_when_off: "Off",
  pc_when_on_request: "When we ask",
  pc_when_auto: "Automatically at a time",
  pc_time_label: "Automatic ask time",
  pc_cutoff_label: "Last ask before kickoff",
  pc_cutoff_hours: (p: { hours: number }) => (p.hours === 1 ? "1 hour" : `${p.hours} hours`),
  pc_approval_label: "Asks from partner clubs",
  pc_approval_each: "Ask our organisers each time",
  pc_approval_standing: "Post without asking",
  pc_saved: "Saved",
  pc_save_failed: "Couldn't save",
  pc_refused: "That can't be done now. Reload the page and try again.",
  // ─── Asking a partner club for a player (slice S2, 2026-10-16) ──────
  // MDs/cross-club-player-ask-plan-2026-10-16.md, sections 3.3 to 3.5.
  // Read by src/lib/partner-ask.ts, the match page's partner panel and
  // the approve page. The post and the partner's notices are in the
  // PARTNER club's language; the asking club's notices in its own.
  xask_post: (p: { asker: string; places: number; day: string; venue: string; format: string | null; fee: string | null }) => {
    const extras = [p.format, p.fee].filter(Boolean).join(", ");
    return (
      `⚽ *${p.asker}* need ${p.places === 1 ? "1 player" : `${p.places} players`}: ${p.day} at ${p.venue}${extras ? ` (${extras})` : ""}.\n` +
      `Fancy a game? *Reply to this message* with *IN* and their organisers will confirm by private message.`
    );
  },
  xask_approval_notice: (p: {
    asker: string;
    places: number;
    day: string;
    venue: string;
    format: string | null;
    fee: string | null;
    own: { confirmed: number; max: number } | null;
    link: string;
    inGroup: boolean;
  }) => {
    const extras = [p.format, p.fee].filter(Boolean).join(", ");
    const who = p.places === 1 ? "one of your players" : `${p.places} of your players`;
    const own = p.own ? ` Your own game that day is ${p.own.confirmed} of ${p.own.max}.` : "";
    const how = p.inGroup
      ? `Reply YES to this message${p.link ? `, or open ${p.link}` : ""}.`
      : `Tap to say yes or no: ${p.link}`;
    return `🤝 *${p.asker}* ask if ${who} can play for them: ${p.day} at ${p.venue}${extras ? ` (${extras})` : ""}.${own}\nOK to post this in your players' group? ${how}`;
  },
  xask_posted_notice_partner: (p: { asker: string; day: string; venue: string }) =>
    `🤝 I've posted *${p.asker}*'s ask for a player in your players' group: ${p.day} at ${p.venue}. Your club lets asks from ${p.asker} through without asking first.`,
  xask_approved_notice_asker: (p: { partner: string; day: string }) =>
    `✅ *${p.partner}* said yes: I've asked their players' group for a player for ${p.day}. Anyone who replies IN goes on your bench marked (${p.partner}).`,
  xask_declined_notice_asker: (p: { partner: string; day: string }) =>
    `*${p.partner}*'s organisers said no to asking their group for ${p.day}.`,
  xask_expired_notice_asker: (p: { partner: string; day: string }) =>
    `*${p.partner}*'s organisers didn't answer in time, so I didn't ask their group for ${p.day}.`,
  xask_nobody_notice_asker: (p: { partner: string; day: string }) => `Nobody from *${p.partner}* took the place for ${p.day}.`,
  xask_no_post_id_notice_asker: (p: { partner: string }) =>
    `⚠️ I can't confirm your ask reached *${p.partner}*'s group, so replies to it may not reach you. Check with their organisers if you still need a player.`,
  xask_filled_line: (p: { asker: string }) => `✅ *${p.asker}*'s place is filled, thanks all 🙌`,
  xask_off_line: (p: { asker: string; day: string }) => `*${p.asker}*'s ask for ${p.day} is closed now, thanks all.`,
  hq_confirm_partner_ask: (p: { asker: string; day: string }) =>
    `Is that YES to posting *${p.asker}*'s ask for ${p.day} in your players' group?`,
  xask_hq_approved: (p: { asker: string }) => `Done: *${p.asker}*'s ask is in your players' group now.`,
  xask_hq_not_posted: (p: { asker: string }) =>
    `I didn't post *${p.asker}*'s ask: it has closed, its place is filled, or it is too late for it now.`,
  xask_refused_too_late: (p: { hours: number }) =>
    `Too late to ask a partner club now: the last ask goes out ${p.hours === 1 ? "1 hour" : `${p.hours} hours`} before kickoff (your setting).`,
  xask_refused_daily_cap: (p: { partner: string }) => `${p.partner} have had two asks today already.`,
  xask_refused_already_open: (p: { partner: string }) => `There's already an ask to ${p.partner} open for this game.`,
  xask_refused_no_places: "No place is open in this game.",
  xask_refused_off: "Asking partner clubs is off in your settings.",
  xask_refused_unreachable: (p: { partner: string }) => `${p.partner}'s group can't be asked right now.`,
  xask_refused_generic: "That can't be asked now. Reload the page and try again.",
  xask_panel_title: "Ask a partner club",
  xask_panel_lead: "Short of players? MatchTime can ask a partner club's players' group. Anyone who replies IN goes on your bench.",
  xask_ask_button: (p: { partner: string }) => `Ask ${p.partner} for a player`,
  xask_status_awaiting: (p: { partner: string }) => `Waiting for ${p.partner}'s organisers to say yes`,
  xask_status_posted: (p: { partner: string; volunteers: number }) =>
    `Asked in ${p.partner}'s group${p.volunteers > 0 ? `: ${p.volunteers === 1 ? "1 player" : `${p.volunteers} players`} replied` : ""}`,
  xask_asked_toast: (p: { partner: string }) => `Asked ${p.partner}'s organisers`,
  xask_posted_toast: (p: { partner: string }) => `Posted in ${p.partner}'s group`,
  xask_page_title: "A partner club asks for a player",
  xask_page_summary: (p: { asker: string; places: number; day: string; venue: string; format: string | null; fee: string | null }) => {
    const extras = [p.format, p.fee].filter(Boolean).join(", ");
    return `${p.asker} ask if ${p.places === 1 ? "one of your players" : `${p.places} of your players`} can play for them: ${p.day} at ${p.venue}${extras ? ` (${extras})` : ""}.`;
  },
  xask_page_own: (p: { confirmed: number; max: number }) => `Your own game that day is ${p.confirmed} of ${p.max}.`,
  xask_page_how: "If you say yes, MatchTime posts the ask in your players' group. Players answer by replying to it with IN; a plain IN still means your own game.",
  xask_page_approve: "Yes, post it in our group",
  xask_page_decline: "No thanks",
  xask_page_posted: "Posted in your players' group.",
  xask_page_declined: "Thanks. They've been told.",
  xask_page_closed: "This ask is closed now.",
  xask_page_not_allowed: "Only an owner or admin of the club that was asked can answer this.",
  // ─── The automatic ask and the organisers' line (slice S5) ──────────
  xask_auto_notice_asker: (p: { partner: string; day: string; posted: boolean }) =>
    p.posted
      ? `🤝 Your automatic ask: a place is still open for ${p.day} and nobody is on your bench, so I've posted an ask in *${p.partner}*'s group.`
      : `🤝 Your automatic ask: a place is still open for ${p.day} and nobody is on your bench, so I've asked *${p.partner}*'s organisers if one of their players can play.`,
  xask_offer_line: (p: { partners: string; link: string }) => `🤝 Want me to ask ${p.partners} for a player? Open the match page: ${p.link}`,
  // ─── Volunteers for a partner club's ask (slice S3, 2026-10-16) ─────
  // The replies are in the VOLUNTEER's club's language (D9); the notices
  // to the asking club in its own. Read by src/lib/partner-guest.ts.
  xask_vol_bench: (p: { name: string; asker: string }) =>
    `Thanks ${p.name}, you're on *${p.asker}*'s bench. Their organisers pick, and they'll let you know.`,
  xask_vol_in: (p: { name: string; asker: string; day: string }) => `✅ Thanks ${p.name}, you're in for *${p.asker}*: ${p.day}.`,
  xask_vol_out: (p: { asker: string }) => `OK, I've taken you off *${p.asker}*'s list.`,
  xask_vol_not_on: (p: { asker: string }) => `You weren't on *${p.asker}*'s list, so there's nothing to change.`,
  xask_vol_closed: (p: { asker: string }) => `*${p.asker}*'s place has gone now, thanks for offering.`,
  xask_vol_overlap: (p: { club: string; time: string; asker: string }) =>
    `You're in ${p.club}'s ${p.time} game that day, so I can't put you on *${p.asker}*'s list.`,
  xask_vol_unknown: (p: { club: string }) =>
    `I can only put ${p.club} players on another club's list, and I don't know you here yet. Message one of ${p.club}'s organisers.`,
  xask_vol_failed: "I couldn't add you just now. Please try again in a minute.",
  xask_vol_notice_asker: (p: { name: string; partner: string; day: string; bench: boolean }) =>
    `🤝 ${p.name} (${p.partner}) answered your ask for ${p.day}: ${p.bench ? "on your bench for you to pick" : "in the squad"}.`,
  xask_vol_out_notice_asker: (p: { name: string; partner: string; day: string }) =>
    `${p.name} (${p.partner}) can't play ${p.day} after all, so I've taken them off.`,
  // ─── Guests after the ask (slice S4, 2026-10-16) ────────────────────
  // DMs to a guest are in HIS club's language (D9); the page words in the
  // asking club's. Read by partner-guest.ts, organiser-pick.ts and the
  // match page's guests panel.
  xask_thanks_dm: (p: { asker: string }) => `*${p.asker}* have their player now. Thanks for offering 🙏`,
  xask_game_off_dm: (p: { asker: string; day: string }) => `*${p.asker}*'s game on ${p.day} is off now, so you're not needed after all. Thanks for offering 🙏`,
  xask_picked_dm: (p: { asker: string; day: string; venue: string }) =>
    `✅ You're playing for *${p.asker}*: ${p.day} at ${p.venue}. Can't make it after all? Reply *OUT* to their ask in your group.`,
  xask_guests_title: "Guests from partner clubs",
  xask_guest_row: (p: { name: string; club: string }) => `${p.name}, guest from ${p.club}`,
  xask_keep_button: (p: { club: string }) => `Add to ${p.club}`,
  xask_keep_done: "Added as a member.",
  xask_guest_badge: (p: { club: string }) => `Guest from ${p.club}`,
  // ─── D5b, the one question (slice S5b, 2026-10-16) ──────────────────
  xask_which: (p: { asker: string }) =>
    `Is that IN for *${p.asker}*'s game or for ours? For ${p.asker}, reply to my ${p.asker} message with IN. For ours, just say IN again.`,
  xask_vol_game_over: (p: { asker: string }) => `*${p.asker}*'s game is over now, so there's nothing to change.`,
  xask_dm_which: (p: { asker: string; askerDay: string; own: string; ownDay: string }) =>
    `Which game are you out of? Reply *1* for *${p.asker}* (${p.askerDay}) or *2* for *${p.own}* (${p.ownDay}).`,
  xask_moved_dm: (p: { asker: string; day: string }) => `*${p.asker}*'s game has moved: it is now ${p.day}. Your place stands. Can't make it? Reply *OUT* to their ask in your group.`,
  xask_guest_overlap: (p: { asker: string }) => `You're playing for *${p.asker}* at that time, so I can't put you in this game as well.`,
  // ─── Who may change a player's number or name (2026-10-18) ─────────
  // Admin player editing (src/lib/player-account-guard.ts). A number is a
  // sign-in, so a club may only edit a record it owns. Names nobody.
  pg_err_player_owns_account:
    "This player manages their own number and name on MatchTime, so only they can change them.",
  pg_err_number_on_matchtime: "That number is already on MatchTime, so it can't be added here.",
  pg_err_club_not_approved: "You can edit players once your club is approved.",
  pg_err_merge_keep_owned:
    "This player manages their own account, so their record has to be the one you keep. Merge the other record into theirs.",
  // ─── Entering a played match's score on the dashboard (2026-10-18) ──
  // FNF could not find where to enter Fri 16 Oct's result. The match page,
  // the result lists and the score action (src/lib/score-entry.ts).
  score_entry_enter: "Enter score",
  score_entry_edit: "Edit score",
  score_entry_add: "Add score",
  score_entry_err_not_played: "This match hasn't been played, so it can't have a score yet.",
  // The result bar at the top of a played match's page (2026-10-18).
  score_entry_no_score_yet: "No score yet",
  // The score panel on the match page itself (2026-10-18): Enter score /
  // Edit score open it in the result bar (src/components/match/score-entry-panel.tsx).
  score_panel_title: "Match score",
  score_panel_input_label: (p: { team: string }): string => `${p.team} score`,
  score_panel_save: "Save score",
  score_panel_saving: "Saving…",
  score_panel_cancel: "Cancel",
  score_panel_saved: "Score saved",
  score_panel_err_invalid: "Enter a whole number, 0 or more, for both teams.",
  score_panel_err_failed: "The score couldn't be saved. Please try again.",
  // ─── A player's own details: /welcome and /profile (2026-10-18) ─────
  // A blank phone never clears the stored one; a stored number is the
  // sign-in number and cannot be changed here (src/lib/own-phone-rules.ts).
  own_welcome_title: "Welcome to MatchTime",
  own_welcome_intro:
    "Just a couple of details. You'll pick your playing positions later, separately for each sport you sign up for.",
  own_name_label: "Your name",
  own_name_placeholder: "Enter your name",
  own_err_name: "Please enter your name",
  own_phone_label: "Phone number",
  own_phone_optional: "(optional)",
  own_phone_help: "Used to match your WhatsApp messages to your attendance.",
  own_phone_signin_note: "This is the number you sign in with, so it can't be changed here.",
  own_err_invalid: "That number doesn't look right. Use the full international format, for example +44 7700 900000.",
  own_err_locked: "Your number is the one you sign in with, so it can't be changed here.",
  own_err_taken: "That number is already on MatchTime, so it can't be added to your account.",
  own_err_generic: "Something went wrong",
  own_welcome_submit: "Complete setup",
  own_saving: "Saving…",
  // ─── A player's phone on /admin/players (FNF incident 2026-10-18) ───
  // Read by updatePlayerPhone / linkPlayerByPhone (actions/players.ts)
  // and the "same person?" dialog (admin/players/phone-link-dialog.tsx).
  // The dialog shows the other user's FIRST name and their club's name
  // and nothing else from that club.
  phone_err_invalid: "That doesn't look like a valid phone number. Use the international format, for example +44 7700 900123.",
  phone_err_not_member: "This player is not a member of this club.",
  phone_err_guest: "This player is a guest from a partner club, so their number can't be set here.",
  phone_err_not_allowed: "Only an owner or admin of this club can change a player's number.",
  phone_err_taken: "That number already belongs to someone else and can't be used twice.",
  phone_err_taken_here: (p: { name: string | null }) =>
    p.name
      ? `That number already belongs to ${p.name} in this club. To combine the two, use Merge.`
      : "That number already belongs to another player in this club. To combine the two, use Merge.",
  phone_err_generic: "Couldn't save the number. Please try again.",
  phone_link_refused_drop_other_clubs:
    "That number belongs to a player at another club. This player is also linked to another club, so the two can't be linked from here. Ask MatchTime support to combine them.",
  phone_link_refused_drop_sign_in:
    "That number belongs to a player at another club. This player has their own MatchTime sign in, so the two can't be linked from here. Ask MatchTime support to combine them.",
  phone_link_title: "Same person?",
  phone_link_question: (p: { name: string | null; clubs: string[] }) => {
    const clubs = p.clubs.length <= 1 ? (p.clubs[0] ?? "") : `${p.clubs.slice(0, -1).join(", ")} and ${p.clubs[p.clubs.length - 1]}`;
    return p.name
      ? `This number belongs to ${p.name}, who plays at ${clubs}. Same person?`
      : `This number belongs to someone who plays at ${clubs}. Same person?`;
  },
  phone_link_explain: (p: { club: string }) =>
    `Yes links them: this player's games, ratings and payments at ${p.club} move onto their existing account, which keeps its number. Nothing at their other club changes.`,
  phone_link_yes: "Yes, link them",
  phone_link_no: "No, it's a different number",
  phone_link_done: "Linked to their existing account.",
  phone_link_declined: "Not saved. That number already belongs to someone else and can't be used twice.",

  // ── Match context header (Kemal, 2026-10-18) ──────────────────────
  // The header on the payments page and the team management page that
  // says which match they are about (`lib/match-context.ts`).
  mch_kickoff: (p: { time: string }): string => `Kickoff ${p.time}`,
  mch_status: (p: { status: string }): string => {
    switch (p.status) {
      case "UPCOMING":
        return "Upcoming";
      case "TEAMS_GENERATED":
        return "Teams made";
      case "TEAMS_PUBLISHED":
        return "Teams published";
      case "COMPLETED":
        return "Played";
      case "CANCELLED":
        return "Cancelled";
      default: {
        const words = p.status.replace(/_/g, " ").toLowerCase();
        return words.charAt(0).toUpperCase() + words.slice(1);
      }
    }
  },
  mch_back_to_match: "Back to match",
};
