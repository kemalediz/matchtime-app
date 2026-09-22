/**
 * THE 2026-09-22 SUTTON INCIDENT, AS A UNIT TEST.
 *
 * 28 minutes before kickoff a player posted, untagged:
 *
 *   "Hi guys, Mojib is replacing Najib on the list. We can change"
 *
 * MatchTime routed it `none` and did nothing. Mojib played, Najib did
 * not, the team sheet named the wrong man, the rating DMs would have
 * gone to him and the match fee was about to be charged to him.
 *
 * Every case below is about the PAIRING, which is the only thing that
 * can turn one message into a drop. The rule it pins: a replacement is
 * recognised ONLY when the message states the direction and BOTH people
 * are real members. Everything else returns null and the pipeline
 * behaves exactly as it did before this file existed.
 */
import { describe, expect, it } from "vitest";
import { findStatedReplacement } from "../replacement";
import type { Claim } from "../types";

const FLOOR = 0.7;

const ROSTER: Record<string, { userId: string; name: string }> = {
  mojib: { userId: "u-mojib", name: "Mojib Sadat" },
  najib: { userId: "u-najib", name: "Najib Ahmadi" },
  amir: { userId: "u-amir", name: "Amir Ahmadi" },
  kemal: { userId: "u-kemal", name: "Kemal Ediz" },
};

/** The roster, matched on the first word of a name, case-folded. */
function lookup(ref: string): { userId: string; name: string } | null {
  const q = ref.trim().toLowerCase().replace(/^@/, "");
  if (!q) return null;
  for (const [key, member] of Object.entries(ROSTER)) {
    if (q === key || q === member.name.toLowerCase()) return member;
  }
  return null;
}

function claim(partial: Partial<Claim> = {}): Claim {
  return {
    subject: "other",
    personRef: "",
    personNamed: true,
    polarity: "in",
    contingent: false,
    conditionOn: "none",
    tense: "present",
    basis: "decision",
    reported: false,
    confidence: 0.95,
    ...partial,
  };
}

/** The pair the incident's message produces once the extractor is told
 *  that a replacement is two claims and which way round it runs. */
function incidentClaims(over: { in?: Partial<Claim>; out?: Partial<Claim> } = {}): Claim[] {
  return [
    claim({ personRef: "Najib", polarity: "out", ...(over.out ?? {}) }),
    claim({ personRef: "Mojib", polarity: "in", replaces: "Najib", ...(over.in ?? {}) }),
  ];
}

function find(claims: Claim[], sender: { userId: string; name: string } | null = ROSTER.kemal) {
  return findStatedReplacement({
    claims,
    targetOf: (c) => (c.subject === "sender" ? sender : lookup(c.personRef)),
    refersTo: (ref) => (/^(?:me|myself)$/i.test(ref.trim()) ? sender : lookup(ref)),
    confidenceFloor: FLOOR,
  });
}

describe("findStatedReplacement: the incident", () => {
  it("pairs Mojib in with Najib out, in that direction", () => {
    const r = find(incidentClaims());
    expect(r).not.toBeNull();
    expect(r!.incoming).toEqual(ROSTER.mojib);
    expect(r!.outgoing).toEqual(ROSTER.najib);
    expect(r!.inClaim.personRef).toBe("Mojib");
    expect(r!.outClaim.personRef).toBe("Najib");
  });

  it("pairs them whichever order the claims arrive in", () => {
    const [out, into] = incidentClaims();
    const r = find([into, out]);
    expect(r).not.toBeNull();
    expect(r!.incoming.userId).toBe("u-mojib");
    expect(r!.outgoing.userId).toBe("u-najib");
  });

  it("resolves `replaces` through the roster, not by string equality", () => {
    const r = find([
      claim({ personRef: "@Najib", polarity: "out" }),
      claim({ personRef: "Mojib", polarity: "in", replaces: "Najib Ahmadi" }),
    ]);
    expect(r?.outgoing.userId).toBe("u-najib");
  });
});

