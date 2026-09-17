/**
 * RED FIRST — the 2026-09-08 Elvin/Raihan incident, and the whole state
 * matrix around it.
 *
 * Production, Sutton FC, the afternoon of a match:
 *
 *   15:25  Elvin:  "please can someone replace me, not feeling well"
 *                  → recorded OUT (DROPPED, still holding a RED slot)
 *   16:15  Wasim:  "I have a friend who will play instead of my dad.
 *                   His name is Raihan"        → Raihan CONFIRMED, no slot
 *   16:47  Kemal:  "@Match Time do not regenerate the teams. Instead
 *                   swap Elvin with Raihan and share us the teams"
 *                  → NOTHING HAPPENED
 *
 * `handleTeamSwapIfApplicable` matched the sentence and then declined,
 * because its rule was "both must resolve uniquely AND both be
 * CONFIRMED". Elvin was DROPPED. The message fell through to `balancer`,
 * which owns no `swap` action, and the operator got
 * `team action "swap" is not a read (no module owns it)` while a stale
 * team sheet stood for a match kicking off that evening.
 *
 * The replacement case IS the common team edit at this club: someone
 * pulls out, someone else comes in, and the line-up has to follow the
 * body. This file pins the decision for EVERY combination of
 * (attendance status × holds a slot) on both sides, in both orderings,
 * so the answer is a table rather than a judgement call.
 */
import { describe, it, expect } from "vitest";
import { buildSwapRefusedReply } from "../group-copy";
import {
  decideSwap,
  isSwapParty,
  parseSwapNames,
  parseSwapRequest,
  planSwap,
  senderStatesAttendance,
  resolveSwapSide,
  type SwapCandidate,
  type SwapDecision,
  type SwapSide,
} from "../team-slot-swap";

// ── The eight states one side can be in ────────────────────────────────
//
// Teams are only ever generated from CONFIRMED attendance
// (`lib/team-generation.ts` and `actions/teams.ts` both build the
// balancer's input from `status: CONFIRMED` rows), so "not CONFIRMED but
// holding a slot" is ALWAYS a stale sheet — a player dropped or benched
// after the teams were built. That fact is what makes the transfer a
// repair rather than an interpretation.
const STATES = {
  "CONFIRMED+slot": { status: "CONFIRMED", team: "RED" },
  "CONFIRMED+none": { status: "CONFIRMED", team: null },
  "BENCH+slot": { status: "BENCH", team: "RED" },
  "BENCH+none": { status: "BENCH", team: null },
  "DROPPED+slot": { status: "DROPPED", team: "RED" },
  "DROPPED+none": { status: "DROPPED", team: null },
  "NONE+slot": { status: "NONE", team: "RED" },
  "NONE+none": { status: "NONE", team: null },
} as const;

type StateKey = keyof typeof STATES;
const KEYS = Object.keys(STATES) as StateKey[];

function side(key: StateKey, id: string, name: string): SwapSide {
  const s = STATES[key];
  return { userId: id, name, status: s.status, team: s.team };
}

/** What `decideSwap` must answer, for every ordered pair. Written out in
 *  full rather than computed, because a table that reimplements the
 *  function under test proves only that it agrees with itself. */
