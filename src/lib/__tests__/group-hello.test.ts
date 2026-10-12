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
  buildGroupHello,
  helloInputFromOrg,
  signsUpEachWeek,
  type GroupHelloSettings,
  type HelloOrgRow,
} from "../group-hello";

const TABLES = { en, tr } as const;
type L = keyof typeof TABLES;
const LANGS: L[] = ["en", "tr"];

const hello = (lang: L, patch: Partial<GroupHelloSettings> = {}, extra: { organiser?: string | null; catchUp?: boolean } = {}) =>
  buildGroupHello({
    organiser: extra.organiser === undefined ? "Ali" : extra.organiser,
    lang,
    catchUp: extra.catchUp,
    settings: { ...DEFAULT_HELLO_SETTINGS, ...patch },
  });

const MON_2100 = { day: 1, time: "21:00" };
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
}

const ROWS: Row[] = [
  {
    name: "defaults: weekly sign-up, bench, every feature, fees as something the organiser can switch on",
    patch: {},
    has: (s) => [
      s.sj_hello_whos_in,
      s.sj_hello_bench,
      s.sj_hello_remind,
      s.sj_hello_teams,
      s.sj_hello_mom({ mom: true, ratings: true }),
      s.sj_hello_stats,
      s.sj_hello_fees({ tracking: false, mode: "off" }),
      s.sj_hello_catch_up,
      s.sj_hello_closer({ attendance: true }),
    ],
    hasNot: (s) => [s.sj_hello_rolling({ deadline: null }), s.sj_hello_bench_organiser, s.sj_hello_monthly],
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
    name: "payment tracking on",
    patch: { paymentTracking: true },
    has: (s) => [s.sj_hello_fees({ tracking: true, mode: "off" })],
    hasNot: (s) => [s.sj_hello_fees({ tracking: false, mode: "off" })],
  },
  {
    name: "pay links on, card and bank",
    patch: { payLinks: "card-and-bank" },
    has: (s) => [s.sj_hello_fees({ tracking: false, mode: "card-and-bank" })],
    hasNot: (s) => [s.sj_hello_fees({ tracking: false, mode: "off" })],
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
    hasNot: (s) => [s.sj_hello_fees({ tracking: true, mode: "off" }), s.sj_hello_fees({ tracking: false, mode: "bank" })],
  },
  {
    name: "remind me off",
    patch: { reminders: false },
    has: (s) => [s.sj_hello_teams],
    hasNot: (s) => [s.sj_hello_remind],
  },
  {
    name: "teams off",
    patch: { teamBalancing: false },
    has: (s) => [s.sj_hello_remind],
    hasNot: (s) => [s.sj_hello_teams],
  },
  {
    name: "Man of the Match only",
    patch: { playerRating: false },
    has: (s) => [s.sj_hello_mom({ mom: true, ratings: false })],
    hasNot: (s) => [s.sj_hello_mom({ mom: true, ratings: true })],
  },
  {
    name: "ratings only",
    patch: { momVoting: false },
    has: (s) => [s.sj_hello_mom({ mom: false, ratings: true })],
    hasNot: (s) => [s.sj_hello_mom({ mom: true, ratings: true })],
  },
  {
    name: "Man of the Match and ratings both off",
    patch: { momVoting: false, playerRating: false },
    has: (s) => [s.sj_hello_stats],
    hasNot: (s) => [
      s.sj_hello_mom({ mom: true, ratings: true }),
      s.sj_hello_mom({ mom: true, ratings: false }),
      s.sj_hello_mom({ mom: false, ratings: true }),
    ],
  },
  {
    name: "stats off",
    patch: { statsQa: false },
    has: (s) => [s.sj_hello_teams],
    hasNot: (s) => [s.sj_hello_stats],
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
    has: (s) => [s.sj_hello_mom({ mom: true, ratings: true }), s.sj_hello_closer({ attendance: false })],
    hasNot: (s) => [
      s.sj_hello_whos_in,
      s.sj_hello_catch_up,
      s.sj_hello_bench,
      s.sj_hello_bench_organiser,
      s.sj_hello_rolling({ deadline: `${s.wd_weekday({ dow: 1 })} 21:00` }),
      s.sj_hello_deadline({ day: s.wd_weekday({ dow: 1 }), time: "21:00" }),
      s.sj_hello_list({ day: s.wd_weekday({ dow: 2 }), time: "20:00" }),
      s.sj_hello_closer({ attendance: true }),
    ],
  },
  {
    name: "squad from a pasted list: nobody is told to say In, no catch-up",
    patch: { squadFromList: true },
    has: (s) => [s.sj_hello_teams],
    hasNot: (s) => [s.sj_hello_whos_in, s.sj_hello_catch_up],
  },
  {
    name: "monthly squad: the monthly lines, no weekly sign-up, no catch-up, rolling ignored",
    patch: { squadMode: "monthly", rollingSquad: true, dropOutDeadline: MON_2100, listPublish: TUE_2000, paymentTracking: true },
    has: (s) => [s.sj_hello_monthly, s.sj_hello_monthly_join({ organisersPick: false }), s.sj_hello_teams, s.sj_hello_stats],
    hasNot: (s) => [
      s.sj_hello_whos_in,
      s.sj_hello_catch_up,
      s.sj_hello_bench,
      s.sj_hello_rolling({ deadline: null }),
      s.sj_hello_rolling({ deadline: `${s.wd_weekday({ dow: 1 })} 21:00` }),
      s.sj_hello_deadline({ day: s.wd_weekday({ dow: 1 }), time: "21:00" }),
      s.sj_hello_list({ day: s.wd_weekday({ dow: 2 }), time: "20:00" }),
      s.sj_hello_fees({ tracking: true, mode: "off" }),
      s.sj_hello_fees({ tracking: false, mode: "off" }),
    ],
  },
  {
    name: "monthly squad, organisers pick",
    patch: { squadMode: "monthly", organisersPick: true },
    has: (s) => [s.sj_hello_monthly, s.sj_hello_monthly_join({ organisersPick: true })],
    hasNot: (s) => [s.sj_hello_monthly_join({ organisersPick: false }), s.sj_hello_bench_organiser],
  },
];

describe("buildGroupHello: each setting is described only when it is on", () => {
  for (const lang of LANGS) {
    for (const row of ROWS) {
      it(`${lang}: ${row.name}`, () => {
        const s = TABLES[lang];
        const out = hello(lang, row.patch);
        // Whole lines: the "tracking and pay links" line begins with the pay links one.
        const said = out.split("\n");
        for (const line of row.has(s)) expect(said, `missing: ${line}`).toContain(line);
        for (const line of row.hasNot(s)) expect(said, `must not say: ${line}`).not.toContain(line);
        // Shape: an opener, the feature lines, the closer, never a blank line doubled.
        expect(out.startsWith(s.sj_hello_opener({ organiser: "Ali" }))).toBe(true);
        expect(out.endsWith(s.sj_hello_closer({ attendance: row.patch.attendance !== false }))).toBe(true);
        expect(out).not.toMatch(/\n\n\n/);
        expect(out).not.toMatch(/[—–]/);
        expect(out).not.toMatch(/undefined|null|\[object/);
      });
    }
  }

  it("the Turkish hello never carries an English instruction word", () => {
    for (const row of ROWS) {
      expect(hello("tr", row.patch), row.name).not.toMatch(/\*In\*|\*Out\*|\bMonday\b|\bTuesday\b|\bbench\b/i);
    }
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
});
