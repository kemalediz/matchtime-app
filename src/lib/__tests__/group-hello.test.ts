/**
 * THE GROUP HELLO, BUILT FROM THE CLUB'S REAL SETTINGS (2026-10-12).
 * Slice S2 of the go-live plan. Pure: no database, no clock, no model.
 *
 * The one promise that must never break: for a club on default settings,
 * with the catch-up line left out, the builder returns today's
 * `sj_group_hello` byte for byte, in both languages.
 */
import { describe, expect, it } from "vitest";
import { en } from "../i18n/strings.en";
import { tr } from "../i18n/strings.tr";
import {
  DEFAULT_HELLO_SETTINGS,
  NO_HELLO_CLUB_FACTS,
  buildGroupHello,
  helloFeatureLines,
  helloInputFromOrg,
  signsUpEachWeek,
  withOptionalTag,
  type GroupHelloSettings,
  type HelloClubFacts,
  type HelloOrgRow,
} from "../group-hello";

const TABLES = { en, tr } as const;
type L = keyof typeof TABLES;
const LANGS: L[] = ["en", "tr"];

/** `carry`: MatchTime already has a squad to carry over. True unless a
 *  case says otherwise, so the rolling rows below are the standing form. */
const hello = (
  lang: L,
  patch: Partial<GroupHelloSettings> = {},
  extra: { organiser?: string | null; catchUp?: boolean; carry?: boolean } = {},
) =>
  buildGroupHello({
    organiser: extra.organiser === undefined ? "Ali" : extra.organiser,
    lang,
    catchUp: extra.catchUp,
    hasSquadToCarry: extra.carry ?? true,
    settings: { ...DEFAULT_HELLO_SETTINGS, ...patch },
  });

const MON_2100 = { day: 1, time: "21:00" };
/** The heading emoji of each feature line, in the order the hello says them. */
const FEATURE_EMOJI = ["👥", "⏰", "⭐", "⚖️", "🏆", "📊", "🤝", "🌍"];
const TUE_2000 = { day: 2, time: "20:00" };

describe("buildGroupHello: default settings are today's hello, byte for byte", () => {
  for (const lang of LANGS) {
    it(`${lang}: organiser named, catch-up left out`, () => {
      expect(hello(lang, {}, { catchUp: false })).toBe(TABLES[lang].sj_group_hello({ organiser: "Ali" }));
    });
    it(`${lang}: no organiser name, catch-up left out`, () => {
      expect(hello(lang, {}, { organiser: null, catchUp: false })).toBe(TABLES[lang].sj_group_hello({ organiser: null }));
    });
    it(`${lang}: with the catch-up line, the only difference is that one paragraph`, () => {
      const s = TABLES[lang];
      const withLine = hello(lang);
      expect(withLine).toContain(`\n\n${s.sj_hello_catch_up}\n\n`);
      expect(withLine.replace(`${s.sj_hello_catch_up}\n\n`, "")).toBe(s.sj_group_hello({ organiser: "Ali" }));
    });
  }
});

/** Each row: a settings patch, what the hello must say, what it must not. */
interface Row {
  name: string;
  patch: Partial<GroupHelloSettings>;
  has: (s: typeof en) => string[];
  hasNot: (s: typeof en) => string[];
  /** False: MatchTime has no squad to carry over yet (a first game). */
  carry?: boolean;
}

const MON = (s: typeof en) => `${s.wd_weekday({ dow: 1 })} 21:00`;

