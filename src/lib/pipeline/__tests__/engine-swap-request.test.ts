/**
 * A MESSAGE THAT ASKS TO SWAP PLAYERS IS NEVER AN ATTENDANCE CHANGE FOR
 * THE PEOPLE IT MOVES (2026-09-17, dry-run cases TR26 / TR27).
 *
 * Measured live against the Sutton squad, REPEAT=10, before the guard:
 *
 *   "@Match Time swap David and Sait"          DROPPED David 10 of 10
 *   "@Match Time David ile Sait'i değiştir"    DROPPED David  9 of 10
 *
 * SINCE 2026-10-30 THE GUARD READS FACTS, NEVER THE WORDS (Kemal: "no
 * string parsing at all"). A message reaching the engine with a team
 * change carries the attendance extractor's "teams" side request, and the
 * attendance batch hands the engine the TEAMS extractor's reading of it
 * (`EngineMessage.teamsReading`). Every test here feeds that reading; the
 * body is never read, so the bodies below are only there for the human.
 *
 * The claims are fed in the shape the live extractor returned
 * (`polarity=out conf=0.7`), so these tests pin the ENGINE's answer to
 * the model's real reading, not to a reading we would have preferred.
 */
import { describe, it, expect } from "vitest";
import { decide } from "../engine";
import type { EngineMessage, TeamFacts } from "../types";
import { NOW, SUTTON, attendanceFacts, claim, msg, statusOf, world } from "./helpers";

const PLAYERS = [...SUTTON, "david"];
const CONFIRMED = ["kemal", "elvin", "sait", "mustafa", "abid", "david", "zeeshan", "najib"];

/** The teams extractor's reading: "swap A and B" moves both. */
function swapOf(moves: string[], over: Partial<TeamFacts> = {}): TeamFacts {
  return {
    kind: "teams",
    action: "swap",
    includeRefs: [],
    teamNames: null,
    swaps: [],
    moves,
    pairings: [],
    swapSides: false,
    ...over,
  };
}

function withReading(m: EngineMessage, teamsReading: EngineMessage["teamsReading"]): EngineMessage {
  return { ...m, teamsReading };
}

function run(
  body: string,
  claims: ReturnType<typeof claim>[],
  reading: EngineMessage["teamsReading"],
  o: { tagged?: boolean; from?: string } = {},
) {
  const state = world({ players: PLAYERS, confirmed: CONFIRMED });
  return decide({
    now: NOW,
    state,
    messages: [
      withReading(
        msg({
          from: o.from ?? "kemal",
          body,
          tagged: o.tagged ?? true,
          route: "other_att",
          facts: attendanceFacts(claims, { sideRequests: reading ? ["teams"] : [] }),
        }),
        reading,
      ),
    ],
  });
}

const davidOut = claim({ subject: "other", personRef: "David", personNamed: true, polarity: "out", confidence: 0.7 });

