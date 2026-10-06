/**
 * The string tables: completeness, hygiene and resolution.
 *
 * Phase 0 shipped the mechanism with one probe entry; Phase 2 moves the
 * real strings in, slice by slice. These rules are enforced for every
 * entry, in every language, so a slice cannot land half-done:
 *
 *   1. completeness: every key in `en` exists in every other table and
 *      no table carries a key `en` does not (belt and braces over the
 *      `: Strings` type check; it also catches an `any`); every
 *      parameterised entry has SAMPLE arguments below, so a new key
 *      without them is a `tsc` error, which is what lets the hygiene
 *      rules render every entry;
 *   2. translated: no Turkish entry IS the English entry (the Phase 0
 *      `untranslated()` wrapper is gone and must not come back: an
 *      entry moved into the table is translated in the same PR), and no
 *      Turkish entry renders to the English text;
 *   3. hygiene: no entry renders to an empty string; no Turkish entry
 *      contains an em dash or an en dash (house style; the English
 *      table is NOT held to that rule, existing English copy uses em
 *      dashes and moves in byte for byte, the golden snapshot decides);
 *      no entry opens with a time-of-day greeting, in either language,
 *      and no entry carries a send-time stamp ("5pm update", "17:00
 *      güncellemesi"); every parameterised entry uses each argument
 *      it is given;
 *   4. resolution: `t()` maps a code to its table, forgives case,
 *      region suffixes and whitespace, and falls back to English for
 *      anything it does not ship.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { en } from "../strings.en";
import { tr } from "../strings.tr";
import { t, type Strings } from "../t";
import { LANGS, LANG_LABELS, DEFAULT_LANG, isLang, normaliseLang } from "../lang";
import { BADGE_NUMBERS } from "../../badge-rules";

const TABLES = { en, tr } as const;

/**
 * One sample argument per parameterised entry. Typed against the table,
 * so adding an entry without a sample here fails `tsc`. The values are
 * deliberately distinctive strings and numbers so the "uses every
 * argument" rule below can find each one in the rendered text.
 */
type SampleArgs = {
  [K in keyof Strings]: Strings[K] extends (p: infer P) => string ? P : null;
};

