/**
 * PLAYERS ARE TOLD "THE WAITING LIST", NOT "THE BENCH" (2026-10-16, FNF).
 *
 * MatchTime told FNF's players' group "Football 9-a-side is full at 18 of
 * 18, but the bench is open. Say IN to go on the bench, and the organisers
 * will pick who plays." The players replied "Bench?" and "We do bench
 * now?": the club had never used a bench, and the word meant nothing to
 * them. The manager had to post what it meant: "It's just the waiting list."
 *
 * So every message a PLAYER reads that is about waiting for a place says
 * "the waiting list". Where the club's own word helps, it follows once, in
 * brackets: "the waiting list (the bench)". It never says "the bench" on
 * its own. Admin-facing copy (the organisers' pick list, HQ, settings) is
 * not covered here and keeps "bench".
 *
 * Turkish already has a plain word for it, "yedek listesi", and the
 * player-facing Turkish uses that form every time it names the list.
 */
import { describe, it, expect } from "vitest";
import { t } from "../i18n/t";
import { buildGroupHello, DEFAULT_HELLO_SETTINGS, type GroupHelloSettings } from "../group-hello";
import { buildFullSquadBenchInvite, buildSquadCompleteBenchInvite, buildBenchIntroLine } from "../bench-offer-copy";
import { buildRollingAnnouncePost, buildSquadFullEveningPost, buildSquadRosterBlock, buildListPublishedPost } from "../scheduler-copy";
import { composeSquadStatusPost, buildSquadCompletePost, buildFormatSwitchAnnouncement } from "../group-copy";
import { buildHelpReply } from "../onboarding-conversation";

type Lang = "en" | "tr";

/** Every player-facing message that names the waiting list, rendered in
 *  every shape it takes (first-come and organiser pick). */
