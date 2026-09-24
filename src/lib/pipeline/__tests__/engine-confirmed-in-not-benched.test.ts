/**
 * A PLAIN "in" NEVER BENCHES ANYBODY (Sutton FC, 2026-09-24).
 *
 * Match `cmtbro2ao0005tt9k16cl8f29`, Tue 29 Sept 21:30, 14 a side, 13
 * confirmed. Erdal pasted the bot's own squad update with "14.Erdal"
 * appended; the pasted-roster arithmetic registered him CONFIRMED at 14
 * and the bot queued "Squad complete, 14/14" with him on it. His very
 * next message, same batch, was the two letters "in". The engine wrote
 * CONFIRMED@14 -> BENCH@14 with the audit note "explicit bench request",
 * and the posted 14/14 list was wrong from that second on.
 *
 * THE MECHANISM. The engine state was loaded AFTER the paste landed, so
 * it saw Erdal CONFIRMED at 14/14; a claim with polarity "in" is
 * idempotent there. The write only happens for polarity "bench": the
 * extractor returned `polarity: "bench"` for the body "in", and
 * `applyClaim` took any uncontingent "bench" as a HUMAN naming the bench
 * (`explicitBench`), which is the one thing that may demote a confirmed
 * player. Nothing checked that the words were ever said.
 *
 * THE RULE THESE TESTS PIN: "bench" is explicit only when the MESSAGE
 * names the bench. Without the word, a "bench" claim is read as the IN
 * it came from, and capacity decides, exactly as an inferred bench always
 * has (PR #27).
 */
import { describe, it, expect } from "vitest";
import { decide } from "../engine";
import {
  NOW,
  SUTTON,
  attendanceFacts,
  benchCount,
  claim,
  confirmedCount,
  msg,
  statusOf,
  world,
} from "./helpers";
import type { ProposedWrite, SquadState } from "../types";

/** The thirteen who were in before Erdal, then Erdal at 14. */
const THIRTEEN = [
  "abid",
  "mustafa",
  "idris",
  "elvin",
  "kemal",
  "sait",
  "faris",
  "shaz",
  "adam",
  "efat",
  "usama",
  "karahan",
  "zair",
];

/** Sutton's roster plus Youssef, who is in the incident. */
const PLAYERS = [...SUTTON, "youssef"];

/** The world the engine loaded: the paste's registration had already
 *  landed, so Erdal is CONFIRMED at position 14 and the squad is full. */
const afterThePaste = (): SquadState =>
  world({ players: PLAYERS, maxPlayers: 14, confirmed: [...THIRTEEN, "erdal"] });

function attWrites(writes: ProposedWrite[]) {
  return writes.filter((w) => w.kind === "attendance");
}

function positionOf(state: SquadState, key: string): number | undefined {
  return state.rows.find((r) => r.userId === `u-${key}`)?.position;
}

/** The pasted squad update, which reaches the engine with no facts: the
 *  pasted-roster clamp discards every claim read off a list. */
const PASTE = msg({
  id: "wa-paste",
  from: "erdal",
  body:
    "🗓 Squad update — 13/14 in for Tuesday 7-a-side, just need 1\n\n" +
    THIRTEEN.map((k, i) => `${i + 1}. ${k}`).join("\n") +
    "\n14.Erdal",
  route: "other_att",
  facts: { kind: "none" },
});

describe("THE INCIDENT: a confirmed player's 'in' is a no-op, never a demotion", () => {
  it("the extractor's 'bench' on a bare 'in' does NOT move Erdal off 14/14", () => {
    const state = afterThePaste();
    const r = decide({
      now: NOW,
      state,
      messages: [
        PASTE,
        msg({
          id: "wa-in",
          from: "erdal",
          body: "in",
          route: "self_att",
          // What production's extractor returned: an uncontingent bench.
          facts: attendanceFacts([claim({ polarity: "bench" })]),
        }),
      ],
    });
    expect(attWrites(r.writes)).toHaveLength(0);
    expect(statusOf(r.nextState, "erdal")).toBe("CONFIRMED");
    expect(positionOf(r.nextState, "erdal")).toBe(14);
    expect(confirmedCount(r.nextState)).toBe(14);
    expect(benchCount(r.nextState)).toBe(0);
    const reasons = r.outcomes.find((o) => o.messageId === "wa-in")!.reasons.join(" | ");
    expect(reasons).toMatch(/never names the bench/);
  });

  it("the same 'in' read correctly as 'in' is also a no-op", () => {
    const r = decide({
      now: NOW,
      state: afterThePaste(),
      messages: [
        PASTE,
        msg({ id: "wa-in", from: "erdal", body: "in", route: "self_att", facts: attendanceFacts([claim({})]) }),
      ],
    });
    expect(attWrites(r.writes)).toHaveLength(0);
    expect(statusOf(r.nextState, "erdal")).toBe("CONFIRMED");
  });

  it("without the paste in the batch: a confirmed player's 'In' at 14/14 stays CONFIRMED", () => {
    for (const polarity of ["in", "bench"] as const) {
      const r = decide({
        now: NOW,
        state: afterThePaste(),
        messages: [
          msg({ from: "erdal", body: "In", route: "self_att", facts: attendanceFacts([claim({ polarity })]) }),
        ],
      });
      expect(attWrites(r.writes), `polarity ${polarity}`).toHaveLength(0);
      expect(statusOf(r.nextState, "erdal")).toBe("CONFIRMED");
    }
  });

  it("Turkish 'varım' from a confirmed player is a no-op too", () => {
    const r = decide({
      now: NOW,
      state: afterThePaste(),
      messages: [
        msg({ from: "erdal", body: "varım", route: "self_att", facts: attendanceFacts([claim({ polarity: "bench" })]) }),
      ],
    });
    expect(attWrites(r.writes)).toHaveLength(0);
    expect(statusOf(r.nextState, "erdal")).toBe("CONFIRMED");
  });
});

