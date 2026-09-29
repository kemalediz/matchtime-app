/**
 * The engine and the composer on a `score` question that asks for
 * SEVERAL results or a period (2026-09-29). The model classifies; these
 * decide and render. With no count and no period, today's answer (the
 * last match) is unchanged.
 */
import { describe, expect, it } from "vitest";
import { decide } from "../engine";
import { compose } from "../compose";
import { displaysSquadState } from "../../group-copy";
import { NOW, msg, world } from "./helpers";
import type { QuestionFacts, RecentResults, SquadState } from "../types";

const score = (over: Partial<QuestionFacts> = {}): QuestionFacts => ({
  kind: "question",
  topic: "score",
  personRef: null,
  statedCount: null,
  ...over,
});

const RESULTS: RecentResults = {
  since: null,
  more: true,
  rows: [
    { dayLabel: "Tue 29 Sep", redLabel: "Red", yellowLabel: "Yellow", red: 5, yellow: 4 },
    { dayLabel: "Tue 22 Sep", redLabel: "Red", yellowLabel: "Yellow", red: 2, yellow: 6 },
    { dayLabel: "Tue 15 Sep", redLabel: "Red", yellowLabel: "Yellow", red: 3, yellow: 3 },
    { dayLabel: "Tue 8 Sep", redLabel: "Red", yellowLabel: "Yellow", red: 7, yellow: 1 },
    { dayLabel: "Tue 1 Sep", redLabel: "Red", yellowLabel: "Yellow", red: 4, yellow: 5 },
    { dayLabel: "Tue 25 Aug", redLabel: "Red", yellowLabel: "Yellow", red: 1, yellow: 0 },
  ],
};

const base = (over: Partial<SquadState> = {}): SquadState => ({
  ...world({ completedMatch: { id: "m-old", kickoffLabel: "Tue 21:30", redScore: 5, yellowScore: 4 } }),
  ...over,
});

const ask = (facts: QuestionFacts, body = "@Match Time give us the scores of the last 5 matches") =>
  msg({ id: "wa-q", from: "shaz", body, route: "question", tagged: true, facts });

describe("the engine", () => {
  it("the incident: the last 5 matches is a list of five", () => {
    const r = decide({ now: NOW, state: base(), messages: [ask(score({ listSize: 5 }))] });
    expect(r.speech).toContainEqual({ kind: "answer_results", messageId: "wa-q", limit: 5, asked: 5, period: null });
    expect(r.speech.some((s) => s.kind === "answer_score")).toBe(false);
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/results question: the last 5 results/);
  });

  it("no count and no period is still the last match, as before", () => {
    const r = decide({ now: NOW, state: base(), messages: [ask(score(), "@Match Time what was the score")] });
    expect(r.speech).toContainEqual({ kind: "answer_score", messageId: "wa-q" });
    expect(r.speech.some((s) => s.kind === "answer_results")).toBe(false);
  });

  it("a count over the cap is served as ten, and the reason says what was asked", () => {
    const r = decide({ now: NOW, state: base(), messages: [ask(score({ listSize: 25 }))] });
    expect(r.speech).toContainEqual({ kind: "answer_results", messageId: "wa-q", limit: 10, asked: 25, period: null });
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/asked for 25/);
  });

  it("a period is carried to the composer", () => {
    const r = decide({ now: NOW, state: base(), messages: [ask(score({ period: { kind: "season" } }), "@Match Time results this season")] });
    expect(r.speech).toContainEqual({ kind: "answer_results", messageId: "wa-q", limit: 10, asked: null, period: { kind: "season" } });
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/period season/);
  });

  it("proposes no writes", () => {
    const r = decide({ now: NOW, state: base(), messages: [ask(score({ listSize: 5 }))] });
    expect(r.writes).toHaveLength(0);
  });
});

describe("the composer", () => {
  it("renders the five most recent results from the loaded snapshot", () => {
    const state = base({ results: { all: RESULTS } });
    const out = compose(decide({ now: NOW, state, messages: [ask(score({ listSize: 5 }))] }));
    const text = out.utterances.find((u) => u.messageId === "wa-q")!.text;
    expect(text.split("\n")).toEqual([
      "⚽ Last 5 results:",
      "• Tue 29 Sep: Red 5 - 4 Yellow. Red won.",
      "• Tue 22 Sep: Red 2 - 6 Yellow. Yellow won.",
      "• Tue 15 Sep: Red 3 - 3 Yellow. A draw.",
      "• Tue 8 Sep: Red 7 - 1 Yellow. Red won.",
      "• Tue 1 Sep: Red 4 - 5 Yellow. Yellow won.",
    ]);
    expect(displaysSquadState(text)).toBe(false);
  });

  it("reads the period's own snapshot", () => {
    const month: RecentResults = { since: new Date("2026-09-01T00:00:00Z"), more: false, rows: RESULTS.rows.slice(0, 2) };
    const state = base({ results: { all: RESULTS, "this:month": month } });
    const out = compose(
      decide({ now: NOW, state, messages: [ask(score({ period: { kind: "this", unit: "month" } }), "@Match Time results this month")] }),
    );
    const text = out.utterances.find((u) => u.messageId === "wa-q")!.text;
    expect(text.split("\n")).toHaveLength(3);
    expect(text).toMatch(/^⚽ Results this month:/);
  });

  it("speaks Turkish in a Turkish group", () => {
    const tr: RecentResults = {
      since: null,
      more: false,
      rows: [{ dayLabel: "29 Eylül Salı", redLabel: "Kırmızı", yellowLabel: "Sarı", red: 5, yellow: 4 }],
    };
    const state = base({ results: { all: tr }, features: { ...base().features, language: "tr" } });
    const out = compose(decide({ now: NOW, state, messages: [ask(score({ listSize: 5 }), "@Match Time son 5 maçın skorları")] }));
    const text = out.utterances.find((u) => u.messageId === "wa-q")!.text;
    expect(text).toBe("⚽ Son sonuç:\n• 29 Eylül Salı: Kırmızı 5 - 4 Sarı. Kırmızı kazandı.\nSkoru kayıtlı maçların hepsi bu.");
  });

  it("says nothing when the results were not loaded, so the batch disowns it with a receipt", () => {
    const out = compose(decide({ now: NOW, state: base(), messages: [ask(score({ listSize: 5 }))] }));
    expect(out.utterances.filter((u) => u.messageId === "wa-q")).toHaveLength(0);
    expect(out.operatorNotes.join(" ")).toMatch(/results/);
  });
});