const EXPECTED: Record<StateKey, Record<StateKey, string>> = {
  "CONFIRMED+slot": {
    "CONFIRMED+slot": "team-swap",
    "CONFIRMED+none": "team-swap",
    "BENCH+slot": "refuse:both-hold-slots",
    "BENCH+none": "refuse:receiver-not-confirmed",
    "DROPPED+slot": "refuse:both-hold-slots",
    "DROPPED+none": "refuse:receiver-not-confirmed",
    "NONE+slot": "refuse:both-hold-slots",
    "NONE+none": "refuse:receiver-not-confirmed",
  },
  "CONFIRMED+none": {
    "CONFIRMED+slot": "team-swap",
    "CONFIRMED+none": "defer-no-teams",
    "BENCH+slot": "slot-transfer",
    "BENCH+none": "refuse:no-slot-to-move",
    "DROPPED+slot": "slot-transfer", // ← THE INCIDENT
    "DROPPED+none": "refuse:no-slot-to-move",
    "NONE+slot": "slot-transfer",
    "NONE+none": "refuse:no-slot-to-move",
  },
  "BENCH+slot": {
    "CONFIRMED+slot": "refuse:both-hold-slots",
    "CONFIRMED+none": "slot-transfer",
    "BENCH+slot": "refuse:nobody-is-playing",
    "BENCH+none": "refuse:nobody-is-playing",
    "DROPPED+slot": "refuse:nobody-is-playing",
    "DROPPED+none": "refuse:nobody-is-playing",
    "NONE+slot": "refuse:nobody-is-playing",
    "NONE+none": "refuse:nobody-is-playing",
  },
  "BENCH+none": {
    "CONFIRMED+slot": "refuse:receiver-not-confirmed",
    "CONFIRMED+none": "refuse:no-slot-to-move",
    "BENCH+slot": "refuse:nobody-is-playing",
    "BENCH+none": "refuse:nobody-is-playing",
    "DROPPED+slot": "refuse:nobody-is-playing",
    "DROPPED+none": "refuse:nobody-is-playing",
    "NONE+slot": "refuse:nobody-is-playing",
    "NONE+none": "refuse:nobody-is-playing",
  },
  "DROPPED+slot": {
    "CONFIRMED+slot": "refuse:both-hold-slots",
    "CONFIRMED+none": "slot-transfer",
    "BENCH+slot": "refuse:nobody-is-playing",
    "BENCH+none": "refuse:nobody-is-playing",
    "DROPPED+slot": "refuse:nobody-is-playing",
    "DROPPED+none": "refuse:nobody-is-playing",
    "NONE+slot": "refuse:nobody-is-playing",
    "NONE+none": "refuse:nobody-is-playing",
  },
  "DROPPED+none": {
    "CONFIRMED+slot": "refuse:receiver-not-confirmed",
    "CONFIRMED+none": "refuse:no-slot-to-move",
    "BENCH+slot": "refuse:nobody-is-playing",
    "BENCH+none": "refuse:nobody-is-playing",
    "DROPPED+slot": "refuse:nobody-is-playing",
    "DROPPED+none": "refuse:nobody-is-playing",
    "NONE+slot": "refuse:nobody-is-playing",
    "NONE+none": "refuse:nobody-is-playing",
  },
  "NONE+slot": {
    "CONFIRMED+slot": "refuse:both-hold-slots",
    "CONFIRMED+none": "slot-transfer",
    "BENCH+slot": "refuse:nobody-is-playing",
    "BENCH+none": "refuse:nobody-is-playing",
    "DROPPED+slot": "refuse:nobody-is-playing",
    "DROPPED+none": "refuse:nobody-is-playing",
    "NONE+slot": "refuse:nobody-is-playing",
    "NONE+none": "refuse:nobody-is-playing",
  },
  "NONE+none": {
    "CONFIRMED+slot": "refuse:receiver-not-confirmed",
    "CONFIRMED+none": "refuse:no-slot-to-move",
    "BENCH+slot": "refuse:nobody-is-playing",
    "BENCH+none": "refuse:nobody-is-playing",
    "DROPPED+slot": "refuse:nobody-is-playing",
    "DROPPED+none": "refuse:nobody-is-playing",
    "NONE+slot": "refuse:nobody-is-playing",
    "NONE+none": "refuse:nobody-is-playing",
  },
};

/** One comparable string per decision, so the table above can be read. */
function label(d: SwapDecision): string {
  return d.kind === "refuse" ? `refuse:${d.reason}` : d.kind;
}

