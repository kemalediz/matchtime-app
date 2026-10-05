/**
 * F3, learned setup: the pure rules. No database, no model.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_INPUT_CHARS,
  buildUserContent,
  historyGate,
  parseDetection,
  planIsWorthTelling,
  planSetup,
  verifyEvidence,
  type OrgSettingsState,
} from "../rules";
import { blankAnswer, loadFixture, STUB_ANSWERS } from "./stubs";

const DEFAULTS: OrgSettingsState = {
  rollingSquadEnabled: false,
  benchPickMode: "first-come",
  dropOutDeadlineDay: null,
  dropOutDeadlineTime: null,
  listPublishDay: null,
  listPublishTime: null,
  paymentTrackingEnabled: false,
  language: "en",
  settingsSetByOrganiser: [],
};

function planFor(name: Parameters<typeof loadFixture>[0], org: Partial<OrgSettingsState> = {}, answer?: Record<string, unknown>) {
  const fx = loadFixture(name);
  const detection = parseDetection(answer ?? STUB_ANSWERS[name], fx.history)!;
  return planSetup({
    detection,
    org: { ...DEFAULTS, language: fx.language, ...org },
    weeklyGame: fx.weeklyGame,
    activities: [{ dayOfWeek: fx.weeklyGame.dayOfWeek, time: fx.weeklyGame.time }],
    chatLanguage: { lang: fx.language, confident: true },
  });
}

describe("historyGate: nothing is read when the chat is empty or too short", () => {
  it("empty history: no-history", () => {
    expect(historyGate(loadFixture("empty").history)).toMatchObject({ ok: false, reason: "no-history" });
  });
  it("five messages: too-short, even with a clear signal in them", () => {
    expect(historyGate(loadFixture("too-short").history)).toMatchObject({ ok: false, reason: "too-short", messages: 5 });
  });
  it("enough messages from only two people: too-short", () => {
    const h = Array.from({ length: 30 }, (_, i) => ({ author: i % 2 ? "A" : "B", text: "in", timestamp: "2026-10-01T10:00:00Z" }));
    expect(historyGate(h)).toMatchObject({ ok: false, reason: "too-short", authors: 2 });
  });
  it("every real fixture passes", () => {
    for (const n of ["rolling", "organiser-picks", "deadlines", "first-come", "turkish", "monthly-list"] as const) {
      expect(historyGate(loadFixture(n).history).ok, n).toBe(true);
    }
  });
});

describe("verifyEvidence: only quotes that are really in the chat", () => {
  const h = [{ author: "Gary", text: "Same lot as last week,\nlet me know", timestamp: "2026-10-01T10:00:00Z" }];
  it("keeps a quote found in a message, ignoring case, spacing and curly quotes", () => {
    expect(verifyEvidence(["same LOT as last   week"], h)).toEqual(["same LOT as last week"]);
  });
  it("drops a reworded or invented quote", () => {
    expect(verifyEvidence(["same squad as last week", "you're all in"], h)).toEqual([]);
  });
  it("drops anything with an account or phone number, even when it is in the chat", () => {
    const bank = [{ author: "G", text: "pay to 12345678 sort 001122", timestamp: "2026-10-01T10:00:00Z" }];
    expect(verifyEvidence(["pay to 12345678"], bank)).toEqual([]);
  });
  it("at most two, no duplicates, nothing that is not a string", () => {
    const many = [{ author: "G", text: "a b c d e f g h", timestamp: "2026-10-01T10:00:00Z" }];
    expect(verifyEvidence(["a b c", "A B C", 7, "d e f", "f g h"], many)).toEqual(["a b c", "d e f"]);
  });
});

describe("parseDetection", () => {
  const fx = loadFixture("rolling");
  it("null for something that is not an object", () => {
    expect(parseDetection("nope", fx.history)).toBeNull();
    expect(parseDetection([1], fx.history)).toBeNull();
  });
  it("an answer whose quote is not in the chat counts as not shown (low)", () => {
    const d = parseDetection(
      { ...blankAnswer(), squad: { answer: "rolling", confidence: "high", evidence: ["you are all in forever"] } },
      fx.history,
    )!;
    expect(d.squad).toEqual({ answer: "rolling", confidence: "low", evidence: [] });
  });
  it("unknown enum values fall back to unclear / no_sign; bad days and times to null", () => {
    const d = parseDetection(
      {
        regular_game: true,
        squad: { answer: "maybe", confidence: "very", evidence: [] },
        drop_out_deadline: { day: "funday", time: "25:00", confidence: "high", evidence: ["See you at 9"] },
        weekly_game: { day: "tuesday", time: "9pm", venue: "  ", players_per_side: 40, confidence: "high", evidence: [] },
      },
      fx.history,
    )!;
    expect(d.squad.answer).toBe("unclear");
    expect(d.dropOutDeadline).toEqual({ day: null, time: null, confidence: "low", evidence: [] });
    expect(d.weeklyGame).toMatchObject({ day: 2, time: null, venue: null, playersPerSide: null, confidence: "low" });
    expect(d.payments.answer).toBe("no_sign");
  });
  it("a time like 9:05 is padded", () => {
    const d = parseDetection(
      { ...blankAnswer(), list_published: { day: "tuesday", time: "9:05", confidence: "high", evidence: ["See you at 9"] } },
      fx.history,
    )!;
    expect(d.listPublished).toMatchObject({ day: 2, time: "09:05", confidence: "high" });
  });
});

describe("planSetup: each signal and the setting it drives", () => {
  it("rolling squad: switches rolling squad on, with its quote", () => {
    const p = planFor("rolling");
    expect(p.applied).toEqual([
      { key: "rollingSquad", from: false, to: true, evidence: ["Same lot as last week, let me know if you can't do Tuesday"], undoneAt: null },
    ]);
    expect(p.data).toEqual({ rollingSquadEnabled: true });
    expect(p.suggestions).toEqual([]);
  });
  it("organisers pick: switches the pick mode to organiser", () => {
    const p = planFor("organiser-picks");
    expect(p.applied.map((a) => a.key)).toEqual(["organiserPicks"]);
    expect(p.data).toEqual({ benchPickMode: "organiser" });
  });
  it("deadlines and payments: both deadlines and payment tracking, and the kickoff time is only suggested", () => {
    const p = planFor("deadlines");
    expect(p.applied.map((a) => a.key)).toEqual(["dropOutDeadline", "listPublish", "paymentTracking"]);
    expect(p.data).toEqual({
      dropOutDeadlineDay: 1,
      dropOutDeadlineTime: "21:00",
      listPublishDay: 2,
      listPublishTime: "20:00",
      paymentTrackingEnabled: true,
    });
    expect(p.suggestions).toEqual([
      { key: "weeklyGameTime", current: "19:00", detected: "20:00", evidence: ["Kickoff Thursday 8pm at Hackney Marshes"] },
    ]);
  });
  it("first come IN: MatchTime already works that way, nothing to change or tell", () => {
    const p = planFor("first-come");
    expect(p.applied).toEqual([]);
    expect(planIsWorthTelling(p)).toBe(false);
  });
  it("Turkish: rolling squad and payment tracking", () => {
    expect(planFor("turkish").applied.map((a) => a.key)).toEqual(["rollingSquad", "paymentTracking"]);
  });
  it("monthly list: noted, never applied, and it holds payment tracking off", () => {
    const p = planFor("monthly-list");
    expect(p.applied).toEqual([]);
    expect(p.noted).toEqual([
      {
        key: "monthlyList",
        prepayForMonth: true,
        payAsYouGoFillIns: true,
        creditForMissedGames: true,
        confidence: "high",
        evidence: ["we normally have the majority of us pay monthly", "Paid but can't play"],
        heldPaymentTracking: true,
      },
    ]);
    expect(p.kept).toEqual([{ key: "paymentTracking", reason: "monthly-list" }]);
    expect(planIsWorthTelling(p)).toBe(true);
  });
});

describe("planSetup: what is never changed", () => {
  it("a setting the organiser saved on the website is left alone, even at its default", () => {
    const p = planFor("rolling", { settingsSetByOrganiser: ["rollingSquad"] });
    expect(p.applied).toEqual([]);
    expect(p.kept).toEqual([{ key: "rollingSquad", reason: "organiser-set" }]);
  });
  it("the pick mode saved by the organiser (benchPickMode) is left alone", () => {
    expect(planFor("organiser-picks", { settingsSetByOrganiser: ["benchPickMode"] }).applied).toEqual([]);
  });
  it("a setting already at the target is not re-applied", () => {
    expect(planFor("rolling", { rollingSquadEnabled: true }).kept).toEqual([{ key: "rollingSquad", reason: "already" }]);
  });
  it("a deadline somebody set differently is not moved", () => {
    const p = planFor("deadlines", { dropOutDeadlineDay: 2, dropOutDeadlineTime: "12:00" });
    expect(p.applied.map((a) => a.key)).not.toContain("dropOutDeadline");
    expect(p.kept).toContainEqual({ key: "dropOutDeadline", reason: "not-default" });
  });
  it("medium confidence changes nothing", () => {
    const a = STUB_ANSWERS.rolling as { squad: Record<string, unknown> };
    const p = planFor("rolling", {}, { ...STUB_ANSWERS.rolling, squad: { ...a.squad, confidence: "medium" } });
    expect(p.applied).toEqual([]);
  });
  it("not a game group: nothing at all", () => {
    const p = planFor("rolling", {}, { ...STUB_ANSWERS.rolling, regular_game: false });
    expect(p).toEqual({ applied: [], suggestions: [], noted: [], kept: [], data: {} });
  });
  it("a deadline the settings page would refuse (after 21:30) is kept with the reason", () => {
    const ans = {
      ...STUB_ANSWERS.deadlines,
      drop_out_deadline: { day: "monday", time: "23:00", confidence: "high", evidence: ["Drop out by Monday 9pm at the latest"] },
    };
    const p = planFor("deadlines", {}, ans);
    expect(p.kept).toContainEqual({ key: "dropOutDeadline", reason: "invalid:outside-hours" });
    expect(p.applied.map((a) => a.key)).toContain("listPublish");
  });
  it("a deadline on match day after kickoff is refused", () => {
    const ans = {
      ...STUB_ANSWERS.deadlines,
      list_published: { day: "thursday", time: "20:00", confidence: "high", evidence: ["Final list goes up Tuesday at 8pm"] },
    };
    const p = planFor("deadlines", {}, ans);
    expect(p.kept).toContainEqual({ key: "listPublish", reason: "invalid:after-kickoff" });
  });
});

describe("planSetup: the weekly game and the language are only ever suggested", () => {
  it("a different day, venue and size become suggestions; nothing is written for them", () => {
    const ans = {
      ...STUB_ANSWERS.rolling,
      weekly_game: {
        day: "wednesday",
        time: "21:00",
        venue: "Powerleague Sutton",
        players_per_side: 7,
        confidence: "high",
        evidence: ["See you at 9 at Goals North Cheam"],
      },
    };
    const p = planFor("rolling", {}, ans);
    expect(p.suggestions.map((s) => s.key)).toEqual(["weeklyGameDay", "venue", "format"]);
    expect(p.suggestions[0]).toMatchObject({ current: "2", detected: "3" });
    expect(Object.keys(p.data)).toEqual(["rollingSquadEnabled"]);
  });
  it("a venue written a little differently is the same venue", () => {
    const ans = {
      ...STUB_ANSWERS.rolling,
      weekly_game: { day: "tuesday", time: "21:00", venue: "goals north cheam", players_per_side: 0, confidence: "high", evidence: ["See you at 9"] },
    };
    expect(planFor("rolling", {}, ans).suggestions).toEqual([]);
  });
  it("a chat clearly in another language: a suggestion, unless the organiser chose the language", () => {
    const fx = loadFixture("turkish");
    const detection = parseDetection(STUB_ANSWERS.turkish, fx.history)!;
    const base = {
      detection,
      weeklyGame: fx.weeklyGame,
      activities: [{ dayOfWeek: 5, time: "21:00" }],
      chatLanguage: { lang: "tr", confident: true },
    };
    expect(planSetup({ ...base, org: { ...DEFAULTS, language: "en" } }).suggestions).toEqual([
      { key: "language", current: "en", detected: "tr", evidence: [] },
    ]);
    expect(planSetup({ ...base, org: { ...DEFAULTS, language: "en", settingsSetByOrganiser: ["language"] } }).suggestions).toEqual([]);
    expect(planSetup({ ...base, chatLanguage: { lang: "tr", confident: false }, org: { ...DEFAULTS } }).suggestions).toEqual([]);
  });
});

describe("buildUserContent", () => {
  it("names the group and the organiser's entry, and stamps messages in London time, oldest first", () => {
    const fx = loadFixture("rolling");
    const { text, sent } = buildUserContent({ groupSubject: fx.groupSubject, weeklyGame: fx.weeklyGame, history: fx.history });
    expect(sent).toBe(fx.history.length);
    expect(text).toContain("Group name: Tuesday Night 6s");
    expect(text).toContain("Weekly game the organiser entered: tuesday 21:00 at Goals North Cheam, 6 a side");
    // 2026-09-07 09:00Z is 10:00 in London (BST).
    expect(text).toContain("[Mon 7 Sep 10:00] Steve Hart: Same lot as last week");
    expect(text.indexOf("Mon 7 Sep")).toBeLessThan(text.indexOf("Wed 30 Sep"));
  });
  it("keeps the NEWEST messages inside the size cap, and puts a list on one line", () => {
    const h = Array.from({ length: 400 }, (_, i) => ({
      author: `P${i % 5}`,
      text: `message ${i}\n1. Ali\n2. Ben ${"x".repeat(300)}`,
      timestamp: new Date(Date.UTC(2026, 8, 1) + i * 60_000).toISOString(),
    }));
    const { text, sent } = buildUserContent({ groupSubject: null, weeklyGame: null, history: h });
    expect(text.length).toBeLessThanOrEqual(MAX_INPUT_CHARS + 400);
    expect(sent).toBeLessThan(400);
    expect(text).toContain("message 399 / 1. Ali / 2. Ben");
    expect(text).not.toContain("message 0 /");
    expect(text).toContain("Weekly game the organiser entered: none entered");
  });
});
