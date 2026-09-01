/**
 * THE DECISION ENGINE — the incident archive as unit tests.
 *
 * MDs/analyzer-redesign-2026-08-31.md §3.2 categorises 35.6% of the
 * 18,315-token prompt (16 sections, 6,642 tokens) as **B — a decision
 * that should be deterministic code**. Every one of those rules moves
 * here, and every one gets a test naming the incident it came from.
 *
 * "That is the actual deliverable: the incident archive stops being a
 * prompt and becomes a test suite." (§12.3)
 *
 * The engine is pure — no DB, no model, no clock — so these run in
 * milliseconds and can enumerate capacity edges that are currently
 * untestable without a live model.
 */
import { describe, it, expect } from "vitest";
import { decide } from "../engine";
import {
  NOW,
  attendanceFacts,
  benchCount,
  claim,
  confirmedCount,
  msg,
  statusOf,
  world,
} from "./helpers";
import type { ProposedWrite } from "../types";

const FULL_14 = [
  "kemal",
  "elvin",
  "sait",
  "mustafa",
  "abid",
  "idris",
  "faris",
  "shaz",
  "adam",
  "efat",
  "usama",
  "karahan",
  "zair",
  "wasim",
];

function attWrites(writes: ProposedWrite[]) {
  return writes.filter((w) => w.kind === "attendance");
}

// ── S1 · coverage ──────────────────────────────────────────────────────

describe("S1 · verdict coverage (2026-05-25, Ibrahim + Baki, cd3214f)", () => {
  it("emits exactly one outcome per input message, always", () => {
    const state = world({ confirmed: ["kemal", "elvin", "sait"] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({ from: "kemal", route: "none", facts: { kind: "none" } }),
        msg({
          from: "elvin",
          route: "self_att",
          facts: attendanceFacts([claim({ polarity: "out" })]),
        }),
        msg({ from: "sait", route: "unsure", facts: { kind: "none" } }),
      ],
    });
    expect(r.outcomes).toHaveLength(3);
    expect(new Set(r.outcomes.map((o) => o.messageId)).size).toBe(3);
  });

  it("lands BOTH drops in a batch — neither is silently omitted", () => {
    const state = world({ confirmed: [...FULL_14] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "zair",
          body: "I am fighting with a terrible flu, anyone replace me?",
          route: "self_att",
          facts: attendanceFacts([claim({ polarity: "out" })], { sideRequests: ["recruit"] }),
        }),
        msg({
          from: "wasim",
          body: "I'm out too, can't put weight on my left foot",
          route: "self_att",
          facts: attendanceFacts([claim({ polarity: "out" })]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "zair")).toBe("DROPPED");
    expect(statusOf(r.nextState, "wasim")).toBe("DROPPED");
    expect(confirmedCount(r.nextState)).toBe(12);
  });
});

// ── S2 · the interaction contract ──────────────────────────────────────

describe("S2 · interaction contract (2026-06-18, 19f43e3 / bd3305d)", () => {
  it("an untagged third-party DROP does nothing at all", () => {
    const state = world({ confirmed: [...FULL_14] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "zair",
          body: "take Habib off, he's not coming",
          route: "other_att",
          tagged: false,
          facts: attendanceFacts([
            claim({ subject: "other", personRef: "Habib", personNamed: true, polarity: "out" }),
          ]),
        }),
      ],
    });
    expect(r.writes).toHaveLength(0);
    expect(r.speech).toHaveLength(0);
    expect(r.outcomes[0].disposition).toBe("noop");
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/tag/i);
  });

  it("the same drop TAGGED is honoured", () => {
    const state = world({ confirmed: [...FULL_14] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "elvin",
          body: "@Match Time Zeeshan is out tonight, take him off",
          route: "other_att",
          tagged: true,
          facts: attendanceFacts([
            claim({ subject: "other", personRef: "Wasim", personNamed: true, polarity: "out" }),
          ]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "wasim")).toBe("DROPPED");
  });

  it("an untagged IN-ONLY add for a named player still registers (bd3305d)", () => {
    const state = world({ confirmed: ["kemal", "elvin"], players: [...FULL_14, "rashad"] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "zair",
          body: "Add Rashad please",
          route: "other_att",
          tagged: false,
          facts: attendanceFacts([
            claim({ subject: "other", personRef: "Rashad", personNamed: true, polarity: "in" }),
          ]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "rashad")).toBe("CONFIRMED");
    // …and never the sender. The 2026-06-11 Salman incident in miniature.
    expect(statusOf(r.nextState, "zair")).toBe("ABSENT");
  });

  it("self-attendance never needs a tag", () => {
    const state = world({ confirmed: ["kemal"] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({ from: "zair", body: "in", route: "self_att", facts: attendanceFacts([claim({})]) }),
      ],
    });
    expect(statusOf(r.nextState, "zair")).toBe("CONFIRMED");
  });
});

// ── S3 · tense ─────────────────────────────────────────────────────────

describe("S3 · tense never registers (replaces looksLikeHypotheticalOrPast)", () => {
  it("a PAST claim writes nothing", () => {
    const state = world({ confirmed: ["kemal", "elvin"] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "zair",
          body: "I was in last week and nobody added me",
          route: "self_att",
          facts: attendanceFacts([claim({ tense: "past" })]),
        }),
      ],
    });
    expect(r.writes).toHaveLength(0);
    expect(statusOf(r.nextState, "zair")).toBe("ABSENT");
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/past/);
  });

  it("a HYPOTHETICAL claim writes nothing", () => {
    const state = world({ confirmed: ["kemal"] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "zair",
          body: "if I was in the team it wouldn't be ruined",
          route: "self_att",
          facts: attendanceFacts([claim({ tense: "hypothetical" })]),
        }),
      ],
    });
    expect(r.writes).toHaveLength(0);
  });

  it("a FUTURE claim DOES register — 'I'll play tomorrow' is a commitment", () => {
    const state = world({ confirmed: ["kemal"] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({ from: "zair", route: "self_att", facts: attendanceFacts([claim({ tense: "future" })]) }),
      ],
    });
    expect(statusOf(r.nextState, "zair")).toBe("CONFIRMED");
  });
});

