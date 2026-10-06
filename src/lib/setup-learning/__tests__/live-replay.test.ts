/**
 * F3, learned setup: THE SECOND LIVE CHECK, REPLAYED OFFLINE. No model.
 *
 * The approved run of 2026-10-06 (six calls, $0.0475) passed five of six
 * fixtures. "rolling" failed: the model answered open_places =
 * organisers_pick at "high" with two real quotes from two messages
 * ("anyone got a mate who can cover?", "Sorted, thanks Dev. Everyone else
 * as you were"), so the two-quote guard let "organisers pick" be switched
 * on for a group whose organiser had only sorted one replacement.
 *
 * The fix is downstream of the model: who fills an open place is never
 * switched from the chat, it is suggested. The prompt is unchanged, so the
 * model's answers are unchanged, and the six RAW answers of that run
 * (__fixtures__/live-check-run-2.json) fed through today's rules are
 * exactly what a third run would produce for the same answers. They are
 * graded here by the same grader the live check uses.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectGroupLang } from "../../i18n/detect";
import { extractJson } from "../../pipeline/llm";
import { composeSetupDm } from "../dm";
import { parseDetection, planIsWorthTelling, planSetup, type OrgSettingsState, type SetupPlan } from "../rules";
import { gradeFixture } from "./grade";
import { FIXTURE_NAMES, loadFixture } from "./stubs";

interface SavedRun {
  model: string;
  calls: number;
  answers: Array<{ fixture: (typeof FIXTURE_NAMES)[number]; raw: string; checked: Record<string, unknown> }>;
}
const RUN = JSON.parse(
  readFileSync(path.join(__dirname, "..", "__fixtures__", "live-check-run-2.json"), "utf8"),
) as SavedRun;

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

/** One saved answer through the parser and the planner, set up as the live check sets them up. */
function replay(name: string) {
  const saved = RUN.answers.find((a) => a.fixture === name)!;
  const fx = loadFixture(saved.fixture);
  const detection = parseDetection(extractJson(saved.raw), fx.history)!;
  const plan = planSetup({
    detection,
    org: { ...DEFAULTS, language: fx.language },
    weeklyGame: fx.weeklyGame,
    activities: [{ dayOfWeek: fx.weeklyGame.dayOfWeek, time: fx.weeklyGame.time }],
    chatLanguage: detectGroupLang({ subject: fx.groupSubject, history: fx.history.map((m) => m.text) }),
  });
  return { saved, fx, detection, plan };
}

function dmOf(lang: string, group: string, plan: SetupPlan): string {
  return composeSetupDm({
    lang,
    group,
    applied: plan.applied.map((a) => ({ ...a, undoUrl: `https://mt.link/undo-${a.key}` })),
    suggestions: plan.suggestions,
    noted: plan.noted,
    scheduleUrl: "https://mt.link/activities",
    settingsUrl: "https://mt.link/settings",
    organiserPicksUrl: "https://mt.link/pick",
  });
}

const SIX = ["rolling", "organiser-picks", "deadlines", "first-come", "turkish", "monthly-list"] as const;

describe("the second live check (2026-10-06), replayed through today's rules", () => {
  it("the saved run is the six fixtures that make a call, one answer each", () => {
    expect(RUN.model).toBe("claude-haiku-4-5");
    expect(RUN.calls).toBe(6);
    expect(RUN.answers.map((a) => a.fixture)).toEqual([...SIX]);
  });

  for (const name of SIX) {
    it(`${name}: the saved answer parses as that run recorded it, and the fixture passes`, () => {
      const { saved, fx, detection, plan } = replay(name);
      // The replay really is that run: the answers after the quote check are identical.
      expect(
        {
          squad: detection.squad,
          openPlaces: detection.openPlaces,
          dropOutDeadline: detection.dropOutDeadline,
          listPublished: detection.listPublished,
          payments: detection.payments,
          monthlyList: detection.monthlyList,
          weeklyGame: detection.weeklyGame,
        },
        name,
      ).toEqual(saved.checked);
      expect(gradeFixture(fx.expect, detection, plan), name).toEqual([]);
    });
  }

  it("rolling, the one that failed: rolling squad is switched on, organisers pick is ONLY suggested, with both quotes", () => {
    const { plan } = replay("rolling");
    expect(plan.applied.map((a) => a.key)).toEqual(["rollingSquad"]);
    expect(plan.data).toEqual({ rollingSquadEnabled: true });
    expect(plan.suggestions).toEqual([
      {
        key: "organiserPicks",
        current: "first-come",
        detected: "organiser",
        evidence: ["anyone got a mate who can cover?", "Sorted, thanks Dev. Everyone else as you were"],
      },
    ]);
  });

  it("organiser-picks: nothing is switched, the organiser is asked, and still gets the DM", () => {
    const { plan } = replay("organiser-picks");
    expect(plan.applied).toEqual([]);
    expect(plan.data).toEqual({});
    expect(plan.suggestions.map((s) => s.key)).toEqual(["organiserPicks"]);
    expect(planIsWorthTelling(plan)).toBe(true);
  });

  it("turkish: organisers pick at medium on one line is neither switched nor suggested", () => {
    const { detection, plan } = replay("turkish");
    expect(detection.openPlaces).toMatchObject({ answer: "organisers_pick", confidence: "medium" });
    expect(plan.applied.map((a) => a.key)).toEqual(["rollingSquad", "paymentTracking"]);
    expect(plan.suggestions).toEqual([]);
  });

  it("no answer of that run switches who fills an open place, in any fixture", () => {
    for (const name of SIX) {
      const { plan } = replay(name);
      expect(plan.applied.map((a) => a.key), name).not.toContain("organiserPicks");
      expect(plan.data, name).not.toHaveProperty("benchPickMode");
    }
  });

  it("the DM the rolling group's organiser would get", () => {
    const { fx, plan } = replay("rolling");
    expect(dmOf("en", fx.groupSubject, plan)).toBe(
      `I read the recent messages in "Tuesday Night 6s" to see how it runs, and set MatchTime up the same way.\n\n` +
        `✅ *Rolling squad is on:* whoever played last time is in next time, unless they say OUT.\n` +
        `From messages like: "Same lot as last week, let me know if you can't do Tuesday"\n` +
        `Undo or change: https://mt.link/undo-rollingSquad\n\n` +
        `Worth a check (I changed nothing here):\n` +
        `🔎 It looks like the organisers choose who fills an open place. If that's right, switch on "The organisers pick".\n` +
        `From messages like: "anyone got a mate who can cover?"\n` +
        `Switch it on here: https://mt.link/pick\n\n` +
        `Everything is on your settings page, with the chat messages behind each one: https://mt.link/settings`,
    );
  });

  it("no DM of that run, in either language, carries an em or en dash", () => {
    for (const name of SIX) {
      const { fx, plan } = replay(name);
      if (!planIsWorthTelling(plan)) continue;
      for (const lang of ["en", "tr"]) expect(dmOf(lang, fx.groupSubject, plan), `${name}/${lang}`).not.toMatch(/[—–]/);
    }
  });
});