function playerMessages(lang: Lang): Record<string, string> {
  const s = t(lang);
  const how = s.bench_promotion_how({ reactions: false });
  const row = (n: string) => ({ name: n });
  const hello = (over: Partial<GroupHelloSettings>, hasSquadToCarry?: boolean) =>
    buildGroupHello({ organiser: "Erdal", lang, settings: { ...DEFAULT_HELLO_SETTINGS, ...over }, hasSquadToCarry });
  return {
    squad_status_post: composeSquadStatusPost({ confirmed: ["Ali", "Bob"], bench: ["Cem"], maxPlayers: 2, lang }),
    roster_block: buildSquadRosterBlock({ confirmed: [row("Ali")], bench: [row("Cem")], maxPlayers: 1, lang }),
    squad_full_evening_empty: buildSquadFullEveningPost({
      activityName: "Football 9-a-side",
      confirmedCount: 18,
      maxPlayers: 18,
      rosterBlock: null,
      benchCount: 0,
      benchInvite: buildSquadCompleteBenchInvite({ lang }),
      lang,
    }),
    squad_complete_post: buildSquadCompletePost({
      maxPlayers: 1,
      activityName: "Football",
      kickoffLabel: "Fri 20:30",
      confirmed: ["Ali"],
      bench: ["Cem"],
      benchInvite: buildSquadCompleteBenchInvite({ lang }),
      lang,
    }),
    squad_complete_bench_invite: buildSquadCompleteBenchInvite({ lang }),
    squad_complete_bench_invite_organiser: buildSquadCompleteBenchInvite({ lang, organiser: true }),
    bench_intro_line: buildBenchIntroLine({ lang }),
    bench_intro_line_organiser: buildBenchIntroLine({ lang, organiser: true }),
    full_squad_bench_invite: buildFullSquadBenchInvite({ matchName: "Football 9-a-side", confirmedCount: 18, maxPlayers: 18, lang }),
    full_squad_bench_invite_organiser: buildFullSquadBenchInvite({
      matchName: "Football 9-a-side",
      confirmedCount: 18,
      maxPlayers: 18,
      lang,
      organiser: true,
    }),
    bench_offer_group_post: s.bench_offer_group_post({ context: "for *Football* tonight", tagList: "@1 @2", reactions: false }),
    bench_offer_group_post_many: s.bench_offer_group_post_many({
      count: 2,
      context: "for *Football* tonight",
      details: [],
      tagList: "@1 @2",
      reactions: false,
    }),
    answer_bench_empty: s.answer_bench_empty,
    answer_bench_list: s.answer_bench_list({ names: ["Ali", "Cem"] }),
    answer_person_bench: s.answer_person_bench({ who: "Ali", kickoffLabel: "Fri 20:30" }),
    needs_tag_for_rest: s.needs_tag_for_rest({ dropped: [], benched: ["Ali"] }),
    bench_claim_too_late: s.bench_claim_too_late({ firstName: "Ali", confirmed: 13, maxPlayers: 14 }),
    oa_bench_claim_too_late: s.oa_bench_claim_too_late({ firstName: "Ali" }),
    oob_bench: s.oob_bench({ name: "Ali", source: "dm", confirmed: 14, maxPlayers: 14 }),
    format_switch_announcement: buildFormatSwitchAnnouncement({
      sportName: "Football",
      maxPlayers: 1,
      kickoffLine: "",
      playing: ["Ali"],
      bench: ["Cem"],
      lang,
    }),
    dm_bench_offer: s.dm_bench_offer({ firstName: "Ali", context: "for Football tonight", reactions: false }),
    dm_bench_offer_many: s.dm_bench_offer_many({ count: 2, firstName: "Ali", context: "for Football tonight", details: [], reactions: false }),
    dm_bench_unclear: s.dm_bench_unclear({ day: null }),
    dm_bench_ack_declined: s.dm_bench_ack({ kind: "declined", day: null }),
    dm_bench_ack_taken: s.dm_bench_ack({ kind: "taken", day: null }),
    dm_self_ack_bench: s.dm_self_ack({ failed: false, status: "BENCH", matchName: "Football", matchWhen: "Fri" }),
    dm_self_ack_waiting_organiser: s.dm_self_ack_waiting_organiser({ matchName: "Football", matchWhen: "Fri" }),
    dm_recruit_invite_play_organiser: s.dm_recruit_invite_play_organiser,
    dm_recruit_chase_organiser: s.dm_recruit_chase_organiser({ firstName: "Ali", count: 1, activityName: "Football", matchWhen: "Fri" }),
    slot_opened_organiser: s.slot_opened_organiser({ kickoffLabel: "Fri 20:30" }),
    rolling_post_full: buildRollingAnnouncePost({
      activityName: "Football",
      dateLabel: "Fri",
      venue: "Pitch",
      deadline: "Thu 21:00",
      confirmed: [row("Ali")],
      bench: [row("Cem")],
      maxPlayers: 1,
      lang,
    }),
    rolling_post_full_organiser: buildRollingAnnouncePost({
      activityName: "Football",
      dateLabel: "Fri",
      venue: "Pitch",
      deadline: "Thu 21:00",
      confirmed: [row("Ali")],
      bench: [],
      maxPlayers: 1,
      organiserPicks: true,
      lang,
    }),
    rolling_post_open_organiser: buildRollingAnnouncePost({
      activityName: "Football",
      dateLabel: "Fri",
      venue: "Pitch",
      deadline: "Thu 21:00",
      confirmed: [],
      bench: [],
      maxPlayers: 1,
      organiserPicks: true,
      lang,
    }),
    list_published: buildListPublishedPost({
      activityName: "Football",
      dateLabel: "Fri",
      venue: "Pitch",
      confirmed: [row("Ali")],
      bench: [row("Cem")],
      maxPlayers: 1,
      lang,
    }),
    mwk_list_open_organiser: s.mwk_list_open_organiser({ open: 2 }),
    mwk_dm_bumped: s.mwk_dm_bumped({ firstName: "Ali", activityName: "Football", when: "Fri" }),
    onb_intro: s.onbIntro(),
    onb_legacy_intro: s.onb_legacy_intro,
    sj_group_hello: s.sj_group_hello({ organiser: "Erdal" }),
    hello_default: hello({}),
    hello_organiser_pick: hello({ organisersPick: true }),
    hello_rolling_first_organiser: hello({ rollingSquad: true, organisersPick: true }, false),
    hello_rolling_join_organiser: hello({ rollingSquad: true, organisersPick: true }, true),
    hello_rolling_join_bench: hello({ rollingSquad: true }, true),
    hello_monthly_organiser: hello({ squadMode: "monthly", organisersPick: true }),
    help_availability: buildHelpReply("availability", { attendance: true } as never, lang),
    help_availability_organiser_picks: buildHelpReply("availability", { attendance: true, organiserPicks: true } as never, lang),
    help_availability_organisers: buildHelpReply("availability", { attendance: true, organisersAnnounce: true } as never, lang),
    help_availability_organisers_picks: buildHelpReply(
      "availability",
      { attendance: true, organisersAnnounce: true, organiserPicks: true } as never,
      lang,
    ),
  };
}