// ── S5 / PR27 · explicit bench vs inferred bench ───────────────────────

describe("S5 + PR#27 · a BENCH row means FULL or ASKED, never 'inferred'", () => {
  it("'In. For bench' is honoured with seven slots open (2026-05-01, Aydın, 401ced4)", () => {
    const state = world({ confirmed: ["kemal", "elvin", "sait", "mustafa", "abid", "idris", "faris"] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "amir",
          body: "In. For bench👍",
          route: "self_att",
          facts: attendanceFacts([claim({ polarity: "bench" })]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "amir")).toBe("BENCH");
    expect(attWrites(r.writes)[0]).toMatchObject({ explicitBench: true });
  });

  it("a CONTINGENT self offer with room CONFIRMS, it never benches (2026-08-31, PR #27)", () => {
    const state = world({
      confirmed: ["kemal", "elvin", "sait", "mustafa", "abid", "idris", "faris", "shaz", "adam", "efat"],
    });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "amir",
          body: "happy to fill in if you're short",
          route: "offer",
          facts: attendanceFacts([
            claim({ contingent: true, conditionOn: "squad", polarity: "in" }),
          ]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "amir")).toBe("CONFIRMED");
    expect(benchCount(r.nextState)).toBe(0);
  });

  it("never proposes a BENCH row while the squad has room unless asked", () => {
    const state = world({ confirmed: ["kemal", "elvin"] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({ from: "zair", route: "self_att", facts: attendanceFacts([claim({ polarity: "in" })]) }),
      ],
    });
    expect(benchCount(r.nextState)).toBe(0);
    expect(statusOf(r.nextState, "zair")).toBe("CONFIRMED");
  });
});

// ── S6 · capacity ──────────────────────────────────────────────────────

describe("S6 · an IN at a full squad still writes something (2026-05-08, Najib, f61a897)", () => {
  it("benches at 14/14 rather than emitting nothing", () => {
    const state = world({ confirmed: [...FULL_14] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({ from: "najib", body: "In", route: "self_att", facts: attendanceFacts([claim({})]) }),
      ],
    });
    expect(statusOf(r.nextState, "najib")).toBe("BENCH");
    expect(confirmedCount(r.nextState)).toBe(14);
    expect(benchCount(r.nextState)).toBe(1);
    // The 2026-05-08 failure was `intent:"in"` with
    // `registerAttendance:null` — a disagreement that cannot be
    // expressed here, because polarity and the write are one thing.
    expect(r.outcomes[0].disposition).toBe("acted");
  });

  it("registration with NO active match degrades loudly rather than silently", () => {
    const state = world({ noMatch: true });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({ from: "najib", body: "In", route: "self_att", facts: attendanceFacts([claim({})]) }),
      ],
    });
    expect(r.writes).toHaveLength(0);
    expect(r.degradations.length).toBeGreaterThan(0);
    expect(r.outcomes[0].disposition).toBe("degraded");
  });
});

// ── S8 · admin demote ──────────────────────────────────────────────────

