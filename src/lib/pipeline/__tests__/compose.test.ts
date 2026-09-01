/**
 * STAGE 4 — COMPOSITION.
 *
 * §6.4: "Every outgoing message is composed from the database AFTER the
 * writes land. Numbers and names are never model-authored, so they
 * cannot be wrong, so nothing needs to check them afterwards."
 *
 * That last clause is the deletion of `enforceCanonicalRoster` — 140
 * lines of regex in six sub-passes, every one of which exists because
 * the model authors the squad text and gets it wrong. The correct
 * deterministic composer, `composeSquadStatusPost()`, already exists
 * forty lines above it and is used only as a fallback. Here it is the
 * ONLY path.
 */
import { describe, it, expect } from "vitest";
import { compose } from "../compose";
import { decide } from "../engine";
import { NOW, attendanceFacts, claim, msg, world } from "./helpers";
import type { EngineResult, SquadState } from "../types";

function composeFor(state: SquadState, messages: Parameters<typeof decide>[0]["messages"]) {
  const result: EngineResult = decide({ now: NOW, state, messages });
  return { result, out: compose(result) };
}

const TEN = ["kemal", "elvin", "sait", "mustafa", "abid", "idris", "faris", "shaz", "adam", "efat"];

describe("the squad post is read out of the projected state", () => {
  it("states the count AFTER the write, never the one before (2026-04-26, Wasim, ef8d801)", () => {
    const state = world({ confirmed: [...TEN, "usama", "karahan", "zair", "wasim"] });
    const { out } = composeFor(state, [
      msg({
        from: "wasim",
        body: "out sorry lads",
        route: "self_att",
        facts: attendanceFacts([claim({ polarity: "out" })]),
      }),
    ]);
    const text = out.utterances.map((u) => u.text).join("\n");
    expect(text).toContain("13/14");
    expect(text).not.toContain("12/14");
    expect(text).not.toMatch(/full squad/i);
    // The incident omitted a confirmed player from the reordered roster.
    expect(text).toContain("Zair Malik");
  });

  it("lists the bench when there is one, and never invents one when there is not", () => {
    const withBench = world({
      confirmed: [...TEN, "usama", "karahan", "zair", "wasim"],
      bench: ["najib"],
    });
    const a = compose(
      decide({
        now: NOW,
        state: withBench,
        messages: [
          msg({ from: "amir", body: "in", route: "self_att", facts: attendanceFacts([claim({})]) }),
        ],
      }),
    );
    expect(a.utterances.map((u) => u.text).join()).toMatch(/Bench \(2\)/);

    const noBench = world({ confirmed: TEN });
    const b = compose(
      decide({
        now: NOW,
        state: noBench,
        messages: [
          msg({ from: "amir", body: "in", route: "self_att", facts: attendanceFacts([claim({})]) }),
        ],
      }),
    );
    expect(b.utterances.map((u) => u.text).join()).not.toMatch(/Bench \(/);
  });

  it("says exactly one thing for a batch of three squad messages (§3.2 S36)", () => {
    const state = world({ confirmed: TEN });
    const { out } = composeFor(state, [
      msg({ from: "usama", body: "in", route: "self_att", facts: attendanceFacts([claim({})]) }),
      msg({ from: "karahan", body: "in", route: "self_att", facts: attendanceFacts([claim({})]) }),
      msg({
        from: "zair",
        body: "@Match Time how many are we now?",
        route: "question",
        tagged: true,
        facts: { kind: "question", topic: "count", personRef: null, statedCount: null },
      }),
    ]);
    expect(out.utterances).toHaveLength(1);
    expect(out.utterances[0].text).toContain("12/14");
  });
});

describe("questions are answered from state, not from the model", () => {
  it("corrects a wrong stated count with the real number (§3.2 S24)", () => {
    const state = world({ confirmed: [...TEN, "usama"] });
    const { out } = composeFor(state, [
      msg({
        from: "amir",
        body: "@Match Time we're 9/14 right?",
        route: "question",
        tagged: true,
        facts: { kind: "question", topic: "count", personRef: null, statedCount: 9 },
      }),
    ]);
    const text = out.utterances[0].text;
    expect(text).toContain("11");
    expect(text).not.toMatch(/yes.{0,20}9\/14/i);
  });

  it("names the bench and speculates about nothing (§3.2 S16)", () => {
    const state = world({ confirmed: [...TEN, "usama", "najib", "zair", "wasim"], bench: ["karahan"] });
    const { out } = composeFor(state, [
      msg({
        from: "adam",
        body: "@Match Time who's on the bench?",
        route: "question",
        tagged: true,
        facts: { kind: "question", topic: "bench", personRef: null, statedCount: null },
      }),
    ]);
    const text = out.utterances[0].text;
    expect(text).toContain("Karahan");
    expect(text).not.toMatch(/5-a-side|downgrade|if we shrink/i);
  });

  it("answers 'is X coming?' without claiming a registration that never happened", () => {
    const state = world({ confirmed: TEN });
    const { out } = composeFor(state, [
      msg({
        from: "kemal",
        body: "@Match Time is Amir also coming or not?",
        route: "question",
        tagged: true,
        facts: { kind: "question", topic: "person_status", personRef: "Amir", statedCount: null },
      }),
    ]);
    const text = out.utterances[0].text;
    expect(text).toContain("Amir");
    expect(text).not.toMatch(/Amir[^.\n]{0,40}\b(is|'s) (confirmed|in the squad|playing)/);
  });

  it("answers 'who has no number?' with names and never a digit (§3.2 S32)", () => {
    const state = world({
      players: ["kemal", "elvin", "sait", "gary", "walt"],
      confirmed: ["kemal", "elvin", "sait", "gary", "walt"],
      noPhone: ["gary", "walt"],
    });
    const { out } = composeFor(state, [
      msg({
        from: "kemal",
        body: "@Match Time who has no phone number on record?",
        route: "question",
        tagged: true,
        facts: { kind: "question", topic: "phones", personRef: null, statedCount: null },
      }),
    ]);
    const text = out.utterances[0].text;
    expect(text).toContain("gary");
    expect(text).toContain("walt");
    expect(text).not.toMatch(/(?:\+\d[\d\s().-]{8,}\d)|(?:\b0\d{9,10}\b)|(?:\b\d{11,}\b)/);
  });

  it("answers a stats question with NO squad block appended (§3.2 S16, cf6ed22)", () => {
    const state = world({
      confirmed: TEN.slice(0, 6),
      appearances: [
        { userId: "u-kemal", matches: 9 },
        { userId: "u-elvin", matches: 7 },
        { userId: "u-sait", matches: 2 },
      ],
    });
    const { out } = composeFor(state, [
      msg({
        from: "shaz",
        body: "@Match Time who's been the most consistent?",
        route: "question",
        tagged: true,
        facts: { kind: "question", topic: "stats", personRef: null, statedCount: null },
      }),
    ]);
    const text = out.utterances[0].text;
    expect(text).toContain("Kemal");
    expect(text).not.toMatch(/\b\d{1,2}\/14\b/);
    expect(text).not.toMatch(/Reply \*?IN/);
  });

  it("answers 'what are our options?' without naming anyone as benched (§3.2 S34)", () => {
    // 2026-08-30: the model computed 8 − 5 instead of 8 − 10 and told a
    // real customer group that "Najib + Mojib + Mustafa go on the bench"
    // when a switch would have benched nobody. format-switch.ts computes
    // it; the composer copies the answer.
    const state = world({
      confirmed: ["kemal", "elvin", "sait", "mustafa", "abid", "najib", "mojib", "idris"],
      smallerFormats: [{ sportName: "Football 5-a-side", totalPlayers: 10 }],
    });
    const { out } = composeFor(state, [
      msg({
        from: "kemal",
        body: "@Match Time we're only 8, what are our options?",
        route: "question",
        tagged: true,
        facts: { kind: "question", topic: "options", personRef: null, statedCount: null },
      }),
    ]);
    const text = out.utterances[0].text;
    expect(text).not.toMatch(/(Najib|Mojib|Mustafa)[^.\n]{0,60}\bbench\b/);
    expect(text).not.toMatch(/\bgo(?:es)? on the bench\b/);
  });
});

describe("the guest name ask", () => {
  it("asks for one name in the singular", () => {
    const state = world({ confirmed: TEN.slice(0, 7) });
    const { out } = composeFor(state, [
      msg({
        from: "amir",
        body: "@Kemal Ediz my brother can play if needed",
        route: "offer",
        facts: attendanceFacts([
          claim({
            subject: "other",
            personRef: "my brother",
            personNamed: false,
            polarity: "in",
            contingent: true,
            conditionOn: "squad",
          }),
        ]),
      }),
    ]);
    expect(out.utterances[0].text).toMatch(/what(?:'s| is| are) their names?\?/i);
    expect(out.reacts).toHaveLength(0);
  });

  it("asks for names in the plural", () => {
    const state = world({ confirmed: [...TEN, "usama"] });
    const { out } = composeFor(state, [
      msg({
        from: "amir",
        body: "two of my guys can play",
        route: "other_att",
        facts: attendanceFacts([
          claim({ subject: "other", personRef: "two of my guys", personNamed: false, polarity: "in" }),
        ]),
      }),
    ]);
    expect(out.utterances[0].text).toMatch(/what are their names\?/i);
  });
});

describe("the composer cannot say a thing the writes do not support", () => {
  it("says nothing at all when nothing happened", () => {
    const state = world({ confirmed: TEN });
    const { out } = composeFor(state, [
      msg({ from: "ayoub", body: "😂😂😂", route: "none", facts: { kind: "none" } }),
      msg({ from: "sait", body: "anyone watching the derby", route: "none", facts: { kind: "none" } }),
    ]);
    expect(out.utterances).toHaveLength(0);
    expect(out.reacts).toHaveLength(0);
  });

  it("never prints a raw phone number, whatever is in the state", () => {
    const state = world({ confirmed: TEN });
    state.roster[0].name = "+44 7700 900123";
    const { out } = composeFor(state, [
      msg({ from: "usama", body: "in", route: "self_att", facts: attendanceFacts([claim({})]) }),
    ]);
    const text = out.utterances.map((u) => u.text).join("\n");
    expect(text).not.toMatch(/(?:\+\d[\d\s().-]{8,}\d)|(?:\b0\d{9,10}\b)|(?:\b\d{11,}\b)/);
  });

  it("routes degradations to the OPERATOR channel, never to the group", () => {
    const state = world({ noMatch: true });
    const { out } = composeFor(state, [
      msg({ from: "najib", body: "In", route: "self_att", facts: attendanceFacts([claim({})]) }),
    ]);
    expect(out.utterances).toHaveLength(0);
    expect(out.operatorNotes.length).toBeGreaterThan(0);
    expect(out.operatorNotes.join(" ")).toMatch(/no active registration match/i);
  });
});

describe("reactions are derived from the write outcome, not authored", () => {
  it("✅ for a confirmed slot, 🪑 for the bench, 👋 for a drop", () => {
    const state = world({ confirmed: TEN });
    const a = composeFor(state, [
      msg({ from: "usama", body: "in", route: "self_att", facts: attendanceFacts([claim({})]) }),
    ]);
    expect(a.out.reacts[0].emoji).toBe("✅");

    const full = world({ confirmed: [...TEN, "usama", "karahan", "zair", "wasim"] });
    const b = composeFor(full, [
      msg({ from: "najib", body: "in", route: "self_att", facts: attendanceFacts([claim({})]) }),
    ]);
    expect(b.out.reacts[0].emoji).toBe("🪑");

    const c = composeFor(full, [
      msg({
        from: "wasim",
        body: "out",
        route: "self_att",
        facts: attendanceFacts([claim({ polarity: "out" })]),
      }),
    ]);
    expect(c.out.reacts[0].emoji).toBe("👋");
  });
});
