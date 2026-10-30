/**
 * HINTS INVITE PEOPLE'S OWN WORDS (Kemal, 2026-10-18).
 *
 * "MatchTime's replies must not make people think they have to type an
 * exact phrase." Everything below is understood by the AI pipeline (the
 * shared router and its extractors, in the players' group, the admin
 * group and DMs), so a hint says "in your own words" or "ask me" and
 * gives ONE example, instead of `write "put Zayn in"` or `Type *teams*`.
 *
 * What is NOT here, on purpose, because the input really is a fixed
 * token read by code with no model: YES / EVET to a question, GO, a
 * number or name from a numbered pick list, ALL / NONE, PAID ALL / PAID
 * 1 3, the help keyword and its topics (`readHelpRequest`), the DM
 * opt-in words ("start messages"), the admin-group link command. The
 * one-word attendance answers (IN / OUT / maybe, VARIM / YOKUM / belki)
 * are also left as they are: they are the group's own vocabulary, not a
 * phrase to learn.
 *
 * Each case: the rendered string invites the reader's own words (or asks
 * them to ask), carries an example, and no longer tells them to type a
 * quoted command.
 */
import { describe, it, expect } from "vitest";
import { en } from "../strings.en";
import { tr } from "../strings.tr";
import { buildHowToUseMe } from "../../onboarding-conversation";

const ALL_ON = {
  attendance: true,
  teamBalancing: true,
  momVoting: true,
  playerRating: true,
  statsQa: true,
  reminders: true,
  bench: true,
  paymentTracking: true,
};

const intro = {
  club: "FNF",
  live: true,
  dow: 5,
  tracks: true,
  teamsAt: "18:00",
  graphics: true,
  mom: true,
  ratings: true,
  organisersShare: false,
  mainChatList: true,
  teamsPosted: true,
  picks: false,
  paid: false,
  relayRatings: false,
};

const uneven = { redLabel: "Red", red: 8, yellowLabel: "Yellow", yellow: 6 };
const score = { redLabel: "Red", red: 5, yellow: 3, yellowLabel: "Yellow" };

/** [label, rendered text, the old instruction that must be gone]. */
type Case = [string, string, RegExp];