describe("S8 · admin demote to bench (2026-06-11, Salman Shelly, 9afa357)", () => {
  const state = () =>
    world({
      players: [...FULL_14, "salman", "talha"],
      confirmed: [
        "kemal",
        "sait",
        "mustafa",
        "abid",
        "idris",
        "faris",
        "shaz",
        "adam",
        "efat",
        "usama",
        "karahan",
        "zair",
        "salman",
        "talha",
      ],
    });

  it("benches the NAMED player and never the sender", () => {
    const r = decide({
      now: NOW,
      state: state(),
      messages: [
        msg({
          from: "elvin",
          body: "@Match Time move Salman to bench, keep Talha",
          route: "other_att",
          tagged: true,
          facts: attendanceFacts([
            claim({ subject: "other", personRef: "Salman", personNamed: true, polarity: "bench" }),
            claim({ subject: "other", personRef: "Talha", personNamed: true, polarity: "in" }),
          ]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "salman")).toBe("BENCH");
    expect(statusOf(r.nextState, "talha")).toBe("CONFIRMED");
    // The incident's signature: the demote was read as the SENDER's own
    // `intent:"in"`, so Elvin got registered and Salman did not move.
    expect(statusOf(r.nextState, "elvin")).toBe("ABSENT");
    expect(confirmedCount(r.nextState)).toBe(13);
    expect(benchCount(r.nextState)).toBe(1);
  });

  it("a NON-admin cannot demote someone else even when tagged", () => {
    const r = decide({
      now: NOW,
      state: state(),
      messages: [
        msg({
          from: "zair",
          body: "@Match Time move Salman to bench",
          route: "other_att",
          tagged: true,
          facts: attendanceFacts([
            claim({ subject: "other", personRef: "Salman", personNamed: true, polarity: "bench" }),
          ]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "salman")).toBe("CONFIRMED");
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/admin/i);
  });
});

// ── S9 · promote from bench / self-replace ─────────────────────────────

describe("S9 · promote from bench (2026-06-16, Aydın, c85a23c)", () => {
  const state = () =>
    world({
      players: [...FULL_14, "aydin"],
      confirmed: [...FULL_14],
      bench: ["aydin"],
    });

  it("SELF-REPLACE promotes the named bench player, no hedge, no confirm step", () => {
    const r = decide({
      now: NOW,
      state: state(),
      messages: [
        msg({
          from: "wasim",
          body: "@Match Time I can't make it tonight, Aydin can take my spot",
          route: "other_att",
          tagged: true,
          facts: attendanceFacts([
            claim({ subject: "sender", polarity: "out" }),
            claim({ subject: "other", personRef: "Aydin", personNamed: true, polarity: "in" }),
          ]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "wasim")).toBe("DROPPED");
    expect(statusOf(r.nextState, "aydin")).toBe("CONFIRMED");
    expect(confirmedCount(r.nextState)).toBe(14);
    const promote = attWrites(r.writes).find((w) => w.kind === "attendance" && w.userId === "u-aydin");
    expect(promote).toMatchObject({ promote: true });
  });

  it("an UNRELATED non-admin cannot promote a bench player over someone else's slot", () => {
    const r = decide({
      now: NOW,
      state: state(),
      messages: [
        msg({
          from: "zair",
          body: "@Match Time replace Wasim with Aydin",
          route: "other_att",
          tagged: true,
          facts: attendanceFacts([
            claim({ subject: "other", personRef: "Wasim", personNamed: true, polarity: "out" }),
            claim({ subject: "other", personRef: "Aydin", personNamed: true, polarity: "in" }),
          ]),
        }),
      ],
    });
    // Zair is neither an admin nor the player being dropped, so the
    // privileged promotion is refused: Wasim's drop stands (a tagged
    // third-party drop is allowed by the contract) but Aydın is NOT
    // pulled off the bench on an unrelated member's say-so.
    // promote-authorization.ts owns this distinction.
    expect(statusOf(r.nextState, "wasim")).toBe("DROPPED");
    expect(statusOf(r.nextState, "aydin")).toBe("BENCH");
    expect(attWrites(r.writes).some((w) => w.kind === "attendance" && w.promote)).toBe(false);
  });

  it("an ADMIN may promote (roster surgery)", () => {
    const r = decide({
      now: NOW,
      state: state(),
      messages: [
        msg({
          from: "elvin",
          body: "@Match Time replace Wasim with Aydin",
          route: "other_att",
          tagged: true,
          facts: attendanceFacts([
            claim({ subject: "other", personRef: "Wasim", personNamed: true, polarity: "out" }),
            claim({ subject: "other", personRef: "Aydin", personNamed: true, polarity: "in" }),
          ]),
        }),
      ],
    });
    const aydin = attWrites(r.writes).find((w) => w.kind === "attendance" && w.userId === "u-aydin");
    expect(aydin).toMatchObject({ promote: true });
  });
});

// ── S11 / S12 · contingency ────────────────────────────────────────────

describe("S11 · the conditional drop HOLDS (2026-06-09, Erdal, b726f63)", () => {
  it("'if u can make happy to drop' leaves the player in the squad", () => {
    const state = world({ confirmed: [...FULL_14.slice(0, 13), "erdal"] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "erdal",
          body: "If u can make happy to drop",
          route: "offer",
          facts: attendanceFacts([
            claim({ polarity: "out", contingent: true, conditionOn: "squad" }),
          ]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "erdal")).toBe("CONFIRMED");
    expect(attWrites(r.writes)).toHaveLength(0);
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/conting/i);
  });

  it("holds on 'happy to drop WHEN you find someone' too — no literal `if` required", () => {
    // route.ts:3095's looksLikeConditionalDrop requires the word "if",
    // so this phrasing bypassed the hold entirely. `contingent` is a
    // field now, so the wording cannot matter.
    const state = world({ confirmed: [...FULL_14.slice(0, 13), "erdal"] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "erdal",
          body: "happy to drop when you find someone",
          route: "offer",
          facts: attendanceFacts([
            claim({ polarity: "out", contingent: true, conditionOn: "squad" }),
          ]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "erdal")).toBe("CONFIRMED");
  });
});

describe("S12 · a replacement request drops the SENDER too (2026-05-26, Mojib, f35dfe6)", () => {
  it("'anyone able to replace me and habibi?' drops both", () => {
    const state = world({
      confirmed: [
        "kemal",
        "elvin",
        "sait",
        "mustafa",
        "abid",
        "idris",
        "faris",
        "shaz",
        "adam",
        "efat",
        "usama",
        "mojib",
        "habib",
        "zair",
      ],
    });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "mojib",
          body: "@Match Time is anyone able to replace me and habibi tonight?",
          route: "other_att",
          tagged: true,
          facts: attendanceFacts(
            [
              claim({ subject: "sender", polarity: "out" }),
              claim({ subject: "other", personRef: "habibi", personNamed: true, polarity: "out" }),
            ],
            { sideRequests: ["recruit"] },
          ),
        }),
      ],
    });
    expect(statusOf(r.nextState, "mojib")).toBe("DROPPED");
    expect(statusOf(r.nextState, "habib")).toBe("DROPPED");
    expect(confirmedCount(r.nextState)).toBe(12);
  });

  it("carries the recruit request ALONGSIDE the drops, losing neither", () => {
    // Today's incident (fix/fast-path-swallows-multi-intent): a regex
    // fast path claimed a two-intent message and threw half away.
    const state = world({ confirmed: [...FULL_14], bench: ["najib"] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "wasim",
          body: "@Match Time I'm out, anyone able to replace me?",
          route: "self_att",
          tagged: true,
          facts: attendanceFacts([claim({ polarity: "out" })], { sideRequests: ["recruit"] }),
        }),
      ],
    });
    expect(statusOf(r.nextState, "wasim")).toBe("DROPPED");
    expect(r.writes.some((w) => w.kind === "open_bench_offer")).toBe(true);
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/recruit/i);
  });
});

// ── S12b · the chase nudge ─────────────────────────────────────────────

describe("S12b · a chase nudge is not a drop (2026-05-28, Kemal, 1daf7db)", () => {
  it("'@all we need more players pls' never drops the person asking", () => {
    const state = world({
      confirmed: ["kemal", "elvin", "sait", "mustafa", "abid", "idris", "faris", "shaz", "adam", "efat"],
    });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "kemal",
          body: "@all we need more players pls",
          route: "other_att",
          facts: attendanceFacts([], { sideRequests: ["chase"] }),
        }),
      ],
    });
    expect(statusOf(r.nextState, "kemal")).toBe("CONFIRMED");
    expect(attWrites(r.writes)).toHaveLength(0);
  });
});