describe("a swap the teams extractor read writes no attendance for the people it moves", () => {
  it("TR27: '@Match Time swap David and Sait' does not drop David", () => {
    const r = run("@Match Time swap David and Sait", [davidOut], swapOf(["David", "Sait"]));
    expect(r.writes.filter((w) => w.kind === "attendance")).toEqual([]);
    expect(statusOf(r.nextState, "david")).toBe("CONFIRMED");
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/swap/i);
  });

  it("TR26: the Turkish form does not drop David or add Sait (the reading carries the case ending)", () => {
    const r = run(
      "@Match Time David ile Sait'i değiştir",
      [davidOut, claim({ subject: "other", personRef: "Sait'i", personNamed: true, polarity: "in", confidence: 0.7 })],
      swapOf(["David", "Sait'i"]),
    );
    expect(r.writes).toEqual([]);
    expect(statusOf(r.nextState, "david")).toBe("CONFIRMED");
  });

  it("a party is matched through the roster, not by spelling: '@David' and 'David' are one person", () => {
    const r = run("@Match Time swap @David and Sait", [{ ...davidOut, personRef: "@David" }], swapOf(["David", "Sait"]));
    expect(statusOf(r.nextState, "david")).toBe("CONFIRMED");
  });

  it("an unknown second name still protects David, whatever its case", () => {
    const r = run("swap david and zork", [{ ...davidOut, personRef: "david" }], swapOf(["david", "zork"]), { tagged: false });
    expect(r.writes).toEqual([]);
    expect(statusOf(r.nextState, "david")).toBe("CONFIRMED");
  });

  it("a person moved to a named side or paired with another is a party too", () => {
    expect(
      statusOf(run("put David in Red", [davidOut], swapOf([], { swaps: [{ personRef: "David", team: "RED" }] })).nextState, "david"),
    ).toBe("CONFIRMED");
    expect(
      statusOf(run("David and Sait together", [davidOut], swapOf([], { pairings: [["David", "Sait"]] })).nextState, "david"),
    ).toBe("CONFIRMED");
  });

  it("the sender's own OUT in the same message still lands when the sender is not a party", () => {
    const r = run(
      "@Match Time swap David and Sait and I'm out",
      [davidOut, claim({ subject: "sender", polarity: "out" })],
      swapOf(["David", "Sait"]),
    );
    expect(statusOf(r.nextState, "kemal")).toBe("DROPPED");
    expect(statusOf(r.nextState, "david")).toBe("CONFIRMED");
  });

  it("a third party the swap does NOT move still drops", () => {
    const r = run(
      "@Match Time swap David and Sait. Zeeshan is out",
      [davidOut, claim({ subject: "other", personRef: "Zeeshan", personNamed: true, polarity: "out" })],
      swapOf(["David", "Sait"]),
    );
    expect(statusOf(r.nextState, "zeeshan")).toBe("DROPPED");
    expect(statusOf(r.nextState, "david")).toBe("CONFIRMED");
  });

  it("'swap me with David' (both in the squad) does not drop the sender", () => {
    const r = run("@Match Time swap me with David", [claim({ subject: "sender", polarity: "out", confidence: 0.7 })], swapOf(["me", "David"]));
    expect(r.writes).toEqual([]);
    expect(statusOf(r.nextState, "kemal")).toBe("CONFIRMED");
  });

  it("no reading, no guard: a drop with no team change read is a drop", () => {
    const r = run("@Match Time David is out", [{ ...davidOut, confidence: 0.95 }], null);
    expect(statusOf(r.nextState, "david")).toBe("DROPPED");
  });

  it("a reading that is not a swap (a clear, the two teams swapping over) moves no named person", () => {
    expect(statusOf(run("x", [{ ...davidOut, confidence: 0.95 }], swapOf([], { action: "clear" })).nextState, "david")).toBe("DROPPED");
    expect(statusOf(run("x", [{ ...davidOut, confidence: 0.95 }], swapOf([], { swapSides: true })).nextState, "david")).toBe("DROPPED");
  });

  it("an UNREADABLE team change applies no claim about anybody but the sender", () => {
    const r = run(
      "@Match Time swap David and Sait and I'm out",
      [davidOut, claim({ subject: "sender", polarity: "out" })],
      "unreadable",
    );
    expect(statusOf(r.nextState, "david")).toBe("CONFIRMED");
    expect(statusOf(r.nextState, "kemal")).toBe("DROPPED");
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/could not be read/);
  });
});

describe("a stated replacement inside a swap message is attendance, not a swap", () => {
  it("'swap Elvin with Raihan, Elvin is out, Raihan in for him': Elvin's OUT lands", () => {
    const state = world({ players: [...PLAYERS, "raihan"], confirmed: CONFIRMED });
    const r = decide({
      now: NOW,
      state,
      messages: [
        withReading(
          msg({
            from: "kemal",
            body: "@Match Time swap Elvin with Raihan, Elvin is out",
            tagged: true,
            route: "other_att",
            facts: attendanceFacts(
              [
                claim({ subject: "other", personRef: "Elvin", personNamed: true, polarity: "out" }),
                claim({ subject: "other", personRef: "Raihan", personNamed: true, polarity: "in", replaces: "Elvin" }),
              ],
              { sideRequests: ["teams"] },
            ),
          }),
          swapOf(["Elvin", "Raihan"]),
        ),
      ],
    });
    expect(statusOf(r.nextState, "elvin")).toBe("DROPPED");
    expect(statusOf(r.nextState, "raihan")).toBe("CONFIRMED");
  });
});