describe("decideSwap — the 2026-09-08 incident, verbatim", () => {
  const elvin: SwapSide = {
    userId: "u-elvin",
    name: "Elvin Aliyev",
    status: "DROPPED",
    team: "RED",
  };
  const raihan: SwapSide = {
    userId: "u-raihan",
    name: "Raihan",
    status: "CONFIRMED",
    team: null,
  };

  it("moves the RED slot from the dropped Elvin to the confirmed Raihan", () => {
    const d = decideSwap(elvin, raihan);
    expect(d.kind).toBe("slot-transfer");
    if (d.kind !== "slot-transfer") return;
    expect(d.from.userId).toBe("u-elvin");
    expect(d.to.userId).toBe("u-raihan");
    expect(d.team).toBe("RED");
  });

  it("reads the same in the other order — 'swap Raihan with Elvin'", () => {
    const d = decideSwap(raihan, elvin);
    expect(d.kind).toBe("slot-transfer");
    if (d.kind !== "slot-transfer") return;
    expect(d.from.userId).toBe("u-elvin");
    expect(d.to.userId).toBe("u-raihan");
    expect(d.team).toBe("RED");
  });

  it("carries NO attendance write — a swap moves a slot, it never drops or adds", () => {
    const d = decideSwap(elvin, raihan);
    expect(d.kind).toBe("slot-transfer");
    if (d.kind !== "slot-transfer") return;
    // The decision type is the whole contract with the caller: it names
    // a matchId/userId/team triple and nothing else. If it cannot name
    // an attendance change, the caller cannot make one from it.
    expect(Object.keys(d).sort()).toEqual(["from", "kind", "team", "to"]);
  });
});

describe("decideSwap — the full state matrix, both orderings", () => {
  for (const a of KEYS) {
    for (const b of KEYS) {
      const expected = EXPECTED[a][b];
      it(`${a} × ${b} → ${expected}`, () => {
        expect(
          label(decideSwap(side(a, "u-a", "Ayaan"), side(b, "u-b", "Bilal"))),
        ).toBe(expected);
      });
    }
  }

  it("is symmetric: decide(a,b) and decide(b,a) reach the same verdict", () => {
    for (const a of KEYS) {
      for (const b of KEYS) {
        const ab = label(decideSwap(side(a, "u-a", "Ayaan"), side(b, "u-b", "Bilal")));
        const ba = label(decideSwap(side(b, "u-b", "Bilal"), side(a, "u-a", "Ayaan")));
        expect(`${a}×${b}: ${ab}`).toBe(`${a}×${b}: ${ba}`);
      }
    }
  });

  it("refuses a player swapped with themselves", () => {
    const one: SwapSide = { userId: "u-a", name: "Ayaan", status: "CONFIRMED", team: "RED" };
    expect(label(decideSwap(one, { ...one }))).toBe("refuse:same-player");
  });
});

// ── THE SHIPPED BOTH-CONFIRMED SWAP MUST NOT MOVE ──────────────────────
describe("decideSwap — the shipped two-confirmed-players team swap", () => {
  const red: SwapSide = { userId: "u-a", name: "Mustafa", status: "CONFIRMED", team: "RED" };
  const yellow: SwapSide = { userId: "u-b", name: "Idris", status: "CONFIRMED", team: "YELLOW" };

  it("exchanges their sides", () => {
    const d = decideSwap(red, yellow);
    expect(d.kind).toBe("team-swap");
    if (d.kind !== "team-swap") return;
    expect(d.teamForA).toBe("YELLOW");
    expect(d.teamForB).toBe("RED");
  });

  it("puts a slotless confirmed player onto the other's side, and moves the other across", () => {
    const slotless: SwapSide = { userId: "u-b", name: "Idris", status: "CONFIRMED", team: null };
    const d = decideSwap(red, slotless);
    expect(d.kind).toBe("team-swap");
    if (d.kind !== "team-swap") return;
    expect(d.teamForA).toBe("YELLOW");
    expect(d.teamForB).toBe("RED");
  });

  it("defers when no teams exist at all — nobody is dropped, nothing is generated", () => {
    const a: SwapSide = { userId: "u-a", name: "Mustafa", status: "CONFIRMED", team: null };
    const b: SwapSide = { userId: "u-b", name: "Idris", status: "CONFIRMED", team: null };
    expect(decideSwap(a, b).kind).toBe("defer-no-teams");
  });
});