// ── S13 · bench slot offers ────────────────────────────────────────────

describe("S13 · bench-slot claims (2026-05-19, Karahan, first-come)", () => {
  const offerState = () =>
    world({
      confirmed: [
        "kemal",
        "elvin",
        "sait",
        "mustafa",
        "abid",
        "idris",
        "faris",
        "shaz",
        "adam",
        "efat",
        "usama",
        "najib",
        "zair",
      ],
      bench: ["karahan", "enayem"],
      dropped: ["wasim"],
      openOffers: [
        { id: "offer-1", replacingUserId: "u-wasim", offeredToUserIds: ["u-karahan", "u-enayem"] },
      ],
    });

  it("a listed bench player's own claim takes the slot", () => {
    const r = decide({
      now: NOW,
      state: offerState(),
      messages: [
        msg({
          from: "karahan",
          body: "I'll take it",
          route: "self_att",
          facts: attendanceFacts([claim({ polarity: "in" })]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "karahan")).toBe("CONFIRMED");
    expect(statusOf(r.nextState, "enayem")).toBe("BENCH");
    expect(r.writes.some((w) => w.kind === "resolve_bench_offer")).toBe(true);
    expect(r.nextState.openOffers).toHaveLength(0);
  });

  it("a third party nominating a bencher does NOT claim the slot; the offer stays open", () => {
    const r = decide({
      now: NOW,
      state: offerState(),
      messages: [
        msg({
          from: "adam",
          body: "@Match Time give the spot to Karahan",
          route: "other_att",
          tagged: true,
          facts: attendanceFacts([
            claim({ subject: "other", personRef: "Karahan", personNamed: true, polarity: "in" }),
          ]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "karahan")).toBe("BENCH");
    expect(statusOf(r.nextState, "enayem")).toBe("BENCH");
    expect(r.nextState.openOffers).toHaveLength(1);
  });

  it("NOBODY on the bench is ever dropped by an offer (Karahan, marked DROPPED in his sleep)", () => {
    const state = world({ confirmed: [...FULL_14], bench: ["karahan", "enayem"] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "wasim",
          body: "out, can't make it tonight",
          route: "self_att",
          facts: attendanceFacts([claim({ polarity: "out" })]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "karahan")).toBe("BENCH");
    expect(statusOf(r.nextState, "enayem")).toBe("BENCH");
    expect(statusOf(r.nextState, "wasim")).toBe("DROPPED");
    expect(benchCount(r.nextState)).toBe(2);
    expect(r.writes.some((w) => w.kind === "open_bench_offer")).toBe(true);
  });
});

// ── S15 · the standing offer / personal uncertainty split ──────────────

describe("S15 · conditionOn decides the opposite outcomes (2026-05-15, Erdal, a9e42e5)", () => {
  it("(a) conditional on the SQUAD registers the sender", () => {
    const state = world({ confirmed: FULL_14.slice(0, 13) });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "erdal",
          body: "consider me as the 14th whenever you have 13 players",
          route: "offer",
          facts: attendanceFacts([
            claim({ polarity: "in", contingent: true, conditionOn: "squad" }),
          ]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "erdal")).toBe("CONFIRMED");
    expect(confirmedCount(r.nextState)).toBe(14);
    expect(benchCount(r.nextState)).toBe(0);
  });

  it("(b) conditional on the SELF writes nothing", () => {
    const state = world({ confirmed: ["kemal", "elvin", "sait", "mustafa", "abid", "idris"] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "usama",
          body: "in if my back holds up",
          route: "offer",
          facts: attendanceFacts([claim({ polarity: "in", contingent: true, conditionOn: "self" })]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "usama")).toBe("ABSENT");
    expect(attWrites(r.writes)).toHaveLength(0);
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/tentative|personal/i);
  });
});

// ── A5 / S20 · the subject check and the ghost user ────────────────────

describe("A5 · 'my brother can play if needed' (2026-08-30, Amir)", () => {
  const state = () =>
    world({ confirmed: ["kemal", "elvin", "sait", "mustafa", "abid", "idris", "faris"] });

  it("benches nobody and provisions no ghost user", () => {
    const r = decide({
      now: NOW,
      state: state(),
      messages: [
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
      ],
    });
    expect(attWrites(r.writes)).toHaveLength(0);
    expect(statusOf(r.nextState, "amir")).toBe("ABSENT");
    expect(r.speech.some((s) => s.kind === "guest_name_ask")).toBe(true);
    expect(r.outcomes[0].react).toBeNull();
  });

  it("code says a relationship is not a name even if the model forgets", () => {
    // Belt and braces: personNamed:true but the ref is "Amir's brother".
    // §11.3 schema drift — the engine treats every field as untrusted.
    const r = decide({
      now: NOW,
      state: state(),
      messages: [
        msg({
          from: "amir",
          body: "my brother can play",
          route: "other_att",
          facts: attendanceFacts([
            claim({
              subject: "other",
              personRef: "Amir's brother",
              personNamed: true,
              polarity: "in",
            }),
          ]),
        }),
      ],
    });
    expect(attWrites(r.writes)).toHaveLength(0);
    expect(r.nextState.roster.map((m) => m.name)).not.toContain("Amir's brother");
  });

  it("a NAMED guest still registers — 'my brother Shahrokh can play'", () => {
    const r = decide({
      now: NOW,
      state: state(),
      messages: [
        msg({
          from: "amir",
          body: "my brother Shahrokh can play",
          route: "other_att",
          facts: attendanceFacts([
            claim({
              subject: "other",
              personRef: "Shahrokh",
              personNamed: true,
              polarity: "in",
            }),
          ]),
        }),
      ],
    });
    const w = attWrites(r.writes);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ name: "Shahrokh", status: "CONFIRMED" });
  });
});

describe("PR#29 · a message carrying TWO facts loses neither", () => {
  it("'I'm in, and my brother can play too' keeps the sender's IN", () => {
    const state = world({
      confirmed: ["kemal", "elvin", "sait", "mustafa", "abid", "idris", "faris"],
    });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "zair",
          body: "I'm in, and my brother can play too",
          route: "self_att",
          facts: attendanceFacts([
            claim({ subject: "sender", polarity: "in" }),
            claim({
              subject: "other",
              personRef: "my brother",
              personNamed: false,
              polarity: "in",
            }),
          ]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "zair")).toBe("CONFIRMED");
    expect(r.speech.some((s) => s.kind === "guest_name_ask")).toBe(true);
  });

  it("'I can't make it but my mate can play' still drops the sender", () => {
    const state = world({
      confirmed: ["kemal", "elvin", "sait", "mustafa", "abid", "idris", "faris", "shaz"],
    });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "shaz",
          body: "I can't make it tonight but my mate can play",
          route: "self_att",
          facts: attendanceFacts([
            claim({ subject: "sender", polarity: "out" }),
            claim({ subject: "other", personRef: "my mate", personNamed: false, polarity: "in" }),
          ]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "shaz")).toBe("DROPPED");
    expect(confirmedCount(r.nextState)).toBe(7);
  });
});

// ── S24 / S25 · claims about state, and short confirmations ────────────

describe("S24 · fact-check a stated count (2026-04-24, f71b6ad)", () => {
  it("answers with the DB's number, not the asserted one", () => {
    const state = world({
      confirmed: ["kemal", "elvin", "sait", "mustafa", "abid", "idris", "faris", "shaz", "adam", "efat", "usama"],
    });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "amir",
          body: "@Match Time we're 9/14 right?",
          route: "question",
          tagged: true,
          facts: { kind: "question", topic: "count", personRef: null, statedCount: 9 },
        }),
      ],
    });
    expect(r.speech.some((s) => s.kind === "answer_count")).toBe(true);
    expect(attWrites(r.writes)).toHaveLength(0);
  });
});