const SAMPLES: SampleArgs = {
  unnamed: null,
  team_sheet_open_slot: null,
  no_match_label: null,
  squad_status_lead: { withBench: true, confirmed: 11, maxPlayers: 14, need: 3 },
  playing_header: null,
  bench_header: { count: 2 },
  teams_post_header: { kickoff: "21:30", venue: "Goals North Cheam" },
  teams_post_footer: null,
  // Row 2b, the 2026-09-15 replacement post. `outNames` and `swaps` are
  // ARRAYS, so the "uses every argument" rule only requires that the
  // entry accept them; the single-swap branch below is the live shape.
  replacement_note: { from: "Wasim" },
  replacement_lead: {
    outNames: ["Wasim"],
    swaps: [{ inName: "Shahrokh", outName: "Wasim", teamLabel: "Yellow" }],
  },
  teams_post_footer_after_replacement: null,
  squad_complete_header: { maxPlayers: 14, activityName: "Tuesday 7-a-side", kickoffLabel: "Tue 22 Sept 21:30" },
  squad_complete_signoff: null,
  bench_promotion_how: { reactions: false },
  squad_complete_bench_invite: { how: "HOWCLAUSE" },
  bench_offer_group_post: { context: "CONTEXTCLAUSE", tagList: "@447700900001", reactions: false },
  bench_offer_context_team: { teamLabel: "Kırmızı", replacingName: "Sait Demir", activityName: "Tuesday 7-a-side", day: "DAYLABEL" },
  bench_offer_context_team_plain: { teamLabel: "Kırmızı", replacingName: "Sait Demir", activityName: "Tuesday 7-a-side", day: "DAYLABEL" },
  bench_offer_context_fixture: { activityName: "Tuesday 7-a-side", day: "DAYLABEL" },
  bench_offer_context_fixture_plain: { activityName: "Tuesday 7-a-side", day: "DAYLABEL" },
  rate_promo: { activityName: "Tuesday 7-a-side", matchDateLabel: "Tue 15 Sep" },
  match_day_chase_fallback: { need: 3, activityName: "Tuesday 7-a-side" },
  slot_opened: { outFirstNames: ["Wasim"], confirmed: 13, maxPlayers: 14, kickoffLabel: "Tue 21:30", open: 1 },
  announce_match: { activityName: "Tuesday 7-a-side", dateLabel: "Tuesday 8 September at 21:30", venue: "Goals North Cheam", maxPlayers: 14 },
  roster_confirmed_header: { confirmed: 11, maxPlayers: 14 },
  roster_nobody_yet: null,
  squad_full_evening_lead: { activityName: "Tuesday 7-a-side", confirmed: 14, maxPlayers: 14 },
  match_day_header: { timeLabel: "21:30", activityName: "Tuesday 7-a-side", venue: "Goals North Cheam" },
  match_day_teams_signoff: null,
  match_day_locked_line: null,
  daily_in_list_fallback_lead: { activityName: "Tuesday 7-a-side", need: 3 },
  unpaid_tail: { unpaid: 4 },
  payment_poll_question: { activityName: "Tuesday 7-a-side" },

  // ── slice 2 ──
  fallback_player: null,
  answer_count: { stated: true, confirmed: 11, maxPlayers: 14, kickoffLabel: "Tue 21:30", need: 3 },
  answer_fixture: { kickoffLabel: "Tue 21:30", venue: "Goals North Cheam" },
  answer_score_no_match: null,
  answer_score_no_score: { kickoffLabel: "Tue 21:30" },
  answer_score_result: { kickoffLabel: "Tue 21:30", redLabel: "Kırmızı", red: 4, yellow: 2, yellowLabel: "Sarı", winnerLabel: "Kırmızı" },
  results_head: { n: 5, period: { kind: "last", count: 3, unit: "month" }, byCount: true },
  results_row: { dayLabel: "Tue 22 Sep", redLabel: "Kırmızı", red: 4, yellow: 2, yellowLabel: "Sarı", winnerLabel: "Kırmızı" },
  results_all_i_have: null,
  results_capped: { max: 10 },
  results_latest: { n: 10 },
  results_none: null,
  results_none_when: { period: { kind: "this", unit: "month" } },
  answer_payments_not_tracked: null,
  answer_payments_no_settled: null,
  answer_payments_no_signal: { kickoffLabel: "Tue 21:30" },
  answer_payments_all_settled: { kickoffLabel: "Tue 21:30" },
  answer_payments_unpaid: { unpaid: 4, chargeable: 13, kickoffLabel: "Tue 21:30" },
  answer_bench_empty: null,
  answer_bench_list: { names: ["Erdal Ozkan", "Amir Ahmadi"] },
  answer_person_not_down: { who: "Zeeshan Khan", kickoffLabel: "Tue 21:30" },
  answer_person_bench: { who: "Erdal Ozkan", kickoffLabel: "Tue 21:30" },
  answer_person_confirmed: { who: "Sait Demir", kickoffLabel: "Tue 21:30" },
  answer_phones_none: null,
  answer_phones_missing: { names: ["Sait Demir", "Abid Hussain"] },
  // The appearances table and the period (2026-09-23), which retired
  // `answer_stats_empty` / `_head` / `_row` and their 30-day window.
  stats_apps_head: { when: "since my records began in April 2026" },
  stats_apps_row: { rank: 1, name: "Kemal Ediz", matches: 4 },
  stats_apps_empty: { when: "in the last month" },
  stats_when: { period: { kind: "season" }, since: "April 2026" },
  stats_span: { period: { kind: "last", count: 3, unit: "month" } },
  stats_period_unreached: { since: "April 2026", span: "the last year" },
  stats_period_not_cut: { table: "team_of_season", since: "April 2026", span: "the last month" },
  stats_mom_head_when: { when: "in the last month" },
  stats_mom_empty_when: { when: "in the last month" },
  // The stats tables (2026-09-23).
  stats_ratings_head: { n: 7, minGames: 3 },
  stats_ratings_row: { rank: 2, name: "Mustafa Kaya", avg: "7.8", games: 9 },
  stats_ratings_empty: { minGames: 3, url: "https://mt.example/s" },
  stats_capped: { cap: 10, url: "https://mt.example/s" },
  stats_bottom: { url: "https://mt.example/s" },
  stats_mom_head: null,
  stats_mom_row: { rank: 2, name: "Sait Demir", wins: 4 },
  stats_mom_empty: null,
  stats_elo_head: { n: 7, minMatches: 3 },
  stats_elo_row: { rank: 2, name: "Kemal Ediz", rating: 1042, matches: 12 },
  stats_elo_empty: { minMatches: 3 },
  stats_tots_head: { sportName: "Football 7-a-side", minGames: 2 },
  stats_tots_row: { n: 3, name: "Baki Aydin", position: "GK", avg: "7.9", games: 6 },
  stats_tots_empty: { minGames: 2 },
  stats_movers_head: null,
  stats_movers_row: { n: 2, name: "Habib Rahman", delta: 3, rank: 4, games: 5 },
  stats_movers_empty: null,
  stats_reliable_head: { minAvg: "6.5", minGames: 4 },
  stats_reliable_row: { n: 2, name: "Sait Demir", avg: "7.3", games: 9 },
  stats_reliable_empty: { minAvg: "6.5", minGames: 4 },
  stats_chem_head: { name: "Idris Bello" },
  stats_chem_winrate: { partner: "Kemal Ediz", wins: 5, games: 7, pct: 71 },
  stats_chem_rating: { partner: "Sait Demir", player: "Idris", avg: "7.9" },
  stats_chem_nemesis: { name: "Zeeshan Khan", player: "Idris", wins: 1, games: 6 },
  stats_chem_empty: { name: "Idris Bello" },
  stats_generic_safe: { url: "https://mt.example/s" },
  stats_ask_unknown: { asker: "Kemal", ref: "Zork" },
  stats_ask_ambiguous: { asker: "Kemal", choices: "Mojib Sadat or Mohammed Ali" },
  answer_options_lead: { confirmed: 11, maxPlayers: 14, need: 3 },
  answer_options_no_formats: null,
  answer_options_none_viable: null,
  teams_not_generated: null,
  score_ack: { redLabel: "Kırmızı", red: 3, yellow: 1, yellowLabel: "Sarı" },
  payment_ack: { firstName: "Sait", count: 3 },
  payments_live_announcement: { collector: "Kemal", card: true, bank: true, direct: true },
  reminder_ack_resolved: { whenLabel: "Thu 10 Sep at 09:00" },
  reminder_ack_unresolved: { phrase: "when the fixture list is out" },
  needs_tag_for_rest: { dropped: ["Abid Hussain"], benched: ["Idris Bello"] },
  bench_claim_too_late: { firstName: "Najib", confirmed: 14, maxPlayers: 14 },
  pending_confirmed_ack: { names: ["Sait Demir", "Abid Hussain"], kickoffLabel: "Tue 21:30" },
  guest_name_ask: { firstName: "Sait", plural: false },
  ask_who_mentioned: null,
  mom_header: { mvpLabel: "Maçın Adamı", activityName: "Tuesday 7-a-side" },
  mom_winner: { name: "Sait Demir", top: 6, total: 12 },
  mom_shared: { names: "Sait Demir & Kemal Ediz", top: 4, total: 12 },
  mom_votes_header: null,
  mom_vote_row: { name: "Sait Demir", votes: 6 },
  mom_trophy_line: null,
  format_switch_proposal: { shortBy: 2, formatName: "5-a-side", total: 10, confirmed: 10, benched: [] },
  kickoff_move_line: { newTime: "21:15", oldTime: "21:30" },
  oob_player_fallback: null,
  oob_in: { name: "Sait Demir", source: "dm", confirmed: 12, maxPlayers: 14 },
  oob_bench: { name: "Sait Demir", source: "app", confirmed: 14, maxPlayers: 14 },
  oob_out: { name: "Sait Demir", source: "reaction", confirmed: 11, maxPlayers: 14 },
  bench_claim_team: { claimer: "Erdal Ozkan", dropped: "Sait Demir", teamLabel: "Kırmızı" },
  bench_claim_replacing: { claimer: "Erdal Ozkan", dropped: "Sait Demir", confirmed: 14, maxPlayers: 14 },
  bench_claim_open: { claimer: "Erdal Ozkan", confirmed: 13, maxPlayers: 14 },
  bench_intro_line: { how: "HOWCLAUSE" },
  full_squad_bench_invite: { matchName: "Tuesday 7-a-side", confirmed: 14, maxPlayers: 14, how: "HOWCLAUSE" },
  bench_asked_line: { benchName: "Erdal Ozkan", confirmed: 13, maxPlayers: 14, reactions: false },
  unresolved_nudge_named: { verb: "join", pushname: "Tommy T" },
  unresolved_nudge_anonymous: { verb: "drop out" },
  stats_blast_reply: { queued: 12 },
  stats_link_sent: { firstName: "Erdal" },
  attendance_failure: { firstName: "Sait", self: "IN", others: ["Abid Hussain"] },
  rating_progress_failed: null,
  rating_progress_no_match: null,
  rating_progress_header: { matchName: "Tuesday 7-a-side", matchWhen: "Tue 8 Sep" },
  rating_progress_rated: { rated: 9, confirmed: 14 },
  rating_progress_mom: { mom: 7, confirmed: 14 },
  rating_progress_still_to_rate: { names: ["Abid Hussain", "Idris Bello"] },
  rating_progress_everyone_rated: null,
  rating_progress_no_mom_pick: { names: ["Faris Nasser"] },
  recruit_no_match: null,
  recruit_full_squad: { matchName: "Tuesday 7-a-side" },
  bulk_cancel: { activityName: "Tuesday 7-a-side", dateLabels: ["Tue 15 Sep", "Tue 22 Sep"] },
  format_switch_header: { sportName: "Football 5-a-side", maxPlayers: 10 },
  format_switch_playing_header: { confirmed: 10, maxPlayers: 10 },
  format_switch_bench_header: null,
  match_cancelled: { activityName: "Tuesday 7-a-side", whenLabel: "Tue 22 Sep at 21:30" },
  team_ops_no_match: null,
  balancer_refusal: { reason: "REASONCLAUSE" },
  team_gen_reason_not_found: null,
  team_gen_reason_status: { status: "COMPLETED" },
  team_gen_reason_not_enough: { confirmed: 9, needed: 14 },
  team_gen_note_including: { names: ["Erdal Ozkan"] },
  team_gen_note_pinned: { pinned: ["Kemal Ediz → RED"] },
  team_gen_note_unmatched_includes: { names: ["Bob"] },
  team_gen_note_unmatched_pins: { names: ["Jim"] },
  team_ops_not_match_day: null,
  team_ops_not_a_build_request: null,
  team_ops_say_generate: null,
  teams_cleared: null,
  teams_clear_nothing: null,
  teams_clear_admin_only: null,
  request_not_handled: null,
  request_not_handled_admin: { url: "https://mt.example/admin" },
  payment_credit_ack: { payerName: "Sait Demir", credited: [], count: 2, matchName: "Tuesday 7-a-side", unpaid: 6, confirmed: 14, unmatched: 1 },
  recruit_failed: null,
  recruit_invited: { invited: 5, matchName: "Tuesday 7-a-side", need: 2 },
  recruit_already_pinged: { matchName: "Tuesday 7-a-side" },
  recruit_nobody_new: { matchName: "Tuesday 7-a-side" },
  swap_deferred: { a: "Kemal Ediz", b: "Sait Demir" },
  team_swap_done: { a: "Kemal Ediz", b: "Elvin Aliyev" },
  slot_transfer_done: { to: "Erdal Ozkan", from: "Sait Demir", teamLabel: "Kırmızı" },
  colour_swap_done: null,
  swap_refused: { a: "David", b: "Zork", why: "WHYCLAUSE" },
  swap_refused_unknown: { name: "Zork" },
  swap_refused_ambiguous: { name: "Omar", candidates: ["Omar One", "Omar Two"] },
  swap_refused_teams_not_generated: null,
  swap_refused_same_player: null,
  swap_refused_nobody_playing: null,
  swap_refused_not_in_squad: { name: "Baki Aydin" },
  swap_refused_both_hold_slots: { name: "Elvin Aliyev" },
  swap_refused_no_slot: { name: "Elvin Aliyev" },
  intro_opener: null,
  intro_what_i_do: null,
  intro_attendance: null,
  intro_daily: null,
  intro_teams: null,
  intro_rating_bit: null,
  intro_mom_bit: null,
  intro_ratings_line: { bits: ["BITONE", "BITTWO"] },
  intro_reminders: null,
  intro_stats: null,
  intro_payments: null,
  intro_closer: null,
  chase_pre_kickoff_fallback: { need: 2, activityName: "Tuesday 7-a-side", timeLabel: "21:30" },
  pre_kickoff_short_fallback: { timeLabel: "21:30", venue: "Goals North Cheam", confirmed: 12, maxPlayers: 14, need: 2 },
  gear_reminder: { timeLabel: "21:30", venue: "Goals North Cheam" },
  ask_score: { activityName: "Tuesday 7-a-side" },

  // ── slice 3 ──
  roster_header_past: null,
  roster_header_tonight: null,
  roster_header_tomorrow: null,
  roster_header_day: { dayLabel: "Tue 8 Sept" },
  chase_tentative_line: { name: "Erdal Ozkan" },
  chase_opener_example: null,

  // ── onboarding (self-setup), merged from main (#94) ──
  //   Zero-argument entries take `null`; the enum-like arguments
  //   (`key`, `englishLabel`, `dow`, `topic`) are branched on, not printed.
  onbIntro: null,
  onbAdminQuestion: null,
  onbConsentAck: { adminCaptured: true, adminQuestion: "ADMINQUESTION" },
  onbAdminsAck: { added: 2, detailsQuestion: "DETAILSQUESTION" },
  onbDetailsQuestion: { missing: ["day", "venue"] },
  onbCompletionPost: {
    groupName: "Tuesday Ballers FC",
    onLabels: ["Attendance tracking", "Team generation"],
    dayName: "Tuesday",
    kickoffTime: "21:00",
    venue: "Goals Wembley",
    weekly: true,
    rosterCount: 12,
    adminsAdded: 2,
    adminDmQueued: true,
    adminName: "Adam Admin",
    howToUseMe: "HOWTOBLOCK",
  },
  onbAdminDm: {
    groupName: "Tuesday Ballers FC",
    url: "https://mt.example/s/abc",
    payments: true,
    seedUrl: "https://mt.example/s/seeds",
    blockBookingsUrl: "https://mt.example/s/blocks",
    matchesUrl: "https://mt.example/s/matches",
  },
  onbCoAdminDm: { groupName: "Tuesday Ballers FC", url: "https://mt.example/s/abc" },
  onbEnrichmentDm: { messagesAnalyzed: 340, groupName: "Tuesday Ballers FC", playerCount: 17, url: "https://mt.example/s/abc" },
  onbCancelled: null,
  onbFeatureLabel: { key: "attendance", englishLabel: "Attendance tracking" },
  onbDayName: { dow: 2 },
  onbHowToUseMe: { attendance: true, teamBalancing: true, momVoting: true, playerRating: true, statsQa: true, reminders: true, bench: true, paymentTracking: true },
  onbHelpHead: null,
  onbHelpTopicLine: { word: "teams", label: "fair teams" },
  onbHelpTopicWord: { topic: "teams" },
  onbHelpTopicLabel: { topic: "teams" },
  onbHelpNotOn: null,
  onbHelpSchedule: { audience: "group", activities: "https://mt.example/a", blockBookings: "https://mt.example/b", bulk: "https://mt.example/c", matches: "https://mt.example/d" },
  onbHelpOffLead: null,
  onbHelpSettingLabel: { topic: "ratings" },
  onbHelpPaymentsOff: null,
  onbHelpSwitchOn: { topic: "mom", audience: "group", url: "https://mt.example/admin/settings", word: "motmword", label: "Motm Label" },
  onbHelpAdminSettings: { url: "https://mt.example/s/settings" },
  onbHelpAdminPage: { url: "https://mt.example/s/page" },
  onbHelpForClub: { club: "Riverside FC" },
  onbHelpExplainer: { topic: "teams" },
  onbHelpBadgesHead: null,
  onbHelpBadgeLine: { key: "reliable", emoji: "🧱", label: "Mr Reliable", n: BADGE_NUMBERS },
  onbHelpBadgesFoot: { dm: false, example: "Mr Reliable" },
  onbHelpBadgesUnknown: { query: "golden boot" },
  onbHelpBadgesClubNote: null,
  onbHelpBadgeDetail: { key: "reliable", emoji: "🧱", label: "Mr Reliable", n: BADGE_NUMBERS },

  // ── private messages (Phase 3) ──
  //   `dayNum`, `kind`, `category` and `decision` are branched on, not printed.
  dm_rating: { activityName: "Tuesday 7-a-side", dateLabel: "DATELABEL", mvpLabel: "MVPLABEL", rateUrl: "https://mt.example/s/rate", statsUrl: "https://mt.example/s/stats" },
  dm_rating_reminder: { dayNum: 1, firstName: "Sait", activityName: "Tuesday 7-a-side", mvpLabel: "MVPLABEL", url: "https://mt.example/s/rate" },
  dm_tentative_followup: { firstName: "Sait", activityName: "Tuesday 7-a-side", whenLabel: "WHENLABEL" },
  dm_tentative_reask: null,
  dm_tentative_ack: { decision: "in", failed: false },
  dm_bench_offer: { firstName: "Erdal", context: "CONTEXTCLAUSE", reactions: false },
  dm_bench_unclear: { day: "DAYLABEL" },
  dm_bench_ack: { kind: "confirmed", day: "DAYLABEL" },
  dm_recruit_invite: { firstName: "Sait", matchName: "Tuesday 7-a-side", matchWhen: "WHENLABEL", spotsLeft: 2, link: "https://mt.example/m/abc", reactions: false },
  dm_recruit_group_invite: { firstName: "Sait", matchName: "Tuesday 7-a-side", matchWhen: "WHENLABEL" },
  dm_recruit_chase: { firstName: "Sait", count: 3, activityName: "Tuesday 7-a-side", matchWhen: "WHENLABEL" },
  dm_self_ack: { failed: false, status: "BENCH", matchName: "Tuesday 7-a-side", matchWhen: "WHENLABEL" },
  dm_sub_ack: { kind: "opt-out-all" },
  dm_reminder: { firstName: "Sait", note: "book the pitch" },
  dm_stats_blast: { firstName: "Sait", url: "https://mt.example/s/stats" },
  dm_stats_link: { firstName: "Sait", url: "https://mt.example/s/stats" },
  dm_qa_apology: null,
  dm_fee_ask: { firstName: "Kemal", activityName: "Tuesday 7-a-side", headcount: 14 },
  dm_fee_confirm_prompt: { fee: "£7.69", headcount: 13, matchName: "Tuesday 7-a-side", wasTotal: true },
  dm_fee_released: { released: 13, fee: "£8.50", matchName: "Tuesday 7-a-side" },
  dm_fee_cancelled: null,
  dm_pay_link: { firstName: "Sait", activityName: "Tuesday 7-a-side", fee: "£8.50", url: "https://mt.example/s/pay" },
  dm_pay_chase: { firstName: "Sait", dayNum: 2, fee: "£8.50", activityName: "Tuesday 7-a-side", url: "https://mt.example/s/pay" },
  dm_direct_pay_nudge: { count: 3, activityName: "Tuesday 7-a-side", url: "https://mt.example/s/collect" },
  dm_direct_pay_notice: { playerName: "Sait Demir", activityName: "Tuesday 7-a-side", amount: "£24", quantity: 3, url: "https://mt.example/s/collect", claimedPaid: true },
  dm_paid_claim_ack: { firstName: "Sait", collectorName: "Elvin", amount: "£8", activityName: "Tuesday 7-a-side" },
  dm_paid_claim_already: { firstName: "Sait", collectorName: "Elvin", amount: "£8", activityName: "Tuesday 7-a-side" },
  dm_paid_for_others: { firstName: "Sait", collectorName: "Elvin", url: "https://mt.example/s/pay" },
  dm_admin_recruit_done: { invited: 5, matchName: "Tuesday 7-a-side", matchWhen: "WHENLABEL", need: 2 },
  dm_admin_recruit_nobody_new: { matchName: "Tuesday 7-a-side" },
  dm_survey_clarify_probe: { firstName: "Sait" },
  dm_survey_clarify: { firstName: "Sait", orgName: "Sutton FC" },
  dm_survey_confirm: { category: "maybe", firstName: "Sait" },
  dm_survey_invite: { firstName: "Sait", orgName: "Sutton FC" },
  onb_legacy_intro: null,
  onb_legacy_question: { field: "side", groupName: "Tuesday Ballers FC" },
  onb_legacy_menu: { lead: "LEADLINE", items: [{ label: "LABELONE", blurb: "BLURBONE" }] },
  onb_legacy_feature_blurb: { key: "bench", englishBlurb: "Standby list" },
  onb_legacy_menu_retry_lead: null,
  onb_legacy_provisioned_lead: { groupName: "Tuesday Ballers FC", playersPerTeam: 7, dayName: "DAYNAME", kickoffTime: "21:00", venue: "Goals Wembley" },
  onb_legacy_completion: { onLabels: ["LABELONE"], dayName: "DAYNAME", kickoffTime: "21:00", venue: "Goals Wembley", weekly: true, howToUseMe: "HOWTOBLOCK" },

  // ── slice 6: the two ratings, on the web ──
  rating_club_tile: null,
  rating_club_label: { orgName: "Sutton Football Club" },
  rating_club_note: null,
  rating_overall_label: null,
  rating_overall_note: null,
  rating_club_empty: null,
  rating_seed_club_hint: null,
  rating_club_provisional: { count: 2 },
  rating_club_balance_note: null,
  rating_club_peers: { count: 7 },
  ai_daily_cap_reached: null,
  stats_leaderboard_title: null,
  stats_leaderboard_info_lead: null,
  stats_leaderboard_info_arrows_lead: null,
  stats_leaderboard_arrow_up: null,
  stats_leaderboard_arrow_down: null,
  stats_leaderboard_arrow_same: null,
  stats_leaderboard_new: null,
  stats_leaderboard_you: null,
  stats_leaderboard_not_ranked: null,
  stats_table_rule: { minGames: 3 },
  stats_leaderboard_join: { minGames: 7, games: 5 },
  stats_leaderboard_away: { avg: "7.4", lastPlayed: "LASTPLAYED" },
  stats_tots_title: null,
  stats_tots_info_lead: { sportName: "SPORTNAME" },
  stats_share_card: null,
  stats_share_badge_label: { label: "BADGELABEL" },
  stats_share_saved: null,
  stats_share_failed: null,
  stats_share_badge_text: { emoji: "EMOJI", label: "BADGELABEL", orgName: "ORGNAME" },
  stats_share_season_text: { orgName: "ORGNAME" },
  badges_post_header: null,
  badges_post_footer: null,
  badges_line_first_game: { emoji: "👟", label: "On the board", names: ["Hamzah"] },
  badges_line_first_mom: { emoji: "🏆", label: "Man of the Match", shared: [["Burak Yildiz", "Mojib"]], solo: ["Wasim"] },
  badges_line_mom_machine: { emoji: "👑", label: "MoM Machine", names: ["Wasim"] },
  badges_line_masterclass: { emoji: "🌟", label: "Masterclass", names: ["Wasim"] },
  badges_line_ten_games: { emoji: "🔟", label: "Regular", names: ["Mojib", "Wasim"] },
  badges_line_reliable: { emoji: "🧱", label: "Mr Reliable", names: ["Najib"] },
  badges_feature_label: null,
  badges_feature_blurb: null,

  // ── self-join slice 4: the organiser web ──
  sj_activity_name: { perSide: 7 },
  sj_per_side_option: { perSide: 7 },
  sj_form_title: null,
  sj_form_lead: null,
  sj_form_club_name: null,
  sj_form_club_name_placeholder: null,
  sj_form_language: null,
  sj_form_game_heading: null,
  sj_form_day: null,
  sj_form_time: null,
  sj_form_venue: null,
  sj_form_venue_placeholder: null,
  sj_form_per_side: null,
  sj_form_submit: null,
  sj_form_submitting: null,
  sj_err_invalid: null,
  sj_err_verify_phone: null,
  sj_verify_phone_link: null,
  sj_err_one_club: null,
  sj_open_my_club: null,
  sj_err_site_cap: null,
  sj_err_generic: null,
  sj_connect_prefill: { club: "Riverside FC", code: "7KQ2" },
  sj_card_title: null,
  sj_button: null,
  sj_button_again: null,
  sj_card_draft: null,
  sj_card_issued: null,
  sj_card_code: { code: "7KQ2" },
  sj_card_wrong_number: { seen: "+44 77** ***123", expected: "+44 7700 900123" },
  sj_card_dm_verified: null,
  sj_card_number_label: null,
  sj_card_pending: null,
  sj_card_pending_other: { group: "Riverside Tuesday 5s" },
  sj_card_approved: { group: "Riverside Tuesday 5s" },
  sj_card_rejected: null,
  sj_card_expired: null,
  sj_card_code_cap: null,
  sj_card_unavailable: null,
  sj_card_already_connected: null,
  admin_players_new_heading: { count: 3 },
  admin_players_new_body: { names: ["Hamzah", "Ayoub"] },
  admin_players_club_rating_header: null,
  admin_players_club_rating_hint: null,
  admin_players_not_rated_yet: null,
  admin_players_rated_games: { count: 4 },
  sj_site_cap_groups: null,
  sj_dm_connected: { name: "Aliyah", club: "Riverside FC" },
  sj_dm_already_connected: null,
  sj_dm_code_expired: null,
  sj_dm_in_group: { group: "Riverside Tuesday 5s" },
  sj_group_hello: { organiser: "Aliyah" },
  sj_dm_approved: {
    club: "Riverside FC",
    group: "Riverside Tuesday 5s",
    scheduleUrl: "https://matchtime.ai/l/sched",
    ratingsUrl: "https://matchtime.ai/l/rate",
    settingsUrl: "https://matchtime.ai/l/set",
    tip: "TIP-PARAGRAPH",
  },
  sj_dm_rejected: { group: "Riverside Tuesday 5s" },
  dm_admin_join_new: { club: "Sutton FC", phone: "+447376548222", url: "https://mt.example/r/phones" },
  dm_admin_join_new_named: { name: "Ali Veli", club: "Sutton FC", phone: "+447376548222", url: "https://mt.example/r/players" },
  dm_admin_join_first: { name: "Hamzah", club: "Sutton FC" },
  dm_admin_join_rejoined: { name: "Hamzah", club: "Sutton FC" },
  dm_admin_join_linked: { placeholder: "Hamza", addedOn: "ADDEDON" },
  dm_admin_join_possible_duplicate: { names: ["Hamza", "Hamzo"], url: "https://mt.example/r/merge" },
  admin_players_duplicates_heading: null,
  admin_players_duplicate_row: { placeholder: "Hamza", keeper: "Hamzah Khan" },
  admin_players_duplicate_merge: { keeper: "Hamzah Khan" },
  // Rolling squad (2026-09-30)
  rolling_announce_lead: { activityName: "Friday 9-a-side", dateLabel: "Friday 9 October at 20:30", venue: "Powerleague Shoreditch", deadline: "Thursday 15:30" },
  rolling_in_header: { confirmed: 16, maxPlayers: 18 },
  rolling_waiting_header: { count: 3 },
  rolling_tail_open: { open: 2 },
  rolling_tail_open_organiser: { open: 2 },
  rolling_tail_full: null,
  rolling_deadline_line: { deadline: "Thursday 15:30" },
  intro_rolling_squad: null,
  late_drop_admin_notice: { name: "Wasim Ali", activityName: "Friday 9-a-side", whenLabel: "Fri 9 Oct at 20:30", time: "16:05", deadline: "Thursday 15:30", confirmed: 17, maxPlayers: 18 },
  wr_section_title: null,
  wr_section_lead: null,
  wr_rolling_label: null,
  wr_rolling_blurb: null,
  wr_rolling_info: null,
  wr_rolling_on: null,
  wr_rolling_off: null,
  wr_save_failed: null,
  carry_over_button: null,
  carry_over_hint: { dateLabel: "Fri 2 Oct" },
  carry_over_done: { count: 16 },
  carry_over_nothing: null,
  // Weekly deadlines (2026-09-30, slice 3)
  dropout_reminder_post: { activityName: "Friday 9-a-side", whenLabel: "Fri 9 Oct at 20:30", time: "21:00", rosterBlock: "*In (16/18):*\n1. Hamzah" },
  deadline_summary_admin: { activityName: "Friday 9-a-side", whenLabel: "Fri 9 Oct at 20:30", confirmed: 16, maxPlayers: 18, out: ["Wasim"], maybe: ["Raihan"], waiting: ["Ali"], open: 2 },
  list_published_head: { activityName: "Friday 9-a-side", dateLabel: "Friday 9 October at 20:30", venue: "Powerleague Shoreditch" },
  list_published_playing_header: { confirmed: 16, maxPlayers: 18 },
  list_published_open: { open: 2 },
  list_published_footer: null,
  wd_dropout_label: null,
  wd_dropout_blurb: null,
  wd_dropout_info: null,
  wd_publish_label: null,
  wd_publish_blurb: null,
  wd_publish_info: null,
  wd_day_label: null,
  wd_time_label: null,
  wd_not_set: null,
  wd_weekday: { dow: 1 },
  wd_save: null,
  wd_clear: null,
  wd_saved: null,
  wd_err_incomplete: null,
  wd_err_bad_value: null,
  wd_err_outside_hours: null,
  wd_err_order: null,
  wd_err_after_kickoff: null,
  // ── slice 2a: the admin channel (2026-09-30) ──
  admin_group_linked: { club: "Friday FNF" },
  admin_group_bad_code: null,
  admin_group_main_group: { club: "Friday FNF" },
  admin_group_removed_dm: { club: "Friday FNF" },
  settings_admin_channel_heading: null,
  settings_admin_channel_info: null,
  settings_admin_channel_mode_one_person: null,
  settings_admin_channel_mode_admin_group: null,
  settings_admin_channel_mode_each_admin: null,
  settings_admin_channel_person_label: null,
  settings_admin_channel_person_owner: { name: "Hamzah" },
  settings_admin_channel_link_button: null,
  settings_admin_channel_link_again: null,
  settings_admin_channel_link_info_title: null,
  settings_admin_channel_link_info: null,
  settings_admin_channel_step_code: { code: "K7P3QX" },
  settings_admin_channel_step_add: null,
  settings_admin_channel_step_send: null,
  settings_admin_channel_command: { code: "K7P3QX" },
  settings_admin_channel_validity: null,
  settings_admin_channel_linked: { group: "FNF HQ" },
  settings_admin_channel_unlink: null,
  settings_admin_channel_pending_note: null,
  settings_admin_channel_saved: null,
  settings_admin_channel_unlinked: null,
  // ── slice 2b: organiser pick (2026-10-01) ──
  slot_opened_organiser: { kickoffLabel: "Fri 20:30" },
  pick_lead_drop: { names: ["Hamzah"], activityName: "Friday 9-a-side", whenLabel: "Fri 9 Oct at 20:30", late: false },
  pick_lead_deadline: { activityName: "Friday 9-a-side", whenLabel: "Fri 9 Oct at 20:30" },
  pick_lead_open_place: { open: 1, activityName: "Friday 9-a-side", whenLabel: "Fri 9 Oct at 20:30", confirmed: 17, maxPlayers: 18 },
  pick_places_line: { open: 1, confirmed: 17, maxPlayers: 18 },
  pick_waiting_header: null,
  pick_list_row: { n: 3, name: "Ali", position: null, rating: null },
  pick_instructions_dm: null,
  pick_instructions_group: null,
  pick_fallback_offer: { when: "Saturday 20:30" },
  pick_fallback_leave: { when: "Saturday 20:30" },
  pick_done_admin: { name: "Wasim", replacedName: "Hamzah", pickerName: "Raihan" },
  pick_group_post: { name: "Wasim", replacedName: "Hamzah", team: null, confirmed: 18, maxPlayers: 18 },
  pick_player_dm: { dayTime: "Friday 20:30", venue: "Goals" },
  pick_not_on_list: { name: "Wasim" },
  pick_already_in: { name: "Wasim" },
  pick_already_filled: { name: "Wasim", pickerName: "Raihan" },
  pick_already_filled_full: { confirmed: 18, maxPlayers: 18 },
  pick_unresolved_tag: null,
  pick_ambiguous: { first: "Ali", names: ["Ali Khan", "Ali Demir"] },
  pick_list_changed: null,
  pick_not_understood: null,
  pick_only_k: { k: 1, names: ["Wasim"] },
  pick_none_ack: null,
  pick_fallback_offered: { activityName: "Friday 9-a-side" },
  pick_fallback_left: { activityName: "Friday 9-a-side", confirmed: 17, maxPlayers: 18 },
  onb_weekly_routine_tip: null,
  wr_pick_label: null,
  wr_pick_blurb: null,
  wr_pick_info: null,
  wr_pick_first_come: null,
  wr_pick_organiser: null,
  wr_fallback_label: null,
  wr_fallback_info: null,
  wr_fallback_offer: null,
  wr_fallback_leave: null,
  wr_pick_saved: null,
  wl_title: { count: 3 },
  wl_hint: null,
  wl_bring_in: null,
  wl_move_up: null,
  wl_move_down: null,
  wl_no_position: null,
  wl_new: null,
  wl_brought_in: { name: "Wasim" },
  wl_full: null,
  wl_failed: null,
  squad_complete_bench_invite_organiser: null,
  bench_intro_line_organiser: null,
  full_squad_bench_invite_organiser: { matchName: "Friday 9-a-side", confirmed: 18, maxPlayers: 18 },
  dm_recruit_invite_play_organiser: null,
  dm_recruit_chase_organiser: { firstName: "Ali", count: 1, activityName: "Friday 9-a-side", matchWhen: "Fri 9 Oct, 20:30" },
  dm_self_ack_waiting_organiser: { matchName: "Friday 9-a-side", matchWhen: "Fri 9 Oct, 20:30" },
  // U1, the organisers' unpaid list (2026-10-01)
  unpaid_group_reminder: { unpaid: 4, dayName: "Friday" },
  unpaid_list_admin: { activityName: "Friday 9-a-side", whenLabel: "Fri 9 Oct at 20:30", names: ["Wasim", "Raihan"], paid: 14, n: 16 },
  // The daily AI cap admin notice (2026-10-01)
  ai_cap_admin_notice: { club: "Sutton FC", more: "MORE-LINE" },
  ai_cap_more_contact: null,
  ai_cap_more_buy: { url: "https://mt.example/buy" },
  // Club fee billing, slice B2 (2026-10-01).
  club_fee_tip: { players: 14, price: "£9.99", perGame: "£2.50", share: "20p", fee: "£7", feePlus: "£7.20", mode: "example" },
  sj_dm_approved_tip: { players: 14, price: "£9.99", perGame: "£2.50", share: "20p", fee: "£7", feePlus: "£7.20", split: false },
  billing_page_title: null,
  billing_state_trial: { date: "Sat 31 Oct", price: "£9.99" },
  billing_state_grace: { date: "Sat 7 Nov" },
  billing_state_subscribed: { price: "£9.99", date: "Tue 1 Dec" },
  billing_state_card_saved: { date: "Tue 1 Dec" },
  billing_state_nothing_until: { date: "Tue 1 Dec" },
  billing_state_subscribed_ending: { date: "Tue 1 Dec" },
  billing_stop_confirm_month: { date: "Tue 1 Dec" },
  billing_stop_confirm_free: { date: "Sat 31 Oct" },
  billing_state_card: { brand: "Visa", last4: "4242" },
  billing_state_paid_with_other: { holder: "Elvin", rest: "RESTLINE" },
  billing_state_past_due: { amount: "£7.49", from: "1 Nov", to: "30 Nov", months: 1, retrying: true, date: "Tue 8 Dec" },
  billing_state_paused: null,
  billing_state_paused_unpaid: { amount: "£15.48", months: 2 },
  billing_state_paused_stopped: null,
  // Club fee billing, slice P4 (games played): the month box, past months.
  billing_month_box: { from: "1 Nov", to: "30 Nov", played: 2, scheduled: 4, upcoming: 3, amount: "£4.99", max: "£9.99", date: "Tue 1 Dec" },
  billing_nothing: null,
  billing_past_months: null,
  billing_see_games: null,
  billing_receipt: null,
  billing_month_line: { from: "1 Nov", to: "30 Nov", status: "paid", games: "GAMESCOUNT", amount: "£7.99" },
  billing_month_games: { played: 4, scheduled: 5 },
  billing_game_outcome: { outcome: "played" },
  billing_state_paused_removed: null,
  billing_card_holder_note: { club: "Riverside FC", contact: "Colin" },
  billing_who_collector: { name: "Colin" },
  billing_who_owner: null,
  billing_who_none: null,
  billing_card_on_file: { yes: true },
  billing_btn_add_card: null,
  billing_btn_change_card: null,
  billing_btn_use_mine: null,
  billing_btn_update_card: null,
  billing_btn_remove_mine: null,
  billing_btn_stop_paying: null,
  billing_btn_keep_paying: null,
  billing_stop_confirm_title: null,
  billing_btn_stop_confirm_yes: null,
  billing_btn_stop_confirm_no: null,
  billing_exempt: { club: "Sutton FC" },
  billing_open: null,
  billing_choose_collector: null,
  billing_banner_grace: { date: "Sat 7 Nov" },
  billing_banner_past_due: { amount: "£7.49", from: "1 Nov", to: "30 Nov", months: 1, date: "Tue 8 Dec" },
  billing_banner_paused: null,
  billing_banner_paused_unpaid: null,
  billing_banner_paused_stopped: null,
  billing_banner_paused_removed: null,
  billing_banner_link: null,
  billing_notice_done: null,
  billing_notice_replaced: null,
  billing_notice_removed: null,
  billing_notice_not_set_up: null,
  billing_notice_already: null,
  billing_notice_re_add: null,
  billing_notice_failed: null,
  billing_notice_stopped: null,
  billing_notice_stopped_free: null,
  billing_notice_kept: null,
  billing_notice_past_due: null,
  billing_dm_card_added: { name: "Colin", club: "Riverside FC", price: "£9.99", date: "Tue 1 Dec", first: true, resumed: false, link: "https://matchtime.ai/r/abc" },
  billing_dm_card_replaced: { name: "Colin", newName: "Pat", club: "Riverside FC" },
  billing_dm_billed_again_card: { name: "Colin", club: "Riverside FC", last4: "4242", price: "£9.99", date: "Tue 1 Dec", link: "https://matchtime.ai/r/abc" },
  billing_dm_card_dropped: { name: "Elvin", club: "Riverside FC" },
  billing_dm_resumed: { club: "Riverside FC" },
  billing_dm_plan_billed: { name: "Colin", club: "Riverside FC", price: "£9.99", date: "Sat 7 Nov", link: "https://matchtime.ai/r/abc" },
  billing_dm_trial_21: { name: "Colin", club: "Riverside FC", date: "Sat 31 Oct", price: "£9.99", firstCharge: "Tue 1 Dec", link: "https://matchtime.ai/r/abc", collector: true },
  billing_dm_trial_28: { name: "Colin", club: "Riverside FC", date: "Sat 31 Oct", price: "£9.99", link: "https://matchtime.ai/r/abc" },
  billing_dm_trial_ended: { name: "Colin", club: "Riverside FC", date: "Sat 7 Nov", price: "£9.99", link: "https://matchtime.ai/r/abc" },
  billing_dm_set_collector: null,
  billing_dm_paused: { name: "Colin", club: "Riverside FC", amount: "£15.48", months: 2, link: "https://matchtime.ai/r/abc", kind: "payment-failed" },
  billing_dm_payment_failed: { name: "Colin", club: "Riverside FC", amount: "£7.49", from: "1 Nov", to: "30 Nov", link: "https://matchtime.ai/r/abc", ownCard: true, retrying: true },
  billing_dm_payment_action: { name: "Colin", club: "Riverside FC", amount: "£7.49", from: "1 Nov", to: "30 Nov", link: "https://invoice.stripe.com/i/abc" },
  billing_dm_payment_action_other: { name: "Colin", club: "Riverside FC", amount: "£7.49", from: "1 Nov", to: "30 Nov", link: "https://invoice.stripe.com/i/abc", billingLink: "https://matchtime.ai/r/abc" },
  billing_dm_payer_changed_card: { name: "Pat", club: "Riverside FC", price: "£9.99", oldName: "Colin", link: "https://matchtime.ai/r/abc" },
  billing_dm_payer_changed_no_card: { name: "Pat", club: "Riverside FC", price: "£9.99", date: "Sat 31 Oct", link: "https://matchtime.ai/r/abc" },
  billing_dm_payer_changed_paused: { name: "Pat", club: "Riverside FC", price: "£9.99", link: "https://matchtime.ai/r/abc" },
  billing_dm_payer_changed_removed: { name: "Pat", club: "Riverside FC", price: "£9.99", link: "https://matchtime.ai/r/abc" },
  billing_admin_no_collector: { link: "https://matchtime.ai/r/abc" },
  // Club fee billing, slice P3 (games played).
  billing_dm_month_charged: { name: "Colin", club: "Riverside FC", played: 4, scheduled: 5, from: "1 Nov", to: "30 Nov", amount: "£7.99", price: "£9.99", last4: "4242", ownCard: true, link: "https://matchtime.ai/r/abc" },
  billing_dm_month_free: { name: "Colin", club: "Riverside FC", from: "1 Nov", to: "30 Nov" },
  billing_dm_keep_paying: { name: "Colin", club: "Riverside FC", price: "£9.99", date: "Tue 1 Dec", restarted: false, link: "https://matchtime.ai/r/abc" },
  // F1 organiser info buttons (2026-10-05).
  info_open: { title: "TITLEARG" },
  info_close: null,
  fs_conf_high: null,
  fs_conf_med: null,
  fs_conf_low: null,
  fs_evidence_none: null,
  info_fs_players_title: null,
  info_fs_players_body: null,
  info_fs_confidence_title: null,
  info_fs_confidence_body: null,
  info_fs_position_title: null,
  info_fs_position_body: null,
  info_fs_seed_title: null,
  info_fs_seed_body: null,
  info_fs_evidence_title: null,
  info_fs_evidence_body: null,
  info_fs_phones_title: null,
  info_fs_phones_body: null,
  info_fs_schedule_title: null,
  info_fs_schedule_body: null,
  info_dash_players_title: null,
  info_dash_players_body: null,
  info_dash_activities_title: null,
  info_dash_activities_body: null,
  info_dash_upcoming_title: null,
  info_dash_upcoming_body: null,
  info_dash_completed_title: null,
  info_dash_completed_body: null,
  info_dash_ratings_title: null,
  info_dash_ratings_body: null,
  info_dash_connect_title: null,
  info_dash_connect_body: null,
  info_pl_list_title: null,
  info_pl_list_body: null,
  info_pl_add_title: null,
  info_pl_add_body: null,
  info_pl_seed_title: null,
  info_pl_seed_body: null,
  info_pl_club_rating_title: null,
  info_pl_club_rating_body: null,
  info_pl_aliases_title: null,
  info_pl_aliases_body: null,
  info_pl_merge_title: null,
  info_pl_merge_body: null,
  info_pl_duplicates_title: null,
  info_pl_duplicates_body: null,
  info_pl_new_title: null,
  info_pl_new_body: null,
  info_pl_role_title: null,
  info_pl_role_body: null,
  info_st_general_title: null,
  info_st_general_body: null,
  info_st_team_names_title: null,
  info_st_team_names_body: null,
  info_st_language_title: null,
  info_st_language_body: null,
  info_st_invite_title: null,
  info_st_invite_body: null,
  info_st_features_title: null,
  info_st_features_body: null,
  info_st_weekly_title: null,
  info_st_weekly_body: null,
  info_st_billing_title: null,
  info_st_billing_body: null,
  info_st_collector_title: null,
  info_st_collector_body: null,
  info_st_bank_title: null,
  info_st_bank_body: null,
  info_st_whatsapp_title: null,
  info_st_whatsapp_body: null,
  info_feat_attendance_title: null,
  info_feat_attendance_body: null,
  info_feat_bench_title: null,
  info_feat_bench_body: null,
  info_feat_teams_title: null,
  info_feat_teams_body: null,
  info_feat_mom_title: null,
  info_feat_mom_body: null,
  info_feat_rating_title: null,
  info_feat_rating_body: null,
  info_feat_reminders_title: null,
  info_feat_reminders_body: null,
  info_feat_stats_title: null,
  info_feat_stats_body: null,
  info_feat_pay_tracking_title: null,
  info_feat_pay_tracking_body: null,
  info_feat_pay_collect_title: null,
  info_feat_pay_collect_body: null,
  info_feat_pay_bank_title: null,
  info_feat_pay_bank_body: null,
  info_feat_pay_card_title: null,
  info_feat_pay_card_body: null,
  info_feat_pay_direct_title: null,
  info_feat_pay_direct_body: null,
  info_feat_badges_title: null,
  info_feat_badges_body: null,
  info_act_page_title: null,
  info_act_page_body: null,
  info_act_generate_title: null,
  info_act_generate_body: null,
  info_act_active_title: null,
  info_act_active_body: null,
  info_act_deadline_title: null,
  info_act_deadline_body: null,
  info_bb_page_title: null,
  info_bb_page_body: null,
  info_bulk_page_title: null,
  info_bulk_page_body: null,
  info_cancel_title: null,
  info_cancel_body: null,
  info_switch_title: null,
  info_switch_body: null,
  info_teams_page_title: null,
  info_teams_page_body: null,
  info_teams_unassigned_title: null,
  info_teams_unassigned_body: null,
  info_teams_bench_title: null,
  info_teams_bench_body: null,
  info_teams_publish_title: null,
  info_teams_publish_body: null,
  info_teams_score_title: null,
  info_teams_score_body: null,
  info_clubs_waiting_title: null,
  info_clubs_waiting_body: null,
  info_clubs_live_title: null,
  info_clubs_live_body: null,
  info_clubs_fee_title: null,
  info_clubs_fee_body: null,
  info_clubs_unsolicited_title: null,
  info_clubs_unsolicited_body: null,
  info_clubs_rejected_title: null,
  info_clubs_rejected_body: null,
  info_clubs_suspended_title: null,
  info_clubs_suspended_body: null,
  info_clubs_limits_title: null,
  info_clubs_limits_body: null,
  info_health_status_title: null,
  info_health_status_body: null,
  info_health_alerts_title: null,
  info_health_alerts_body: null,
  info_bill_page_title: null,
  info_bill_page_body: null,
  info_bill_card_title: null,
  info_bill_card_body: null,
  info_bill_past_title: null,
  info_bill_past_body: null,
  // F3, learned setup (2026-10-05).
  sj_dm_setup_intro: { group: "Old Boys Monday" },
  sj_dm_setup_intro_nothing: { group: "Old Boys Monday" },
  setup_applied_line: { key: "dropOutDeadline", day: "Mondayz", time: "21:05" },
  sj_dm_setup_from: { quote: "same squad as last week" },
  sj_dm_setup_undo: { url: "https://matchtime.ai/r/undo1" },
  sj_dm_setup_check_head: null,
  setup_suggestion_line: { key: "venue", current: "Goals Wimbledon", detected: "Powerleague Mill Hill" },
  sj_dm_setup_check_link: { url: "https://matchtime.ai/r/game1" },
  setup_monthly_pattern: { prepay: true, payg: true, credits: true },
  sj_dm_setup_monthly: { pattern: "regulars pay monthly", heldPaymentTracking: true },
  sj_dm_setup_outro: { url: "https://matchtime.ai/r/settings1" },
  setup_monthly_label: null,
  setup_lang_name: { key: "tr" },
  settings_learned_title: null,
  settings_learned_lead: null,
  settings_learned_undo: null,
  settings_learned_undone: null,
  settings_learned_changed_since: null,
  settings_learned_undo_failed: null,
  settings_learned_from: null,
  settings_learned_check_head: null,
  settings_learned_noted_head: null,
  // Monthly squad (2026-10-05, slice 2)
  msq_section_title: null,
  msq_section_lead: null,
  msq_mode_label: null,
  msq_mode_blurb: null,
  msq_mode_weekly: null,
  msq_mode_monthly: null,
  msq_rolling_note: null,
  msq_months_link: null,
  msq_payg_label: null,
  msq_payg_blurb: null,
  msq_opens_label: null,
  msq_opens_blurb: null,
  msq_opens_unit: null,
  msq_credit_label: null,
  msq_credit_blurb: null,
  msq_credit_any: null,
  msq_credit_filled: null,
  msq_credit_none: null,
  msq_instructions_label: null,
  msq_instructions_blurb: null,
  msq_instructions_placeholder: null,
  msq_save: null,
  msq_saved: null,
  msq_switched_monthly: null,
  msq_switched_weekly: null,
  msq_err_price: null,
  msq_err_days: null,
  msq_err_long: null,
  mth_nav: null,
  mth_page_title: null,
  mth_page_lead: null,
  mth_no_fixture: null,
  mth_no_players: null,
  mth_fixture_games: { games: 5, played: 2 },
  mth_empty_title: { month: "MONTHLABEL" },
  mth_empty_body: null,
  mth_paste_label: null,
  mth_paste_hint: null,
  mth_paste_button: null,
  mth_paste_read: { count: 11 },
  mth_paste_unmatched: { names: "NAMELIST" },
  mth_paste_month: null,
  mth_paste_not_list: null,
  mth_games_label: null,
  mth_played_label: null,
  mth_share_label: null,
  mth_share_hint: null,
  mth_col_in: null,
  mth_col_slot: null,
  mth_col_player: null,
  mth_col_type: null,
  mth_col_paid: null,
  mth_col_amount: null,
  mth_col_credits: null,
  mth_col_games: null,
  mth_col_credits_used: null,
  mth_col_due: null,
  mth_kind_regular: null,
  mth_kind_payg: null,
  mth_paid_none: null,
  mth_paid_claimed: null,
  mth_paid_confirmed: null,
  mth_due_unknown: null,
  mth_selected_count: { regulars: 11, payg: 3 },
  mth_nothing_posts: null,
  mth_start_button: { month: "MONTHLABEL" },
  mth_started: { month: "MONTHLABEL" },
  mth_status: { status: "running" },
  mth_started_mid: { played: 3 },
  mth_share_line: { amount: "£7.50" },
  mth_no_share: null,
  mth_paid_amount: { state: "STATELABEL", amount: "£22.50" },
  mth_start_error: { key: "no-players" },
  info_st_monthly_title: null,
  info_st_monthly_body: null,
  info_msq_mode_title: null,
  info_msq_mode_body: null,
  info_msq_payg_title: null,
  info_msq_payg_body: null,
  info_msq_opens_title: null,
  info_msq_opens_body: null,
  info_msq_credit_title: null,
  info_msq_credit_body: null,
  info_msq_instructions_title: null,
  info_msq_instructions_body: null,
  info_mth_page_title: null,
  info_mth_page_body: null,
  info_mth_start_title: null,
  info_mth_start_body: null,
  info_mth_paste_title: null,
  info_mth_paste_body: null,
  info_mth_paid_title: null,
  info_mth_paid_body: null,
  info_mth_credits_title: null,
  info_mth_credits_body: null,
  // Monthly squad, slice 5 (2026-10-06): the weekly flow
  mwk_list_header: { month: "October", when: "Mon 12 Oct, 20:00" },
  mwk_list_paid: null,
  mwk_list_cant_play_paid: null,
  mwk_list_cant_play: null,
  mwk_list_reserves: null,
  mwk_list_open: { open: 3, price: "£8" },
  mwk_list_open_organiser: { open: 3 },
  mwk_pool_group: { open: 3, when: "Mon 12 Oct, 20:00", price: "£8" },
  mwk_dm_sender_not_matched: { names: ["Gaz", "Tariq"] },
  mwk_dm_sender_not_list: { month: "October" },
  mwk_pool_dm: { firstName: "Omar", activityName: "Monday 7-a-side", when: "Mon 12 Oct, 20:00", price: "£8" },
  mwk_dm_moved_out_paid: { actor: "Rob", activityName: "Monday 7-a-side", when: "Mon 12 Oct, 20:00" },
  mwk_dm_moved_out: { actor: "Rob", activityName: "Monday 7-a-side", when: "Mon 12 Oct, 20:00" },
  mwk_dm_added: { actor: "Rob", activityName: "Monday 7-a-side", when: "Mon 12 Oct, 20:00" },
  mwk_admin_paste_ignored: { actor: "Alex", names: ["Bilal", "Chris"], when: "Mon 12 Oct, 20:00" },
  mwk_admin_paste_not_added: { actor: "Alex", names: ["Tariq", "Big O"], when: "Mon 12 Oct, 20:00" },
  mwk_dm_bumped: { firstName: "Zed", activityName: "Monday 7-a-side", when: "Mon 12 Oct, 20:00" },
  // Monthly squad, slice 3 (2026-10-06): the month opens, sign-up
  msq_list_note: null,
  msu_list_header: { month: "MONTHLABEL", games: 5, weekday: "WEEKDAYLABEL", days: "2, 9, 16, 23, 30" },
  msu_list_carried: { prev: "MONTHLABEL" },
  msu_list_out: { month: "Monthlabel" },
  msu_list_join: { month: "Monthlabel" },
  msu_list_payg: { day: 9 },
  msu_list_link: { url: "https://matchtime.ai/month" },
  msu_list_deadline: { when: "Tue 27 Oct, 10:00" },
  msu_dm_waiting: { firstName: "Zed", month: "MONTHLABEL", max: 14 },
  msu_dm_payg: { firstName: "Zed", month: "MONTHLABEL", days: "9, 23" },
  msu_admin_waiting: { name: "Zed Stone", month: "MONTHLABEL", max: 14, link: "https://matchtime.ai/admin/months" },
  msu_dm_paste_others: { names: ["Gaz", "Tariq"], month: "Monthlabel" },
  msu_dm_locked: { month: "MONTHLABEL" },
  msu_dm_unknown_days: { days: "10, 11", month: "MONTHLABEL", games: "2, 9, 16, 23, 30" },
  mth_signup_open: { when: "Tue 27 Oct, 10:00" },
  mth_signup_ended: null,
  mth_signup_counts: { regulars: 12, max: 14, payg: 3, waiting: 1 },
  mth_kind_waiting: null,
  mth_payg_days: { days: "9, 23" },
  mth_act_regular: null,
  mth_act_payg: null,
  mth_act_remove: null,
  mth_act_error: null,
  mth_add_label: null,
  mth_add_regular: null,
  mth_add_payg: null,
  mth_next_month: { month: "MONTHLABEL" },
  info_mth_signup_title: null,
  info_mth_signup_body: null,
  mmp_title: { month: "MONTHLABEL" },
  mmp_games: { games: 5, days: "2, 9, 16, 23, 30" },
  mmp_none: null,
  mmp_state: { outcome: "regular", slot: 7, days: null },
  mmp_btn_in: null,
  mmp_btn_payg: null,
  mmp_btn_out: null,
  mmp_payg_pick: null,
  mmp_closed: null,
  mmp_locked: null,
  mmp_error: null,
  // Monthly squad, slice 4 (2026-10-06): price, payments, reminders
  mpy_priced_header: { month: "MONTHLABEL", share: "£7.50", when: "Fri 30 Oct, 21:00", collector: "Sam" },
  mpy_priced_sub: { games: 5, full: "£37.50" },
  mpy_list_paid_amount: { amount: "£37.50" },
  mpy_priced_instructions: { text: "INSTRUCTIONSTEXT" },
  mpy_priced_how: null,
  mpy_group_reminder: { count: 4, month: "MONTHLABEL", when: "Fri 30 Oct, 21:00" },
  mpy_dm_reminder: {
    kind: "r1",
    firstName: "Zed",
    month: "MONTHLABEL",
    amount: "£30",
    games: 5,
    credits: 1,
    when: "Fri 30 Oct, 21:00",
    collector: "Sam",
    instructions: "INSTRUCTIONSTEXT",
  },
  mpy_dm_claim_ack: { firstName: "Zed", amount: "£37.50", month: "MONTHLABEL", collector: "Sam" },
  mpy_admin_price_ask: { month: "MONTHLABEL", regulars: 12, payg: 2, link: "https://matchtime.ai/admin/months", tip: "TIPTEXT" },
  mpy_fee_tip: { price: "£9.99", regulars: 12, games: 5, perGame: "20p", perMonth: "£1" },
  mpy_digest: { count: 3, month: "MONTHLABEL", lines: ["1. Alex £37.50", "2. Bilal £30"] },
  mpy_reply_confirmed: { month: "MONTHLABEL", names: ["Alex", "Bilal"] },
  mpy_reply_declined: { month: "MONTHLABEL", names: ["Alex", "Bilal"] },
  mpy_reply_unknown: { numbers: "7, 9", month: "MONTHLABEL" },
  mpy_reply_stale: null,
  mpy_reply_other_month: { month: "Monthlabel", other: "Othermonth" },
  mpy_reply_no_digest: null,
  mpy_summary_head: { month: "MONTHLABEL" },
  mpy_summary_confirmed: { count: 11, total: "£282.50" },
  mpy_summary_claimed: { count: 1, names: "NAMELIST" },
  mpy_summary_unpaid: { count: 2, names: "NAMELIST" },
  mpy_summary_venue: { due: "£450", venue: "£480" },
  mpy_none: null,
  mth_price_title: null,
  mth_price_share: null,
  mth_price_concession: null,
  mth_price_venue: null,
  mth_price_payby: null,
  mth_price_suggest: { amount: "£7.50" },
  mth_price_save: null,
  mth_price_update: null,
  mth_price_posts: null,
  mth_price_locked: null,
  mth_price_error: { key: "bad-share" },
  mth_payby_line: { when: "Fri 30 Oct, 21:00" },
  mth_confirm: null,
  mth_unconfirm: null,
  mth_confirm_error: { key: "not-collector" },
  info_mth_price_title: null,
  info_mth_price_body: null,
  mmp_due: { amount: "£30", games: 5, credits: 1 },
  mmp_payby: { when: "Fri 30 Oct, 21:00", collector: "Sam" },
  mmp_not_priced: null,
  mmp_btn_paid: null,
  mmp_paid_state: { kind: "claimed" },
  // Monthly squad, slice 6.
  mcl_cancel_credit: { count: 3 },
  mcl_sum_head: { month: "MONTHLABEL", games: 4 },
  mcl_sum_regulars: { count: 12, confirmed: 11, total: "£282.50" },
  mcl_sum_claimed: { count: 2, names: "Jake £22.50" },
  mcl_sum_unpaid: { count: 3, names: "Carl £30" },
  mcl_sum_owes_more: { names: "Dev £2" },
  mcl_sum_owed_back: { names: "Ed £2" },
  mcl_sum_payg: { games: 6, total: "£48", paid: 4 },
  mcl_sum_payg_chase: { count: 2, names: "Omar 12 Oct" },
  mcl_sum_payg_none: null,
  mcl_sum_leavers: { names: "Jake 2 games (£15)" },
  mcl_sum_owed_games: { name: "Jake", games: 2 },
  mcl_sum_carried: { games: 9, names: "Sam x2, Rob" },
  mcl_sum_carried_none: null,
  mcl_sum_used: { games: 10 },
  mcl_sum_page: { link: "https://matchtime.test/admin/months" },
  mcl_leaver_notice: { name: "Jake Moss", month: "MONTHLABEL", games: 2, amount: "£15", link: "https://matchtime.test/admin/months" },
  mcl_share_head: { month: "MONTHLABEL", share: "£8" },
  mcl_share_owes: { names: "Alex £2" },
  mcl_share_back: { names: "Ed £3" },
  mcl_share_none: null,
  mcl_share_foot: { link: "https://matchtime.test/admin/months" },
  mcl_midjoin_dm: { firstName: "Dev", month: "MONTHLABEL", games: 3, amount: "£22.50", collector: "Sam" },
  mcl_midjoin_admin: { name: "Dev Patel", month: "MONTHLABEL", games: 3, amount: "£22.50", link: "https://matchtime.test/admin/months" },
  mth_bal_owes: { amount: "£2" },
  mth_bal_back: { amount: "£2" },
  mth_refunded: { amount: "£15" },
  mth_leavers_title: null,
  mth_leavers_lead: null,
  mth_leaver_owed: { games: 2, amount: "£15" },
  mth_leaver_settled: null,
  mth_refund_label: null,
  mth_refund_btn: null,
  mth_refund_error: null,
  mth_refund_collector_only: null,
  mth_share_change_title: null,
  mth_share_change_lead: null,
  mth_share_change_ack: null,
  mth_share_change_btn: null,
  mth_summary_title: null,
  mth_credits_link: null,
  mth_earlier: { month: "MONTHLABEL" },
  mth_back_current: null,
  mth_viewing_past: { month: "MONTHLABEL" },
  mcr_title: null,
  mcr_lead: null,
  mcr_back: null,
  mcr_add_title: null,
  mcr_add_player: null,
  mcr_add_games: null,
  mcr_add_reason: null,
  mcr_add_reason_hint: null,
  mcr_add_btn: null,
  mcr_error: { key: "bad-reason" },
  mcr_empty: null,
  mcr_available: { games: 7 },
  mcr_col_date: null,
  mcr_col_reason: null,
  mcr_col_state: null,
  mcr_reason: { kind: "missed", day: "Mon 12 Oct" },
  mcr_state: { status: "used", detail: "MONTHLABEL" },
  mcr_remove_btn: null,
  mcr_remove_reason: null,
  mcr_remove_confirm: null,
  mcr_cancel: null,
  info_mcr_title: null,
  info_mcr_body: null,
  mmp_away_title: null,
  mmp_away_lead: { kind: "any-miss" },
  mmp_away_save: null,
  mmp_away_saved: null,
  mmp_away_seeded: { day: "Mon 12 Oct" },
  mmp_away_none: null,
  mmp_join_rest: { games: 3, amount: "£22.50" },
  mmp_btn_join_rest: null,
  mmp_bal_owes: { amount: "£2" },
  mmp_bal_back: { amount: "£2" },
  mwp_title: null,
  mwp_tag_paid: null,
  mwp_tag_monthly: null,
  mwp_tag_payg: null,
  mwp_cant_paid: null,
  mwp_cant: null,
  mwp_open: { open: 2 },
};

