/**
 * F3, learned setup: does a model answer, read by the rules, give what a
 * fixture expects? ONE grader, used by the approved live check
 * (scripts/live-check-setup-learning.ts) and by the offline replay of a
 * saved run (live-replay.test.ts), so the two can never disagree about
 * what "pass" means. Pure: no model, no database.
 *
 * A fixture pins the detection fields it cares about, and exactly which
 * settings are switched and which patterns are noted. Suggestions must be
 * the ones listed, in order; a key in `mayAlsoSuggest` is tolerated on
 * top, because a suggestion changes nothing and the model is known to
 * offer it (see rolling.json).
 */
import { planIsWorthTelling, type Detection, type SetupPlan } from "../rules";

export interface FixtureExpect extends Record<string, unknown> {
  applied: string[];
  noted: string[];
  suggestions: string[];
  /** Suggestions that may appear on top of `suggestions` without failing. */
  mayAlsoSuggest?: string[];
  dm: boolean;
  skipped?: string;
}

/** Every miss as "field: expected X, got Y". Empty when the fixture passes. */
export function gradeFixture(e: FixtureExpect, d: Detection, plan: SetupPlan): string[] {
  const misses: string[] = [];
  const check = (label: string, want: unknown, got: unknown) => {
    if (want !== undefined && JSON.stringify(want) !== JSON.stringify(got)) {
      misses.push(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    }
  };
  check("regularGame", e.regularGame, d.regularGame);
  check("squad", e.squad, d.squad.answer);
  check("openPlaces", e.openPlaces, d.openPlaces.answer);
  check("payments", e.payments, d.payments.answer);
  check("monthlyList", e.monthlyList, d.monthlyList.answer);
  if (e.dropOutDeadline) check("dropOutDeadline", e.dropOutDeadline, { day: d.dropOutDeadline.day, time: d.dropOutDeadline.time });
  if (e.listPublished) check("listPublished", e.listPublished, { day: d.listPublished.day, time: d.listPublished.time });

  const keys = (xs: Array<{ key: string }>) => xs.map((x) => x.key);
  check("applied", e.applied, keys(plan.applied));
  check("noted", e.noted, keys(plan.noted));
  const tolerated = new Set((e.mayAlsoSuggest ?? []).filter((k) => !e.suggestions.includes(k)));
  check(
    "suggestions",
    e.suggestions,
    keys(plan.suggestions).filter((k) => !tolerated.has(k)),
  );
  check("dm", e.dm, planIsWorthTelling(plan));
  return misses;
}