describe("S25 · a bare 'Confirmed' resolves against the bot's own last post (7453daa)", () => {
  it("registers exactly the names MatchTime listed as pending", () => {
    const state = world({
      confirmed: ["kemal", "elvin", "sait", "mustafa", "abid", "idris"],
      lastBotPost:
        "Got it 🙌 Pending — waiting for confirmation: Faris Nasser, Shaz Iqbal. Say the word and I'll lock them in.",
    });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "amir",
          body: "Confirmed",
          route: "other_att",
          facts: attendanceFacts([], { affirmation: "yes" }),
        }),
      ],
    });
    expect(statusOf(r.nextState, "faris")).toBe("CONFIRMED");
    expect(statusOf(r.nextState, "shaz")).toBe("CONFIRMED");
    expect(statusOf(r.nextState, "amir")).toBe("ABSENT");
  });

  it("a bare 'Confirmed' with NO pending list writes nothing", () => {
    const state = world({ confirmed: ["kemal"], lastBotPost: "Squad is 1/14, need 13 more 🙏" });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({ from: "amir", body: "Confirmed", route: "other_att", facts: attendanceFacts([], { affirmation: "yes" }) }),
      ],
    });
    expect(r.writes).toHaveLength(0);
  });
});

// ── S29 · the banter-drop guard (SURVIVES, §9) ─────────────────────────

describe("S29 · the banter-drop guard survives (2026-06-12, Zeeshan, ed0a50b)", () => {
  it("refuses a joke drop the target contradicts in the same window", () => {
    const state = world({
      confirmed: ["kemal", "elvin", "sait", "mustafa", "abid", "idris", "faris", "shaz", "adam", "efat", "usama", "zeeshan"],
    });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "ayoub",
          body: "Zeeshan is out 😂😂 vote him out lads",
          route: "other_att",
          tagged: true,
          facts: attendanceFacts([
            claim({ subject: "other", personRef: "Zeeshan", personNamed: true, polarity: "out" }),
          ]),
        }),
        msg({
          from: "zeeshan",
          body: "what?? I'm in lads 😂",
          route: "self_att",
          facts: attendanceFacts([claim({ polarity: "in" })]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "zeeshan")).toBe("CONFIRMED");
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/contradict|corrobor/i);
  });

  it("the same drop from an ADMIN, uncontested, is honoured", () => {
    const state = world({
      confirmed: ["kemal", "elvin", "sait", "mustafa", "abid", "idris", "faris", "shaz", "adam", "efat", "usama", "zeeshan"],
    });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "elvin",
          body: "@Match Time Zeeshan is out tonight, take him off",
          route: "other_att",
          tagged: true,
          facts: attendanceFacts([
            claim({ subject: "other", personRef: "Zeeshan", personNamed: true, polarity: "out" }),
          ]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "zeeshan")).toBe("DROPPED");
    expect(confirmedCount(r.nextState)).toBe(11);
  });
});

// ── S35 / S36 · batch collapse ─────────────────────────────────────────