// ── NAME PARSING ───────────────────────────────────────────────────────
describe("parseSwapNames", () => {
  it("reads the incident sentence, ignoring the 'do not regenerate' clause", () => {
    expect(
      parseSwapNames(
        "@Match Time do not regenerate the teams. Instead swap Elvin with Raihan and share us the teams",
      ),
    ).toEqual({ a: "elvin", b: "raihan" });
  });

  const YES: Array<[string, string, string]> = [
    ["swap Elvin with Raihan", "elvin", "raihan"],
    ["switch Mustafa and Idris", "mustafa", "idris"],
    ["swap Sait for Zeeshan", "sait", "zeeshan"],
    ["swap Ali & Omar", "ali", "omar"],
    ["please swap Nabeel, Adam", "nabeel", "adam"],
  ];
  for (const [body, a, b] of YES) {
    it(`reads "${body}"`, () => expect(parseSwapNames(body)).toEqual({ a, b }));
  }

  const NO = [
    "swap the colours",
    "swap the teams please",
    "can we swap sides",
    // Used to come back as `need` + `ed`: the engine backtracked INSIDE
    // one word. Saved only by neither half resolving to a player, which
    // is not a guard. The `\b` after each captured name closes it.
    "no swap needed",
    "swap Elvin with Elvin",
  ];
  for (const body of NO) {
    it(`declines "${body}"`, () => expect(parseSwapNames(body)).toBeNull());
  }
});

// ── THE TURKISH FORM (2026-09-17) ──────────────────────────────────────
//
// The Turkish copy tells the group to type "@Match Time X ile Y'yi
// değiştir". The second name carries the accusative suffix after an
// apostrophe ('yi, 'ı, 'u, 'ü, 'yı…), which is stripped: the roster knows
// "Can", not "Can'ı".
describe("parseSwapNames: Turkish", () => {
  const YES: Array<[string, string, string]> = [
    ["@Match Time David ile Ali'yi değiştir", "david", "ali"],
    ["@Match Time Mustafa ile Idris'i değiştir", "mustafa", "idris"],
    ["Ali ile Can'ı değiştir", "ali", "can"],
    ["Ali ile Can’ı değiştir", "ali", "can"], // the phone's curly apostrophe
    ["ali ile can'ı degistir", "ali", "can"],
    ["Sait ile Burak'ı değiştirir misin", "sait", "burak"],
    ["Elvin ve Raihan'ı değiştir", "elvin", "raihan"],
    ["Elvin ile Raihan değiştir", "elvin", "raihan"],
  ];
  for (const [body, a, b] of YES) {
    it(`reads "${body}"`, () => expect(parseSwapNames(body)).toEqual({ a, b }));
  }

  const NO = [
    // Colours are the colour swap's, never two players.
    "@Match Time kırmızı ile sarıyı değiştir",
    "@Match Time Kırmızı ile Sarı'yı değiştir",
    "@Match Time renkleri değiştir",
    "@Match Time renkleri ve takımları değiştir",
    // Negated: "do not swap Ali and Can".
    "Ali ile Can'ı değiştirme",
    // No pair at all.
    "@Match Time maç saatini değiştir",
    "@Match Time takımları kur",
    "Ali ile Ali'yi değiştir",
  ];
  for (const body of NO) {
    it(`declines "${body}"`, () => expect(parseSwapNames(body)).toBeNull());
  }
});

// ── NAME RESOLUTION ────────────────────────────────────────────────────
//
// The pool WIDENS from "CONFIRMED only" to "anyone with an attendance
// row or a team slot", which is what lets a DROPPED Elvin be found at
// all. Widening a pool can create ambiguity where there was none, so the
// resolution is two-stage and a name that resolved before resolves to
// the same person now.
describe("resolveSwapSide", () => {
  const roster: SwapCandidate[] = [
    { userId: "u-elvin", name: "Elvin Aliyev", status: "DROPPED", team: "RED" },
    { userId: "u-raihan", name: "Raihan", status: "CONFIRMED", team: null },
    { userId: "u-omar1", name: "Omar One", status: "CONFIRMED", team: "RED" },
    { userId: "u-omar2", name: "Omar Two", status: "DROPPED", team: null },
  ];

  it("finds a DROPPED player by first name — the whole point", () => {
    expect(resolveSwapSide("elvin", roster)?.userId).toBe("u-elvin");
  });

  it("finds a CONFIRMED player by first name", () => {
    expect(resolveSwapSide("raihan", roster)?.userId).toBe("u-raihan");
  });

  it("prefers the unique CONFIRMED match, so the shipped behaviour is unchanged", () => {
    // Two Omars. Before the widening only Omar One was in the pool and
    // "omar" resolved to him; it still must.
    expect(resolveSwapSide("omar", roster)?.userId).toBe("u-omar1");
  });

  it("refuses an ambiguous name when neither candidate is CONFIRMED", () => {
    const two: SwapCandidate[] = [
      { userId: "u-1", name: "Omar One", status: "DROPPED", team: "RED" },
      { userId: "u-2", name: "Omar Two", status: "DROPPED", team: null },
    ];
    expect(resolveSwapSide("omar", two)).toBeNull();
  });

  it("returns null for a name nobody carries", () => {
    expect(resolveSwapSide("kevin", roster)).toBeNull();
  });
});