const EN_CASES: Case[] = [
  ["teams_post_footer", en.teams_post_footer, /Reply `@Match Time swap X with Y`/],
  ["match_day_locked_line", en.match_day_locked_line, /Say \*@Match Time generate the teams\*/],
  ["teams_not_generated", en.teams_not_generated, /Say '@Match Time generate the teams'/],
  ["score_recorded_hint", en.score_recorded_hint(score), /tell me "no, it was"/],
  ["bench_claim_team", en.bench_claim_team({ claimer: "Ali", dropped: "Sam", teamLabel: "Red" }), /Say "@Match Time regenerate the teams"/],
  ["team_ops_say_generate", en.team_ops_say_generate, /Say "@Match Time generate the teams"/],
  ["swap_deferred", en.swap_deferred({ a: "Ali", b: "Sam" }), /say \*@Match Time generate the teams\*/],
  ["swap_refused_teams_not_generated", en.swap_refused_teams_not_generated, /Say \*@Match Time generate the teams\* first/],
  ["intro_teams", en.intro_teams, /Say "@Match Time generate the teams"|Reply `@Match Time swap X with Y`/],
  ["intro_reminders", en.intro_reminders, /Say "@MatchTime remind me Monday"/],
  ["onbHowToUseMe (reminders line)", buildHowToUseMe(ALL_ON, "en"), /Say \*"@Match Time remind me Thursday"\*/],
  ["onbHelpExplainer ratings", en.onbHelpExplainer({ topic: "ratings" }), /Type \*@Match Time my stats\*/],
  ["onbHelpExplainer mom", en.onbHelpExplainer({ topic: "mom" }), /Type \*@Match Time my stats\*/],
  ["onbHelpExplainer teams", en.onbHelpExplainer({ topic: "teams" }), /Tag \*@Match Time generate the teams\* when|ask me to \*"@Match Time show the teams"\*/],
  ["onbHelpExplainer reminders", en.onbHelpExplainer({ topic: "reminders" }), /Say \*"@Match Time remind me Thursday"\*/],
  ["onbHelpExplainer payments", en.onbHelpExplainer({ topic: "payments" }), /Tag \*@Match Time who still owes\?\* to see/],
  ["onbHelpOrganisersExplainer reminders", en.onbHelpOrganisersExplainer({ topic: "reminders", organiserPicks: false }), /Say \*"@Match Time remind me Thursday"\*/],
  ["onbHelpAdminOrganisers", en.onbHelpAdminOrganisers, /type \*help\* and I'll show the commands/],
  ["sj_group_hello", en.sj_group_hello({ organiser: "Raihan" }), /say \*"@Match Time remind me Thursday"\*/],
  ["sj_hello_remind", en.sj_hello_remind, /say \*"@Match Time remind me Thursday"\*/],
  ["admin_group_intro (live)", en.admin_group_intro(intro), /Type \*help\* here/],
  ["admin_group_intro (not live)", en.admin_group_intro({ ...intro, live: false }), /type \*help\* here/],
  ["tp_how_to_change", en.tp_how_to_change({ a: "Sam", b: "Alex" }), /To change them: \*swap Sam Alex\* swaps/],
  ["tp_final_footer", en.tp_final_footer, /\*swap\* and \*move\* still work/],
  ["tp_no_teams", en.tp_no_teams, /Type \*teams\*/],
  ["tp_reminder", en.tp_reminder({ kickoff: "Fri 20:30" }), /Type \*teams\*/],
  ["tp_teams_set_aside", en.tp_teams_set_aside, /type \*teams\*/],
  ["tp_short_squad", en.tp_short_squad({ kickoff: "Fri 20:30", confirmed: 9, needed: 10 }), /type \*teams\*/],
  ["tp_uneven", en.tp_uneven(uneven), /\*move\* a player/],
  ["tp_uneven_confirm", en.tp_uneven_confirm(uneven), /\*move\* a player/],
  [
    "payments_live_announcement (direct)",
    en.payments_live_announcement({ collector: "Raihan", card: true, bank: false, direct: true }),
    /Just DM me \*Paid\*/,
  ],
  ["ao_ready_no_tag (reads)", en.ao_ready_no_tag({ reads: true, mainChat: false }), /just type the command/],
  ["ao_ready_no_tag (not reads)", en.ao_ready_no_tag({ reads: false, mainChat: false }), /just type the command|clear commands/],
  ["ao_ready_help_group", en.ao_ready_help_group, /Type \*help\* here/],
];

const TR_CASES: Case[] = [
  ["teams_post_footer", tr.teams_post_footer, /`@Match Time X ile Y'yi değiştir` yazın/],
  ["match_day_locked_line", tr.match_day_locked_line, /sohbete \*@Match Time takımları kur\* yazın/],
  ["teams_not_generated", tr.teams_not_generated, /\*@Match Time takımları kur\* yazın/],
  ["score_recorded_hint", tr.score_recorded_hint(score), /"hayır" diye başlayıp/],
  ["bench_claim_team", tr.bench_claim_team({ claimer: "Ali", dropped: "Sam", teamLabel: "Kırmızı" }), /"@Match Time takımları yeniden kur" yazın/],
  ["team_ops_say_generate", tr.team_ops_say_generate, /"@Match Time takımları kur" yazın/],
  ["swap_deferred", tr.swap_deferred({ a: "Ali", b: "Sam" }), /\*@Match Time takımları kur\* yazın/],
  ["swap_refused_teams_not_generated", tr.swap_refused_teams_not_generated, /\*@Match Time takımları kur\* yazın/],
  ["intro_teams", tr.intro_teams, /"@Match Time takımları kur" deyin|`@Match Time X ile Y'yi değiştir` yazsın/],
  ["intro_reminders", tr.intro_reminders, /"@Match Time pazartesi hatırlat" deyin/],
  ["onbHowToUseMe (reminders line)", buildHowToUseMe(ALL_ON, "tr"), /\*"@Match Time perşembe hatırlat"\* yazın/],
  ["onbHelpExplainer ratings", tr.onbHelpExplainer({ topic: "ratings" }), /\*@Match Time istatistiklerim\* yazın/],
  ["onbHelpExplainer mom", tr.onbHelpExplainer({ topic: "mom" }), /\*@Match Time istatistiklerim\* yazın/],
  ["onbHelpExplainer teams", tr.onbHelpExplainer({ topic: "teams" }), /takımları kur\* yazmanız yeter|takımları göster"\* yazın|renkleri değiştir\* yazın/],
  ["onbHelpExplainer payments", tr.onbHelpExplainer({ topic: "payments" }), /\*@Match Time kim ödemedi\?\* yazın/],
  ["onbHelpOrganisersExplainer reminders", tr.onbHelpOrganisersExplainer({ topic: "reminders", organiserPicks: false }), /hatırlat"\* yazın/],
  ["onbHelpAdminOrganisers", tr.onbHelpAdminOrganisers, /\*yardım\* yaz, orada kabul ettiğim komutları/],
  ["sj_group_hello", tr.sj_group_hello({ organiser: "Raihan" }), /hatırlat"\* yazın/],
  ["sj_hello_remind", tr.sj_hello_remind, /hatırlat"\* yazın/],
  ["admin_group_intro (live)", tr.admin_group_intro(intro), /\*yardım\* yazın/],
  ["admin_group_intro (not live)", tr.admin_group_intro({ ...intro, live: false }), /\*yardım\* yazın/],
  ["tp_how_to_change", tr.tp_how_to_change({ a: "Ali", b: "Can" }), /\*Ali ile Can değiş\* iki oyuncunun/],
  ["tp_final_footer", tr.tp_final_footer, /\*değiş\* ve \*taşı\* hâlâ çalışır/],
  ["tp_no_teams", tr.tp_no_teams, /\*takımlar\* yazın/],
  ["tp_reminder", tr.tp_reminder({ kickoff: "Cum 20:30" }), /\*takımlar\*, sonra/],
  ["tp_teams_set_aside", tr.tp_teams_set_aside, /\*takımlar\* yazın/],
  ["tp_short_squad", tr.tp_short_squad({ kickoff: "Cum 20:30", confirmed: 9, needed: 10 }), /\*takımlar\* yazın/],
  ["tp_uneven", tr.tp_uneven({ ...uneven, redLabel: "Kırmızı", yellowLabel: "Sarı" }), /\*taşı\* ile geçirin/],
  ["tp_uneven_confirm", tr.tp_uneven_confirm({ ...uneven, redLabel: "Kırmızı", yellowLabel: "Sarı" }), /\*taşı\* ile geçirin/],
  [
    "payments_live_announcement (direct)",
    tr.payments_live_announcement({ collector: "Raihan", card: true, bank: false, direct: true }),
    /\*Ödedim\* yazın/,
  ],
  ["ao_ready_no_tag (reads)", tr.ao_ready_no_tag({ reads: true, mainChat: false }), /komutu yazmanız yeter/],
  ["ao_ready_no_tag (not reads)", tr.ao_ready_no_tag({ reads: false, mainChat: false }), /komutu yazmanız yeter|açık komutlarla/],
  ["ao_ready_help_group", tr.ao_ready_help_group, /\*yardım\* yazın/],
];

const EN_INVITE = /in your own words|just ask|ask me|tell me who|tag me and/i;
const EN_EXAMPLE = /for example|e\.g\./;
const TR_INVITE = /kendi cümle|bana sorun|sorun \(|isteyin|kimin diğer takıma/i;
const TR_EXAMPLE = /örneğin|örn\./;

describe("English hints invite the reader's own words, with an example", () => {
  for (const [label, text, old] of EN_CASES) {
    it(label, () => {
      expect(text).not.toMatch(old);
      expect(text).toMatch(EN_INVITE);
    });
  }
  it("every English hint that names a command shows it as an example", () => {
    for (const [label, text] of EN_CASES) {
      if (/^(tp_(final_footer|short_squad|uneven|uneven_confirm)|ao_ready_no_tag.*)$/.test(label)) continue;
      expect(text, label).toMatch(EN_EXAMPLE);
    }
  });
});

describe("Turkish hints invite the reader's own words, with an example", () => {
  for (const [label, text, old] of TR_CASES) {
    it(label, () => {
      expect(text).not.toMatch(old);
      expect(text).toMatch(TR_INVITE);
    });
  }
  it("every Turkish hint that names a command shows it as an example", () => {
    for (const [label, text] of TR_CASES) {
      if (/^(tp_(final_footer|short_squad|uneven|uneven_confirm)|ao_ready_no_tag.*)$/.test(label)) continue;
      expect(text, label).toMatch(TR_EXAMPLE);
    }
  });
});

describe("no em or en dashes in the rewritten hints", () => {
  for (const [label, text] of [...EN_CASES, ...TR_CASES]) {
    it(label, () => {
      expect(text).not.toMatch(/[–—]/);
    });
  }
});
