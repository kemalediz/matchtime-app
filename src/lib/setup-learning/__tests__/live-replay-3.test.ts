/**
 * F3, learned setup: THE THIRD LIVE CHECK, REPLAYED OFFLINE. No model.
 *
 * The approved run of 2026-10-12 (eight calls, $0.0711) passed all eight
 * fixtures on the prompt and schema as rewritten for go-live slice D3.
 * Its RAW answers are kept in __fixtures__/live-check-run-3.json, with
 * the answers after the quote check and the plans exactly as that run
 * computed them.
 *
 * The review of PR #238 then tightened the rules DOWNSTREAM of the model
 * (a quote must be whole words; a description quote must keep clear of
 * what the masking left and be more than a scrap; a fee excerpt must
 * state a price; chat is no longer held to the placeholder rule). The
 * prompt and the schema were not touched, so the model's answers are the
 * same answers, and this file is the proof that those rule changes move
 * NOTHING for them: every fixture still passes, with the same checked
 * answers and the same plan, to the last quote.
 *
 * What it does not prove: that the model always answers this way. It is
 * one pass.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectGroupLang } from "../../i18n/detect";
import { extractJson } from "../../pipeline/llm";
import { SETUP_LEARNING_MODEL } from "../prompt";
import { parseDetection, planSetup, type OrgSettingsState } from "../rules";
import { gradeFixture } from "./grade";
import { FIXTURE_NAMES, loadFixture } from "./stubs";

interface SavedRun {
  model: string;
  calls: number;
  spent: number;
  answers: Array<{ fixture: (typeof FIXTURE_NAMES)[number]; raw: string; checked: Record<string, unknown>; plan: Record<string, unknown> }>;
}
const RUN = JSON.parse(readFileSync(path.join(__dirname, "..", "__fixtures__", "live-check-run-3.json"), "utf8")) as SavedRun;

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

/** One saved answer through today's parser and planner, set up as the live check sets them up. */
function replay(name: string) {
  const saved = RUN.answers.find((a) => a.fixture === name)!;
  const fx = loadFixture(saved.fixture);
  const detection = parseDetection(extractJson(saved.raw), fx.history, fx.description)!;
  const plan = planSetup({
    detection,
    org: { ...DEFAULTS, language: fx.language },
    weeklyGame: fx.weeklyGame,
    activities: [{ dayOfWeek: fx.weeklyGame.dayOfWeek, time: fx.weeklyGame.time }],
    chatLanguage: detectGroupLang({ subject: fx.groupSubject, history: fx.history.map((m) => m.text) }),
  });
  return { saved, fx, detection, plan };
}

const EIGHT = ["rolling", "organiser-picks", "deadlines", "first-come", "turkish", "monthly-list", "description-supports", "description-stale"] as const;

describe("the third live check (2026-10-12), replayed through today's rules", () => {
  it("the saved run is the eight fixtures that make a call, one answer each, and holds no secret", () => {
    expect(RUN.model).toBe(SETUP_LEARNING_MODEL);
    expect(RUN.calls).toBe(8);
    expect(RUN.spent).toBeCloseTo(0.0711, 3);
    expect(RUN.answers.map((a) => a.fixture)).toEqual([...EIGHT]);
    expect(JSON.stringify(RUN)).not.toMatch(/sk-ant|api[_-]?key|authorization|bearer/i);
  });

  for (const name of EIGHT) {
    it(`${name}: the fixture passes, with the same checked answers and the same plan as the run`, () => {
      const { saved, fx, detection, plan } = replay(name);
      expect(gradeFixture(fx.expect, detection, plan), name).toEqual([]);
      expect(
        {
          squad: detection.squad,
          openPlaces: detection.openPlaces,
          dropOutDeadline: detection.dropOutDeadline,
          listPublished: detection.listPublished,
          payments: detection.payments,
          monthlyList: detection.monthlyList,
          weeklyGame: detection.weeklyGame,
          matchFee: detection.matchFee,
        },
        name,
      ).toEqual(saved.checked);
      // Through JSON, as the run saved it: a key that is undefined is no key.
      expect(JSON.parse(JSON.stringify(plan)), name).toEqual(saved.plan);
    });
  }

  it("description-supports: the deadline was switched on a message and the description, and the fee came from the description alone", () => {
    const { plan } = replay("description-supports");
    expect(plan.applied.map((a) => [a.key, a.to, a.fromDescription])).toEqual([
      ["dropOutDeadline", { day: 2, time: "18:00" }, ["Drop out by Tuesday 6pm or you still pay"]],
    ]);
    expect(plan.suggestions.map((s) => [s.key, s.detected, s.fromDescription])).toEqual([["matchFee", "6", ["£6 a player, pay before kick off"]]]);
    expect(JSON.stringify(plan)).not.toMatch(/removed|Pay Kemal/);
  });

  it("description-stale: the chat won on every point, and nothing quotes the description", () => {
    const { detection, plan } = replay("description-stale");
    expect(detection.squad.answer).toBe("sign_up_each_week");
    expect(plan.applied.map((a) => [a.key, a.to])).toEqual([["dropOutDeadline", { day: 4, time: "10:00" }]]);
    expect(plan.suggestions.map((s) => [s.key, s.detected])).toEqual([["matchFee", "7"]]);
    expect(JSON.stringify(plan)).not.toContain("fromDescription");
  });
});