describe("English: players read 'the waiting list', never a bare 'bench'", () => {
  const messages = playerMessages("en");

  for (const [name, text] of Object.entries(messages)) {
    it(`${name} names the waiting list`, () => {
      expect(text).toMatch(/waiting list/i);
    });

    it(`${name} says 'bench' only as '(the bench)' after 'waiting list', at most once`, () => {
      const benches = text.match(/bench/gi) ?? [];
      expect(benches.length).toBeLessThanOrEqual(1);
      if (benches.length === 1) expect(text).toMatch(/waiting list\*?\s\(the bench\)/i);
    });
  }

  it("the FNF reply: plain words, and the organisers pick", () => {
    expect(messages.full_squad_bench_invite_organiser).toBe(
      "*Football 9-a-side* is full at 18 of 18, but the waiting list (the bench) is open. " +
        "Say *IN* to go on it, and when a place opens the organisers pick who plays. 🙏",
    );
  });

  it("first-come wording never says the organisers pick; organiser wording always does", () => {
    for (const k of ["full_squad_bench_invite", "squad_complete_bench_invite", "bench_intro_line", "rolling_post_full", "hello_default"]) {
      expect(messages[k], k).not.toMatch(/organisers pick|organisers will pick/);
    }
    for (const k of [
      "full_squad_bench_invite_organiser",
      "squad_complete_bench_invite_organiser",
      "bench_intro_line_organiser",
      "rolling_post_full_organiser",
      "rolling_post_open_organiser",
      "hello_organiser_pick",
      "hello_monthly_organiser",
      "slot_opened_organiser",
      "mwk_list_open_organiser",
      "help_availability_organiser_picks",
    ]) {
      expect(messages[k], k).toMatch(/organisers (will )?pick/);
    }
  });

  it("nobody is promised a place in a queue: the offer goes to everyone waiting", () => {
    for (const text of Object.values(messages)) {
      expect(text).not.toMatch(/first in line|first on the/i);
    }
  });
});

describe("Turkish: the list is 'yedek listesi' every time", () => {
  const messages = playerMessages("tr");

  for (const [name, text] of Object.entries(messages)) {
    it(`${name} names it as 'yedek listesi'`, () => {
      const forms = text.match(/yede[kğ]\p{L}*(?:\s+\p{L}+)?/giu) ?? [];
      expect(forms.length, text).toBeGreaterThan(0);
      for (const f of forms) expect(f, text).toMatch(/^yedek\s+listes/i);
    });
  }

  it("nobody is promised a place in a queue", () => {
    for (const text of Object.values(messages)) {
      expect(text).not.toMatch(/sıra sende|ilk sırada/i);
    }
  });
});