// ── A SWAP REQUEST IS NEVER ATTENDANCE (2026-09-17, TR26 / TR27) ───────
//
// The swap check refuses a message it cannot apply (an unknown or
// ambiguous name, teams not generated) and the message reaches the
// attendance pipeline. Measured live before this change, REPEAT=10:
// "@Match Time swap David and Sait" dropped David 10 of 10, and "@Match
// Time David ile Sait'i değiştir" 9 of 10. `isSwapParty` is the test the
// engine asks of every claim in such a message: is this claim about one
// of the two people the message asks to swap?
describe("isSwapParty", () => {
  const P = { a: "david", b: "sait" };
  const other = (personRef: string) => ({ subject: "other" as const, personRef });

  const YES: Array<[string, { a: string; b: string }, string]> = [
    ["the first name, as typed", P, "David"],
    ["the second name", P, "Sait"],
    ["an @mention of the name", P, "@David"],
    ["the full name the extractor copied", P, "Sait Demir"],
    ["the Turkish accusative", P, "Sait'i"],
    ["the curly apostrophe", P, "Sait’i"],
    ["upper case", P, "DAVID"],
    ["a dotted capital İ", { a: "idris", b: "can" }, "İdris"],
    ["a parsed name with its own suffix", { a: "david", b: "ali'yi" }, "Ali"],
  ];
  for (const [label, parties, ref] of YES) {
    it(`claims about "${ref}" are a swap party (${label})`, () => {
      expect(isSwapParty(other(ref), parties)).toBe(true);
    });
  }

  const NO: Array<[string, { a: string; b: string }, string]> = [
    ["a different player", P, "Zeeshan"],
    ["a name that merely STARTS with a party", P, "Davidson"],
    ["an empty reference", P, ""],
    // "@Kemal switch it to 7 a side and include Amir" parses as a swap of
    // "it" and "to". Amir is not a party, and his IN must survive: this is
    // router rule 15's own example, and it is why the guard is per NAME
    // and never per message.
    ["the rule-15 message's real player", { a: "it", b: "to" }, "Amir"],
  ];
  for (const [label, parties, ref] of NO) {
    it(`claims about "${ref}" are not (${label})`, () => {
      expect(isSwapParty(other(ref), parties)).toBe(false);
    });
  }

  describe("substitution phrasing is never a swap (review of PR #99)", () => {
    const NOT_SWAPS = [
      "swap me out, Kieran can take my place",
      "can someone swap in for me tonight? I'm out",
      "@Kemal can you switch it to 7 a side and put Amir in as the 14th",
      "can anyone swap with me",
      "happy to swap for someone",
      "switch me off the list",
      "can we swap over",
    ];
    for (const body of NOT_SWAPS) {
      it(`"${body}" parses as no swap`, () => expect(parseSwapNames(body)).toBeNull());
    }
    it("'swap me with Kieran' still parses (the rule for it lives in the guard)", () => {
      expect(parseSwapNames("swap me with Kieran please, I can't make it")).toEqual({ a: "me", b: "kieran" });
    });
  });

  describe("senderStatesAttendance", () => {
    const YES = [
      "swap me with Kieran please, I can't make it",
      "swap me with Kieran, I'm out",
      "swap me with Kieran as I cannot make it tonight",
      "swap me with Kieran, not coming",
      "swap me with Kieran, count me out",
      "beni Kieran ile değiştir, yokum",
    ];
    for (const body of YES) {
      it(`"${body}" states attendance outside the swap`, () =>
        expect(senderStatesAttendance(body)).toBe(true));
    }
    const NO = ["@Match Time swap me with Kieran", "@Match Time swap David and Sait", "swap me with Kieran please"];
    for (const body of NO) {
      it(`"${body}" does not`, () => expect(senderStatesAttendance(body)).toBe(false));
    }
  });

  it("the sender's own claim is a party only when the swap names the sender", () => {
    const sender = { subject: "sender" as const, personRef: "" };
    expect(isSwapParty(sender, P)).toBe(false);
    expect(isSwapParty(sender, { a: "me", b: "david" })).toBe(true);
    expect(isSwapParty(sender, { a: "david", b: "myself" })).toBe(true);
  });

  it("'Ben' is a player, not the Turkish 'I': the sender's own claim survives", () => {
    const sender = { subject: "sender" as const, personRef: "" };
    expect(isSwapParty(sender, { a: "ben", b: "pat" })).toBe(false);
    expect(isSwapParty(other("Ben"), { a: "ben", b: "pat" })).toBe(true);
  });
});

