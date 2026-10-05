/**
 * What a correct model answer looks like for each fixture: the RAW JSON
 * the structured output would return, so `parseDetection` runs for real
 * on it (enum checks, evidence verified against the fixture's chat).
 * Unit tests only: nothing here calls a model.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { HistoryMessage } from "../../onboarding-enrichment-reconcile";

export interface Fixture {
  name: string;
  teaches: string;
  groupSubject: string;
  language: string;
  weeklyGame: { dayOfWeek: number; time: string; venue: string; playersPerSide: number };
  expect: Record<string, unknown> & { applied: string[]; noted: string[]; suggestions: string[]; dm: boolean; skipped?: string };
  history: HistoryMessage[];
}

export const FIXTURE_NAMES = [
  "rolling",
  "organiser-picks",
  "deadlines",
  "first-come",
  "turkish",
  "monthly-list",
  "empty",
  "too-short",
] as const;

export function loadFixture(name: (typeof FIXTURE_NAMES)[number]): Fixture {
  return JSON.parse(readFileSync(path.join(__dirname, "..", "__fixtures__", `${name}.json`), "utf8")) as Fixture;
}

const none = { confidence: "low", evidence: [] as string[] };
const unclear = (answer = "unclear") => ({ answer, ...none });
const noTime = { day: "none", time: "none", ...none };

/** The defaults: a regular game, nothing else shown. */
export function blankAnswer(): Record<string, unknown> {
  return {
    regular_game: true,
    squad: unclear(),
    open_places: unclear(),
    drop_out_deadline: noTime,
    list_published: noTime,
    payments: unclear("no_sign"),
    monthly_list: { ...unclear("no_sign"), prepay_for_month: false, pay_as_you_go_fill_ins: false, credit_for_missed_games: false },
    weekly_game: { day: "none", time: "none", venue: "", players_per_side: 0, ...none },
  };
}

export const STUB_ANSWERS: Record<string, Record<string, unknown>> = {
  rolling: {
    ...blankAnswer(),
    squad: { answer: "rolling", confidence: "high", evidence: ["Same lot as last week, let me know if you can't do Tuesday"] },
    open_places: unclear(),
    weekly_game: {
      day: "tuesday",
      time: "21:00",
      venue: "Goals North Cheam",
      players_per_side: 0,
      confidence: "high",
      evidence: ["See you at 9 at Goals North Cheam"],
    },
  },
  "organiser-picks": {
    ...blankAnswer(),
    open_places: {
      answer: "organisers_pick",
      confidence: "high",
      evidence: ["Drop me a message if you fancy a game and I'll sort the team"],
    },
  },
  deadlines: {
    ...blankAnswer(),
    squad: { answer: "sign_up_each_week", confidence: "high", evidence: ["in please"] },
    drop_out_deadline: { day: "monday", time: "21:00", confidence: "high", evidence: ["Drop out by Monday 9pm at the latest"] },
    list_published: { day: "tuesday", time: "20:00", confidence: "high", evidence: ["Final list goes up Tuesday at 8pm"] },
    payments: { answer: "players_confirm_paying", confidence: "high", evidence: ["sent £6"] },
    weekly_game: {
      day: "thursday",
      time: "20:00",
      venue: "Hackney Marshes",
      players_per_side: 0,
      confidence: "high",
      evidence: ["Kickoff Thursday 8pm at Hackney Marshes"],
    },
  },
  "first-come": {
    ...blankAnswer(),
    squad: { answer: "sign_up_each_week", confidence: "high", evidence: ["in for Saturday"] },
    open_places: { answer: "first_to_ask", confidence: "high", evidence: ["whoever's quickest gets in"] },
  },
  turkish: {
    ...blankAnswer(),
    squad: { answer: "rolling", confidence: "high", evidence: ["Kadro geçen haftakiyle aynı, olmayan yazsın"] },
    payments: { answer: "players_confirm_paying", confidence: "high", evidence: ["Ödedim"] },
  },
  "monthly-list": {
    ...blankAnswer(),
    squad: unclear(),
    payments: { answer: "players_confirm_paying", confidence: "high", evidence: ["i’ve paid as well"] },
    monthly_list: {
      answer: "monthly_list",
      prepay_for_month: true,
      pay_as_you_go_fill_ins: true,
      credit_for_missed_games: true,
      confidence: "high",
      evidence: ["we normally have the majority of us pay monthly", "Paid but can't play"],
    },
  },
};
