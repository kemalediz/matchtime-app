/**
 * SAYING YOU ARE FREE TO PLAY PUTS YOU ON THE BENCH (FNF, 2026-10-28).
 *
 * Friday's match was full at 18/18, teams generated, bench empty. Seb
 * wrote "I’m free to play this Friday if there’s any drop outs 👍🏼". The
 * attendance extractor returned exactly what PR #48 taught it:
 *
 *   sender · bench · contingent · conditionOn squad · basis availability · 0.7
 *
 * and the engine's availability gate wrote nothing ("availability
 * statement about Seb, not a commitment to play: no write"). 38 minutes
 * later he typed "@Match Time In" and was benched with a 🪑. His first
 * message meant exactly that.
 *
 * Kemal's ruling the same day: people who say they are free or available
 * for a match go on the bench. So being free to play is the same fact as
 * offering to fill a gap, and the engine treats it as the standing offer
 * it already knows (§3.2 S15(a)): capacity decides. Squad full: BENCH.
 * A place open: the place, because a bench row beside empty slots is the
 * 2026-08-31 incident (`applyClaim`).
 *
 * Third parties never register: "my brother is free Friday" is an offer of
 * someone else, contingent, and held.
 */
import { describe, it, expect } from "vitest";
import { decide } from "../engine";
import { parseFacts } from "../extractors";
import { NOW, SUTTON, attendanceFacts, benchCount, claim, confirmedCount, msg, statusOf, world } from "./helpers";
import type { Facts } from "../types";

const PLAYERS = [...SUTTON, "seb"];
const EIGHTEEN = SUTTON.slice(0, 18);
const FULL_18 = () =>
  world({
    players: PLAYERS,
    maxPlayers: 18,
    confirmed: EIGHTEEN,
    teams: Object.fromEntries(EIGHTEEN.map((k, i) => [k, i % 2 === 0 ? "RED" : "YELLOW"])) as Record<string, "RED" | "YELLOW">,
  });

const SEB_BODY = "I’m free to play this Friday if there’s any drop outs 👍🏼";

/** The extractor's output for Seb's message, as production logged it,
 *  `basis` and all: a model or a stub still sending the retired field
 *  must not change the outcome. */
const SEB_RAW = JSON.stringify({
  claims: [
    {
      subject: "sender",
      personRef: "",
      personNamed: false,
      polarity: "bench",
      contingent: true,
      conditionOn: "squad",
      tense: "future",
      basis: "availability",
      reported: false,
      replaces: "",
      confidence: 0.7,
    },
  ],
  affirmation: "none",
  sideRequests: [],
});

function sebFacts(): Facts {
  const { facts, degradations } = parseFacts("attendance", SEB_RAW, "wa-seb");
  expect(degradations).toEqual([]);
  return facts;
}