// ── WHAT THE ROUTE DOES WITH A PARSED SWAP ─────────────────────────────
//
// `planSwap` is the pure half of `handleTeamSwapIfApplicable`. It adds
// two things to `decideSwap`: it separates a message that is not a
// player swap at all ("switch it to 7 a side": neither word is anybody)
// from a real swap it cannot apply, and it names WHY it refused, so the
// owner is told instead of hearing nothing.
describe("planSwap", () => {
  const roster: SwapCandidate[] = [
    { userId: "u-david", name: "David", status: "CONFIRMED", team: "RED" },
    { userId: "u-sait", name: "Sait Demir", status: "CONFIRMED", team: "YELLOW" },
    { userId: "u-elvin", name: "Elvin Aliyev", status: "DROPPED", team: null },
    { userId: "u-baki", name: "Baki Aydin", status: "BENCH", team: null },
    { userId: "u-omar1", name: "Omar One", status: "DROPPED", team: null },
    { userId: "u-omar2", name: "Omar Two", status: "BENCH", team: null },
    { userId: "u-kemal", name: "Kemal Ediz", status: "CONFIRMED", team: "YELLOW" },
  ];
  const noTeams = roster.map((r) => ({ ...r, team: null }));
  const opts = { sender: { userId: "u-kemal", name: "Kemal Ediz" }, teamsExist: true };

  it("applies a swap it can apply, exactly as decideSwap says", () => {
    const p = planSwap({ a: "david", b: "sait" }, roster, opts);
    expect(p.kind).toBe("decided");
    if (p.kind === "decided") expect(p.decision.kind).toBe("team-swap");
  });

  it("is not a player swap when NEITHER word is a player", () => {
    expect(planSwap({ a: "it", b: "to" }, roster, opts)).toEqual({ kind: "not-a-player-swap" });
  });

  it("is not a player swap when a word only PREFIXES a player ('to' and Tom)", () => {
    // "@Match Time switch it to 7 a side" parses as it / to, and "to"
    // prefix-matches Tom Third. Caught by the e2e suite: the owner was
    // told "I haven't swapped It and Tom Third".
    const withTom: SwapCandidate[] = [
      ...roster,
      { userId: "u-tom", name: "Tom Third", status: "CONFIRMED", team: "YELLOW" },
    ];
    expect(planSwap({ a: "it", b: "to" }, withTom, opts)).toEqual({ kind: "not-a-player-swap" });
  });

  it("a prefix still resolves once the other word is exactly a player", () => {
    const p = planSwap({ a: "dav", b: "sait" }, roster, opts);
    expect(p.kind).toBe("decided");
  });

  it("refuses an unknown name, and names it as typed", () => {
    expect(planSwap({ a: "david", b: "zork" }, roster, opts)).toEqual({
      kind: "refused",
      a: "David",
      b: "Zork",
      why: { reason: "unknown-name", name: "Zork" },
    });
  });

  for (const body of [
    "swap david and zork",
    "@Match Time swap david and zork",
    "@Match Time david ile zork'u değiştir",
  ]) {
    it(`"${body}": a lowercase unknown name is still refused, and named`, () => {
      const req = parseSwapRequest(body)!;
      const p = planSwap(req, roster, opts);
      expect(p).toEqual({
        kind: "refused",
        a: "David",
        b: "Zork",
        why: { reason: "unknown-name", name: "Zork" },
      });
      if (p.kind === "refused") {
        expect(buildSwapRefusedReply({ ...p, lang: "en" })).toContain("*Zork*");
      }
    });
  }

  it("a time or filler word is never a player: 'swap david and tonight' is no swap", () => {
    for (const body of [
      "swap david and tonight",
      "swap david tomorrow",
      "swap david please",
      "swap david now mate",
      "david ile yarın değiştir",
      "david ile bugün değiştir",
      "david ve akşam değiştir",
    ]) {
      expect(parseSwapRequest(body), body).toBeNull();
    }
  });

  it("refuses an ambiguous name, and lists who it could be", () => {
    expect(planSwap({ a: "omar", b: "sait" }, roster, opts)).toEqual({
      kind: "refused",
      a: "Omar",
      b: "Sait Demir",
      why: { reason: "ambiguous-name", name: "Omar", candidates: ["Omar One", "Omar Two"] },
    });
  });

  it("says the teams are not generated when that is the reason", () => {
    const p = planSwap({ a: "david", b: "elvin" }, noTeams, { ...opts, teamsExist: false });
    expect(p).toEqual({
      kind: "refused",
      a: "David",
      b: "Elvin Aliyev",
      why: { reason: "teams-not-generated" },
    });
  });

  it("keeps the shipped deferral for two confirmed players and no teams", () => {
    const p = planSwap({ a: "david", b: "sait" }, noTeams, { ...opts, teamsExist: false });
    expect(p.kind).toBe("decided");
    if (p.kind === "decided") expect(p.decision.kind).toBe("defer-no-teams");
  });

  it("names the player who is not in the squad", () => {
    expect(planSwap({ a: "david", b: "baki" }, roster, opts)).toEqual({
      kind: "refused",
      a: "David",
      b: "Baki Aydin",
      why: { reason: "receiver-not-confirmed", name: "Baki Aydin" },
    });
  });

  it("refuses when nobody named is playing", () => {
    const p = planSwap({ a: "elvin", b: "baki" }, roster, opts);
    expect(p.kind === "refused" && p.why).toEqual({ reason: "nobody-is-playing" });
  });

  it("reads 'me' as the sender", () => {
    const p = planSwap({ a: "me", b: "david" }, roster, opts);
    expect(p.kind).toBe("decided");
    if (p.kind === "decided" && p.decision.kind === "team-swap") {
      expect(p.decision.a.userId).toBe("u-kemal");
      expect(p.decision.b.userId).toBe("u-david");
    }
  });

  it("a swap naming the sender that cannot be applied is a substitution, never a refusal", () => {
    // "swap me with David" from someone not in the squad: the fast path
    // must not answer "nobody was dropped" while the pipeline reads the
    // message as the substitution it is.
    const p = planSwap({ a: "me", b: "david" }, roster, {
      sender: { userId: "u-new", name: "New Guy" },
      teamsExist: true,
    });
    expect(p).toEqual({ kind: "not-a-player-swap" });
  });

  it("a swap naming the sender is left to the pipeline when the sender also states attendance", () => {
    const p = planSwap({ a: "me", b: "david" }, roster, { ...opts, senderStatesAttendance: true });
    expect(p).toEqual({ kind: "not-a-player-swap" });
  });

  it("'Ben' resolves to the player called Ben, never to the sender", () => {
    const withBen: SwapCandidate[] = [
      ...roster,
      { userId: "u-ben", name: "Ben Bench", status: "BENCH", team: null },
    ];
    const p = planSwap({ a: "ben", b: "elvin" }, withBen, opts);
    expect(p).toEqual({
      kind: "refused",
      a: "Ben Bench",
      b: "Elvin Aliyev",
      why: { reason: "nobody-is-playing" },
    });
  });

  it("'me' from an unresolved sender is not a side at all", () => {
    const p = planSwap({ a: "me", b: "zork" }, roster, { sender: null, teamsExist: true });
    expect(p).toEqual({ kind: "not-a-player-swap" });
  });
});
