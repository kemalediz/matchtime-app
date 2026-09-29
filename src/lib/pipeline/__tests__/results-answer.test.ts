/**
 * RECENT RESULTS (2026-09-29). Sutton FC asked "@Match Time give us the
 * scores of the last 5 matches" and got the last match only. The model
 * now reads the count and the period (`listSize`, `period`); this module
 * turns them into a plan and renders the answer from data, in code.
 */
import { describe, expect, it } from "vitest";
import { planResultsQuestion, renderResults, resultsKey, RESULTS_MAX } from "../results-answer";
import { displaysSquadState } from "../../group-copy";
import type { QuestionFacts, RecentResults, ResultRow } from "../types";

const q = (over: Partial<QuestionFacts> = {}): QuestionFacts => ({
  kind: "question",
  topic: "score",
  personRef: null,
  statedCount: null,
  ...over,
});

const row = (day: string, red: number, yellow: number, labels: [string, string] = ["Red", "Yellow"]): ResultRow => ({
  dayLabel: day,
  redLabel: labels[0],
  yellowLabel: labels[1],
  red,
  yellow,
});

const FIVE: ResultRow[] = [
  row("Tue 29 Sep", 5, 4),
  row("Tue 22 Sep", 2, 6),
  row("Tue 15 Sep", 3, 3),
  row("Tue 8 Sep", 7, 1),
  row("Tue 1 Sep", 4, 5),
];
const snap = (rows: ResultRow[], more = false): RecentResults => ({ since: null, rows, more });

describe("planResultsQuestion", () => {
  it("no count and no period keeps today's answer: the last match", () => {
    expect(planResultsQuestion(q())).toEqual({ kind: "last_match" });
    expect(planResultsQuestion(q({ listSize: null, period: null }))).toEqual({ kind: "last_match" });
  });

  it("a count of one with no period is still the last match", () => {
    expect(planResultsQuestion(q({ listSize: 1 }))).toEqual({ kind: "last_match" });
  });

  it("the incident: the last 5 matches", () => {
    expect(planResultsQuestion(q({ listSize: 5 }))).toEqual({ kind: "list", limit: 5, asked: 5, period: null });
  });

  it("caps at ten and remembers what was asked", () => {
    expect(RESULTS_MAX).toBe(10);
    expect(planResultsQuestion(q({ listSize: 20 }))).toEqual({ kind: "list", limit: 10, asked: 20, period: null });
  });

  it("a period with no count lists up to ten", () => {
    expect(planResultsQuestion(q({ period: { kind: "season" } }))).toEqual({
      kind: "list",
      limit: 10,
      asked: null,
      period: { kind: "season" },
    });
    expect(planResultsQuestion(q({ period: { kind: "this", unit: "month" } }))).toMatchObject({ limit: 10, asked: null });
  });

  it("a count and a period together keep both", () => {
    expect(planResultsQuestion(q({ listSize: 3, period: { kind: "last", count: 2, unit: "month" } }))).toEqual({
      kind: "list",
      limit: 3,
      asked: 3,
      period: { kind: "last", count: 2, unit: "month" },
    });
  });
});

describe("resultsKey", () => {
  it("the whole record is one key; a cutting period is its own", () => {
    expect(resultsKey(null)).toBe("all");
    expect(resultsKey({ kind: "season" })).toBe("all");
    expect(resultsKey({ kind: "all_time" })).toBe("all");
    expect(resultsKey({ kind: "this", unit: "month" })).toBe("this:month");
    expect(resultsKey({ kind: "last", count: 3, unit: "month" })).toBe("last:3:month");
  });
});