describe("free to play, from the sender: the standing offer", () => {
  it("Seb's exact message to a full squad with an empty bench puts him on the bench", () => {
    const r = decide({
      now: NOW,
      state: FULL_18(),
      messages: [msg({ from: "seb", body: SEB_BODY, route: "offer", facts: sebFacts() })],
    });
    expect(statusOf(r.nextState, "seb")).toBe("BENCH");
    expect(confirmedCount(r.nextState)).toBe(18);
    expect(benchCount(r.nextState)).toBe(1);
    expect(r.outcomes[0].react).toBe("🪑");
    expect(r.outcomes[0].reasons.join(" ")).not.toMatch(/availability statement/);
  });

  it("lands where his later \"@Match Time In\" landed: the same row, the same react", () => {
    const later = decide({
      now: NOW,
      state: FULL_18(),
      messages: [
        msg({ from: "seb", body: "@Match Time In", tagged: true, route: "self_att", facts: attendanceFacts([claim({ polarity: "in" })]) }),
      ],
    });
    const first = decide({
      now: NOW,
      state: FULL_18(),
      messages: [msg({ from: "seb", body: SEB_BODY, route: "offer", facts: sebFacts() })],
    });
    expect(statusOf(later.nextState, "seb")).toBe("BENCH");
    expect(statusOf(first.nextState, "seb")).toBe(statusOf(later.nextState, "seb"));
    expect(first.outcomes[0].react).toBe(later.outcomes[0].react);
  });

  it("with a place open, the same message takes the place: no bench beside empty slots", () => {
    const state = world({ players: PLAYERS, maxPlayers: 18, confirmed: SUTTON.slice(0, 15) });
    const r = decide({
      now: NOW,
      state,
      messages: [msg({ from: "seb", body: SEB_BODY, route: "offer", facts: sebFacts() })],
    });
    expect(statusOf(r.nextState, "seb")).toBe("CONFIRMED");
    expect(benchCount(r.nextState)).toBe(0);
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/standing offer/);
  });

  it.each([
    ["available to play if needed"],
    ["I'm free if you need me"],
    ["I'm around if you're short"],
    ["I'm free Friday"],
    ["cuma boşum, lazım olursa"],
    ["biri düşerse oynarım"],
  ])("%s, read as the offer, benches the sender at full", (body) => {
    const r = decide({
      now: NOW,
      state: FULL_18(),
      messages: [
        msg({
          from: "seb",
          body,
          route: "offer",
          facts: attendanceFacts([claim({ polarity: "bench", contingent: true, conditionOn: "squad", tense: "future", confidence: 0.8 })]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "seb")).toBe("BENCH");
  });

  it("a player already in the squad who says he is free stays in, and nobody is demoted", () => {
    const state = world({ players: PLAYERS, maxPlayers: 18, confirmed: EIGHTEEN });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "kemal",
          body: "I'm free Friday anyway",
          route: "offer",
          facts: attendanceFacts([claim({ polarity: "bench", contingent: true, conditionOn: "squad", tense: "future" })]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "kemal")).toBe("CONFIRMED");
    expect(r.writes.filter((w) => w.kind === "attendance")).toEqual([]);
  });
});

describe("free to play, about someone else: never a registration", () => {
  it("\"my brother is free Friday\" registers nobody, at full or with room", () => {
    for (const state of [FULL_18(), world({ players: PLAYERS, maxPlayers: 18, confirmed: SUTTON.slice(0, 10) })]) {
      const r = decide({
        now: NOW,
        state,
        messages: [
          msg({
            from: "seb",
            body: "my brother is free Friday",
            route: "offer",
            facts: attendanceFacts([
              claim({ subject: "other", personRef: "my brother", personNamed: false, polarity: "in", contingent: true, conditionOn: "squad", tense: "future" }),
            ]),
          }),
        ],
      });
      expect(r.writes.filter((w) => w.kind === "attendance")).toEqual([]);
      expect(r.nextState.roster.some((m) => /brother/i.test(m.name))).toBe(false);
    }
  });

  it("a named member said to be free is held too", () => {
    const r = decide({
      now: NOW,
      state: world({ players: PLAYERS, maxPlayers: 18, confirmed: SUTTON.slice(0, 10) }),
      messages: [
        msg({
          from: "seb",
          body: "Najib is free Friday",
          route: "other_att",
          facts: attendanceFacts([
            claim({ subject: "other", personRef: "Najib", personNamed: true, polarity: "in", contingent: true, conditionOn: "squad", tense: "future" }),
          ]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "najib")).toBe("ABSENT");
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/not the sender/);
  });
});

describe("unable to play still settles it", () => {
  it("\"I'm away next week\" drops a confirmed player, as before", () => {
    const r = decide({
      now: NOW,
      state: world({ confirmed: ["kemal", "abid", "elvin"] }),
      messages: [
        msg({
          from: "abid",
          body: "I'm away next week",
          route: "self_att",
          facts: attendanceFacts([claim({ polarity: "out", tense: "future", confidence: 0.9 })]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "abid")).toBe("DROPPED");
  });

  it("a real commitment ten days out still registers", () => {
    const r = decide({
      now: NOW,
      state: world({ confirmed: [] }),
      messages: [
        msg({ from: "abid", body: "I'm in for next Tuesday", route: "self_att", facts: attendanceFacts([claim({ polarity: "in", tense: "future" })]) }),
      ],
    });
    expect(statusOf(r.nextState, "abid")).toBe("CONFIRMED");
  });
});