const ROWS: Row[] = [
  {
    name: "defaults: weekly sign-up, bench, the catch-up line, no fees line without pay links",
    patch: {},
    has: (s) => [
      s.sj_hello_whos_in,
      s.sj_hello_bench,
      s.sj_hello_catch_up,
      s.sj_hello_closer,
    ],
    hasNot: (s) => [
      s.sj_hello_rolling({ deadline: null }),
      s.sj_hello_bench_organiser,
      s.sj_hello_monthly,
    ],
  },
  {
    name: "rolling squad, no deadline: not told to say In each week, no catch-up",
    patch: { rollingSquad: true },
    has: (s) => [s.sj_hello_rolling({ deadline: null }), s.sj_hello_rolling_join({ mode: "bench" }), s.sj_hello_bench],
    hasNot: (s) => [s.sj_hello_whos_in, s.sj_hello_catch_up],
  },
  {
    name: "rolling squad with a drop-out deadline: the deadline is folded into the rolling line",
    patch: { rollingSquad: true, dropOutDeadline: MON_2100 },
    has: (s) => [s.sj_hello_rolling({ deadline: `${s.wd_weekday({ dow: 1 })} 21:00` })],
    hasNot: (s) => [
      s.sj_hello_whos_in,
      s.sj_hello_catch_up,
      s.sj_hello_deadline({ day: s.wd_weekday({ dow: 1 }), time: "21:00" }),
    ],
  },
  {
    name: "rolling squad, bench off: the join line does not promise a bench",
    patch: { rollingSquad: true, bench: false },
    has: (s) => [s.sj_hello_rolling_join({ mode: "no-bench" })],
    hasNot: (s) => [s.sj_hello_bench, s.sj_hello_rolling_join({ mode: "bench" })],
  },
  {
    name: "rolling squad, organisers pick: an In goes on the bench and the organisers pick",
    patch: { rollingSquad: true, organisersPick: true },
    has: (s) => [s.sj_hello_rolling_join({ mode: "organiser" }), s.sj_hello_bench_organiser],
    hasNot: (s) => [s.sj_hello_bench, s.sj_hello_rolling_join({ mode: "bench" })],
  },
  // ── A rolling club MatchTime has no squad for yet (2026-10-13): the
  //    first game. Nobody is "in already", so nobody is told they are. ──
  {
    name: "rolling squad, FIRST GAME: say In for the first game, then you stay in",
    carry: false,
    patch: { rollingSquad: true },
    has: (s) => [s.sj_hello_rolling_first({ deadline: null, mode: "first-come" }), s.sj_hello_bench],
    hasNot: (s) => [
      s.sj_hello_rolling({ deadline: null }),
      s.sj_hello_rolling_join({ mode: "bench" }),
      s.sj_hello_whos_in,
      s.sj_hello_catch_up,
    ],
  },
  {
    name: "rolling squad, FIRST GAME, with a drop-out deadline folded in",
    carry: false,
    patch: { rollingSquad: true, dropOutDeadline: MON_2100 },
    has: (s) => [s.sj_hello_rolling_first({ deadline: MON(s), mode: "first-come" })],
    hasNot: (s) => [
      s.sj_hello_rolling({ deadline: MON(s) }),
      s.sj_hello_rolling_first({ deadline: null, mode: "first-come" }),
      s.sj_hello_deadline({ day: s.wd_weekday({ dow: 1 }), time: "21:00" }),
      s.sj_hello_rolling_join({ mode: "bench" }),
      s.sj_hello_catch_up,
    ],
  },
  {
    name: "rolling squad, FIRST GAME, organisers pick: an In goes on the bench and the organisers pick",
    carry: false,
    patch: { rollingSquad: true, organisersPick: true, dropOutDeadline: MON_2100 },
    has: (s) => [s.sj_hello_rolling_first({ deadline: MON(s), mode: "organiser" }), s.sj_hello_bench_organiser],
    hasNot: (s) => [
      s.sj_hello_rolling({ deadline: MON(s) }),
      s.sj_hello_rolling_first({ deadline: MON(s), mode: "first-come" }),
      s.sj_hello_rolling_join({ mode: "organiser" }),
      s.sj_hello_bench,
      s.sj_hello_catch_up,
    ],
  },
  {
    name: "rolling squad, FIRST GAME, bench off",
    carry: false,
    patch: { rollingSquad: true, bench: false },
    has: (s) => [s.sj_hello_rolling_first({ deadline: null, mode: "first-come" })],
    hasNot: (s) => [s.sj_hello_bench, s.sj_hello_rolling_join({ mode: "no-bench" })],
  },
  {
    name: "no squad to carry changes nothing for a club that signs up each week",
    carry: false,
    patch: {},
    has: (s) => [s.sj_hello_whos_in, s.sj_hello_catch_up],
    hasNot: (s) => [s.sj_hello_rolling_first({ deadline: null, mode: "first-come" })],
  },
  {
    name: "no squad to carry changes nothing for a monthly club",
    carry: false,
    patch: { squadMode: "monthly", rollingSquad: true },
    has: (s) => [s.sj_hello_monthly],
    hasNot: (s) => [s.sj_hello_rolling_first({ deadline: null, mode: "first-come" })],
  },
  {
    name: "weekly sign-up with a drop-out deadline: its own line",
    patch: { dropOutDeadline: MON_2100 },
    has: (s) => [s.sj_hello_whos_in, s.sj_hello_deadline({ day: s.wd_weekday({ dow: 1 }), time: "21:00" }), s.sj_hello_catch_up],
    hasNot: (s) => [s.sj_hello_rolling({ deadline: `${s.wd_weekday({ dow: 1 })} 21:00` })],
  },
  {
    name: "final list day set",
    patch: { listPublish: TUE_2000 },
    has: (s) => [s.sj_hello_list({ day: s.wd_weekday({ dow: 2 }), time: "20:00" })],
    hasNot: () => [],
  },
  {
    name: "organisers pick, weekly sign-up: the bench line is the organisers' one",
    patch: { organisersPick: true },
    has: (s) => [s.sj_hello_whos_in, s.sj_hello_bench_organiser],
    hasNot: (s) => [s.sj_hello_bench],
  },
  {
    name: "pay links on, card and bank",
    patch: { payLinks: "card-and-bank" },
    has: (s) => [s.sj_hello_fees({ tracking: false, mode: "card-and-bank" })],
    hasNot: () => [],
  },
  {
    name: "pay links on, card only",
    patch: { payLinks: "card" },
    has: (s) => [s.sj_hello_fees({ tracking: false, mode: "card" })],
    hasNot: (s) => [s.sj_hello_fees({ tracking: false, mode: "card-and-bank" })],
  },
  {
    name: "payment tracking and pay links both on: one fees line that says both",
    patch: { paymentTracking: true, payLinks: "bank" },
    has: (s) => [s.sj_hello_fees({ tracking: true, mode: "bank" })],
    hasNot: (s) => [s.sj_hello_fees({ tracking: false, mode: "bank" })],
  },
  {
    name: "bench off, weekly sign-up",
    patch: { bench: false },
    has: (s) => [s.sj_hello_whos_in],
    hasNot: (s) => [s.sj_hello_bench, s.sj_hello_bench_organiser],
  },
  {
    name: "attendance off (a Man of the Match and ratings group): no In or Out anywhere",
    patch: { attendance: false, bench: false, dropOutDeadline: MON_2100, listPublish: TUE_2000, rollingSquad: true, organisersPick: true },
    has: (s) => [withOptionalTag(s.sj_hello_friend, s.sj_hello_optional({ organiser: "Ali" })), s.sj_hello_remind, s.sj_hello_closer_tag_only],
    hasNot: (s) => [
      s.sj_hello_friend,
      s.sj_hello_closer,
      s.sj_hello_whos_in,
      s.sj_hello_catch_up,
      s.sj_hello_bench,
      s.sj_hello_bench_organiser,
      s.sj_hello_rolling({ deadline: `${s.wd_weekday({ dow: 1 })} 21:00` }),
      s.sj_hello_deadline({ day: s.wd_weekday({ dow: 1 }), time: "21:00" }),
      s.sj_hello_list({ day: s.wd_weekday({ dow: 2 }), time: "20:00" }),
    ],
  },
  {
    name: "squad from a pasted list: nobody is told to say In, no catch-up",
    patch: { squadFromList: true },
    has: (s) => [s.sj_hello_friend],
    hasNot: (s) => [s.sj_hello_whos_in, s.sj_hello_catch_up],
  },
  {
    name: "monthly squad: the monthly lines, no weekly sign-up, no catch-up, rolling ignored",
    patch: { squadMode: "monthly", rollingSquad: true, dropOutDeadline: MON_2100, listPublish: TUE_2000, paymentTracking: true },
    has: (s) => [
      s.sj_hello_monthly,
      s.sj_hello_monthly_join({ organisersPick: false }),
      s.sj_hello_month_list({ organiser: "Ali" }),
    ],
    hasNot: (s) => [
      s.sj_hello_whos_in,
      s.sj_hello_catch_up,
      s.sj_hello_bench,
      s.sj_hello_rolling({ deadline: null }),
      s.sj_hello_rolling({ deadline: `${s.wd_weekday({ dow: 1 })} 21:00` }),
      s.sj_hello_deadline({ day: s.wd_weekday({ dow: 1 }), time: "21:00" }),
      s.sj_hello_list({ day: s.wd_weekday({ dow: 2 }), time: "20:00" }),
      s.sj_hello_fees({ tracking: true, mode: "card" }),
    ],
  },
  {
    name: "monthly squad, organisers pick",
    patch: { squadMode: "monthly", organisersPick: true },
    has: (s) => [s.sj_hello_monthly, s.sj_hello_monthly_join({ organisersPick: true })],
    hasNot: (s) => [s.sj_hello_monthly_join({ organisersPick: false }), s.sj_hello_bench_organiser],
  },
  {
    name: "organisers mode, weekly sign-up: the organisers share the list and teams",
    patch: { organisersAnnounce: true, listPublish: TUE_2000 },
    has: (s) => [s.sj_hello_organisers_share({ list: true, teams: true })],
    hasNot: (s) => [s.sj_hello_list({ day: s.wd_weekday({ dow: 2 }), time: "20:00" })],
  },
];

