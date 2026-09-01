/**
 * Unit tests for the incident-corpus GRADER and SCOREBOARD.
 *
 * The corpus CASES are data; these tests are about the machinery that
 * judges them. Written red-first (MDs/analyzer-redesign-2026-08-31.md
 * §10 step 1): a corpus nobody has tested is a corpus nobody can trust
 * to say "the new pipeline is safe".
 *
 * Nothing here touches a database, a model, or Playwright.
 */
import { describe, it, expect } from "vitest";
import {
  gradeCase,
  buildScoreboard,
  renderScoreboard,
  ALL_PROMPT_SECTIONS,
  type CorpusCase,
  type CorpusObservation,
} from "./grade";

// ── Fixtures ───────────────────────────────────────────────────────────

const baseCase = (over: Partial<CorpusCase> = {}): CorpusCase => ({
  id: "T1-example",
  title: "example",
  sections: ["S6"],
  category: "D",
  provenance: { kind: "commit", ref: "f61a897", note: "test fixture" },
  world: {
    maxPlayers: 14,
    players: [
      { key: "najib", name: "Najib Ahmadi" },
      { key: "alice", name: "Alice Admin", role: "ADMIN" },
    ],
  },
  messages: [{ from: "najib", body: "In" }],
  expect: { attendance: [{ player: "najib", status: "BENCH" }] },
  ...over,
});

const obs = (over: Partial<CorpusObservation> = {}): CorpusObservation => ({
  attendanceBefore: [],
  attendanceAfter: [],
  memberNamesBefore: ["Najib Ahmadi", "Alice Admin"],
  memberNamesAfter: ["Najib Ahmadi", "Alice Admin"],
  spoken: [],
  dms: [],
  reacts: [],
  benchOffersOpen: 0,
  ...over,
});

// ── The four contract tests named in the brief ─────────────────────────

describe("gradeCase — the runner's own contract", () => {
  it("a case whose known-correct outcome actually happened PASSES", () => {
    const r = gradeCase(
      baseCase(),
      obs({ attendanceAfter: [{ name: "Najib Ahmadi", status: "BENCH" }] }),
    );
    expect(r.passed).toBe(true);
    expect(r.failures).toEqual([]);
    expect(r.classification).toBe(null);
  });

  it("a deliberately WRONG expectation FAILS on an otherwise-correct run", () => {
    const wrong = baseCase({
      // The truth is BENCH; assert CONFIRMED and the grader must object.
      expect: { attendance: [{ player: "najib", status: "CONFIRMED" }] },
    });
    const r = gradeCase(
      wrong,
      obs({ attendanceAfter: [{ name: "Najib Ahmadi", status: "BENCH" }] }),
    );
    expect(r.passed).toBe(false);
    expect(r.classification).toBe("wrong_write");
    expect(r.failures.join(" ")).toMatch(/Najib/);
  });

  it("a pipeline that writes NOTHING fails a case that requires a write", () => {
    const r = gradeCase(baseCase(), obs());
    expect(r.passed).toBe(false);
    expect(r.classification).toBe("missed_write");
    expect(r.failures.join(" ")).toMatch(/no attendance row/i);
  });

  it("a pipeline that writes when the truth is 'write nothing' is a SPURIOUS write", () => {
    const c = baseCase({ expect: { attendance: [{ player: "najib", status: "ABSENT" }] } });
    const r = gradeCase(c, obs({ attendanceAfter: [{ name: "Najib Ahmadi", status: "BENCH" }] }));
    expect(r.passed).toBe(false);
    expect(r.classification).toBe("spurious_write");
  });

  it("classification prefers a spurious write over a missed one when both happen", () => {
    const c = baseCase({
      expect: {
        attendance: [
          { player: "najib", status: "CONFIRMED" },
          { player: "alice", status: "ABSENT" },
        ],
      },
    });
    const r = gradeCase(c, obs({ attendanceAfter: [{ name: "Alice Admin", status: "BENCH" }] }));
    expect(r.passed).toBe(false);
    expect(r.classification).toBe("spurious_write");
    expect(r.failures.length).toBe(2);
  });
});