describe("S35 · only an author's LATEST message writes", () => {
  it("'in' then 'no sorry, out' leaves the player OUT", () => {
    const state = world({ confirmed: ["kemal", "elvin", "sait", "mustafa", "usama"] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({ from: "usama", body: "actually I'm in", route: "self_att", facts: attendanceFacts([claim({})]) }),
        msg({
          from: "usama",
          body: "no sorry, out — work thing",
          route: "self_att",
          facts: attendanceFacts([claim({ polarity: "out" })]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "usama")).toBe("DROPPED");
    expect(confirmedCount(r.nextState)).toBe(4);
    // The superseded message still gets an outcome — never dropped.
    expect(r.outcomes).toHaveLength(2);
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/supersed/i);
  });
});

describe("S36 · one authoritative squad post per batch", () => {
  it("three squad-state messages produce exactly one squad_status", () => {
    const state = world({
      confirmed: ["kemal", "elvin", "sait", "mustafa", "abid", "idris", "faris", "shaz", "adam", "efat"],
    });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({ from: "usama", body: "in", route: "self_att", facts: attendanceFacts([claim({})]) }),
        msg({ from: "karahan", body: "in", route: "self_att", facts: attendanceFacts([claim({})]) }),
        msg({
          from: "zair",
          body: "@Match Time how many are we now?",
          route: "question",
          tagged: true,
          facts: { kind: "question", topic: "count", personRef: null, statedCount: null },
        }),
      ],
    });
    expect(confirmedCount(r.nextState)).toBe(12);
    expect(r.speech.filter((s) => s.kind === "squad_status")).toHaveLength(1);
    // The count question is answered BY that post, not by a second one.
    expect(r.speech.filter((s) => s.kind === "answer_count")).toHaveLength(0);
  });
});

// ── S37 · the confidence floor ─────────────────────────────────────────

describe("S37 · the confidence floor is per fact, not per verdict", () => {
  it("drops a low-confidence claim and keeps a confident one in the same message", () => {
    const state = world({ confirmed: ["kemal"], players: [...FULL_14, "rashad"] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "zair",
          body: "I'm in, maybe Rashad too?",
          route: "other_att",
          facts: attendanceFacts([
            claim({ subject: "sender", polarity: "in", confidence: 0.95 }),
            claim({
              subject: "other",
              personRef: "Rashad",
              personNamed: true,
              polarity: "in",
              confidence: 0.4,
            }),
          ]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "zair")).toBe("CONFIRMED");
    expect(statusOf(r.nextState, "rashad")).toBe("ABSENT");
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/confidence/i);
  });
});

// ── Identity ───────────────────────────────────────────────────────────

describe("identity resolution (SURVIVES §9 — never about the model)", () => {
  it("resolves a first name and a near-miss ('habibi' → Habib Rahman)", () => {
    const state = world({ confirmed: [...FULL_14.slice(0, 13), "habib"] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "elvin",
          body: "@Match Time habibi is out",
          route: "other_att",
          tagged: true,
          facts: attendanceFacts([
            claim({ subject: "other", personRef: "habibi", personNamed: true, polarity: "out" }),
          ]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "habib")).toBe("DROPPED");
  });

  it("bails on an AMBIGUOUS first name rather than guessing", () => {
    const state = world({
      players: ["kemal", "elvin", "sait"],
      confirmed: ["kemal", "elvin", "sait"],
    });
    // Two members whose first names both start with "Sa".
    state.roster.push({ userId: "u-sami", name: "Sait Yilmaz", isAdmin: false, hasPhone: true });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "elvin",
          body: "@Match Time Sait is out",
          route: "other_att",
          tagged: true,
          facts: attendanceFacts([
            claim({ subject: "other", personRef: "Sait", personNamed: true, polarity: "out" }),
          ]),
        }),
      ],
    });
    expect(r.writes).toHaveLength(0);
    expect(r.degradations.some((d) => /ambiguous/i.test(d.detail))).toBe(true);
  });

  it("never registers a raw @lid digit string as a person", () => {
    const state = world({ confirmed: ["kemal", "elvin"] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "kemal",
          body: "@158055467598020 @140432612827333 is replacing @189206211076115",
          route: "other_att",
          tagged: true,
          facts: attendanceFacts([
            claim({
              subject: "other",
              personRef: "140432612827333",
              personNamed: true,
              polarity: "in",
            }),
            claim({
              subject: "other",
              personRef: "189206211076115",
              personNamed: true,
              polarity: "out",
            }),
          ]),
        }),
      ],
    });
    expect(r.writes).toHaveLength(0);
    expect(r.nextState.roster.some((m) => /^\d+$/.test(m.name))).toBe(false);
    expect(r.degradations.length).toBeGreaterThan(0);
  });

  it("an OUT for someone with no attendance row is a no-op, not a failure", () => {
    const state = world({ confirmed: ["kemal", "elvin"] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "zair",
          body: "out",
          route: "self_att",
          facts: attendanceFacts([claim({ polarity: "out" })]),
        }),
      ],
    });
    expect(attWrites(r.writes)).toHaveLength(0);
    expect(r.outcomes[0].disposition).toBe("noop");
    expect(r.degradations).toHaveLength(0);
  });
});

// ── Tenancy and authorisation (SURVIVE §9) ─────────────────────────────

describe("tenancy · attendance can be switched off per org", () => {
  it("writes nothing at all when the org does not track attendance", () => {
    const state = world({ confirmed: ["kemal"], features: { attendance: false } });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({ from: "zair", body: "in", route: "self_att", facts: attendanceFacts([claim({})]) }),
      ],
    });
    expect(r.writes).toHaveLength(0);
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/attendance/i);
  });
});