describe("buildGroupHello: each setting is described only when it is on", () => {
  for (const lang of LANGS) {
    for (const row of ROWS) {
      it(`${lang}: ${row.name}`, () => {
        const s = TABLES[lang];
        const out = hello(lang, row.patch, { carry: row.carry });
        // Whole lines: the "tracking and pay links" line begins with the pay links one.
        const said = out.split("\n");
        for (const line of row.has(s)) expect(said, `missing: ${line}`).toContain(line);
        for (const line of row.hasNot(s)) expect(said, `must not say: ${line}`).not.toContain(line);
        // Shape: an opener, the feature lines, the closer, never a blank line doubled.
        expect(out.startsWith(s.sj_hello_opener({ organiser: "Ali" }))).toBe(true);
        expect(out.endsWith(row.patch.attendance === false ? s.sj_hello_closer_tag_only : s.sj_hello_closer)).toBe(true);
        // Every feature is mentioned once, whatever the settings (Kemal,
        // 2026-11-02 and 2026-11-03): switched off, it is marked optional.
        for (const head of FEATURE_EMOJI) expect(out.split(head).length - 1, head).toBe(1);
        // The month's list is a monthly club's line only.
        if (row.patch.squadMode !== "monthly") expect(out).not.toContain(s.sj_hello_month_list({ organiser: "Ali" }));
        expect(out).not.toMatch(/\n\n\n/);
        expect(out).not.toMatch(/[—–]/);
        expect(out).not.toMatch(/undefined|null|\[object/);
      });
    }
  }

  it("the Turkish hello never carries an English instruction word", () => {
    for (const row of ROWS) {
      expect(hello("tr", row.patch, { carry: row.carry }), row.name).not.toMatch(/\*In\*|\*Out\*|\bMonday\b|\bTuesday\b|\bbench\b/i);
    }
  });

  it("a rolling club with nothing said about a squad to carry gets the first-game form: never a false 'you're in'", () => {
    for (const lang of LANGS) {
      const s = TABLES[lang];
      const out = buildGroupHello({ organiser: "Ali", lang, settings: { ...DEFAULT_HELLO_SETTINGS, rollingSquad: true } });
      expect(out).toContain(s.sj_hello_rolling_first({ deadline: null, mode: "first-come" }));
      expect(out).not.toContain(s.sj_hello_rolling({ deadline: null }));
    }
  });

  it("the first-game line says the three things, in order: same squad, In for the first game, then only Out", () => {
    const first = en.sj_hello_rolling_first({ deadline: "Monday 21:00", mode: "first-come" });
    expect(first).toMatch(/same squad.*first game.*say \*In\*.*After that.*say \*Out\*.*before \*Monday 21:00\*/i);
    expect(first).not.toMatch(/if you played last time/i);
    const pick = en.sj_hello_rolling_first({ deadline: null, mode: "organiser" });
    expect(pick).toMatch(/first game.*say \*In\*.*bench.*organisers pick/i);
    const trFirst = tr.sj_hello_rolling_first({ deadline: "Pazartesi 21:00", mode: "first-come" });
    expect(trFirst).toMatch(/ilk maç.*\*VARIM\*.*\*Pazartesi 21:00\*.*\*YOKUM\*/);
  });

  it("an unknown language reads as English", () => {
    expect(hello("xx" as L, {}, { catchUp: false })).toBe(en.sj_group_hello({ organiser: "Ali" }));
  });

  it("the day and time read as the setup findings DM writes them", () => {
    expect(hello("en", { dropOutDeadline: MON_2100 })).toContain("Monday 21:00");
    expect(hello("tr", { dropOutDeadline: MON_2100 })).toContain("Pazartesi 21:00");
    expect(en.setup_applied_line({ key: "dropOutDeadline", day: en.wd_weekday({ dow: 1 }), time: "21:00" })).toContain("Monday 21:00");
    expect(tr.setup_applied_line({ key: "dropOutDeadline", day: tr.wd_weekday({ dow: 1 }), time: "21:00" })).toContain("Pazartesi 21:00");
  });
});

describe("signsUpEachWeek", () => {
  const cases: Array<[string, Partial<GroupHelloSettings>, boolean]> = [
    ["defaults", {}, true],
    ["rolling squad", { rollingSquad: true }, false],
    ["monthly squad", { squadMode: "monthly" }, false],
    ["attendance off", { attendance: false }, false],
    ["squad from a pasted list", { squadFromList: true }, false],
    ["organisers pick", { organisersPick: true }, true],
  ];
  for (const [name, patch, want] of cases) {
    it(name, () => expect(signsUpEachWeek({ ...DEFAULT_HELLO_SETTINGS, ...patch })).toBe(want));
  }
});

describe("helloInputFromOrg: an Organisation row to the builder's input", () => {
  const ROW: HelloOrgRow = {
    language: "en",
    squadMode: "weekly",
    featureAttendance: true,
    featureBench: true,
    featureTeamBalancing: true,
    featureMomVoting: true,
    featurePlayerRating: true,
    featureReminders: true,
    featureStatsQa: true,
    featureSquadFromList: false,
    rollingSquadEnabled: false,
    benchPickMode: "first-come",
    dropOutDeadlineDay: null,
    dropOutDeadlineTime: null,
    listPublishDay: null,
    listPublishTime: null,
    paymentTrackingEnabled: false,
    paymentCollectionEnabled: false,
    stripeConnectAccountId: null,
    stripeChargesEnabled: false,
    payMethodCard: true,
    payMethodPayByBank: true,
  };
  const from = (patch: Partial<HelloOrgRow>, name: string | null = "Ali Veli") => helloInputFromOrg({ ...ROW, ...patch }, name);

  it("a row on the column defaults is the default settings, and the hello is today's", () => {
    const input = from({});
    expect(input.settings).toEqual(DEFAULT_HELLO_SETTINGS);
    expect(input.organiser).toBe("Ali");
    expect(buildGroupHello({ ...input, catchUp: false })).toBe(en.sj_group_hello({ organiser: "Ali" }));
  });

  it("takes the organiser's first name only, and none when there is no name", () => {
    expect(from({}, "  Ayşe Nur Kaya ").organiser).toBe("Ayşe");
    expect(from({}, null).organiser).toBeNull();
    expect(from({}, "   ").organiser).toBeNull();
  });

  it("carries the language, and an unknown one reads as English", () => {
    expect(from({ language: "tr" }).lang).toBe("tr");
    expect(from({ language: "xx" }).lang).toBe("en");
  });

  it("reads the weekly routine", () => {
    const s = from({
      rollingSquadEnabled: true,
      benchPickMode: "organiser",
      dropOutDeadlineDay: 1,
      dropOutDeadlineTime: "21:00",
      listPublishDay: 2,
      listPublishTime: "20:00",
      paymentTrackingEnabled: true,
    }).settings;
    expect(s).toMatchObject({
      rollingSquad: true,
      organisersPick: true,
      dropOutDeadline: MON_2100,
      listPublish: TUE_2000,
      paymentTracking: true,
    });
  });

  it("half a deadline, or a malformed one, reads as not set", () => {
    expect(from({ dropOutDeadlineDay: 1, dropOutDeadlineTime: null }).settings.dropOutDeadline).toBeNull();
    expect(from({ listPublishDay: null, listPublishTime: "20:00" }).settings.listPublish).toBeNull();
    expect(from({ dropOutDeadlineDay: 9, dropOutDeadlineTime: "21:00" }).settings.dropOutDeadline).toBeNull();
    expect(from({ dropOutDeadlineDay: 1, dropOutDeadlineTime: "9pm" }).settings.dropOutDeadline).toBeNull();
  });

  it("a monthly club reads rolling squad as off", () => {
    const s = from({ squadMode: "monthly", rollingSquadEnabled: true }).settings;
    expect(s.squadMode).toBe("monthly");
    expect(s.rollingSquad).toBe(false);
    expect(from({ squadMode: "something-else" }).settings.squadMode).toBe("weekly");
  });

  it("pay links are on only when the club can actually be charged", () => {
    const live = { paymentCollectionEnabled: true, stripeConnectAccountId: "acct_1", stripeChargesEnabled: true };
    expect(from({ paymentCollectionEnabled: true }).settings.payLinks).toBe("off");
    expect(from({ ...live, stripeChargesEnabled: false }).settings.payLinks).toBe("off");
    expect(from(live).settings.payLinks).toBe("card-and-bank");
    expect(from({ ...live, payMethodPayByBank: false }).settings.payLinks).toBe("card");
    expect(from({ ...live, payMethodCard: false }).settings.payLinks).toBe("bank");
    expect(from({ ...live, payMethodCard: false, payMethodPayByBank: false }).settings.payLinks).toBe("off");
  });

  it("each feature flag is carried", () => {
    const s = from({
      featureAttendance: false,
      featureBench: false,
      featureTeamBalancing: false,
      featureMomVoting: false,
      featurePlayerRating: false,
      featureReminders: false,
      featureStatsQa: false,
      featureSquadFromList: true,
    }).settings;
    expect(s).toMatchObject({
      attendance: false,
      bench: false,
      teamBalancing: false,
      momVoting: false,
      playerRating: false,
      reminders: false,
      statsQa: false,
      squadFromList: true,
    });
  });

  it("reads listAnnouncer: only \"organisers\" is organisers mode", () => {
    expect(from({ listAnnouncer: "organisers" }).settings.organisersAnnounce).toBe(true);
    expect(from({ listAnnouncer: "matchtime" }).settings.organisersAnnounce).toBe(false);
    expect(from({ listAnnouncer: null }).settings.organisersAnnounce).toBe(false);
  });
});

/**
 * ORGANISERS MODE (2026-10-15). `Organisation.listAnnouncer = "organisers"`
 * (FNF): the squad list and every team sheet go to the club's admin channel,
 * never the players' group (bot-scheduler.ts `toOrganisers`,
 * list-announcer.ts), and a players' team request is answered "The
 * organisers will post the teams." (organisers-list-copy.ts). FNF's hello
 * said "Fair teams: tag me and I pick balanced teams" and, as a rolling
 * organiser-pick club, "For the first game with me, say In: I'll put you on
 * the bench", while its organisers had pasted the list themselves.
 */
describe("buildGroupHello: a club whose organisers share the list and teams", () => {
  const FNF: Partial<GroupHelloSettings> = { organisersAnnounce: true, rollingSquad: true, organisersPick: true };

  for (const lang of LANGS) {
    const s = TABLES[lang] as typeof en;
    it(`${lang}: says the organisers share the list and teams`, () => {
      const out = hello(lang, FNF);
      expect(out).toContain(s.sj_hello_organisers_share({ list: true, teams: true }));
    });
    it(`${lang}: the first game is the organisers' pick, not "say In and go on the bench"`, () => {
      const out = hello(lang, FNF, { carry: false });
      expect(out).not.toContain(s.sj_hello_rolling_first({ deadline: null, mode: "organiser" }));
      expect(out).toContain(s.sj_hello_rolling_first_organisers({ deadline: null }));
      // An In from anyone else still goes on the bench for the organisers to pick.
      expect(out).toContain(s.sj_hello_bench_organiser);
    });
    it(`${lang}: the final list is the organisers' to share, not "I post it here"`, () => {
      const out = hello(lang, { organisersAnnounce: true, listPublish: TUE_2000 });
      expect(out).not.toContain(s.sj_hello_list({ day: s.wd_weekday({ dow: 2 }), time: "20:00" }));
      expect(out).toContain(s.sj_hello_organisers_share({ list: true, teams: true }));
    });
    it(`${lang}: team balancing off: only the list is theirs; attendance off: only the teams`, () => {
      expect(hello(lang, { organisersAnnounce: true, teamBalancing: false })).toContain(
        s.sj_hello_organisers_share({ list: true, teams: false }),
      );
      expect(hello(lang, { organisersAnnounce: true, attendance: false })).toContain(
        s.sj_hello_organisers_share({ list: false, teams: true }),
      );
    });
    it(`${lang}: a rolling club with a squad to carry keeps its standing lines`, () => {
      const out = hello(lang, FNF, { carry: true });
      expect(out).toContain(s.sj_hello_rolling({ deadline: null }));
    });
    it(`${lang}: a rolling first-come club in organisers mode is still asked for an In (it takes a place)`, () => {
      const out = hello(lang, { organisersAnnounce: true, rollingSquad: true }, { carry: false });
      expect(out).toContain(s.sj_hello_rolling_first({ deadline: null, mode: "first-come" }));
    });
    it(`${lang}: a club MatchTime announces for is unchanged`, () => {
      expect(hello(lang, { organisersAnnounce: false }, { catchUp: false })).toBe(s.sj_group_hello({ organiser: "Ali" }));
    });
  }
});

/**
 * THE FIXED BLOCK AND THE OPENING (Kemal, 2026-11-02). Every club's hello
 * carries the same features block verbatim; only the opening varies: the
 * organiser, the game day, the squad lines, a weekly club's pay links, and
 * for a monthly club the organiser's month's list.
 */
describe("buildGroupHello: the approved welcome", () => {
  /** The welcome Kemal approved for a monthly club's group (organiser
   *  Davide, Monday games), with every claim made true on 2026-11-03 for
   *  the Monday night vets' settings: no player pool and no partner club,
   *  so both are marked optional and name Davide. */
  const APPROVED = [
    "👋 Hi everyone, I'm *MatchTime*. Davide has set me up to help run the Monday games. Here's what I do, right here in WhatsApp:",
    "",
    "📋 *Monthly squad:* regulars sign up and pay for the whole month, and are in every game of it. Can't make one? Say *Out*.",
    "✅ *Not a regular?* When a place is open, say *In* to take it. You pay for that game only.",
    "👥 *Bringing a friend:* say a friend is coming and I'll DM you a link to send them.",
    `⏰ *Remind me:* tag me and say when, in your own words (for example *"@Match Time remind me Thursday"*), and I'll DM you then.`,
    "",
    "⭐ *Ratings:* the morning after each game I DM everyone who played a private link to rate the others out of 10. Your scores stay private and you can't rate yourself. I combine them into a form rating for each player, updated as the ratings come in.",
    "⚖️ *Fair teams:* on match day tag me and ask, in your own words (for example *@Match Time make the teams*), and I'll pick two balanced sides from those ratings, so the games stay close. The more people rate, the fairer the teams.",
    "🏆 *Man of the Match:* on the same private link, pick the standout player and I'll announce the winner in the group. Wins add up over the season.",
    "📊 *Your profile:* everyone gets their own page with their games, ratings and MoM awards. Ask me any stats question too, for example *@Match Time my stats*.",
    "🤝 *More games (optional, Davide can switch this on):* if you fancy playing on other nights, you can join the local MatchTime player pool and get offered spare places in nearby games. It's up to you whether to join. Here's the link to register: matchtime.ai/play",
    "🌍 *Partner clubs (optional, Davide can switch this on):* when we're short, nearby partner clubs can lend us players, and you can get extra games helping them out.",
    "",
    "Davide will post the month's list as usual.",
    "",
    "I don't reply to the banter, only to In, Out or a tag. Anything else, tag me: *@Match Time help*",
  ].join("\n");

  it("en: the monthly club on its settings (the vets: no pool, no partners) reads exactly as approved", () => {
    const out = buildGroupHello({
      organiser: "Davide",
      lang: "en",
      gameDay: 1,
      settings: { ...DEFAULT_HELLO_SETTINGS, squadMode: "monthly" },
    });
    expect(out).toBe(APPROVED);
  });

  it("the game day: one day names it, none falls back to this group's games", () => {
    const named = (gameDay: number | null, organiser: string | null = "Ali") =>
      buildGroupHello({ organiser, lang: "en", gameDay, settings: DEFAULT_HELLO_SETTINGS }).split("\n")[0];
    expect(named(1)).toContain("Ali has set me up to help run the Monday games.");
    expect(named(null)).toContain("Ali has set me up to help run this group's games.");
    expect(named(5, null)).toContain("I'm here to help run the Friday games.");
    expect(named(null, null)).toContain("I'm here to help run this group's games.");
    const trLine = buildGroupHello({ organiser: "Ali", lang: "tr", gameDay: 1, settings: DEFAULT_HELLO_SETTINGS }).split("\n")[0];
    expect(trLine).toContain("Ali beni Pazartesi maçlarını düzenlemeye yardım etmem için kurdu.");
  });

  it("the month's list line is a monthly club's, and only with an organiser's name", () => {
    for (const lang of LANGS) {
      const s = TABLES[lang];
      expect(hello(lang, { squadMode: "monthly" })).toContain(`\n\n${s.sj_hello_month_list({ organiser: "Ali" })}\n\n`);
      expect(hello(lang, { squadMode: "monthly" }, { organiser: null })).not.toContain(s.sj_hello_month_list({ organiser: "Ali" }));
      expect(hello(lang)).not.toContain(s.sj_hello_month_list({ organiser: "Ali" }));
    }
  });

  it("a weekly club's fees line sits in the opening, before the fixed block; none without pay links", () => {
    for (const lang of LANGS) {
      const s = TABLES[lang];
      const out = hello(lang, { payLinks: "card", paymentTracking: true });
      expect(out).toContain(`${s.sj_hello_fees({ tracking: true, mode: "card" })}\n${s.sj_hello_friend}`);
      expect(hello(lang, { paymentTracking: true })).not.toMatch(/💷/);
    }
  });

  it("the house rules hold on the fixed block", () => {
    for (const lang of LANGS) {
      const s = TABLES[lang];
      const all = { ...DEFAULT_HELLO_SETTINGS };
      for (const text of [s.sj_hello_friend, ...helloFeatureLines({ organiser: "Ali", lang, settings: all })]) {
        expect(text).not.toMatch(/[—–]/);
        expect(text).not.toMatch(/waiting list|bekleme listesi/i);
      }
    }
  });
});

/**
 * EVERY CLAIM TRUE FOR THE CLUB (Kemal, 2026-11-03). The welcome describes
 * every feature, but a feature the club has switched off is marked
 * "(optional, <organiser> can switch this on)", and each line says what
 * MatchTime really does:
 *
 *   ratings      the rating DM the morning after (bot-scheduler.ts 6b); the
 *                club rating is computed from the ratings as they arrive
 *                (player-rating.ts), there is no weekly job
 *   teams        built on a TAGGED ask on match day (team-ops-engine-batch.ts
 *                `isMatchDay`; no cron builds them, bot-scheduler.ts "4.
 *                Teams post"); organisers mode: proposed to the organisers
 *   MoM          picked on the rating link (actions/ratings.ts
 *                submitMoMVote) and announced by the scheduler (6e); no
 *                group poll exists; organisers pick: announced from the pick
 *   pool         `poolOpenForClub` (pool/flags.ts), read by the loader
 *   partners     active partnerships, each direction (club-partnership.ts)
 *   closer       MatchTime posts its own updates, so it never says it stays
 *                quiet, only that it does not reply to banter
 *
 * The end-to-end proof of each behaviour: e2e/api/group-hello-claims.spec.ts.
 */
describe("buildGroupHello: every claim is true for the club's settings", () => {
  const FACTS_ON: HelloClubFacts = { pool: true, partnersAsk: true, partnersHelp: true };
  const say = (
    lang: L,
    patch: Partial<GroupHelloSettings> = {},
    facts: HelloClubFacts = NO_HELLO_CLUB_FACTS,
    organiser: string | null = "Davide",
  ) => buildGroupHello({ organiser, lang, catchUp: false, settings: { ...DEFAULT_HELLO_SETTINGS, ...patch }, clubFacts: facts }).split("\n");
  const tagged = (s: typeof en, line: string, organiser: string | null = "Davide") => withOptionalTag(line, s.sj_hello_optional({ organiser }));

  for (const lang of LANGS) {
    const s = TABLES[lang] as typeof en;

    it(`${lang}: everything on: every line is the plain one, nothing is marked optional`, () => {
      const out = say(lang, {}, FACTS_ON);
      for (const line of [s.sj_hello_friend, s.sj_hello_remind, s.sj_hello_ratings, s.sj_hello_teams, s.sj_hello_mom, s.sj_hello_profile, s.sj_hello_pool, s.sj_hello_partners]) {
        expect(out).toContain(line);
      }
      expect(out.join("\n")).not.toContain(s.sj_hello_optional({ organiser: "Davide" }));
    });

    it(`${lang}: the pool is off: its line is kept, marked optional, naming the organiser`, () => {
      const out = say(lang, {}, { ...FACTS_ON, pool: false });
      expect(out).toContain(tagged(s, s.sj_hello_pool));
      expect(out).not.toContain(s.sj_hello_pool);
    });

    it(`${lang}: partner clubs, each direction as it really is`, () => {
      expect(say(lang, {}, { ...FACTS_ON, partnersHelp: false })).toContain(s.sj_hello_partners_lend);
      expect(say(lang, {}, { ...FACTS_ON, partnersAsk: false })).toContain(s.sj_hello_partners_help({ organiser: "Davide" }));
      const none = say(lang, {}, { ...FACTS_ON, partnersAsk: false, partnersHelp: false });
      expect(none).toContain(tagged(s, s.sj_hello_partners));
      expect(none).not.toContain(s.sj_hello_partners);
    });

    it(`${lang}: no organiser name: the optional mark says "the organiser"`, () => {
      const out = say(lang, {}, NO_HELLO_CLUB_FACTS, null).join("\n");
      expect(out).toContain(withOptionalTag(s.sj_hello_pool, s.sj_hello_optional({ organiser: null })));
      expect(s.sj_hello_optional({ organiser: null })).toMatch(lang === "en" ? /the organiser can switch this on/ : /organizatör açabilir/);
    });

    it(`${lang}: Man of the Match: players pick on the rating link; organisers pick; off; no ratings means no link to vote on`, () => {
      expect(say(lang)).toContain(s.sj_hello_mom);
      const org = say(lang, { momByOrganisers: true });
      expect(org).toContain(s.sj_hello_mom_organisers);
      expect(org).not.toContain(s.sj_hello_mom);
      expect(say(lang, { momVoting: false })).toContain(tagged(s, s.sj_hello_mom));
      expect(say(lang, { momVoting: false, momByOrganisers: true })).toContain(tagged(s, s.sj_hello_mom_organisers));
      expect(say(lang, { playerRating: false })).toContain(tagged(s, s.sj_hello_mom));
      // The organisers' pick needs no rating link.
      expect(say(lang, { playerRating: false, momByOrganisers: true })).toContain(s.sj_hello_mom_organisers);
    });

    it(`${lang}: ratings: off, and a club with nobody confirmed (attendance off, no pasted squad), are optional`, () => {
      expect(say(lang)).toContain(s.sj_hello_ratings);
      expect(say(lang, { playerRating: false })).toContain(tagged(s, s.sj_hello_ratings));
      expect(say(lang, { attendance: false })).toContain(tagged(s, s.sj_hello_ratings));
      expect(say(lang, { attendance: false, squadFromList: true })).toContain(s.sj_hello_ratings);
    });

    it(`${lang}: fair teams: a tagged ask on match day; organisers mode: for the organisers; off: optional`, () => {
      expect(say(lang)).toContain(s.sj_hello_teams);
      const org = say(lang, { organisersAnnounce: true });
      expect(org).toContain(s.sj_hello_teams_organisers);
      expect(org).not.toContain(s.sj_hello_teams);
      expect(say(lang, { teamBalancing: false })).toContain(tagged(s, s.sj_hello_teams));
      expect(say(lang, { teamBalancing: false, organisersAnnounce: true })).toContain(tagged(s, s.sj_hello_teams));
    });

    it(`${lang}: profile always; stats questions off: said to be optional`, () => {
      expect(say(lang)).toContain(s.sj_hello_profile);
      const off = say(lang, { statsQa: false });
      expect(off).toContain(s.sj_hello_profile_no_stats({ organiser: "Davide" }));
      expect(off).not.toContain(s.sj_hello_profile);
    });

    it(`${lang}: remind me off and the friend link without attendance are optional`, () => {
      expect(say(lang, { reminders: false })).toContain(tagged(s, s.sj_hello_remind));
      expect(say(lang, { attendance: false })).toContain(tagged(s, s.sj_hello_friend));
    });

    it(`${lang}: the closer never says MatchTime stays quiet; without attendance it does not mention In or Out`, () => {
      expect(say(lang).at(-1)).toBe(s.sj_hello_closer);
      expect(say(lang, { attendance: false }).at(-1)).toBe(s.sj_hello_closer_tag_only);
    });

    it(`${lang}: every feature is mentioned in every combination of switches`, () => {
      const flags = ["reminders", "teamBalancing", "momVoting", "playerRating", "statsQa", "attendance", "organisersAnnounce", "momByOrganisers"] as const;
      for (let mask = 0; mask < 1 << flags.length; mask++) {
        const patch: Partial<GroupHelloSettings> = {};
        flags.forEach((f, i) => ((patch as Record<string, boolean>)[f] = (mask & (1 << i)) !== 0));
        for (const facts of [NO_HELLO_CLUB_FACTS, FACTS_ON]) {
          const out = say(lang, patch, facts).join("\n");
          for (const head of FEATURE_EMOJI) expect(out.split(head).length - 1, `${head} ${JSON.stringify(patch)}`).toBe(1);
          expect(out).not.toMatch(/[—–]|waiting list|bekleme listesi|undefined|null/);
        }
      }
    });
  }

  it("the false claims are gone from every variant: no group vote, no weekly update, no 'stay quiet'", () => {
    const variants = [
      ...[en, tr].map((s) => s.sj_group_hello({ organiser: "Ali" })),
      ...LANGS.flatMap((lang) => [say(lang, {}, FACTS_ON), say(lang, { momByOrganisers: true }), say(lang, { attendance: false })].map((l) => l.join("\n"))),
    ];
    for (const text of variants) {
      expect(text).not.toMatch(/quick vote|post a .*vote in the group|updated every week|stay quiet/i);
      expect(text).not.toMatch(/kısa bir oylama|her hafta güncellenen|sessiz kalırım/);
    }
  });

  it("withOptionalTag puts the mark inside the bold heading, before its colon", () => {
    expect(withOptionalTag("🤝 *More games:* join the pool", " (optional, Davide can switch this on)")).toBe(
      "🤝 *More games (optional, Davide can switch this on):* join the pool",
    );
    expect(withOptionalTag("no heading here", " (x)")).toBe("no heading here (x)");
  });

  it("helloInputFromOrg reads who chooses Man of the Match", () => {
    const row = { ...helloInputFromOrgRow(), momChosenBy: "organisers" };
    expect(helloInputFromOrg(row, "Ali").settings.momByOrganisers).toBe(true);
    expect(helloInputFromOrg({ ...row, momChosenBy: "players" }, "Ali").settings.momByOrganisers).toBe(false);
    expect(helloInputFromOrg({ ...row, momChosenBy: null }, "Ali").settings.momByOrganisers).toBe(false);
  });
});

function helloInputFromOrgRow(): HelloOrgRow {
  return {
    language: "en",
    squadMode: "weekly",
    featureAttendance: true,
    featureBench: true,
    featureTeamBalancing: true,
    featureMomVoting: true,
    featurePlayerRating: true,
    featureReminders: true,
    featureStatsQa: true,
    featureSquadFromList: false,
    rollingSquadEnabled: false,
    benchPickMode: "first-come",
    dropOutDeadlineDay: null,
    dropOutDeadlineTime: null,
    listPublishDay: null,
    listPublishTime: null,
    paymentTrackingEnabled: false,
    paymentCollectionEnabled: false,
    stripeConnectAccountId: null,
    stripeChargesEnabled: false,
    payMethodCard: true,
    payMethodPayByBank: true,
  };
}