/** Render an entry with its sample arguments. */
function render(table: Strings, key: keyof Strings): string {
  const entry = table[key];
  if (typeof entry === "function") {
    return (entry as (p: unknown) => string)(SAMPLES[key]);
  }
  return String(entry);
}

const KEYS = Object.keys(en) as Array<keyof Strings>;

describe("string tables: completeness", () => {
  it("ships a table for every language in LANGS, and nothing else", () => {
    expect(Object.keys(TABLES).sort()).toEqual([...LANGS].sort());
  });

  it("every key in en exists in every other table, and vice versa", () => {
    const enKeys = Object.keys(en).sort();
    for (const lang of LANGS) {
      const keys = Object.keys(TABLES[lang]).sort();
      expect(keys, `keys of ${lang}`).toEqual(enKeys);
    }
  });

  it("every entry is a function or a string, in every table", () => {
    for (const lang of LANGS) {
      for (const [key, entry] of Object.entries(TABLES[lang])) {
        expect(
          typeof entry === "function" || typeof entry === "string",
          `${lang}.${key} must be a function or a string`,
        ).toBe(true);
      }
    }
  });

  it("every key has a sample argument entry (and no extras)", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...KEYS].sort());
  });

  it("carries the week-one group subset (Phase 2 slice 1)", () => {
    for (const key of [
      "announce_match",
      "squad_status_lead",
      "playing_header",
      "bench_header",
      "roster_confirmed_header",
      "match_day_header",
      "match_day_locked_line",
      "daily_in_list_fallback_lead",
      "squad_complete_header",
      "squad_complete_bench_invite",
      "teams_post_header",
      "teams_post_footer",
      "slot_opened",
      "bench_offer_group_post",
      "bench_offer_context_team",
      "rate_promo",
      "match_day_chase_fallback",
      "unpaid_tail",
      "payment_poll_question",
    ]) {
      expect(KEYS, key).toContain(key);
    }
  });
});