describe("siblings of the incident", () => {
  it("a BENCH player saying 'in' on a full squad stays BENCH, position unchanged", () => {
    for (const polarity of ["in", "bench"] as const) {
      const state = world({ players: PLAYERS, maxPlayers: 14, confirmed: [...THIRTEEN, "erdal"], bench: ["youssef"] });
      const before = positionOf(state, "youssef");
      const r = decide({
        now: NOW,
        state,
        messages: [
          msg({ from: "youssef", body: "in", route: "self_att", facts: attendanceFacts([claim({ polarity })]) }),
        ],
      });
      expect(attWrites(r.writes), `polarity ${polarity}`).toHaveLength(0);
      expect(statusOf(r.nextState, "youssef")).toBe("BENCH");
      expect(positionOf(r.nextState, "youssef")).toBe(before);
    }
  });

  it("OUT from a confirmed player still drops him", () => {
    const r = decide({
      now: NOW,
      state: afterThePaste(),
      messages: [
        msg({ from: "erdal", body: "out", route: "self_att", facts: attendanceFacts([claim({ polarity: "out" })]) }),
      ],
    });
    expect(attWrites(r.writes)).toEqual([
      expect.objectContaining({ userId: "u-erdal", status: "DROPPED" }),
    ]);
    expect(statusOf(r.nextState, "erdal")).toBe("DROPPED");
  });

  it("a newcomer's bare 'in' read as 'bench' with room CONFIRMS: no bench beside an empty slot", () => {
    const state = world({ players: PLAYERS, maxPlayers: 14, confirmed: THIRTEEN });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({ from: "habib", body: "In", route: "self_att", facts: attendanceFacts([claim({ polarity: "bench" })]) }),
      ],
    });
    expect(statusOf(r.nextState, "habib")).toBe("CONFIRMED");
    expect(attWrites(r.writes)[0]).toMatchObject({ status: "CONFIRMED", explicitBench: false });
  });

  it("a newcomer's bare 'in' read as 'bench' on a full squad benches him as INFERRED, not explicit", () => {
    const r = decide({
      now: NOW,
      state: afterThePaste(),
      messages: [
        msg({ from: "habib", body: "In", route: "self_att", facts: attendanceFacts([claim({ polarity: "bench" })]) }),
      ],
    });
    expect(statusOf(r.nextState, "habib")).toBe("BENCH");
    expect(attWrites(r.writes)[0]).toMatchObject({ status: "BENCH", explicitBench: false });
  });
});

describe("a bench the message DOES name is still honoured", () => {
  it("a confirmed player asking for the bench in words is demoted (explicit)", () => {
    const r = decide({
      now: NOW,
      state: afterThePaste(),
      messages: [
        msg({
          from: "erdal",
          body: "put me on the bench, let Habib play",
          route: "self_att",
          facts: attendanceFacts([claim({ polarity: "bench" })]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "erdal")).toBe("BENCH");
    expect(positionOf(r.nextState, "erdal")).toBe(14);
    expect(attWrites(r.writes)[0]).toMatchObject({ status: "BENCH", explicitBench: true });
  });

  it("'In as a reserve' (Youssef, same day) is an explicit bench", () => {
    const r = decide({
      now: NOW,
      state: world({ players: PLAYERS, maxPlayers: 14, confirmed: THIRTEEN }),
      messages: [
        msg({
          from: "youssef",
          body: "In as a reserve",
          route: "self_att",
          facts: attendanceFacts([claim({ polarity: "bench" })]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "youssef")).toBe("BENCH");
    expect(attWrites(r.writes)[0]).toMatchObject({ explicitBench: true });
  });

  it("Turkish 'yedekte kalayım' from a confirmed player is an explicit bench", () => {
    const r = decide({
      now: NOW,
      state: afterThePaste(),
      messages: [
        msg({
          from: "erdal",
          body: "yedekte kalayım",
          route: "self_att",
          facts: attendanceFacts([claim({ polarity: "bench" })]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "erdal")).toBe("BENCH");
    expect(attWrites(r.writes)[0]).toMatchObject({ explicitBench: true });
  });
});