// ── Expectations are about writes and decisions, not wording ───────────

describe("gradeCase — speech is asserted by PROPERTY, never by golden string", () => {
  it("`speaks: silent` fails when the bot replied", () => {
    const c = baseCase({ expect: { unchanged: true, speaks: "silent" } });
    expect(gradeCase(c, obs()).passed).toBe(true);
    const r = gradeCase(c, obs({ spoken: ["Nice one 🙌"] }));
    expect(r.passed).toBe(false);
    expect(r.classification).toBe("speech");
  });

  it("`speaks: silent` fails when the bot sent a DM or reacted", () => {
    const c = baseCase({ expect: { unchanged: true, speaks: "silent" } });
    expect(gradeCase(c, obs({ dms: [{ to: null, text: "hi" }] })).passed).toBe(false);
    expect(gradeCase(c, obs({ reacts: ["👍"] })).passed).toBe(false);
    expect(gradeCase(c, obs({ reacts: [null] })).passed).toBe(true);
  });

  it("`speaks: required` fails on silence", () => {
    const c = baseCase({ expect: { unchanged: true, speaks: "required" } });
    expect(gradeCase(c, obs()).passed).toBe(false);
    expect(gradeCase(c, obs({ spoken: ["anything at all"] })).passed).toBe(true);
  });

  it("mustMention names a specific player; mustNotMention forbids one", () => {
    const c = baseCase({
      expect: {
        unchanged: true,
        speaks: "required",
        mustMention: ["Najib Ahmadi"],
        mustNotMention: ["Alice Admin"],
      },
    });
    expect(gradeCase(c, obs({ spoken: ["Najib, are you around tonight?"] })).passed).toBe(true);
    expect(gradeCase(c, obs({ spoken: ["Alice, are you around tonight?"] })).passed).toBe(false);
    // First name is enough — the bot speaks in first names.
    expect(gradeCase(c, obs({ spoken: ["Nobody named here"] })).passed).toBe(false);
  });

  it("a raw phone number in ANY outbound text fails every case, unasked", () => {
    const c = baseCase({ expect: { unchanged: true, speaks: "any" } });
    const r = gradeCase(c, obs({ spoken: ["ring him on +447700900123"] }));
    expect(r.passed).toBe(false);
    expect(r.failures.join(" ")).toMatch(/phone/i);
  });

  it("a claimed move that never happened fails (words must match action)", () => {
    const c = baseCase({
      expect: { attendance: [{ player: "najib", status: "ABSENT" }], speaks: "any" },
    });
    const r = gradeCase(c, obs({ spoken: ["Najib goes on the bench 👍"] }));
    expect(r.passed).toBe(false);
    expect(r.failures.join(" ")).toMatch(/claim/i);
  });

  it("the same sentence is fine when the write really did happen", () => {
    const c = baseCase({
      expect: { attendance: [{ player: "najib", status: "BENCH" }], speaks: "any" },
    });
    const r = gradeCase(
      c,
      obs({
        attendanceAfter: [{ name: "Najib Ahmadi", status: "BENCH" }],
        spoken: ["Najib goes on the bench 👍"],
      }),
    );
    expect(r.passed).toBe(true);
  });
});

