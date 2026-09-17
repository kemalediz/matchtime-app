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
  teams_post_footer: "Objections? Reply `swap X Y` — admin will confirm.",

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

  // ── rows 69, 70: the match-day 17:00 posts (scheduler-copy.ts) ───

  match_day_header: (p: { timeLabel: string; activityName: string; venue: string }): string =>
    `⚽ *Tonight at ${p.timeLabel}* — *${p.activityName}* at ${p.venue}`,
  match_day_teams_signoff: "See you tonight 🙌",
  match_day_locked_line:
    "Squad is locked. Say *@MatchTime generate teams* in the chat to lock in tonight's lineup 👇",

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
};