describe("findStatedReplacement: a false drop is the whole danger", () => {
  it("refuses when the message states no direction", () => {
    // "Ali is coming, Mehmet can't make it": two ordinary claims.
    expect(find([claim({ personRef: "Najib", polarity: "out" }), claim({ personRef: "Mojib" })])).toBeNull();
  });

  it("refuses when the arriving player is not a member", () => {
    expect(
      find([
        claim({ personRef: "Najib", polarity: "out" }),
        claim({ personRef: "Zork", polarity: "in", replaces: "Najib" }),
      ]),
    ).toBeNull();
  });

  it("refuses when the leaving player is not a member", () => {
    expect(
      find([
        claim({ personRef: "Zork", polarity: "out" }),
        claim({ personRef: "Mojib", polarity: "in", replaces: "Zork" }),
      ]),
    ).toBeNull();
  });

  it("refuses when `replaces` names somebody no out claim is about", () => {
    expect(
      find([
        claim({ personRef: "Najib", polarity: "out" }),
        claim({ personRef: "Mojib", polarity: "in", replaces: "Amir" }),
      ]),
    ).toBeNull();
  });

  it("refuses a message with no out claim at all", () => {
    expect(find([claim({ personRef: "Mojib", polarity: "in", replaces: "Najib" })])).toBeNull();
  });

  it("refuses when two replacements are stated at once", () => {
    expect(
      find([
        claim({ personRef: "Najib", polarity: "out" }),
        claim({ personRef: "Mojib", polarity: "in", replaces: "Najib" }),
        claim({ personRef: "Amir", polarity: "in", replaces: "Najib" }),
      ]),
    ).toBeNull();
  });

  it("refuses when both halves name the same person", () => {
    expect(
      find([
        claim({ personRef: "Mojib", polarity: "out" }),
        claim({ personRef: "Mojib", polarity: "in", replaces: "Mojib" }),
      ]),
    ).toBeNull();
  });

  it("refuses an unnamed arrival, so no ghost inherits a slot", () => {
    expect(
      find([
        claim({ personRef: "Najib", polarity: "out" }),
        claim({ personRef: "my brother", polarity: "in", personNamed: false, replaces: "Najib" }),
      ]),
    ).toBeNull();
  });
});

describe("findStatedReplacement: the confidence floor still applies", () => {
  it("refuses when the arriving claim is below the floor", () => {
    expect(find(incidentClaims({ in: { confidence: 0.6 } }))).toBeNull();
  });

  it("refuses when the leaving claim is below the floor", () => {
    expect(find(incidentClaims({ out: { confidence: 0.6 } }))).toBeNull();
  });

  it("accepts exactly at the floor", () => {
    expect(find(incidentClaims({ in: { confidence: FLOOR }, out: { confidence: FLOOR } }))).not.toBeNull();
  });
});

describe("findStatedReplacement: the vetoes every other claim gets", () => {
  it("refuses a contingent arrival", () => {
    expect(find(incidentClaims({ in: { contingent: true, conditionOn: "squad" } }))).toBeNull();
  });

  it("refuses a contingent departure", () => {
    expect(find(incidentClaims({ out: { contingent: true, conditionOn: "squad" } }))).toBeNull();
  });

  it("refuses a past or hypothetical claim", () => {
    expect(find(incidentClaims({ in: { tense: "past" } }))).toBeNull();
    expect(find(incidentClaims({ out: { tense: "hypothetical" } }))).toBeNull();
  });

  it("refuses an availability statement dressed as an arrival", () => {
    expect(find(incidentClaims({ in: { basis: "availability" } }))).toBeNull();
  });

  it("accepts a future commitment", () => {
    expect(find(incidentClaims({ in: { tense: "future" }, out: { tense: "future" } }))).not.toBeNull();
  });
});

describe("findStatedReplacement: the sender may be the one leaving", () => {
  it("pairs \"I'm out, Mojib is replacing me\"", () => {
    const r = find([
      claim({ subject: "sender", personRef: "", polarity: "out", personNamed: false }),
      claim({ personRef: "Mojib", polarity: "in", replaces: "me" }),
    ]);
    expect(r).not.toBeNull();
    expect(r!.outgoing.userId).toBe("u-kemal");
    expect(r!.incoming.userId).toBe("u-mojib");
  });

  it("refuses it when the sender could not be resolved", () => {
    expect(
      find(
        [
          claim({ subject: "sender", personRef: "", polarity: "out", personNamed: false }),
          claim({ personRef: "Mojib", polarity: "in", replaces: "me" }),
        ],
        null,
      ),
    ).toBeNull();
  });

  it("never lets the sender be the one ARRIVING on somebody else's word", () => {
    // A sender claim can only be about the sender, so "replaces" on a
    // sender IN is their own substitution and is not this pairing.
    expect(
      find([
        claim({ personRef: "Najib", polarity: "out" }),
        claim({ subject: "sender", personRef: "", polarity: "in", personNamed: false, replaces: "Najib" }),
      ]),
    ).toBeNull();
  });
});
