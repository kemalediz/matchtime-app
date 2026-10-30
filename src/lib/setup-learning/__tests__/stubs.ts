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
import type { FixtureExpect } from "./grade";

export interface Fixture {
  name: string;
  teaches: string;
  groupSubject: string;
  language: string;
  weeklyGame: { dayOfWeek: number; time: string; venue: string; playersPerSide: number };
  expect: FixtureExpect;
  history: HistoryMessage[];
  /** The group description as stored (already masked). Two fixtures have one. */
  description?: string;
}

export const FIXTURE_NAMES = [
  "rolling",
  "organiser-picks",
  "deadlines",
  "first-come",
  "turkish",
  "monthly-list",
  "description-supports",
  "description-stale",
  "whole-pitch",
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
    match_fee: { amount: 0, currency: "none", basis: "none", ...none },
  };
}

// A sentence the organiser posts again every week: quoted twice, once for
// each of two weeks' messages.
const DROP_OUT = "Drop out by Monday 9pm at the latest";
const LIST_UP = "Final list goes up Tuesday at 8pm";
const KADRO = "Kadro geçen haftakiyle aynı, olmayan yazsın";
const FEE_ASK = "£6 each please to the usual account";

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
    // The organiser asks for the same fee every week: two messages.
    match_fee: { amount: 6, currency: "pounds", basis: "per_player", confidence: "high", evidence: [FEE_ASK, FEE_ASK] },
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
    // Lira: the club's fee is held in pounds, so this is no fee.
    match_fee: { amount: 150, currency: "other", basis: "per_player", confidence: "high", evidence: ["Kişi başı 150 TL", "Kişi başı 150 TL"] },
  },
  // The description states the deadline and the fee; ONE message repeats
  // the deadline. The second deadline quote ends in the description's full
  // stop, so it is in the description only.
  "description-supports": {
    ...blankAnswer(),
    squad: { answer: "sign_up_each_week", confidence: "high", evidence: ["in please"] },
    drop_out_deadline: {
      day: "tuesday",
      time: "18:00",
      confidence: "high",
      evidence: ["drop out by Tuesday 6pm or you still pay, that hasn't changed", "Drop out by Tuesday 6pm or you still pay."],
    },
    match_fee: { amount: 6, currency: "pounds", basis: "per_player", confidence: "medium", evidence: ["£6 a player, pay before kick off."] },
  },
  // The description is out of date; every answer comes from the chat.
  "description-stale": {
    ...blankAnswer(),
    squad: { answer: "sign_up_each_week", confidence: "high", evidence: ["names in every week please", "Names for Thursday please"] },
    drop_out_deadline: {
      day: "thursday",
      time: "10:00",
      confidence: "high",
      evidence: ["tell me by Thursday 10am at the latest", "Drop outs by Thursday 10am please"],
    },
    match_fee: { amount: 7, currency: "pounds", basis: "per_player", confidence: "high", evidence: ["it's £7 each from now on", "Reminder it's £7 each now"] },
  },
  // The whole pitch's price, every week: the model says so (2026-10-30),
  // and no fee is suggested, though every quote holds the number.
  "whole-pitch": {
    ...blankAnswer(),
    squad: { answer: "sign_up_each_week", confidence: "high", evidence: ["in please", "ben varım"] },
    match_fee: {
      amount: 60,
      currency: "pounds",
      basis: "whole_pitch",
      confidence: "high",
      evidence: ["£60 for the hour, we split it between whoever turns up", "still £60 for the hour"],
    },
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

/**
 * What the model answers for each fixture as a whole, for the tests that
 * run a fixture end to end and grade it against its `expect`. The same as
 * STUB_ANSWERS (each built to teach one rule) except where the fixture's
 * expectation follows a reading those stubs leave out on purpose.
 *
 * organiser-picks (Kemal, 2026-10-19): the organiser posts "Team for
 * Wednesday" every Monday at 19:00 London for four weeks. Haiku 5.5
 * quotes two of those posts, so the list going out Monday 19:00 is
 * applied. Haiku 4.5 quoted one, and nothing was.
 */
export const FIXTURE_ANSWERS: Record<string, Record<string, unknown>> = {
  ...STUB_ANSWERS,
  "organiser-picks": {
    ...STUB_ANSWERS["organiser-picks"],
    list_published: {
      day: "monday",
      time: "19:00",
      confidence: "high",
      evidence: ["Team for Wednesday: Tariq, Nathan, Ollie, Jamal, Rhys, Ben, Sami and me", "Team for Wednesday: Tariq, Nathan, Ollie, Jamal, Rhys"],
    },
  },
};