describe("S21 · bulk payment credit is admin-only", () => {
  const base = () =>
    world({
      confirmed: ["kemal", "elvin", "sait", "amir"],
      features: { paymentTracking: true },
      completedMatch: {
        id: "done-1",
        redScore: null,
        yellowScore: null,
        participantUserIds: ["u-kemal", "u-elvin", "u-sait", "u-amir"],
      },
    });

  it("an ADMIN's credit is proposed and changes no attendance", () => {
    const r = decide({
      now: NOW,
      state: base(),
      messages: [
        msg({
          from: "elvin",
          body: "@Match Time Amir paid for 4 players",
          route: "admin_ops",
          tagged: true,
          facts: { kind: "admin", action: "bulk_payment", payerRef: "Amir", count: 4 },
        }),
      ],
    });
    expect(r.writes.some((w) => w.kind === "payment_credit")).toBe(true);
    expect(attWrites(r.writes)).toHaveLength(0);
  });

  it("a random member's credit is refused (the chase math must not be corruptible)", () => {
    const r = decide({
      now: NOW,
      state: base(),
      messages: [
        msg({
          from: "zair",
          body: "@Match Time Amir paid for 4 players",
          route: "admin_ops",
          tagged: true,
          facts: { kind: "admin", action: "bulk_payment", payerRef: "Amir", count: 4 },
        }),
      ],
    });
    expect(r.writes).toHaveLength(0);
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/admin/i);
  });
});

describe("S17 · score", () => {
  it("records a final result on the completed match", () => {
    const state = world({
      confirmed: ["kemal", "elvin"],
      completedMatch: {
        id: "done-1",
        redScore: null,
        yellowScore: null,
        participantUserIds: ["u-kemal", "u-elvin"],
      },
    });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "kemal",
          body: "Red won 5-3",
          route: "score",
          facts: { kind: "score", first: 5, second: 3 },
        }),
      ],
    });
    expect(r.writes.find((w) => w.kind === "score")).toMatchObject({ red: 5, yellow: 3 });
  });

  it("refuses a score from someone who did not play and is not an admin", () => {
    const state = world({
      confirmed: ["kemal"],
      completedMatch: {
        id: "done-1",
        redScore: null,
        yellowScore: null,
        participantUserIds: ["u-kemal"],
      },
    });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "zair",
          body: "we won 9-0",
          route: "score",
          facts: { kind: "score", first: 9, second: 0 },
        }),
      ],
    });
    expect(r.writes).toHaveLength(0);
  });
});

// ── S19 · show vs generate ─────────────────────────────────────────────

describe("S19 · 'show the teams again' never re-runs the balancer (2026-06-18, c408649)", () => {
  it("proposes no team writes", () => {
    const state = world({
      players: ["kemal", "elvin", "sait", "mustafa", "zeeshan", "nabeel"],
      confirmed: ["kemal", "elvin", "sait", "mustafa", "zeeshan", "nabeel"],
      maxPlayers: 6,
      teams: { kemal: "RED", elvin: "RED", zeeshan: "RED", sait: "YELLOW", mustafa: "YELLOW", nabeel: "YELLOW" },
    });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "elvin",
          body: "@Match Time show the teams again",
          route: "balancer",
          tagged: true,
          facts: { kind: "teams", action: "show", includeRefs: [], teamNames: null, swaps: [] },
        }),
      ],
    });
    expect(r.writes).toHaveLength(0);
    expect(r.nextState.teams).toEqual(state.teams);
    expect(r.speech.some((s) => s.kind === "teams_post")).toBe(true);
  });
});

// ── Degrade loudly ─────────────────────────────────────────────────────

describe("degrade loudly (never a silent no-op)", () => {
  it("a message flagged degraded upstream surfaces, it does not vanish", () => {
    const state = world({ confirmed: ["kemal"] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "zair",
          body: "in",
          route: "unsure",
          facts: { kind: "none" },
          degraded: "extractor returned invalid JSON",
        }),
      ],
    });
    expect(r.outcomes[0].disposition).toBe("degraded");
    expect(r.degradations).toHaveLength(1);
    expect(r.degradations[0].detail).toMatch(/invalid JSON/);
  });

  it("an `unsure` route with attendance-shaped facts is treated as attendance, not dropped", () => {
    const state = world({ confirmed: ["kemal"] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({ from: "zair", body: "in", route: "unsure", facts: attendanceFacts([claim({})]) }),
      ],
    });
    expect(statusOf(r.nextState, "zair")).toBe("CONFIRMED");
  });

  it("a `none` route carrying claims is a two-stage disagreement and is logged (§11.2)", () => {
    const state = world({ confirmed: ["kemal"] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({ from: "zair", body: "in", route: "none", facts: attendanceFacts([claim({})]) }),
      ],
    });
    expect(r.writes).toHaveLength(0);
    expect(r.degradations.some((d) => /disagree/i.test(d.detail))).toBe(true);
  });
});

// ── Found by the first live corpus sweep (2026-09-01) ──────────────────
//
// Everything below was a real failure on the 46-case corpus, triaged
// from the pipeline's own routes+facts+reasons trail and fixed in the
// ENGINE rather than in a prompt. That is the loop the redesign is for:
// §6.1's "fixing a rule in a 360-token router with a 40-case eval set
// takes ten minutes and produces a number", applied to the engine too.

describe("S28 · a replacement frees the slot BEFORE it fills it", () => {
  it("'X is replacing Y' at a full squad confirms X and drops Y", () => {
    // Live corpus, first sweep: Izzet was processed first against a
    // 14/14 squad, landed on the BENCH, and Elnur's drop then left the
    // squad at 13 with a bench. Claim ORDER inside one message is a
    // decision, so the engine owns it: OUT before IN, always.
    const state = world({
      players: [...FULL_14, "izzet", "elnur"],
      confirmed: [...FULL_14.slice(0, 13), "elnur"],
    });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "kemal",
          body: "@Match Time @Izzet Erdogan is replacing @Elnur Mammadov",
          route: "other_att",
          tagged: true,
          facts: attendanceFacts([
            claim({ subject: "other", personRef: "Izzet Erdogan", personNamed: true, polarity: "in" }),
            claim({ subject: "other", personRef: "Elnur Mammadov", personNamed: true, polarity: "out" }),
          ]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "elnur")).toBe("DROPPED");
    expect(statusOf(r.nextState, "izzet")).toBe("CONFIRMED");
    expect(confirmedCount(r.nextState)).toBe(14);
    expect(benchCount(r.nextState)).toBe(0);
  });
});