describe("gradeCase — ghost members and counts", () => {
  it("provisioning a User from a relationship word fails by default", () => {
    const c = baseCase({ expect: { unchanged: true, speaks: "any" } });
    const r = gradeCase(
      c,
      obs({ memberNamesAfter: ["Najib Ahmadi", "Alice Admin", "Najib's brother"] }),
    );
    expect(r.passed).toBe(false);
    expect(r.classification).toBe("spurious_write");
    expect(r.failures.join(" ")).toMatch(/brother/);
  });

  it("a legitimately named guest is allowed when the case expects them", () => {
    const c = baseCase({
      expect: { attendance: [{ player: "Shahrokh", status: "CONFIRMED" }], allowNewMembers: true },
    });
    const r = gradeCase(
      c,
      obs({
        memberNamesAfter: ["Najib Ahmadi", "Alice Admin", "Shahrokh"],
        attendanceAfter: [{ name: "Shahrokh", status: "CONFIRMED" }],
      }),
    );
    expect(r.passed).toBe(true);
  });

  it("`counts` compares the squad totals", () => {
    const c = baseCase({ expect: { counts: { confirmed: 2, bench: 0 } } });
    const ok = obs({
      attendanceAfter: [
        { name: "Najib Ahmadi", status: "CONFIRMED" },
        { name: "Alice Admin", status: "CONFIRMED" },
      ],
    });
    expect(gradeCase(c, ok).passed).toBe(true);
    const bad = obs({ attendanceAfter: [{ name: "Najib Ahmadi", status: "CONFIRMED" }] });
    expect(gradeCase(c, bad).passed).toBe(false);
  });

  it("`unchanged` compares the whole attendance set, not just named players", () => {
    const c = baseCase({ expect: { unchanged: true } });
    const before = [{ name: "Alice Admin", status: "CONFIRMED" as const }];
    expect(gradeCase(c, obs({ attendanceBefore: before, attendanceAfter: before })).passed).toBe(
      true,
    );
    const r = gradeCase(
      c,
      obs({
        attendanceBefore: before,
        attendanceAfter: [...before, { name: "Najib Ahmadi", status: "BENCH" }],
      }),
    );
    expect(r.passed).toBe(false);
    expect(r.classification).toBe("spurious_write");
  });
});

// ── The scoreboard ─────────────────────────────────────────────────────

describe("buildScoreboard", () => {
  const results = [
    { caseId: "a", sections: ["S6"], category: "D" as const, runs: 5, passes: 5, classifications: [] },
    {
      caseId: "b",
      sections: ["S8"],
      category: "B" as const,
      runs: 5,
      passes: 3,
      classifications: ["missed_write" as const, "missed_write" as const],
    },
    {
      caseId: "c",
      sections: ["S8", "S9"],
      category: "B" as const,
      runs: 1,
      passes: 0,
      classifications: ["spurious_write" as const],
    },
  ];

  it("counts cases, runs and hit-rates", () => {
    const sb = buildScoreboard(results, { sections: ["S6", "S7", "S8", "S9"] });
    expect(sb.totals.cases).toBe(3);
    expect(sb.totals.casesFullyPassed).toBe(1);
    expect(sb.totals.runs).toBe(11);
    expect(sb.totals.runsPassed).toBe(8);
    expect(sb.totals.runPassRate).toBeCloseTo(8 / 11, 6);
  });

  it("breaks results down per category", () => {
    const sb = buildScoreboard(results, { sections: ALL_PROMPT_SECTIONS });
    expect(sb.byCategory.D).toMatchObject({ cases: 1, casesFullyPassed: 1 });
    expect(sb.byCategory.B).toMatchObject({ cases: 2, casesFullyPassed: 0 });
    expect(sb.byCategory.A).toMatchObject({ cases: 0 });
  });

  it("breaks results down per prompt section, counting a multi-section case once each", () => {
    const sb = buildScoreboard(results, { sections: ["S6", "S7", "S8", "S9"] });
    expect(sb.bySection.S6.cases).toBe(1);
    expect(sb.bySection.S8.cases).toBe(2);
    expect(sb.bySection.S9.cases).toBe(1);
    expect(sb.bySection.S7.cases).toBe(0);
  });

  it("reports the coverage gap honestly — sections with NO case at all", () => {
    const sb = buildScoreboard(results, { sections: ["S6", "S7", "S8", "S9", "S34"] });
    expect(sb.coverageGaps).toEqual(["S7", "S34"]);
  });

  it("tallies the step-3 decision criteria (spurious vs missed writes)", () => {
    const sb = buildScoreboard(results, { sections: ALL_PROMPT_SECTIONS });
    expect(sb.byClassification.spurious_write).toBe(1);
    expect(sb.byClassification.missed_write).toBe(2);
    expect(sb.byClassification.wrong_write).toBe(0);
    expect(sb.byClassification.speech).toBe(0);
    // §10 step 3: "zero cases where the new pipeline would write and the
    // old correctly did not; ≤2% where it would miss a write".
    expect(sb.criteria.spuriousWriteRuns).toBe(1);
    expect(sb.criteria.missedWriteRate).toBeCloseTo(2 / 11, 6);
  });

  it("knows the full §3.2 section list (39 sections, S0–S38)", () => {
    expect(ALL_PROMPT_SECTIONS.length).toBe(39);
    expect(ALL_PROMPT_SECTIONS[0]).toBe("S0");
    expect(ALL_PROMPT_SECTIONS.at(-1)).toBe("S38");
  });

  it("renders a human-readable scoreboard mentioning every category", () => {
    const text = renderScoreboard(buildScoreboard(results, { sections: ALL_PROMPT_SECTIONS }));
    expect(text).toMatch(/CASES/);
    expect(text).toMatch(/spurious_write/);
    expect(text).toMatch(/coverage gap/i);
  });
});