// ── THE SENDER AS A PARTY (review of PR #99, 2026-09-17) ───────────────
//
// A swap naming the sender that cannot be applied is a substitution, and
// the sender's OUT is the point of it. Decided by `planSwap` over the
// database, never by the words.
describe("a substitution involving the sender is a drop, not a swap", () => {
  const PLAYERS_S = [...PLAYERS, "salman"];
  const withZair = [...CONFIRMED, "zair"];
  const senderOut = claim({ subject: "sender", polarity: "out" });
  function runS(
    claims: ReturnType<typeof claim>[],
    reading: EngineMessage["teamsReading"],
    o: { teams?: Record<string, "RED" | "YELLOW">; confirmed?: string[] } = {},
  ) {
    const state = world({
      players: PLAYERS_S,
      confirmed: o.confirmed ?? withZair,
      bench: o.confirmed?.includes("salman") ? [] : ["salman"],
      teams: o.teams,
    });
    return decide({
      now: NOW,
      state,
      messages: [
        withReading(
          msg({ from: "zair", body: "(read by the models)", route: "self_att", facts: attendanceFacts(claims, { sideRequests: ["teams"] }) }),
          reading,
        ),
      ],
    });
  }

  it("'swap me with Salman', Salman on the bench: the sender's OUT applies", () => {
    expect(statusOf(runS([senderOut], swapOf(["me", "Salman"])).nextState, "zair")).toBe("DROPPED");
  });

  it("'swap me with Salman', both in and the teams built: a team swap, nobody is dropped", () => {
    const r = runS([senderOut], swapOf(["me", "Salman"]), {
      confirmed: [...withZair, "salman"],
      teams: { zair: "RED", salman: "YELLOW" },
    });
    expect(statusOf(r.nextState, "zair")).toBe("CONFIRMED");
  });

  it("…but a stated replacement of the sender is his drop, both in or not", () => {
    const r = runS(
      [senderOut, claim({ subject: "other", personRef: "Salman", personNamed: true, polarity: "in", replaces: "me" })],
      swapOf(["me", "Salman"]),
      { confirmed: [...withZair, "salman"], teams: { zair: "RED", salman: "YELLOW" } },
    );
    expect(statusOf(r.nextState, "zair")).toBe("DROPPED");
  });

  it("the sender named by his own name is the sender", () => {
    const r = runS([senderOut], swapOf(["Zair", "Salman"]), {
      confirmed: [...withZair, "salman"],
      teams: { zair: "RED", salman: "YELLOW" },
    });
    expect(statusOf(r.nextState, "zair")).toBe("CONFIRMED");
  });
});

describe("a refused swap claim supersedes nothing", () => {
  it("'out' then a team swap 'swap me with David' in one batch still drops the sender", () => {
    // S35 lets only an author's LATEST self message write. A self claim
    // the swap guard refuses must not count as that latest message, or
    // the real "out" before it is discarded as superseded.
    const state = world({
      players: PLAYERS,
      confirmed: ["zair", "david"],
      teams: { zair: "RED", david: "YELLOW" },
    });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({ from: "zair", body: "out", route: "self_att", facts: attendanceFacts([claim({ polarity: "out" })]) }),
        withReading(
          msg({
            from: "zair",
            body: "@Match Time swap me with David",
            tagged: true,
            route: "self_att",
            facts: attendanceFacts([claim({ polarity: "out", confidence: 0.7 })], { sideRequests: ["teams"] }),
          }),
          swapOf(["me", "David"]),
        ),
      ],
    });
    expect(statusOf(r.nextState, "zair")).toBe("DROPPED");
  });
});

describe("genuine drops are untouched", () => {
  const cases: Array<[string, string, string, boolean]> = [
    ["Zeeshan OUT", "Zeeshan", "zeeshan", false],
    ["@Match Time Najib is out", "Najib", "najib", true],
    ["@Wasim can't make it", "@Wasim", "wasim", false],
  ];
  for (const [body, ref, key, tagged] of cases) {
    it(`"${body}" drops ${key}`, () => {
      const state = world({ players: PLAYERS, confirmed: [...CONFIRMED, "wasim"] });
      const r = decide({
        now: NOW,
        state,
        messages: [
          msg({
            from: "kemal",
            body,
            tagged,
            route: "other_att",
            facts: attendanceFacts([claim({ subject: "other", personRef: ref, personNamed: true, polarity: "out" })]),
          }),
        ],
      });
      expect(statusOf(r.nextState, key)).toBe("DROPPED");
    });
  }

  it("a body that LOOKS like a swap is not one without the reading: 'switch it to 7 a side and put Amir in' registers Amir", () => {
    const r = run(
      "@Kemal can you switch it to 7 a side and put Amir in as the 14th",
      [claim({ subject: "other", personRef: "Amir", personNamed: true, polarity: "in" })],
      null,
    );
    expect(statusOf(r.nextState, "amir")).toBe("CONFIRMED");
  });

  it("…nor is 'swap David and Sait' typed with no reading: the body is never read", () => {
    const r = run("@Match Time swap David and Sait", [{ ...davidOut, confidence: 0.95 }], null);
    expect(statusOf(r.nextState, "david")).toBe("DROPPED");
  });
});