describe("S12 · the roster decides whether a reference names someone", () => {
  it("honours a nickname the model reported as personNamed:false", () => {
    // Live corpus: the extractor called "habibi" an endearment rather
    // than a name (3/3), so the engine's unnamed-third-party rule
    // blocked a drop the message plainly makes. `personNamed` is the
    // model's reading of the TEXT; whether a reference identifies a
    // SQUAD MEMBER is the roster's business, and only code has the
    // roster. Placeholder words still lose: identity.ts refuses them
    // before this can fire.
    const state = world({
      confirmed: [...FULL_14.slice(0, 12), "mojib", "habib"],
    });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "mojib",
          body: "@Match Time is anyone able to replace me and habibi tonight?",
          route: "other_att",
          tagged: true,
          facts: attendanceFacts(
            [
              claim({ subject: "sender", polarity: "out" }),
              claim({
                subject: "other",
                personRef: "habibi",
                personNamed: false,
                polarity: "out",
              }),
            ],
            { sideRequests: ["recruit"] },
          ),
        }),
      ],
    });
    expect(statusOf(r.nextState, "mojib")).toBe("DROPPED");
    expect(statusOf(r.nextState, "habib")).toBe("DROPPED");
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/resolves to a squad member/i);
  });

  it("still refuses a relationship, however confident the model is", () => {
    const state = world({ confirmed: FULL_14.slice(0, 7) });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "amir",
          body: "my brother can play",
          route: "other_att",
          facts: attendanceFacts([
            claim({
              subject: "other",
              personRef: "my brother",
              personNamed: true,
              polarity: "in",
              confidence: 1,
            }),
          ]),
        }),
      ],
    });
    expect(r.writes.filter((w) => w.kind === "attendance")).toHaveLength(0);
  });
});

describe("S25 · a resolved confirmation is answered even when nothing changed", () => {
  it("acknowledges names that were already down", () => {
    // Live corpus: "Confirmed" resolved the pending set correctly, both
    // names were ALREADY confirmed, so every write was idempotent and
    // the bot said nothing at all. "Message understood, action silently
    // not taken" is this product's signature failure (§9), and it
    // applies just as much to an action that was already true.
    const state = world({
      confirmed: ["kemal", "elvin", "sait", "mustafa", "abid", "idris", "faris", "shaz"],
      lastBotPost:
        "Got it 🙌 Pending — waiting for confirmation: Faris Nasser, Shaz Iqbal. Say the word and I'll lock them in.",
    });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "amir",
          body: "Confirmed",
          route: "other_att",
          facts: attendanceFacts([], { affirmation: "yes" }),
        }),
      ],
    });
    expect(r.writes).toHaveLength(0);
    expect(r.speech.some((s) => s.kind === "pending_confirmed_ack")).toBe(true);
  });
});

describe("S13 · an offer is claimed by someone it was offered to, and only then", () => {
  it("an unrelated player's IN does not resolve an open offer", () => {
    // The offer's audience is the bench AT THE TIME IT OPENED. Anyone
    // else saying IN is an ordinary registration; it must not consume
    // the slot the bench is being asked to step into, or the first
    // bencher to answer finds the offer already gone.
    const state = world({
      confirmed: [
        "kemal",
        "elvin",
        "sait",
        "mustafa",
        "abid",
        "idris",
        "faris",
        "shaz",
        "adam",
        "efat",
        "usama",
        "najib",
        "zair",
      ],
      bench: ["karahan"],
      dropped: ["wasim"],
      openOffers: [
        { id: "offer-1", replacingUserId: "u-wasim", offeredToUserIds: ["u-karahan"] },
      ],
    });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({ from: "amir", body: "in", route: "self_att", facts: attendanceFacts([claim({})]) }),
      ],
    });
    expect(statusOf(r.nextState, "amir")).toBe("CONFIRMED");
    expect(r.nextState.openOffers).toHaveLength(1);
    expect(r.writes.some((w) => w.kind === "resolve_bench_offer")).toBe(false);
  });

  it("an offer whose audience list is EMPTY is offered to nobody, not to everyone", () => {
    // An offer can outlive its bench (everyone on it gets confirmed).
    // An empty audience must fail closed: the alternative is that the
    // next person to say IN silently consumes an offer that was never
    // theirs.
    const state = world({
      confirmed: ["kemal", "elvin", "sait"],
      dropped: ["wasim"],
      openOffers: [{ id: "offer-1", replacingUserId: "u-wasim", offeredToUserIds: [] }],
    });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({ from: "amir", body: "in", route: "self_att", facts: attendanceFacts([claim({})]) }),
      ],
    });
    expect(statusOf(r.nextState, "amir")).toBe("CONFIRMED");
    expect(r.nextState.openOffers).toHaveLength(1);
  });

  it("a CONFIRMED player cannot claim an offer they were never on the bench for", () => {
    const state = world({
      confirmed: ["kemal", "elvin", "sait", "karahan"],
      dropped: ["wasim"],
      openOffers: [
        { id: "offer-1", replacingUserId: "u-wasim", offeredToUserIds: ["u-karahan"] },
      ],
    });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "karahan",
          body: "in",
          route: "self_att",
          facts: attendanceFacts([claim({})]),
        }),
      ],
    });
    // Idempotent: already confirmed, nothing to do, offer untouched.
    expect(r.writes).toHaveLength(0);
    expect(r.nextState.openOffers).toHaveLength(1);
  });
});