describe("renderResults, English", () => {
  const plan = (limit: number, asked: number | null, period: QuestionFacts["period"] = null) => ({ limit, asked, period: period ?? null });

  it("the incident: five results, most recent first, with who won", () => {
    const text = renderResults(plan(5, 5), snap(FIVE), "en");
    expect(text).toBe(
      [
        "⚽ Last 5 results:",
        "• Tue 29 Sep: Red 5 - 4 Yellow. Red won.",
        "• Tue 22 Sep: Red 2 - 6 Yellow. Yellow won.",
        "• Tue 15 Sep: Red 3 - 3 Yellow. A draw.",
        "• Tue 8 Sep: Red 7 - 1 Yellow. Red won.",
        "• Tue 1 Sep: Red 4 - 5 Yellow. Yellow won.",
      ].join("\n"),
    );
    expect(displaysSquadState(text!)).toBe(false);
    expect(text).not.toMatch(/—|–/);
  });

  it("prints only as many as asked", () => {
    const text = renderResults(plan(2, 2), snap(FIVE, true), "en")!;
    expect(text.split("\n")).toHaveLength(3);
    expect(text).toMatch(/^⚽ Last 2 results:/);
  });

  it("says so when the record holds fewer than asked", () => {
    const text = renderResults(plan(5, 5), snap(FIVE.slice(0, 3)), "en")!;
    expect(text).toMatch(/^⚽ Last 3 results:/);
    expect(text).toContain("That's every scored match I have on record.");
  });

  it("says so when it posts fewer than asked because of the cap", () => {
    const ten = Array.from({ length: 10 }, (_, i) => row(`Tue ${i + 1} Sep`, i, 1));
    const text = renderResults(plan(10, 20), snap(ten, true), "en")!;
    expect(text).toMatch(/^⚽ Last 10 results:/);
    expect(text).toContain("I post up to 10 results in the group.");
  });

  it("a cutting period names the period", () => {
    const text = renderResults(plan(10, null, { kind: "this", unit: "month" }), snap(FIVE.slice(0, 2)), "en")!;
    expect(text).toMatch(/^⚽ Results this month:/);
    const last = renderResults(plan(10, null, { kind: "last", count: 3, unit: "month" }), snap(FIVE), "en")!;
    expect(last).toMatch(/^⚽ Results in the last 3 months:/);
  });

  it("a cutting period with more than ten says these are the latest", () => {
    const ten = Array.from({ length: 10 }, (_, i) => row(`Tue ${i + 1} Sep`, i, 1));
    const text = renderResults(plan(10, null, { kind: "last", count: 1, unit: "year" }), snap(ten, true), "en")!;
    expect(text).toMatch(/^⚽ Results in the last year:/);
    expect(text).toContain("These are the latest 10.");
  });

  it("the season and all time are the whole record, and say how many", () => {
    expect(renderResults(plan(10, null, { kind: "season" }), snap(FIVE), "en")).toMatch(/^⚽ Last 5 results this season:/);
    expect(renderResults(plan(10, null, { kind: "all_time" }), snap(FIVE), "en")).toMatch(/^⚽ Last 5 results on record:/);
  });

  it("a single row reads 'Last result'", () => {
    expect(renderResults(plan(3, 3), snap(FIVE.slice(0, 1)), "en")).toMatch(/^⚽ Last result:/);
  });

  it("nothing on record, and nothing in a period, are said plainly", () => {
    expect(renderResults(plan(5, 5), snap([]), "en")).toBe("I haven't got a scored match on record for this group yet.");
    expect(renderResults(plan(10, null, { kind: "this", unit: "month" }), snap([]), "en")).toBe("No scored matches this month.");
  });

  it("renders each match under its own team names", () => {
    const text = renderResults(plan(1 + 1, 2), snap([row("Tue 29 Sep", 1, 0, ["Bibs", "Skins"]), row("Tue 22 Sep", 0, 0)]), "en")!;
    expect(text).toContain("Bibs 1 - 0 Skins. Bibs won.");
  });

  it("returns null when the results were not loaded", () => {
    expect(renderResults(plan(5, 5), undefined, "en")).toBeNull();
  });
});

describe("renderResults, Turkish", () => {
  const plan = (limit: number, asked: number | null, period: QuestionFacts["period"] = null) => ({ limit, asked, period: period ?? null });
  const TR = FIVE.map((r, i) => ({ ...r, dayLabel: ["29 Eylül Salı", "22 Eylül Salı", "15 Eylül Salı", "8 Eylül Salı", "1 Eylül Salı"][i], redLabel: "Kırmızı", yellowLabel: "Sarı" }));

  it("son 5 maçın skorları", () => {
    const text = renderResults(plan(5, 5), snap(TR), "tr")!;
    expect(text.split("\n")[0]).toBe("⚽ Son 5 sonuç:");
    expect(text).toContain("• 29 Eylül Salı: Kırmızı 5 - 4 Sarı. Kırmızı kazandı.");
    expect(text).toContain("• 15 Eylül Salı: Kırmızı 3 - 3 Sarı. Berabere.");
    expect(displaysSquadState(text, "tr")).toBe(false);
    expect(text).not.toMatch(/—|–/);
  });

  it("periods, shortfalls and empties in Turkish", () => {
    expect(renderResults(plan(10, null, { kind: "this", unit: "month" }), snap(TR.slice(0, 2)), "tr")).toMatch(/^⚽ Bu ay oynanan maçların sonuçları:/);
    expect(renderResults(plan(10, null, { kind: "last", count: 3, unit: "month" }), snap(TR), "tr")).toMatch(/^⚽ Son 3 ayda oynanan maçların sonuçları:/);
    expect(renderResults(plan(10, null, { kind: "season" }), snap(TR), "tr")).toMatch(/^⚽ Bu sezon son 5 sonuç:/);
    expect(renderResults(plan(5, 5), snap(TR.slice(0, 3)), "tr")).toContain("Skoru kayıtlı maçların hepsi bu.");
    expect(renderResults(plan(5, 5), snap([]), "tr")).toBe("Bu grup için skoru kayıtlı bir maç henüz yok.");
    expect(renderResults(plan(10, null, { kind: "this", unit: "month" }), snap([]), "tr")).toBe("Bu ay skoru kayıtlı maç yok.");
  });
});
