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
  bench_offer_context_team: { teamLabel: "Kırmızı", replacingName: "Sait Demir", activityName: "Tuesday 7-a-side" },
  bench_offer_context_team_plain: { teamLabel: "Kırmızı", replacingName: "Sait Demir", activityName: "Tuesday 7-a-side" },
  bench_offer_context_fixture: { activityName: "Tuesday 7-a-side" },
  bench_offer_context_fixture_plain: { activityName: "Tuesday 7-a-side" },
  rate_promo: { activityName: "Tuesday 7-a-side", matchDateLabel: "Tue 15 Sep" },
  match_day_chase_fallback: { need: 3, activityName: "Tuesday 7-a-side" },
  bench_offer_open: { benchNames: ["Erdal Ozkan", "Amir Ahmadi"] },
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

  // ── private messages (Phase 3) ──
  //   `dayNum`, `kind`, `category` and `decision` are branched on, not printed.
  dm_rating: { activityName: "Tuesday 7-a-side", dateLabel: "DATELABEL", mvpLabel: "MVPLABEL", rateUrl: "https://mt.example/s/rate", statsUrl: "https://mt.example/s/stats" },
  dm_rating_reminder: { dayNum: 1, firstName: "Sait", activityName: "Tuesday 7-a-side", mvpLabel: "MVPLABEL", url: "https://mt.example/s/rate" },
  dm_tentative_followup: { firstName: "Sait", activityName: "Tuesday 7-a-side", whenLabel: "WHENLABEL" },
  dm_tentative_reask: null,
  dm_tentative_ack: { decision: "in", failed: false },
  dm_bench_offer: { firstName: "Erdal", context: "CONTEXTCLAUSE", reactions: false },
  dm_bench_unclear: null,
  dm_bench_ack: { kind: "taken" },
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
  sj_dm_approved: { club: "Riverside FC", group: "Riverside Tuesday 5s", link: "https://matchtime.ai/admin/activities" },
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
      /^(onb|dm_admin_join|sj_dm|sj_group_hello|request_not_handled|admin_group_|settings_admin_channel_)/.test(String(k)),
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
  const ENUM_ARGS = new Set(["source", "verb", "self", "status", "key", "englishLabel", "dow", "topic", "dayNum", "kind", "category", "decision", "field", "englishBlurb", "table", "audience"]);

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
