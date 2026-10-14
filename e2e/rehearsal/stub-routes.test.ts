import { describe, expect, it } from "vitest";
import { estimateLiveCost, stubRouting } from "./stub-routes";

describe("stubRouting: what the stubbed router and extractor answer", () => {
  it("chat gets no route at all (silence), never the 'unsure' fallback", () => {
    expect(stubRouting({ body: "Ramos is the goat defender" })).toEqual({ route: "none" });
    expect(stubRouting({ body: "I'm out of here lol, see ya" })).toEqual({ route: "none" });
    expect(stubRouting({ body: "" })).toEqual({ route: "none" });
  });

  it("a plain in or out gets the obvious route and the sender's own claim", () => {
    for (const body of ["in", "IN", "I'm in", "im in 👍", "in please"]) {
      const r = stubRouting({ body });
      expect(r.route, body).toBe("self_att");
      expect((r.facts?.claims as Array<{ polarity: string }>)[0].polarity).toBe("in");
    }
    for (const body of ["out", "Out", "I'm out", "out this week", "can't make it", "cant make it this week sorry"]) {
      const r = stubRouting({ body });
      expect(r.route, body).toBe("self_att");
      expect((r.facts?.claims as Array<{ polarity: string }>)[0].polarity).toBe("out");
    }
  });

  it("an explicit route and facts on the step win", () => {
    expect(stubRouting({ body: "lol", route: "question" })).toEqual({ route: "question" });
    expect(stubRouting({ body: "x", route: "self_att", facts: { claims: [] } })).toEqual({ route: "self_att", facts: { claims: [] } });
  });

  it("reads the shorthand stubs", () => {
    const other = stubRouting({ body: "Dan out", stub: "other-out:Dan" });
    expect(other.route).toBe("other_att");
    expect((other.facts?.claims as Array<Record<string, unknown>>)[0]).toMatchObject({ subject: "other", personRef: "Dan", polarity: "out", personNamed: true });
    const score = stubRouting({ body: "7-4 to bibs", stub: "score:7-4" }, ["Bibs", "Non-bibs"]);
    expect(score).toEqual({
      route: "score",
      facts: { hasScore: true, first: 7, second: 4, firstTeam: "Bibs", secondTeam: "Non-bibs", winner: "", loser: "", correction: false, swapped: false, otherGame: false },
    });
    expect(stubRouting({ body: "x", stub: "self-out" }).route).toBe("self_att");
    expect(() => stubRouting({ body: "x", stub: "teleport" })).toThrow(/unknown stub/);
  });
});

describe("estimateLiveCost", () => {
  it("prices each kind of call and totals them", () => {
    const e = estimateLiveCost({ routerCalls: 100, extractorCalls: 10, otherCalls: { "rating adjuster": 2 } });
    expect(e.lines.map((l) => l.kind)).toEqual(["router", "extractor", "rating adjuster"]);
    expect(e.totalCalls).toBe(112);
    expect(e.totalUsd).toBeGreaterThan(0);
    expect(e.totalUsd).toBeCloseTo(e.lines.reduce((a, l) => a + l.usd, 0), 10);
  });
});