// ── Expectations the incident archive needs beyond attendance ──────────

describe("gradeCase — teams, reply volume, and explicit claim-checking", () => {
  const withTeams = (over: Partial<CorpusObservation>): CorpusObservation =>
    obs({
      teamsBefore: [
        { name: "Najib Ahmadi", team: "RED" },
        { name: "Alice Admin", team: "YELLOW" },
      ],
      ...over,
    });

  it("`teamsUnchanged` fails when the balancer reshuffled an admin's manual swap", () => {
    const c = baseCase({ expect: { unchanged: true, teamsUnchanged: true } });
    expect(
      gradeCase(
        c,
        withTeams({
          teamsAfter: [
            { name: "Najib Ahmadi", team: "RED" },
            { name: "Alice Admin", team: "YELLOW" },
          ],
        }),
      ).passed,
    ).toBe(true);
    const r = gradeCase(
      c,
      withTeams({
        teamsAfter: [
          { name: "Najib Ahmadi", team: "YELLOW" },
          { name: "Alice Admin", team: "RED" },
        ],
      }),
    );
    expect(r.passed).toBe(false);
    expect(r.classification).toBe("wrong_write");
    expect(r.failures.join(" ")).toMatch(/team/i);
  });

  it("`speaksAtMost` catches the four-contradictory-posts incident", () => {
    const c = baseCase({ expect: { unchanged: true, speaksAtMost: 1 } });
    expect(gradeCase(c, obs({ spoken: ["we're 12/14"] })).passed).toBe(true);
    const r = gradeCase(c, obs({ spoken: ["we're 12/14", "we're 13/14", "full squad"] }));
    expect(r.passed).toBe(false);
    expect(r.failures.join(" ")).toMatch(/at most 1/i);
  });

  it("`claimsMatchWrites: true` is on its own a real assertion", () => {
    const c = baseCase({ expect: { claimsMatchWrites: true, speaks: "any" } });
    expect(gradeCase(c, obs({ spoken: ["anyone free tonight?"] })).passed).toBe(true);
    expect(gradeCase(c, obs({ spoken: ["Najib goes on the bench"] })).passed).toBe(false);
  });

  it("`claimsMatchWrites: false` opts a case out of the words-match-action check", () => {
    const c = baseCase({ expect: { unchanged: true, claimsMatchWrites: false } });
    expect(gradeCase(c, obs({ spoken: ["Najib goes on the bench"] })).passed).toBe(true);
  });
});
