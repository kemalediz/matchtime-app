/**
 * What a correct model answer looks like for each fixture: the RAW JSON
 * the structured output would return, so `parseDetection` runs for real
 * on it (enum checks, evidence verified against the fixture's chat).
 * Unit tests only: nothing here calls a model.
 *
 * A correct answer backs every "high" with TWO excerpts from two
 * different messages (the same sentence posted again another week is a
 * second message), because that is what `planSetup` needs to switch a
 * setting. OBSERVED_ANSWERS, at the foot, are the wrong answers the first
 * live check got on 2026-10-05.
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

// A sentence the organiser posts again every week: quoted twice, once for
// each of two weeks' messages.
const DROP_OUT = "Drop out by Monday 9pm at the latest";
const LIST_UP = "Final list goes up Tuesday at 8pm";
const KADRO = "Kadro geçen haftakiyle aynı, olmayan yazsın";

export const STUB_ANSWERS: Record<string, Record<string, unknown>> = {
  rolling: {
    ...blankAnswer(),
    squad: {
      answer: "rolling",
      confidence: "high",
      evidence: ["Same lot as last week, let me know if you can't do Tuesday", "Usual crew this week too, only message if you're dropping out"],
    },
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
      evidence: ["Drop me a message if you fancy a game and I'll sort the team", "I'll pick someone off the reserve list"],
    },
  },
  deadlines: {
    ...blankAnswer(),
    squad: { answer: "sign_up_each_week", confidence: "high", evidence: ["in please"] },
    drop_out_deadline: { day: "monday", time: "21:00", confidence: "high", evidence: [DROP_OUT, DROP_OUT] },
    list_published: { day: "tuesday", time: "20:00", confidence: "high", evidence: [LIST_UP, LIST_UP] },
    payments: { answer: "players_confirm_paying", confidence: "high", evidence: ["sent £6", "paid"] },
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
    squad: { answer: "rolling", confidence: "high", evidence: [KADRO, KADRO] },
    payments: { answer: "players_confirm_paying", confidence: "high", evidence: ["Ödedim", "Gönderdim abi"] },
  },
  "monthly-list": {
    ...blankAnswer(),
    squad: unclear(),
    payments: { answer: "players_confirm_paying", confidence: "high", evidence: ["i’ve paid as well", "paid!"] },
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

/**
 * THE WRONG ANSWERS OF THE FIRST LIVE CHECK (2026-10-05, Haiku 4.5, six
 * calls, three fixtures failed). RECONSTRUCTED from what was reported of
 * that run, not copied from its raw output, which was not kept:
 *
 *   turkish       reported: organisers_pick at "high" on the one line
 *                 "Tamam Burak, yerine birini bulalım", and a squad
 *                 "evidence" item that was the model's own summary. The
 *                 payments answer is assumed to have been right.
 *   monthly-list  reported: rolling squad and organisers pick both applied,
 *                 the rolling quote shown to the organiser being "Usually
 *                 ends up ok lol". The other excerpts here are stand-ins,
 *                 chosen verbatim so only the monthly rule can stop them.
 *   rolling       its output was not reported at all. This is a GUESS at
 *                 the shape (the same misreading as turkish: an organiser
 *                 asking who can cover read as organisers picking), kept
 *                 so that shape is pinned; it is not evidence of the cause.
 */
export const OBSERVED_ANSWERS: Record<"turkish" | "monthly-list" | "rolling", Record<string, unknown>> = {
  turkish: {
    ...blankAnswer(),
    squad: { answer: "rolling", confidence: "high", evidence: ["Same squad repeated every week across 4 weeks", KADRO] },
    open_places: { answer: "organisers_pick", confidence: "high", evidence: ["Tamam Burak, yerine birini bulalım"] },
    payments: { answer: "players_confirm_paying", confidence: "high", evidence: ["Ödedim", "Gönderdim abi"] },
  },
  "monthly-list": {
    ...blankAnswer(),
    squad: { answer: "rolling", confidence: "high", evidence: ["Usually ends up ok lol", "you can write my name down as a regular"] },
    open_places: {
      answer: "organisers_pick",
      confidence: "high",
      evidence: ["Add yourself to list mate we are happy to have u", "let the regulars slap their names down first"],
    },
    payments: { answer: "players_confirm_paying", confidence: "high", evidence: ["i’ve paid as well", "paid!"] },
    monthly_list: {
      answer: "monthly_list",
      prepay_for_month: true,
      pay_as_you_go_fill_ins: true,
      credit_for_missed_games: true,
      confidence: "high",
      evidence: ["we normally have the majority of us pay monthly", "Paid but can't play"],
    },
  },
  rolling: {
    ...(STUB_ANSWERS.rolling as Record<string, unknown>),
    open_places: { answer: "organisers_pick", confidence: "high", evidence: ["anyone got a mate who can cover?"] },
  },
};