describe("string tables: the Turkish is translated", () => {
  /** The Turkish file's CODE lines: the docblocks talk about the rules
   *  and are allowed to name them. */
  const source = readFileSync(path.resolve(__dirname, "../strings.tr.ts"), "utf8")
    .split("\n")
    .filter((line) => {
      const l = line.trim();
      return !(l.startsWith("//") || l.startsWith("*") || l.startsWith("/*"));
    })
    .join("\n");

  it("no entry is wrapped in untranslated()", () => {
    expect(source).not.toMatch(/untranslated\(/);
  });

  it("no entry delegates to the English table", () => {
    expect(source).not.toMatch(/\ben\.[a-z_]+/);
    for (const key of KEYS) {
      expect(tr[key], `tr.${key} is the very same value as en.${key}`).not.toBe(en[key]);
    }
  });

  it("no entry renders to the English text", () => {
    for (const key of KEYS) {
      expect(render(tr, key), `tr.${key}`).not.toBe(render(en, key));
    }
  });

  it("no Turkish entry contains an English instruction token the group is never told to type", () => {
    // The Turkish group is told to write *VARIM*; an "*IN*" left in a
    // Turkish sentence is a half-moved string. (The team commands are
    // pinned separately, in tr-team-commands.test.ts.)
    for (const key of KEYS) {
      expect(render(tr, key), `tr.${key}`).not.toMatch(/\*IN\*|\bsay IN\b|\breply IN\b/);
    }
  });
});

describe("string tables: hygiene", () => {
  // 2026-09-30, MT Test: the organiser's join DM ended in a bare
  // "/admin/players/phones". WhatsApp does not make a path tappable, and
  // typed into a browser it lands on a sign-in page. A link to a page is
  // always a full URL (an admin's own signed-in link, or the public URL).
  it("no entry sends a bare /admin path: every page is a full URL", () => {
    for (const lang of LANGS) {
      for (const key of KEYS) {
        const out = render(TABLES[lang], key);
        expect(out, `${lang}.${key}`).not.toMatch(/(^|[\s:(])\/admin\b/m);
      }
    }
  });

  // 2026-09-30, Kemal's second setup on "MT Test": the completion post
  // and the how-to still read "squad — no need to type anyone in",
  // "availability — no need to tag me". The ENGLISH table is not held to
  // the dash rule in general (it moved in byte for byte), but everything
  // a new club reads while setting up, and every organiser DM about it,
  // is: the setup questions and acks, the completion posts, the how-to,
  // help, the setup DMs and the join DM.
  it("no onboarding, help or organiser-setup entry carries an em or en dash, in any language", () => {
    const onboarding = KEYS.filter((k) =>
      /^(onb|dm_admin_join|sj_dm|sj_group_hello|request_not_handled|admin_group_|settings_admin_channel_|setup_|settings_learned_|msq_|mth_|mwk_|msu_|mmp_|mpy_|info_st_monthly_|info_msq_|info_mth_)/.test(String(k)),
    );
    expect(onboarding.length).toBeGreaterThan(40);
    for (const lang of LANGS) {
      for (const key of onboarding) {
        expect(render(TABLES[lang], key), `${lang}.${key}`).not.toMatch(/[—–]/);
      }
    }
  });

  it("no entry renders to an empty string", () => {
    for (const lang of LANGS) {
      for (const key of KEYS) {
        expect(render(TABLES[lang], key).trim().length, `${lang}.${key}`).toBeGreaterThan(0);
      }
    }
  });

  it("no Turkish entry contains an em dash or an en dash", () => {
    for (const key of KEYS) {
      expect(render(tr, key), `tr.${key}`).not.toMatch(/[—–]/);
    }
  });

  it("no entry in any table opens with a time-of-day greeting", () => {
    const greeting =
      /^(?:\W*)(?:good\s+)?(?:morning|afternoon|evening)\b|^(?:\W*)(?:günaydın|iyi akşamlar|iyi günler|iyi geceler|selamlar|merhabalar)\b/iu;
    for (const lang of LANGS) {
      for (const key of KEYS) {
        expect(render(TABLES[lang], key), `${lang}.${key}`).not.toMatch(greeting);
      }
    }
  });

  it("no entry carries a send-time stamp", () => {
    // "5pm update", "17:00 update", "17:00 güncellemesi", "akşam
    // güncellemesi": a post that names the hour it was scheduled for is
    // wrong whenever it fires late (the 2026-09-04 incident). The
    // kickoff TIME is allowed and is passed in as an argument, never
    // written into an entry.
    const stamp = /\b\d{1,2}\s*(?:am|pm)\b\s*(?:update|güncelleme)|\b\d{1,2}:\d{2}\s*(?:update|güncelleme)|\b(?:morning|evening|akşam|sabah)\s+(?:update|güncelleme)/iu;
    for (const lang of LANGS) {
      for (const key of KEYS) {
        expect(render(TABLES[lang], key), `${lang}.${key}`).not.toMatch(stamp);
      }
    }
  });

  /** Arguments that are a closed set the entry BRANCHES on rather than
   *  text it prints: the rendered sentence says "replied by DM", never
   *  the token "dm". */
  const ENUM_ARGS = new Set(["source", "verb", "self", "status", "key", "englishLabel", "dow", "topic", "dayNum", "kind", "category", "decision", "field", "englishBlurb", "table", "audience", "mode", "outcome"]);

  it("every parameterised entry uses every argument it is given", () => {
    // A string or number argument must appear in the output; a boolean,
    // an array or an enum only has to be accepted (the entry branches on it).
    for (const lang of LANGS) {
      for (const key of KEYS) {
        const args = SAMPLES[key];
        if (args === null) continue;
        const out = render(TABLES[lang], key);
        for (const [name, value] of Object.entries(args as Record<string, unknown>)) {
          if (ENUM_ARGS.has(name)) continue;
          if (typeof value === "string" || typeof value === "number") {
            expect(out, `${lang}.${key} ignores its "${name}" argument`).toContain(String(value));
          }
        }
      }
    }
  });
});

describe("t(): resolution", () => {
  it("returns the English table for 'en' and the Turkish table for 'tr'", () => {
    expect(t("en")).toBe(en);
    expect(t("tr")).toBe(tr);
  });

  it("a parameterised entry is wired end to end in both languages", () => {
    expect(t("en").bench_header({ count: 2 })).toBe("*Bench (2):*");
    expect(t("tr").bench_header({ count: 2 })).toBe("*Yedekler (2):*");
  });

  it("falls back to English for anything the product does not ship", () => {
    expect(t("fr")).toBe(en);
    expect(t("")).toBe(en);
    expect(t(null)).toBe(en);
    expect(t(undefined)).toBe(en);
    expect(t("xx-YY")).toBe(en);
  });

  it("forgives case, region suffixes and whitespace", () => {
    expect(t("TR")).toBe(tr);
    expect(t(" tr ")).toBe(tr);
    expect(t("tr-TR")).toBe(tr);
    expect(t("tr_TR")).toBe(tr);
    expect(t("en-GB")).toBe(en);
  });
});

describe("lang helpers", () => {
  it("DEFAULT_LANG is English", () => {
    expect(DEFAULT_LANG).toBe("en");
  });

  it("normaliseLang mirrors t()'s rules and never returns an unknown code", () => {
    expect(normaliseLang("tr")).toBe("tr");
    expect(normaliseLang("TR")).toBe("tr");
    expect(normaliseLang("tr-TR")).toBe("tr");
    expect(normaliseLang("en")).toBe("en");
    expect(normaliseLang("de")).toBe("en");
    expect(normaliseLang(null)).toBe("en");
    expect(normaliseLang(undefined)).toBe("en");
    expect(normaliseLang("")).toBe("en");
    expect(normaliseLang("   ")).toBe("en");
  });

  it("isLang is strict (no normalisation)", () => {
    expect(isLang("tr")).toBe(true);
    expect(isLang("TR")).toBe(false);
    expect(isLang("fr")).toBe(false);
    expect(isLang(null)).toBe(false);
    expect(isLang(3)).toBe(false);
  });

  it("every shipped language has a picker label", () => {
    for (const lang of LANGS) {
      expect(LANG_LABELS[lang].trim().length).toBeGreaterThan(0);
    }
  });
});
