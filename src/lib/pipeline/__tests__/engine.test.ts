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
  SUTTON,
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

// ── S36b · the roster post is DEMAND-driven ────────────────────────────

describe("S36b · a routine attendance change gets the react and nothing else (2026-09-09)", () => {
  // Kemal, on the live Sutton FC group: "for every IN, MT is responding
  // with the squad. I think that is overmessaging. Only a tick is enough
  // to confirm the attendance is taken and a 5pm update about the squad
  // is what we agreed."
  //
  // The batch-level roster post used to ride on `squadChanged`, so ANY
  // batch that moved a row posted the whole fourteen-line squad. Three
  // INs across two batches on the morning of 2026-09-09 produced two
  // full roster posts on top of the ✅ each message already gets.
  const SQUAD_Q = {
    kind: "question",
    topic: "squad",
    personRef: null,
    statedCount: null,
  } as const;
  const COUNT_Q = {
    kind: "question",
    topic: "count",
    personRef: null,
    statedCount: null,
  } as const;

  it("one IN on a short squad: a ✅ and NO roster post", () => {
    const state = world({ confirmed: ["kemal", "elvin", "sait"] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({ from: "usama", body: "in", route: "self_att", facts: attendanceFacts([claim({})]) }),
      ],
    });
    expect(statusOf(r.nextState, "usama")).toBe("CONFIRMED");
    // The react IS the acknowledgement. §9's failure to avoid is
    // "message understood, action silently not taken", and a tick is not
    // silence — see `whatsapp-bot/src/react-fallback.ts` for what happens
    // when the WhatsApp layer cannot place one.
    expect(r.outcomes[0].react).toBe("✅");
    expect(r.speech).toHaveLength(0);
  });

  it("three INs in one batch: three ✅, still no roster post", () => {
    const state = world({ confirmed: ["kemal", "elvin", "sait"] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({ from: "usama", body: "in", route: "self_att", facts: attendanceFacts([claim({})]) }),
        msg({ from: "karahan", body: "in", route: "self_att", facts: attendanceFacts([claim({})]) }),
        msg({ from: "zair", body: "im in", route: "self_att", facts: attendanceFacts([claim({})]) }),
      ],
    });
    expect(confirmedCount(r.nextState)).toBe(6);
    expect(r.outcomes.map((o) => o.react)).toEqual(["✅", "✅", "✅"]);
    expect(r.speech.filter((s) => s.kind === "squad_status")).toHaveLength(0);
  });

  it("the IN that FILLS the squad posts nothing either — `squad-announce.ts` owns that", () => {
    // `registerAttendance` calls `announceSquadFullIfJustFilled` on every
    // confirm (`attendance.ts:380`), which posts "✅ *Squad complete —
    // 14/14*" with the full line-up, deduped on `<matchId>:squad-locked`
    // and re-armed on a confirmed drop. An engine post here would be a
    // SECOND roster one line away from it.
    const state = world({ confirmed: FULL_14.slice(0, 13) });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({ from: "habib", body: "in", route: "self_att", facts: attendanceFacts([claim({})]) }),
      ],
    });
    expect(confirmedCount(r.nextState)).toBe(14);
    expect(r.outcomes[0].react).toBe("✅");
    expect(r.speech.filter((s) => s.kind === "squad_status")).toHaveLength(0);
  });

  it("a drop from a full squad speaks the BENCH OFFER, not the roster", () => {
    const state = world({ confirmed: [...FULL_14], bench: ["habib"] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "zair",
          body: "sorry lads, can't make it",
          route: "self_att",
          facts: attendanceFacts([claim({ polarity: "out" })]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "zair")).toBe("DROPPED");
    expect(r.speech.map((s) => s.kind)).toEqual(["bench_offer_open"]);
  });

  it("\"who's in?\" is still answered with the roster", () => {
    const state = world({ confirmed: ["kemal", "elvin", "sait"] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "adam",
          body: "@Match Time who's in?",
          route: "question",
          tagged: true,
          facts: SQUAD_Q,
        }),
      ],
    });
    expect(r.speech.map((s) => s.kind)).toEqual(["answer_squad"]);
  });

  it("a count question in the SAME batch as an IN is still answered", () => {
    // The subtle half. `deferredSquadQuestions` rode on `squadChanged`:
    // the question was answered BY the roster post. Take the post away
    // unconditionally and the question gets nothing at all — §9's
    // signature failure, arrived at from the other direction.
    const state = world({ confirmed: ["kemal", "elvin", "sait"] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({ from: "usama", body: "in", route: "self_att", facts: attendanceFacts([claim({})]) }),
        msg({
          from: "zair",
          body: "@Match Time how many are we now?",
          route: "question",
          tagged: true,
          facts: COUNT_Q,
        }),
      ],
    });
    // Answered ONCE, by the single authoritative post (S36) — not by a
    // second, separately-composed sentence beside it.
    expect(r.speech.filter((s) => s.kind === "squad_status")).toHaveLength(1);
    expect(r.speech.filter((s) => s.kind === "answer_count")).toHaveLength(0);
  });

  it("an admin BENCHING somebody else DOES post the roster — that player has no react", () => {
    // The other survivor. `reactFor(status, self)` gives the sender a
    // plain 👍 when the row that moved was not theirs, so a 🪑 never
    // reaches Pete's side of the conversation: the 👍 tells the admin it
    // is done and tells Pete nothing. `queueSlotEmojiRefresh` retro-
    // reacts his last IN, which is real but is one transition, is
    // asynchronous, and rides the reaction layer that placed nothing at
    // all for days in the 2026-08-31 incident.
    const state = world({ confirmed: [...FULL_14] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "kemal",
          body: "@Match Time move Zair to the bench please",
          route: "other_att",
          tagged: true,
          facts: attendanceFacts([
            claim({ subject: "other", personRef: "Zair", personNamed: true, polarity: "bench" }),
          ]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "zair")).toBe("BENCH");
    expect(r.outcomes[0].react).toBe("👍");
    expect(r.speech.filter((s) => s.kind === "squad_status")).toHaveLength(1);
  });

  it("an admin dropping somebody else posts it too, beside the bench offer", () => {
    const state = world({ confirmed: [...FULL_14], bench: ["habib"] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "kemal",
          body: "@Match Time Zair is out tonight",
          route: "other_att",
          tagged: true,
          facts: attendanceFacts([
            claim({ subject: "other", personRef: "Zair", personNamed: true, polarity: "out" }),
          ]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "zair")).toBe("DROPPED");
    expect(r.speech.map((s) => s.kind)).toEqual(["bench_offer_open", "squad_status"]);
  });

  it("a SELF drop in the same batch as a third-party move posts ONCE, not twice", () => {
    // Both survivors and a deferred question at the same time still make
    // exactly one post. That is S36, and it is the invariant this whole
    // block is a narrowing of rather than a replacement for.
    const state = world({ confirmed: [...FULL_14] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "wasim",
          body: "out sorry lads",
          route: "self_att",
          facts: attendanceFacts([claim({ polarity: "out" })]),
        }),
        msg({
          from: "kemal",
          body: "@Match Time Zair is out too",
          route: "other_att",
          tagged: true,
          facts: attendanceFacts([
            claim({ subject: "other", personRef: "Zair", personNamed: true, polarity: "out" }),
          ]),
        }),
        msg({
          from: "adam",
          body: "@Match Time how many are we now?",
          route: "question",
          tagged: true,
          facts: COUNT_Q,
        }),
      ],
    });
    expect(r.speech.filter((s) => s.kind === "squad_status")).toHaveLength(1);
    expect(r.speech.filter((s) => s.kind === "answer_count")).toHaveLength(0);
  });

  it("a roster question in the SAME batch as an IN is still answered", () => {
    const state = world({ confirmed: ["kemal", "elvin", "sait"] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({ from: "usama", body: "in", route: "self_att", facts: attendanceFacts([claim({})]) }),
        msg({
          from: "adam",
          body: "@Match Time list the players",
          route: "question",
          tagged: true,
          facts: SQUAD_Q,
        }),
      ],
    });
    expect(r.speech.filter((s) => s.kind === "squad_status")).toHaveLength(1);
    expect(r.speech.filter((s) => s.kind === "answer_squad")).toHaveLength(0);
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
          facts: { kind: "teams", action: "show", includeRefs: [], teamNames: null, swaps: [], pairings: [] },
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
// §6.1's "fixing a rule in a small router with a 40-case eval set takes
// ten minutes and produces a number", applied to the engine too. (§6.1
// wrote "360-token"; the router prompt was 669 tokens when anyone
// finally counted, and is 2,554 since 2026-09-11. The point survives
// the arithmetic: it is the eval set, not the token count, that turns
// an argument into a number.)

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

// ── Found by an adversarial review of this branch (2026-09-01) ─────────
//
// Three of these were blockers: a real OUT swallowed, a self-correction
// inverted, and PR #27's bench invariant loosened. All three are the
// same shape — a rule that is right for the case it was written for and
// wrong one step to the side — which is precisely why the engine has to
// be dense with tests rather than merely pure.

describe("state collapse only defers to a message that would ACTUALLY write", () => {
  it("keeps an OUT that a later CONTINGENT message would not have acted on", () => {
    // Blocker. `lastSelfIndexByAuthor` used to record the last message
    // CONTAINING a self claim, not the last one that produces a write,
    // so any later claim the engine then declines (contingent, past,
    // hypothetical, low confidence) killed the earlier real one. In
    // production: a phantom player in a paid squad, and "message
    // understood, action silently not taken".
    const state = world({ confirmed: [...FULL_14] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "wasim",
          body: "out",
          route: "self_att",
          facts: attendanceFacts([claim({ polarity: "out" })]),
        }),
        msg({
          from: "wasim",
          body: "in if I finish work early",
          route: "offer",
          facts: attendanceFacts([
            claim({ polarity: "in", contingent: true, conditionOn: "self" }),
          ]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "wasim")).toBe("DROPPED");
    expect(confirmedCount(r.nextState)).toBe(13);
  });

  it("keeps an OUT that a later PAST-TENSE message would not have acted on", () => {
    const state = world({ confirmed: [...FULL_14] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "wasim",
          body: "out",
          route: "self_att",
          facts: attendanceFacts([claim({ polarity: "out" })]),
        }),
        msg({
          from: "wasim",
          body: "gutted, I was in last week too",
          route: "self_att",
          facts: attendanceFacts([claim({ polarity: "in", tense: "past" })]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "wasim")).toBe("DROPPED");
  });

  it("still lets a later REAL message supersede an earlier one (S35)", () => {
    const state = world({ confirmed: ["kemal", "elvin", "sait", "mustafa", "usama"] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({ from: "usama", body: "actually I'm in", route: "self_att", facts: attendanceFacts([claim({})]) }),
        msg({
          from: "usama",
          body: "no sorry, out",
          route: "self_att",
          facts: attendanceFacts([claim({ polarity: "out" })]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "usama")).toBe("DROPPED");
  });
});

describe("a self-correction inside ONE message keeps its textual order", () => {
  it("'I'm in tonight. Actually no, scrap that, I'm out' leaves the player OUT", () => {
    // Blocker. The OUT-first sort exists so a REPLACEMENT frees a slot
    // before it fills it, which is always two different people. Applied
    // to two claims about the SAME person it reversed the correction and
    // registered someone who had just said they were out.
    const state = world({ confirmed: FULL_14.slice(0, 5) });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "zair",
          body: "I'm in tonight. Actually no, scrap that, I'm out",
          route: "self_att",
          facts: attendanceFacts([
            claim({ polarity: "in" }),
            claim({ polarity: "out" }),
          ]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "zair")).toBe("ABSENT");
    expect(attWrites(r.writes)).toHaveLength(0);
  });

  it("emits at most one attendance write per person per message", () => {
    const state = world({ confirmed: [...FULL_14.slice(0, 4), "usama"] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "usama",
          body: "I'm out. actually I'm in",
          route: "self_att",
          facts: attendanceFacts([claim({ polarity: "out" }), claim({ polarity: "in" })]),
        }),
      ],
    });
    const perUser = attWrites(r.writes).filter((w) => w.kind === "attendance" && w.userId === "u-usama");
    expect(perUser.length).toBeLessThanOrEqual(1);
    expect(statusOf(r.nextState, "usama")).toBe("CONFIRMED");
  });

  it("still frees the slot before filling it across DIFFERENT people", () => {
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
    expect(statusOf(r.nextState, "izzet")).toBe("CONFIRMED");
    expect(benchCount(r.nextState)).toBe(0);
  });
});

describe("a CONTINGENT claim about someone ELSE never registers them", () => {
  // Found by the §10 step 6 replay sweep over real production history
  // and adjudicated `old_right`. It is the dangerous direction —
  // registering someone who did not ask — and it is the one criterion
  // §10 step 3 sets at ZERO.
  //
  //   2026-06-11, Omar Yusuf, 7.3h to kickoff, squad 10/14:
  //   "Also, if David would like to join, I'd be happy for him to take
  //   my spot" → the engine registered DAVID, who had not spoken, and
  //   left Omar in. The squad grew to 11 instead of swapping. The
  //   incumbent wrote nothing, and production's own label was
  //   `conditional_in`.

  it("holds a named third party's contingent IN instead of registering them", () => {
    const state = world({ confirmed: ["omar"] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "omar",
          body: "if David would like to join, I'd be happy for him to take my spot",
          route: "offer",
          tagged: true,
          facts: attendanceFacts([
            claim({
              subject: "other",
              personRef: "David",
              personNamed: true,
              polarity: "in",
              contingent: true,
              conditionOn: "squad",
            }),
          ]),
        }),
      ],
    });
    expect(r.writes).toEqual([]);
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/contingent claim about .*not the sender/);
  });

  it("still registers the SENDER's own standing offer — S15(a) is unchanged", () => {
    // The control case, and the one that would break if this fix were
    // written as "contingent never registers". §3.2 S15's two flavours
    // have OPPOSITE outcomes and conflating them is incident A5.
    const state = world({ confirmed: [] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "amir",
          body: "consider me as the 14th whenever you have 13",
          route: "offer",
          facts: attendanceFacts([
            claim({ polarity: "in", contingent: true, conditionOn: "squad", tense: "future" }),
          ]),
        }),
      ],
    });
    expect(r.writes).toHaveLength(1);
    expect(r.writes[0]).toMatchObject({ kind: "attendance", status: "CONFIRMED" });
  });

  it("makes A5's refusal structural — it no longer rests on personNamed", () => {
    // "my brother can play if needed" is now refused TWICE: once because
    // the reference is not a name, and once because a contingent claim
    // about a third party never registers. A schema-drift regression in
    // `personNamed` can no longer provision a ghost user on its own.
    const state = world({ confirmed: [] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "amir",
          body: "@Match Time my brother can play if needed",
          route: "offer",
          tagged: true,
          facts: attendanceFacts([
            claim({
              subject: "other",
              personRef: "Amir's brother",
              // The model getting this WRONG is the whole point of the test.
              personNamed: true,
              polarity: "in",
              contingent: true,
              conditionOn: "squad",
            }),
          ]),
        }),
      ],
    });
    expect(r.writes).toEqual([]);
    expect(r.nextState.roster.some((m) => /brother/i.test(m.name))).toBe(false);
  });

  it("a contingent third-party BENCH is held too, not just an IN", () => {
    const state = world({ confirmed: ["dan"] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "amir",
          body: "@Match Time Dan can bench if we're over",
          route: "offer",
          tagged: true,
          facts: attendanceFacts([
            claim({
              subject: "other",
              personRef: "Dan",
              personNamed: true,
              polarity: "bench",
              contingent: true,
              conditionOn: "squad",
            }),
          ]),
        }),
      ],
    });
    expect(r.writes).toEqual([]);
  });
});

describe("PR#27 · a CONTINGENT bench is inferred, not explicit", () => {
  it("does not write a bench row at 0/14 for a standing offer", () => {
    // Blocker. `route.ts:2412-2417` derives benchIntent deterministically
    // and calls a conditional_in's BENCH "inferred" precisely so that a
    // standing offer with slots open becomes CONFIRMED. The engine was
    // calling every model-supplied `bench` explicit, which regenerates
    // the 2026-08-31 incident: "Confirmed (10/14)" over "Bench (1)".
    const state = world({ confirmed: [] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "amir",
          body: "happy to bench if you're short",
          route: "offer",
          facts: attendanceFacts([
            claim({ polarity: "bench", contingent: true, conditionOn: "squad" }),
          ]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "amir")).toBe("CONFIRMED");
    expect(benchCount(r.nextState)).toBe(0);
  });

  it("an UNCONDITIONAL bench request is still honoured with slots open", () => {
    const state = world({ confirmed: ["kemal", "elvin"] });
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
  });
});

describe("bench offers, continued", () => {
  it("re-registering a DROPPED player closes the offer opened for their slot", () => {
    // attendance.ts:204-240 does this for real (Sutton 2026-05-26: Baki
    // was re-confirmed in admin and the stale offer kept firing bench
    // prompts on top of the squad-locked message). The engine must not
    // propose a world where that offer is still open.
    const state = world({
      confirmed: ["kemal", "elvin", "sait"],
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
        msg({
          from: "wasim",
          body: "actually I can make it",
          route: "self_att",
          facts: attendanceFacts([claim({ polarity: "in" })]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "wasim")).toBe("CONFIRMED");
    expect(r.nextState.openOffers).toHaveLength(0);
  });

  it("says something when a bench player answers an offer whose slot has gone", () => {
    // The 2026-05-19 Karahan shape: a bench player answers and machinery
    // ignores them. Silence is the one response that is never right.
    const state = world({
      players: ["kemal", "elvin", "karahan"],
      maxPlayers: 2,
      confirmed: ["kemal", "elvin"],
      bench: ["karahan"],
      openOffers: [{ id: "offer-1", replacingUserId: null, offeredToUserIds: ["u-karahan"] }],
    });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({ from: "karahan", body: "in", route: "self_att", facts: attendanceFacts([claim({})]) }),
      ],
    });
    expect(statusOf(r.nextState, "karahan")).toBe("BENCH");
    expect(r.speech.some((s) => s.kind === "bench_claim_too_late")).toBe(true);
  });
});

describe("value clamps degrade rather than silently altering a number", () => {
  it("refuses a payment credit larger than the squad", () => {
    // Real money on a real club. §6.4's claim is that numbers are never
    // model-authored so they cannot be wrong; this one IS model-authored,
    // and silently clamping it and then announcing the clamped figure is
    // the worst of both.
    const state = world({
      confirmed: ["kemal", "elvin", "sait", "amir"],
      features: { paymentTracking: true },
      completedMatch: {
        id: "done-1",
        redScore: null,
        yellowScore: null,
        participantUserIds: ["u-kemal", "u-elvin", "u-sait", "u-amir"],
      },
    });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "elvin",
          body: "@Match Time Amir paid for 20 players",
          route: "admin_ops",
          tagged: true,
          facts: { kind: "admin", action: "bulk_payment", payerRef: "Amir", count: 20 },
        }),
      ],
    });
    expect(r.writes).toHaveLength(0);
    expect(r.degradations.some((d) => /20/.test(d.detail))).toBe(true);
  });

  it("never overwrites a score that is already recorded", () => {
    const state = world({
      confirmed: ["kemal"],
      completedMatch: {
        id: "done-1",
        redScore: 5,
        yellowScore: 2,
        participantUserIds: ["u-kemal"],
      },
    });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "kemal",
          body: "3-3 last night",
          route: "score",
          facts: { kind: "score", first: 3, second: 3 },
        }),
      ],
    });
    expect(r.writes).toHaveLength(0);
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/already recorded/i);
  });
});

describe("PR#33 · an admin's recruit command addresses MatchTime", () => {
  const world10 = () =>
    world({
      players: [
        "kemal",
        "elvin",
        "sait",
        "mustafa",
        "abid",
        "idris",
        "faris",
        "shaz",
        "adam",
        "najib",
        "zair",
      ],
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
        "najib",
      ],
    });

  const facts = () =>
    attendanceFacts(
      [claim({ subject: "other", personRef: "Najib", personNamed: true, polarity: "out" })],
      { sideRequests: ["recruit"] },
    );

  it("drops the named player from the SAME untagged message (2026-09-01)", () => {
    // The incident: the bot acted on the recruit half of an untagged
    // admin message and treated the drop in the sentence before it as
    // overheard banter, then told the owner his squad was full moments
    // after he said someone was out. PR #33's widening is reused here,
    // not re-decided, so one constant reverts both pipelines.
    const r = decide({
      now: NOW,
      state: world10(),
      messages: [
        msg({
          from: "kemal",
          body: "Najib is out. We need one more player.\n\nCan someone pls come forward",
          route: "other_att",
          tagged: false,
          facts: facts(),
        }),
      ],
    });
    expect(statusOf(r.nextState, "najib")).toBe("DROPPED");
    expect(confirmedCount(r.nextState)).toBe(9);
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/recruit command addresses/i);
  });

  it("does NOT widen the gate for a non-admin", () => {
    const r = decide({
      now: NOW,
      state: world10(),
      messages: [
        msg({
          from: "zair",
          body: "Najib is out. Can someone come forward",
          route: "other_att",
          tagged: false,
          facts: facts(),
        }),
      ],
    });
    expect(statusOf(r.nextState, "najib")).toBe("CONFIRMED");
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/tag/i);
  });

  // ⚠️ UPDATED 2026-09-07 — THIS TEST USED TO ASSERT THE OPPOSITE, and
  // the flip is deliberate rather than a fix to a broken test.
  //
  // It read "does NOT widen the gate for an admin with no recruit ask",
  // quoting `recruit-request.ts`: "Whether THAT should change is a
  // separate decision and is not taken here". That decision HAS now been
  // taken. On 2026-09-07 the owner posted "@Shahrokh🐔 Sutton Football
  // Club is out due to unforeseen issue at work" — an admin OUT with no
  // recruit clause and no bot tag, i.e. exactly this shape — and
  // MatchTime did nothing while the squad read 13/14 with a player in it
  // who was not coming. `ADMIN_REPORTED_OUT_IS_TAG_FREE` is what changed,
  // and the two waivers stay separate constants so either reverts alone.
  it("an admin OUT with NO recruit ask is ALSO waived now (2026-09-07)", () => {
    const r = decide({
      now: NOW,
      state: world10(),
      messages: [
        msg({
          from: "kemal",
          body: "Najib has hurt his foot unfortunately",
          route: "other_att",
          tagged: false,
          facts: attendanceFacts([
            claim({ subject: "other", personRef: "Najib", personNamed: true, polarity: "out" }),
          ]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "najib")).toBe("DROPPED");
    // …and it says WHICH waiver did it, not the recruit one.
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/ADMIN_REPORTED_OUT_IS_TAG_FREE/);
    expect(r.outcomes[0].reasons.join(" ")).not.toMatch(/recruit command addresses/i);
  });

  it("a NON-admin OUT with no recruit ask is still suppressed", () => {
    // The half of the old assertion that does NOT change.
    const r = decide({
      now: NOW,
      state: world10(),
      messages: [
        msg({
          from: "zair",
          body: "Najib has hurt his foot unfortunately",
          route: "other_att",
          tagged: false,
          facts: attendanceFacts([
            claim({ subject: "other", personRef: "Najib", personNamed: true, polarity: "out" }),
          ]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "najib")).toBe("CONFIRMED");
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/requires an @Match Time tag/);
  });
});

// ── basis · availability is not a commitment ───────────────────────────

describe("an AVAILABILITY statement registers nobody (2026-06-20, Abid Kazmi)", () => {
  // The last adjudicated spurious write left open by PR #44, found by
  // the §10 step 6 replay sweep over real production history:
  //
  //   g-9e11e1c220:2026-06-20T18:00:34.268Z — Kemal chases the group
  //   ("guys, nobody interested? …"), Abid Kazmi replies "I will be back
  //   Tuesday week", 241.5h (ten days) before kickoff, squad 0/14. The
  //   engine registered him CONFIRMED. Production labelled it out/OUT
  //   and the incumbent's replay run wrote nothing: only the engine put
  //   him in the squad.
  //
  // It is a SCHEMA GAP, measured rather than assumed. Three live runs of
  // the shipped extractor on the real message with its real history
  // returned, every time:
  //
  //   polarity "in" · contingent false · conditionOn "none" · tense "future"
  //
  // …which is byte-for-byte the shape "I'm in for next Tuesday" returns.
  // Neither `tense` nor `contingent` can separate them: `future` is the
  // right tense for both, and neither is conditional on anything. The
  // schema had no field for "this reports where I will be, it does not
  // ask for a place", so `basis` is that field.
  //
  // The asymmetry is deliberate and is §13's default: being ABLE to play
  // is necessary but never sufficient, so an availability IN never
  // registers; being UNABLE to play settles it, so an availability OUT
  // still frees the slot.

  it("does not register the sender who says they will be back", () => {
    const state = world({ confirmed: [] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "abid",
          body: "I will be back Tuesday week",
          route: "self_att",
          facts: attendanceFacts([
            claim({ polarity: "in", tense: "future", basis: "availability", confidence: 0.7 }),
          ]),
        }),
      ],
    });
    expect(r.writes).toEqual([]);
    expect(statusOf(r.nextState, "abid")).toBe("ABSENT");
    expect(r.outcomes[0].disposition).toBe("noop");
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/availability/i);
  });

  it("STILL registers a real commitment ten days out — the opposite direction", () => {
    // The control. A fix written as "future never registers" would pass
    // the test above and break this one, and this is the shape the group
    // actually uses when the chase goes out early.
    const state = world({ confirmed: [] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "abid",
          body: "I'm in for next Tuesday",
          route: "self_att",
          facts: attendanceFacts([
            claim({ polarity: "in", tense: "future", basis: "decision", confidence: 0.95 }),
          ]),
        }),
      ],
    });
    expect(r.writes).toHaveLength(1);
    expect(statusOf(r.nextState, "abid")).toBe("CONFIRMED");
  });

  it("does not register a THIRD PARTY reported as available either", () => {
    const state = world({ confirmed: [] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "kemal",
          body: "@Match Time Najib is back from Turkey next week",
          route: "other_att",
          tagged: true,
          facts: attendanceFacts([
            claim({
              subject: "other",
              personRef: "Najib",
              personNamed: true,
              polarity: "in",
              tense: "future",
              basis: "availability",
            }),
          ]),
        }),
      ],
    });
    expect(r.writes).toEqual([]);
    expect(statusOf(r.nextState, "najib")).toBe("ABSENT");
  });

  it("does not put an available player on the bench either", () => {
    // `bench` is an EXPLICIT ask, so `availability` + `bench` should not
    // occur — but a squad place is a squad place, and the rule is about
    // giving one to someone who never asked for it.
    const state = world({ confirmed: FULL_14 });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "efat",
          body: "I'm around Tuesday if that helps",
          route: "offer",
          facts: attendanceFacts([
            claim({ polarity: "bench", tense: "future", basis: "availability" }),
          ]),
        }),
      ],
    });
    expect(r.writes).toEqual([]);
  });

  it("STILL drops a confirmed player who says they are away — an availability OUT settles it", () => {
    // The other half of the asymmetry, and the reason this is not
    // "availability claims are ignored". A place nobody can use is a
    // place the club loses; "I'm away that week" is as good a reason to
    // free it as "I'm out". Suppressing this direction would trade one
    // spurious write for a class of missed ones.
    const state = world({ confirmed: ["kemal", "abid", "elvin"] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "abid",
          body: "I'm away next week",
          route: "self_att",
          facts: attendanceFacts([
            claim({ polarity: "out", tense: "future", basis: "availability", confidence: 0.9 }),
          ]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "abid")).toBe("DROPPED");
  });

  it("cannot be superseded INTO existence by a later availability claim", () => {
    // The state collapse defers to a later message only when that later
    // message would itself write. An availability IN would not, so an
    // earlier real commitment must survive it.
    const state = world({ confirmed: [] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          id: "m1",
          from: "abid",
          body: "In",
          route: "self_att",
          facts: attendanceFacts([claim({ polarity: "in", basis: "decision" })]),
        }),
        msg({
          id: "m2",
          from: "abid",
          body: "I will be back Tuesday week anyway",
          route: "self_att",
          facts: attendanceFacts([
            claim({ polarity: "in", tense: "future", basis: "availability" }),
          ]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "abid")).toBe("CONFIRMED");
  });
});

// ── §3.2 S16 / S19 · the 2026-09-06 question sweep ─────────────────────
//
// Twelve tagged questions replayed against the live Sutton squad. Four
// produced no speech at all, three answered a roster request with a
// bare count, and one posted a team sheet with nobody on it. These are
// the engine half of the fix.

describe("S16 · a roster question is not a counting question", () => {
  const ROSTER_Q = {
    kind: "question" as const,
    topic: "squad" as const,
    personRef: null,
    statedCount: null,
  };

  it("asks for `answer_squad`, never `answer_count`", () => {
    const state = world({ confirmed: ["kemal", "elvin", "sait"] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "adam",
          body: "@Match Time list the players",
          route: "question",
          tagged: true,
          facts: ROSTER_Q,
        }),
      ],
    });
    expect(r.speech.some((s) => s.kind === "answer_squad")).toBe(true);
    expect(r.speech.some((s) => s.kind === "answer_count")).toBe(false);
    expect(r.writes).toHaveLength(0);
  });

  it("is deferred into the batch squad post when the squad also changed (S36)", () => {
    const state = world({ confirmed: ["kemal", "elvin"] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "sait",
          body: "in",
          route: "self_att",
          facts: attendanceFacts([claim({ polarity: "in" })]),
        }),
        msg({
          from: "adam",
          body: "@Match Time list the players",
          route: "question",
          tagged: true,
          facts: ROSTER_Q,
        }),
      ],
    });
    expect(r.speech.filter((s) => s.kind === "squad_status")).toHaveLength(1);
    expect(r.speech.some((s) => s.kind === "answer_squad")).toBe(false);
  });

  it("still requires the tag the interaction contract requires", () => {
    const state = world({ confirmed: ["kemal"] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({ from: "adam", body: "whos in", route: "question", facts: ROSTER_Q }),
      ],
    });
    expect(r.speech).toHaveLength(0);
  });
});

describe("S16 · a fixture question is answered, not shrugged at", () => {
  it("emits `answer_fixture` rather than degrading to silence", () => {
    const state = world({ confirmed: ["kemal"] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "adam",
          body: "@Match Time what time is kickoff",
          route: "question",
          tagged: true,
          facts: { kind: "question", topic: "fixture", personRef: null, statedCount: null },
        }),
      ],
    });
    expect(r.speech.some((s) => s.kind === "answer_fixture")).toBe(true);
    expect(r.outcomes[0].disposition).toBe("acted");
    expect(r.degradations).toHaveLength(0);
    expect(r.writes).toHaveLength(0);
  });
});

describe("a result question is answered from the match that was played", () => {
  const scoreAsk = () =>
    msg({
      from: "adam",
      body: "@Match Time what was the score",
      route: "question",
      tagged: true,
      facts: { kind: "question", topic: "score", personRef: null, statedCount: null },
    });

  it("emits `answer_score` rather than degrading to silence", () => {
    const state = world({
      confirmed: ["kemal"],
      completedMatch: { id: "m-old", redScore: 5, yellowScore: 3 },
    });
    const r = decide({ now: NOW, state, messages: [scoreAsk()] });
    expect(r.speech.some((s) => s.kind === "answer_score")).toBe(true);
    expect(r.outcomes[0].disposition).toBe("acted");
    expect(r.degradations).toHaveLength(0);
    expect(r.writes).toHaveLength(0);
  });

  it("still emits it when no match has been played — the composer says so", () => {
    // The engine does NOT branch on whether a score exists. It emits the
    // intent and the composer renders the honest sentence for each of
    // the three states, because splitting the decision across two
    // modules is how one of them ends up rendering a `null` as a number.
    const state = world({ confirmed: ["kemal"] });
    const r = decide({ now: NOW, state, messages: [scoreAsk()] });
    expect(r.speech.some((s) => s.kind === "answer_score")).toBe(true);
    expect(r.writes).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 2026-09-07 · THE SHAHROKH INCIDENT — an admin reporting a player out,
// with no @Match Time tag.
//
// Kemal posted to the live Sutton FC group, the day before kickoff:
//
//     "@Shahrokh🐔 Sutton Football Club is out due to unforeseen issue
//      at work"
//
// Shahrokh was CONFIRMED at position 10. MatchTime did nothing: the
// verdict is a third-party OUT, `actionRequiresTag` said yes, and the
// message tags no bot. The squad kept reading 13/14 with a player in it
// who was not coming, and the row was corrected by hand.
//
// ⚠️ THE TRAP: the message DOES contain an "@" — of the PLAYER. Tagged
// in this codebase means the BOT was mentioned. A player @-mention has
// never been a tag and still is not one.
//
// The fix is `ADMIN_REPORTED_OUT_IS_TAG_FREE`, and it is deliberately
// scoped to OWNER/ADMIN senders: a member of the group must still tag
// the bot to remove anybody, or the group can drop each other by typing
// a sentence.
// ══════════════════════════════════════════════════════════════════════

describe("2026-09-07 · an admin's untagged third-party OUT (Shahrokh)", () => {
  const INCIDENT = "@Shahrokh🐔 Sutton Football Club is out due to unforeseen issue at work";

  /** 13/14 with Shahrokh in the squad — the state that message landed in. */
  const squad = () =>
    world({
      players: [...SUTTON, "shahrokh"],
      maxPlayers: 14,
      confirmed: [...FULL_14.slice(0, 12), "shahrokh"],
    });

  const dropShahrokh = () =>
    attendanceFacts([
      claim({ subject: "other", personRef: "Shahrokh", personNamed: true, polarity: "out" }),
    ]);

  it("THE INCIDENT: admin, no bot tag → Shahrokh is DROPPED", () => {
    const r = decide({
      now: NOW,
      state: squad(),
      messages: [
        msg({ from: "kemal", body: INCIDENT, route: "other_att", facts: dropShahrokh() }),
      ],
    });
    expect(statusOf(r.nextState, "shahrokh")).toBe("DROPPED");
    expect(confirmedCount(r.nextState)).toBe(12);
    expect(attWrites(r.writes)).toHaveLength(1);
    expect(r.outcomes[0].disposition).toBe("acted");
    expect(r.degradations).toHaveLength(0);
  });

  it("THE LIMIT: the same message from a NON-admin writes nothing", () => {
    const r = decide({
      now: NOW,
      state: squad(),
      messages: [
        // Zair is an ordinary member. Removing someone who never
        // consented is still an explicit, tagged op for him.
        msg({ from: "zair", body: INCIDENT, route: "other_att", facts: dropShahrokh() }),
      ],
    });
    expect(statusOf(r.nextState, "shahrokh")).toBe("CONFIRMED");
    expect(r.writes).toHaveLength(0);
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/requires an @Match Time tag/);
  });

  it("a TAGGED non-admin drop still works (the tag is the other route in)", () => {
    const r = decide({
      now: NOW,
      state: squad(),
      messages: [
        msg({
          from: "zair",
          body: "@Match Time Shahrokh is out",
          tagged: true,
          route: "other_att",
          facts: dropShahrokh(),
        }),
      ],
    });
    expect(statusOf(r.nextState, "shahrokh")).toBe("DROPPED");
  });

  it("an admin's untagged third-party IN is unchanged (already tag-free)", () => {
    const r = decide({
      now: NOW,
      state: squad(),
      messages: [
        msg({
          from: "kemal",
          body: "Najib is playing tomorrow",
          route: "other_att",
          facts: attendanceFacts([
            claim({ subject: "other", personRef: "Najib", personNamed: true, polarity: "in" }),
          ]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "najib")).toBe("CONFIRMED");
  });

  it("an admin's own untagged OUT is unchanged (already tag-free)", () => {
    const r = decide({
      now: NOW,
      state: squad(),
      messages: [
        msg({
          from: "kemal",
          body: "can't make it lads",
          route: "self_att",
          facts: attendanceFacts([claim({ polarity: "out" })]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "kemal")).toBe("DROPPED");
    expect(statusOf(r.nextState, "shahrokh")).toBe("CONFIRMED");
  });

  // ── The waiver must never GUESS who was named ─────────────────────
  it("an admin naming someone who is not a member drops nobody", () => {
    const r = decide({
      now: NOW,
      state: squad(),
      messages: [
        msg({
          from: "kemal",
          body: "Ronaldo is out",
          route: "other_att",
          facts: attendanceFacts([
            claim({ subject: "other", personRef: "Ronaldo", personNamed: true, polarity: "out" }),
          ]),
        }),
      ],
    });
    expect(r.writes).toHaveLength(0);
    expect(confirmedCount(r.nextState)).toBe(13);
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/not a member/);
  });

  it("an AMBIGUOUS name from an admin bails loudly and drops nobody", () => {
    const state = squad();
    // Two Amirs on the roster. "Amir is out" identifies neither.
    state.roster.push({ userId: "u-amir2", name: "Amir Khan", isAdmin: false, hasPhone: true });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "kemal",
          body: "Amir is out",
          route: "other_att",
          facts: attendanceFacts([
            claim({ subject: "other", personRef: "Amir", personNamed: true, polarity: "out" }),
          ]),
        }),
      ],
    });
    expect(r.writes).toHaveLength(0);
    expect(r.degradations).toHaveLength(1);
    expect(r.degradations[0].detail).toMatch(/ambiguous/i);
  });

  it("a low-confidence claim from an admin is still below the floor", () => {
    const r = decide({
      now: NOW,
      state: squad(),
      messages: [
        msg({
          from: "kemal",
          body: "not sure but I think Shahrokh might be out?",
          route: "other_att",
          facts: attendanceFacts([
            claim({
              subject: "other",
              personRef: "Shahrokh",
              personNamed: true,
              polarity: "out",
              confidence: 0.5,
            }),
          ]),
        }),
      ],
    });
    expect(r.writes).toHaveLength(0);
    expect(statusOf(r.nextState, "shahrokh")).toBe("CONFIRMED");
  });

  // ── BENCH and SWAP, pinned both ways ──────────────────────────────
  it("an admin's untagged BENCH of another player is NOT waived", () => {
    const r = decide({
      now: NOW,
      state: squad(),
      messages: [
        msg({
          from: "kemal",
          body: "put Shahrokh on the bench",
          route: "other_att",
          facts: attendanceFacts([
            claim({ subject: "other", personRef: "Shahrokh", personNamed: true, polarity: "bench" }),
          ]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "shahrokh")).toBe("CONFIRMED");
    expect(r.writes).toHaveLength(0);
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/requires an @Match Time tag/);
  });

  it("the same BENCH, TAGGED, still works", () => {
    const r = decide({
      now: NOW,
      state: squad(),
      messages: [
        msg({
          from: "kemal",
          body: "@Match Time put Shahrokh on the bench",
          tagged: true,
          route: "other_att",
          facts: attendanceFacts([
            claim({ subject: "other", personRef: "Shahrokh", personNamed: true, polarity: "bench" }),
          ]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "shahrokh")).toBe("BENCH");
  });

  it("an admin's untagged SWAP (OUT + IN) IS waived — both halves already are", () => {
    const r = decide({
      now: NOW,
      state: squad(),
      messages: [
        msg({
          from: "kemal",
          body: "Shahrokh is out, Najib can take his spot",
          route: "other_att",
          facts: attendanceFacts([
            claim({ subject: "other", personRef: "Shahrokh", personNamed: true, polarity: "out" }),
            claim({ subject: "other", personRef: "Najib", personNamed: true, polarity: "in" }),
          ]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "shahrokh")).toBe("DROPPED");
    expect(statusOf(r.nextState, "najib")).toBe("CONFIRMED");
    expect(confirmedCount(r.nextState)).toBe(13);
  });

  it("a NON-admin's untagged SWAP loses its DROP half, and only that half", () => {
    // CHANGED 2026-09-08, deliberately, and it is the same change as the
    // David incident seen from the other side. This used to assert
    // "suppressed entirely", and that outcome was not a rule anybody
    // wrote: it was the all-or-nothing gate, where one refused entry
    // discarded every other entry in the message.
    //
    // Per entry, the contract's own answers are unambiguous. The OUT is
    // refused — an ordinary member may not remove a player who never
    // consented, which is the whole reason the tag rule exists and it is
    // untouched. The IN is a third-party ADD, and an ADD has been
    // tag-free for EVERYONE since the third-party-add change; it can
    // only add somebody, never take a place off anybody, and capacity
    // decides whether that is a slot or the bench exactly as it would
    // for "Najib can play if you're short" typed on its own.
    //
    // And the sender is TOLD which half did not happen, so a member
    // cannot come away believing he swapped two players.
    const r = decide({
      now: NOW,
      state: squad(),
      messages: [
        msg({
          from: "zair",
          body: "Shahrokh is out, Najib can take his spot",
          route: "other_att",
          facts: attendanceFacts([
            claim({ subject: "other", personRef: "Shahrokh", personNamed: true, polarity: "out" }),
            claim({ subject: "other", personRef: "Najib", personNamed: true, polarity: "in" }),
          ]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "shahrokh")).toBe("CONFIRMED");
    expect(statusOf(r.nextState, "najib")).not.toBe("ABSENT");
    expect(r.speech.find((x) => x.kind === "needs_tag_for_rest")).toMatchObject({
      entries: [{ name: "Shahrokh", action: "OUT" }],
    });
  });

  // ── THE APPLY PATH IS THE SAME ONE ────────────────────────────────
  //
  // A drop opens a slot, and the slot is offered to the bench by the
  // apply layer (`attendance.ts:cancelAttendance` →
  // `requestBenchConfirmationOnDrop`), which reads the write the engine
  // proposes. So the property that matters here is that a WAIVED drop
  // and a TAGGED drop produce the SAME write, byte for byte apart from
  // the message id — anything else and the offer chain would see a
  // different object on the untagged path.
  it("a waived drop proposes exactly the write a tagged drop proposes", () => {
    const run = (tagged: boolean) =>
      decide({
        now: NOW,
        state: squad(),
        messages: [
          msg({
            id: tagged ? "wa-tagged" : "wa-waived",
            from: "kemal",
            body: tagged ? "@Match Time Shahrokh is out" : INCIDENT,
            tagged,
            route: "other_att",
            facts: dropShahrokh(),
          }),
        ],
      });
    const waived = attWrites(run(false).writes).map((w) => ({ ...w, sourceMessageId: "-" }));
    const tagged = attWrites(run(true).writes).map((w) => ({ ...w, sourceMessageId: "-" }));
    expect(waived).toHaveLength(1);
    expect(waived).toEqual(tagged);
    expect(waived[0].status).toBe("DROPPED");
  });

  it("the freed slot is offered: a bench player is still there to take it", () => {
    // The engine does not open the offer (the apply layer does), but it
    // must leave the state the offer is computed from: a bench holder
    // and one fewer confirmed player.
    const state = world({
      players: [...SUTTON, "shahrokh"],
      maxPlayers: 14,
      confirmed: [...FULL_14.slice(0, 13), "shahrokh"],
      bench: ["najib"],
    });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({ from: "kemal", body: INCIDENT, route: "other_att", facts: dropShahrokh() }),
      ],
    });
    expect(statusOf(r.nextState, "shahrokh")).toBe("DROPPED");
    expect(statusOf(r.nextState, "najib")).toBe("BENCH"); // nobody is auto-promoted
    expect(confirmedCount(r.nextState)).toBe(13); // one slot open, 14 max
  });

  // ── The banter guard had to move with the waiver ──────────────────
  //
  // `banterRefusal` exempted ADMINS from the joke-marker refusal, and
  // that was safe only because an admin's third-party drop necessarily
  // carried a tag: a tag is a deliberate act. The waiver removes that,
  // so the exemption now hangs off the TAG rather than the seat.
  it("an admin's untagged drop with banter markers is REFUSED", () => {
    const r = decide({
      now: NOW,
      state: squad(),
      messages: [
        msg({
          from: "kemal",
          body: "Shahrokh is out 😂😂 vote him out lads",
          route: "other_att",
          facts: dropShahrokh(),
        }),
      ],
    });
    expect(statusOf(r.nextState, "shahrokh")).toBe("CONFIRMED");
    expect(r.writes).toHaveLength(0);
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/banter/i);
  });

  it("the same banter markers WITH a tag are still honoured (unchanged)", () => {
    const r = decide({
      now: NOW,
      state: squad(),
      messages: [
        msg({
          from: "kemal",
          body: "@Match Time Shahrokh is out 😂 he's gutted",
          tagged: true,
          route: "other_att",
          facts: dropShahrokh(),
        }),
      ],
    });
    expect(statusOf(r.nextState, "shahrokh")).toBe("DROPPED");
  });

  it("the target contradicting it in the same window still wins", () => {
    const r = decide({
      now: NOW,
      state: squad(),
      messages: [
        msg({ from: "kemal", body: INCIDENT, route: "other_att", facts: dropShahrokh() }),
        msg({
          from: "shahrokh",
          body: "what? I'm in lads",
          route: "self_att",
          facts: attendanceFacts([claim({ polarity: "in" })]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "shahrokh")).toBe("CONFIRMED");
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/contradict|corrobor/i);
  });
});

describe("S19 · showing teams that were never generated", () => {
  it("says so instead of composing a team post over two empty lists", () => {
    const state = world({ confirmed: ["kemal", "elvin", "sait", "mustafa"], maxPlayers: 4 });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "elvin",
          body: "@Match Time show the teams",
          route: "balancer",
          tagged: true,
          facts: { kind: "teams", action: "show", includeRefs: [], teamNames: null, swaps: [], pairings: [] },
        }),
      ],
    });
    expect(r.speech.some((s) => s.kind === "teams_not_generated")).toBe(true);
    expect(r.speech.some((s) => s.kind === "teams_post")).toBe(false);
    expect(r.outcomes[0].disposition).toBe("acted");
    expect(r.writes).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 2026-09-08 · THE DAVID INCIDENT — one refused clause threw away every
// other clause in the same message.
//
// Kemal posted to the live Sutton FC group, untagged, on match day:
//
//     "David is OUT voluntarily to switch to 5aside.
//
//      Either @Mojib Jalali or @Najib can be in the main squad and the
//      other can go to bench"
//
// MatchTime recorded NOTHING. The stored reasoning:
//
//     by=attendance-engine intent=conditional_in action=none
//     attendance-engine (other_att): requires an @Match Time tag
//     (interaction contract)
//
// David stayed in the squad and the owner corrected it by hand, twice.
//
// WHY: `ADMIN_REPORTED_OUT_IS_TAG_FREE` waives the tag for an admin only
// when the entries are ALL IN or OUT. The bench clause failed that
// `every`, and because the gate was taken once FOR THE WHOLE MESSAGE,
// the single refused clause took a clean, unambiguous "David is OUT"
// down with it.
//
// THE BENCH RULE IS NOT REVERSED. A demote is roster surgery and still
// needs a tag from everybody, the owner included. What changes is the
// GRANULARITY: the gate is asked per claim, the permitted claims are
// applied through the SAME path they always took, and the refused ones
// are named out loud rather than dropped in silence (§9).
//
// This is the fifth production incident in this repo where a compound
// message lost half its meaning. See the memory note on the
// terminal-short-circuit bug class: the decision was being taken for the
// whole message when it belonged to each part.
// ══════════════════════════════════════════════════════════════════════

describe("2026-09-08 · an admin's untagged [OUT + BENCH] (David / Mojib)", () => {
  const INCIDENT =
    "David is OUT voluntarily to switch to 5aside.\n\n" +
    "Either @Mojib Jalali or @Najib can be in the main squad and the other can go to bench";

  /** David and Mojib both in the squad, which is where that message landed. */
  const squad = () =>
    world({
      players: [...SUTTON, "david"],
      maxPlayers: 14,
      // Zair is in it too: two of the cases below are about an ordinary
      // member's OWN drop surviving beside a clause he may not make, and
      // a member who was never in the squad has no drop to lose.
      confirmed: [...FULL_14.slice(0, 11), "zair", "david", "mojib"],
    });

  /** The split the message makes: one third-party OUT, one third-party
   *  BENCH. Exactly the shape the old `every` refused wholesale. */
  const outAndBench = () =>
    attendanceFacts([
      claim({ subject: "other", personRef: "David", personNamed: true, polarity: "out" }),
      claim({ subject: "other", personRef: "Mojib", personNamed: true, polarity: "bench" }),
    ]);

  it("THE INCIDENT: David is DROPPED and Mojib is left alone", () => {
    const r = decide({
      now: NOW,
      state: squad(),
      messages: [
        msg({ from: "kemal", body: INCIDENT, route: "other_att", facts: outAndBench() }),
      ],
    });
    expect(statusOf(r.nextState, "david")).toBe("DROPPED");
    expect(statusOf(r.nextState, "mojib")).toBe("CONFIRMED");
    expect(attWrites(r.writes)).toHaveLength(1);
    expect(r.outcomes[0].disposition).toBe("acted");
    expect(r.degradations).toHaveLength(0);
  });

  it("the refusal of the BENCH half is RECORDED, naming the clause", () => {
    const r = decide({
      now: NOW,
      state: squad(),
      messages: [
        msg({ from: "kemal", body: INCIDENT, route: "other_att", facts: outAndBench() }),
      ],
    });
    const reasons = r.outcomes[0].reasons.join(" | ");
    expect(reasons).toMatch(/Mojib/);
    expect(reasons).toMatch(/tag/i);
  });

  it("the reason trail still names the WAIVER that carried the drop", () => {
    // The reason trail is the only place a wrong drop can be traced back
    // to a policy rather than to a model. The message-level form of this
    // check (`!needsTag && actionRequiresTag(gate)`) goes quiet on a
    // message that carries a waived drop AND a refused demote, which is
    // this incident exactly, so it is asked over the permitted claims.
    const r = decide({
      now: NOW,
      state: squad(),
      messages: [
        msg({ from: "kemal", body: INCIDENT, route: "other_att", facts: outAndBench() }),
      ],
    });
    expect(r.outcomes[0].reasons.join(" | ")).toMatch(/ADMIN_REPORTED_OUT_IS_TAG_FREE/);
  });

  it("SPEECH: MatchTime says what it did NOT do", () => {
    // §9: "message understood, action silently not taken" is this
    // product's signature failure, and a partially-applied instruction
    // the owner does not know was partial is exactly that.
    //
    // The sentence rides a turn MatchTime is already taking (David's
    // drop landed, and it was an ADMIN moving somebody else's row, which
    // is one of the two things that still posts the roster — S36b), so
    // it costs no extra message.
    const r = decide({
      now: NOW,
      state: squad(),
      messages: [
        msg({ from: "kemal", body: INCIDENT, route: "other_att", facts: outAndBench() }),
      ],
    });
    const s = r.speech.find((x) => x.kind === "needs_tag_for_rest");
    expect(s).toBeDefined();
    expect(s).toMatchObject({
      kind: "needs_tag_for_rest",
      entries: [{ name: "Mojib Sadat", action: "BENCH" }],
    });
    // …and the squad post it rides on is still there.
    expect(r.speech.some((x) => x.kind === "squad_status")).toBe(true);
  });

  it("THE LIMIT: the same message from a NON-admin applies NOTHING", () => {
    const r = decide({
      now: NOW,
      state: squad(),
      messages: [
        msg({ from: "zair", body: INCIDENT, route: "other_att", facts: outAndBench() }),
      ],
    });
    expect(statusOf(r.nextState, "david")).toBe("CONFIRMED");
    expect(statusOf(r.nextState, "mojib")).toBe("CONFIRMED");
    expect(r.writes).toHaveLength(0);
    expect(r.speech).toHaveLength(0);
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/requires an @Match Time tag/);
  });

  it("an admin's untagged [OUT, OUT] still applies BOTH (yesterday, unchanged)", () => {
    const r = decide({
      now: NOW,
      state: squad(),
      messages: [
        msg({
          from: "kemal",
          body: "David and Mojib are both out",
          route: "other_att",
          facts: attendanceFacts([
            claim({ subject: "other", personRef: "David", personNamed: true, polarity: "out" }),
            claim({ subject: "other", personRef: "Mojib", personNamed: true, polarity: "out" }),
          ]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "david")).toBe("DROPPED");
    expect(statusOf(r.nextState, "mojib")).toBe("DROPPED");
    expect(r.speech.some((x) => x.kind === "needs_tag_for_rest")).toBe(false);
  });

  it("an admin's untagged [BENCH] ALONE still applies nothing (unchanged)", () => {
    const r = decide({
      now: NOW,
      state: squad(),
      messages: [
        msg({
          from: "kemal",
          body: "put Mojib on the bench",
          route: "other_att",
          facts: attendanceFacts([
            claim({ subject: "other", personRef: "Mojib", personNamed: true, polarity: "bench" }),
          ]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "mojib")).toBe("CONFIRMED");
    expect(r.writes).toHaveLength(0);
    // SILENT. The refusal only ever rides a turn MatchTime was already
    // taking; a lone sentence on an untagged message is the chattiness
    // the interaction contract exists to prevent.
    expect(r.speech).toHaveLength(0);
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/requires an @Match Time tag/);
  });

  it("an admin's TAGGED [OUT + BENCH] applies BOTH (unchanged)", () => {
    const r = decide({
      now: NOW,
      state: squad(),
      messages: [
        msg({
          from: "kemal",
          body: "@Match Time " + INCIDENT,
          tagged: true,
          route: "other_att",
          facts: outAndBench(),
        }),
      ],
    });
    expect(statusOf(r.nextState, "david")).toBe("DROPPED");
    expect(statusOf(r.nextState, "mojib")).toBe("BENCH");
    expect(r.speech.some((x) => x.kind === "needs_tag_for_rest")).toBe(false);
  });

  // ── THE APPLY PATH IS THE SAME ONE ────────────────────────────────
  //
  // A drop opens a slot and the apply layer offers it to the bench
  // (`attendance.ts:cancelAttendance` → `requestBenchConfirmationOnDrop`),
  // reading the write the engine proposes. A PARTIALLY applied
  // instruction must therefore produce the byte-identical write, or the
  // vacated slot is offered differently, or not at all.
  it("the partially-applied drop proposes exactly the write a clean drop proposes", () => {
    const run = (facts: ReturnType<typeof outAndBench>) =>
      decide({
        now: NOW,
        state: squad(),
        messages: [
          msg({ id: "wa-fixed", from: "kemal", body: INCIDENT, route: "other_att", facts }),
        ],
      });
    const partial = attWrites(run(outAndBench()).writes);
    const clean = attWrites(
      run(
        attendanceFacts([
          claim({ subject: "other", personRef: "David", personNamed: true, polarity: "out" }),
        ]),
      ).writes,
    );
    expect(partial).toHaveLength(1);
    expect(partial).toEqual(clean);
    expect(partial[0].status).toBe("DROPPED");
  });

  it("the freed slot is still offered to the bench off the partial apply", () => {
    // The engine's half of the offer chain: the `open_bench_offer` write
    // and the sentence that goes with it, both fired by the drop that
    // survived the split.
    const state = world({
      players: [...SUTTON, "david"],
      maxPlayers: 14,
      confirmed: [...FULL_14.slice(0, 13), "david"],
      bench: ["mojib"],
    });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({ from: "kemal", body: INCIDENT, route: "other_att", facts: outAndBench() }),
      ],
    });
    expect(statusOf(r.nextState, "david")).toBe("DROPPED");
    expect(r.writes.some((w) => w.kind === "open_bench_offer")).toBe(true);
    expect(r.speech.some((x) => x.kind === "bench_offer_open")).toBe(true);
    // Mojib is on the bench and the BENCH clause was refused, so he is
    // exactly where he was: on the bench, and now one of the people the
    // freed slot is offered to.
    expect(statusOf(r.nextState, "mojib")).toBe("BENCH");
  });

  // ── The other half of the granularity bug: the SENDER's own claim ──
  it("a member's own claim survives beside a third-party clause it may not make", () => {
    // "I'm out, and put Mojib on the bench" from an ordinary member.
    // Before the split, the bench clause discarded the sender's own drop
    // too, and the club turned up short with a player in the list who
    // had said he was not coming.
    const r = decide({
      now: NOW,
      state: squad(),
      messages: [
        msg({
          from: "zair",
          body: "I'm out lads, put Mojib on the bench",
          route: "other_att",
          facts: attendanceFacts([
            claim({ polarity: "out" }),
            claim({ subject: "other", personRef: "Mojib", personNamed: true, polarity: "bench" }),
          ]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "zair")).toBe("DROPPED");
    expect(statusOf(r.nextState, "mojib")).toBe("CONFIRMED");
  });

  // ── The collapse runs BEFORE the split, and it has to ──────────────
  it("two claims about the SAME person are collapsed first, so the LAST one is gated", () => {
    // "Mojib is in… actually put Mojib on the bench" from an admin,
    // untagged. Gating the raw claim list would refuse the BENCH, keep
    // the earlier IN and register the man the message just demoted —
    // the correction reversed, which is the shape the per-person
    // collapse already existed to prevent.
    const r = decide({
      now: NOW,
      state: world({ players: [...SUTTON, "david"], maxPlayers: 14, confirmed: [...FULL_14.slice(0, 12)] }),
      messages: [
        msg({
          from: "kemal",
          body: "Mojib is in. Actually no, put him on the bench",
          route: "other_att",
          facts: attendanceFacts([
            claim({ subject: "other", personRef: "Mojib", personNamed: true, polarity: "in" }),
            claim({ subject: "other", personRef: "Mojib", personNamed: true, polarity: "bench" }),
          ]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "mojib")).toBe("ABSENT");
    expect(r.writes).toHaveLength(0);
  });

  // ── The recruit waiver reaches exactly as far as the OUT waiver ────
  it("PR #33's recruit waiver does NOT carry a BENCH either", () => {
    // `addressedByRecruit` stands in for the tag, and it is model
    // output ("this sentence asks for players") rather than the Pi's
    // structured mention list. The bench rule's "second, independent
    // signal" cannot be an inference, so the waiver reaches an OUT and
    // stops there. The OUT half still lands, which is PR #33 working.
    const r = decide({
      now: NOW,
      state: squad(),
      messages: [
        msg({
          from: "kemal",
          body: "David is out, put Mojib on the bench. We need one more player",
          route: "other_att",
          facts: attendanceFacts(
            [
              claim({ subject: "other", personRef: "David", personNamed: true, polarity: "out" }),
              claim({ subject: "other", personRef: "Mojib", personNamed: true, polarity: "bench" }),
            ],
            { sideRequests: ["recruit"] },
          ),
        }),
      ],
    });
    expect(statusOf(r.nextState, "david")).toBe("DROPPED");
    expect(statusOf(r.nextState, "mojib")).toBe("CONFIRMED");
  });

  it("a NON-admin's untagged [self OUT + third-party OUT] applies only the self half", () => {
    const r = decide({
      now: NOW,
      state: squad(),
      messages: [
        msg({
          from: "zair",
          body: "I'm out and David is out too",
          route: "other_att",
          facts: attendanceFacts([
            claim({ polarity: "out" }),
            claim({ subject: "other", personRef: "David", personNamed: true, polarity: "out" }),
          ]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "zair")).toBe("DROPPED");
    expect(statusOf(r.nextState, "david")).toBe("CONFIRMED");
    const s = r.speech.find((x) => x.kind === "needs_tag_for_rest");
    expect(s).toMatchObject({ entries: [{ name: "David", action: "OUT" }] });
  });

  it("a refused clause naming NOBODY on the roster is never spoken about", () => {
    // The refusal sentence names people, and the only names it may
    // print are the roster's. An unresolvable reference would have been
    // refused by identity.ts anyway ("not a member; nothing to drop or
    // bench"), so there is nothing to tell the group.
    const r = decide({
      now: NOW,
      state: squad(),
      messages: [
        msg({
          from: "kemal",
          body: "David is out, bench Ronaldo",
          route: "other_att",
          facts: attendanceFacts([
            claim({ subject: "other", personRef: "David", personNamed: true, polarity: "out" }),
            claim({ subject: "other", personRef: "Ronaldo", personNamed: true, polarity: "bench" }),
          ]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "david")).toBe("DROPPED");
    expect(r.speech.some((x) => x.kind === "needs_tag_for_rest")).toBe(false);
  });

  it("a refused clause is NOT spoken about when nothing was applied at all", () => {
    // David is already DROPPED, so the permitted half writes nothing and
    // MatchTime takes no turn. The refusal has no turn to ride and stays
    // in the reason trail, where the operator log can see it.
    const state = world({
      players: [...SUTTON, "david"],
      maxPlayers: 14,
      confirmed: [...FULL_14.slice(0, 12), "mojib"],
      dropped: ["david"],
    });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({ from: "kemal", body: INCIDENT, route: "other_att", facts: outAndBench() }),
      ],
    });
    expect(r.writes).toHaveLength(0);
    expect(r.speech).toHaveLength(0);
    expect(r.outcomes[0].reasons.join(" | ")).toMatch(/Mojib/);
  });
});

// ── S43 · a claimless affirmation on a self_att route (2026-09-09) ─────
//
// THE INCIDENT. Four players typed the single word "In" for Tuesday's
// match inside twenty minutes. Two were registered and two were
// silently discarded:
//
//   19:37:58  Wasim   "In"  -> intent=in    action=IN
//   19:47:55  Abid    "In"  -> intent=noise action=none
//   19:57:58  Mojib   "In"  -> intent=noise action=none
//   19:57:59  habib   "In"  -> intent=in    action=IN
//
// Mojib and habib are ONE SECOND apart, in the SAME batch, with the
// same word, and got opposite outcomes. All four resolved to real
// members. Neither Abid nor Mojib was in the squad; neither saw a tick;
// both believed they were in. Kemal noticed, not the system.
//
// The extractor read the two that died as `claims: []` with
// `affirmation: "yes"` — a bare answer to MatchTime's last post rather
// than the sender's own claim about themselves. `handleAttendance` then
// looked for a pending set in that post, found none, and RETURNED:
// "message understood, action silently not taken", §9's named signature
// failure, verbatim.
//
// The measured claimless rate for "In" in that conversation window was
// 14 of 20 (`scripts/measure-claimless.ts`). No amount of prompt work
// makes it zero, so the ENGINE has to be right when extraction wobbles.
describe("S43 · a claimless affirmation is resolved, not discarded (2026-09-09, Abid + Mojib)", () => {
  /** Exactly what the extractor returned for Abid's and Mojib's "In". */
  const bareAffirmation = () => attendanceFacts([], { affirmation: "yes" });

  it("THE INCIDENT: a resolved member's claimless 'In' on self_att is CONFIRMED", () => {
    const state = world({ confirmed: ["kemal", "elvin", "sait"] });
    const r = decide({
      now: NOW,
      state,
      messages: [msg({ from: "mojib", body: "In", route: "self_att", facts: bareAffirmation() })],
    });
    expect(statusOf(r.nextState, "mojib")).toBe("CONFIRMED");
  });

  it("all four of the real messages register, not two of them", () => {
    const state = world({ confirmed: ["kemal", "elvin", "sait"] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        // Wasim and habib came back WITH a claim; Abid and Mojib did not.
        // The whole point is that the outcome must not depend on which.
        msg({ from: "wasim", body: "In", route: "self_att", facts: attendanceFacts([claim()]) }),
        msg({ from: "abid", body: "In", route: "self_att", facts: bareAffirmation() }),
        msg({ from: "mojib", body: "In", route: "self_att", facts: bareAffirmation() }),
        msg({ from: "habib", body: "In", route: "self_att", facts: attendanceFacts([claim()]) }),
      ],
    });
    for (const who of ["wasim", "abid", "mojib", "habib"]) {
      expect(statusOf(r.nextState, who)).toBe("CONFIRMED");
    }
  });

  it("the fallback is not a word list: it never reads the message body", () => {
    // Kemal: "not just in, anyone can say yes, count me, sure. Many
    // different words." The engine is told by the ROUTER that this is
    // the sender's own attendance and by the EXTRACTOR that the sender
    // affirmed. Neither of those is a word, so the body can be anything
    // a player might type — including something nobody has thought of.
    for (const body of ["count me", "sure", "go on then", "aye", "why not", "yep me too"]) {
      const r = decide({
        now: NOW,
        state: world({ confirmed: ["kemal"] }),
        messages: [msg({ from: "mojib", body, route: "self_att", facts: bareAffirmation() })],
      });
      expect(statusOf(r.nextState, "mojib"), `body=${JSON.stringify(body)}`).toBe("CONFIRMED");
    }
  });

  it("says WHY in the reason trail, naming the route it leaned on", () => {
    const r = decide({
      now: NOW,
      state: world({ confirmed: ["kemal"] }),
      messages: [msg({ from: "mojib", body: "In", route: "self_att", facts: bareAffirmation() })],
    });
    expect(r.outcomes[0].reasons.join(" | ")).toMatch(/self_att/);
  });

  it("a bare 'yes' the ROUTER did not call self-attendance still registers nobody", () => {
    // The negative case, and the tension worth stating plainly: "yes"
    // is on both lists. What separates them is not the word, it is
    // whether the router — which sees the whole batch — read the
    // message as the sender joining this match. A "yes" answering
    // "@Wasim can Najib come please?" routed `none` in production on
    // 2026-09-08 and must keep doing nothing here.
    for (const route of ["other_att", "unsure", "offer"] as const) {
      const r = decide({
        now: NOW,
        state: world({ confirmed: ["kemal"] }),
        messages: [msg({ from: "mojib", body: "yes", route, facts: bareAffirmation() })],
      });
      expect(r.writes, `route=${route}`).toHaveLength(0);
      expect(statusOf(r.nextState, "mojib"), `route=${route}`).toBe("ABSENT");
    }
  });

  it("'ok 👍' with nothing to answer registers nobody", () => {
    const r = decide({
      now: NOW,
      state: world({ confirmed: ["kemal"] }),
      messages: [
        msg({ from: "mojib", body: "ok 👍", route: "other_att", facts: bareAffirmation() }),
      ],
    });
    expect(r.writes).toHaveLength(0);
    expect(r.speech).toHaveLength(0);
  });

  it("an affirmation from an UNRESOLVED sender writes nothing", () => {
    // Same treatment a claimful "In" from an unresolved sender gets: no
    // write, and the §9 unresolved-sender degradation so it is not
    // silence. Never a registration for a person the roster cannot name.
    const r = decide({
      now: NOW,
      state: world({ confirmed: ["kemal"] }),
      messages: [msg({ from: null, body: "In", route: "self_att", facts: bareAffirmation() })],
    });
    expect(r.writes).toHaveLength(0);
    expect(r.degradations.some((d) => /sender could not be resolved/i.test(d.detail))).toBe(true);
  });

  it("a claimless affirmation on an org that does not track attendance writes nothing", () => {
    const r = decide({
      now: NOW,
      state: world({ confirmed: ["kemal"], features: { attendance: false } }),
      messages: [msg({ from: "mojib", body: "In", route: "self_att", facts: bareAffirmation() })],
    });
    expect(r.writes).toHaveLength(0);
  });

  it("the S25 pending-set path still wins when there IS a pending set", () => {
    // Unchanged, deliberately: the pending set is a KNOWN OBJECT and a
    // lookup beats an inference. `parsePendingSet` runs first and the
    // self_att fallback only sees what it leaves behind.
    const state = world({
      confirmed: ["kemal", "elvin", "sait", "mustafa", "abid", "idris"],
      lastBotPost:
        "Got it 🙌 Pending — waiting for confirmation: Faris Nasser, Shaz Iqbal. Say the word and I'll lock them in.",
    });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({ from: "amir", body: "Confirmed", route: "other_att", facts: bareAffirmation() }),
      ],
    });
    expect(statusOf(r.nextState, "faris")).toBe("CONFIRMED");
    expect(statusOf(r.nextState, "shaz")).toBe("CONFIRMED");
    expect(statusOf(r.nextState, "amir")).toBe("ABSENT");
  });

  it("a claimless affirmation with NO active match degrades rather than going silent", () => {
    const r = decide({
      now: NOW,
      state: world({ confirmed: [], noMatch: true }),
      messages: [msg({ from: "mojib", body: "In", route: "self_att", facts: bareAffirmation() })],
    });
    expect(r.writes).toHaveLength(0);
    expect(r.degradations.some((d) => /no active registration match/i.test(d.detail))).toBe(true);
  });

  it("a claimless affirmation on a FULL squad goes to the bench, not nowhere", () => {
    // Proof that the synthesised claim runs the whole gauntlet below the
    // branch rather than being written straight out: capacity is
    // arithmetic the engine does after the claim exists.
    const state = world({ maxPlayers: 14, confirmed: FULL_14 });
    const r = decide({
      now: NOW,
      state,
      messages: [msg({ from: "mojib", body: "In", route: "self_att", facts: bareAffirmation() })],
    });
    expect(statusOf(r.nextState, "mojib")).toBe("BENCH");
  });

  it("a claimless affirmation beside a chase nudge is still the sender's own IN", () => {
    // `chase` on its own returns early ("no attendance change"). It must
    // not swallow the sender's affirmation with it — that is the same
    // shape as the 2026-05-28 incident where a chase dropped its asker.
    const r = decide({
      now: NOW,
      state: world({ confirmed: ["kemal"] }),
      messages: [
        msg({
          from: "mojib",
          body: "In, need a couple more lads",
          route: "self_att",
          facts: attendanceFacts([], { affirmation: "yes", sideRequests: ["chase"] }),
        }),
      ],
    });
    expect(statusOf(r.nextState, "mojib")).toBe("CONFIRMED");
  });
});

// ── S43b · the residue: self_att with nothing in it at all ─────────────
describe("S43b · a `self_att` message the extractor read as empty is a SIGNAL, not silence", () => {
  it("degrades when the router says self_att and the extractor returns nothing at all", () => {
    // The mirror of the `route === "none"` disagreement detector at the
    // top of the loop. Measured at 2 of 20 on "count me": the extractor
    // returns no claim AND no affirmation, so there is no polarity to
    // write and nothing to resolve — but a phrasing Kemal named by name
    // failing 10% of the time must reach an operator.
    const r = decide({
      now: NOW,
      state: world({ confirmed: ["kemal"] }),
      messages: [
        msg({ from: "mojib", body: "count me", route: "self_att", facts: attendanceFacts([]) }),
      ],
    });
    expect(r.writes).toHaveLength(0);
    expect(
      r.degradations.some((d) => /router said `self_att` but the extractor returned no claim/.test(d.detail)),
    ).toBe(true);
  });

  it("does NOT degrade for the same emptiness on any other route", () => {
    // `other_att`, `offer` and `unsure` are all routes where "nothing to
    // report" is an ordinary answer, and an operator note per benign
    // message is how a signal becomes noise nobody reads.
    for (const route of ["other_att", "offer", "unsure"] as const) {
      const r = decide({
        now: NOW,
        state: world({ confirmed: ["kemal"] }),
        messages: [msg({ from: "mojib", body: "hmm", route, facts: attendanceFacts([]) })],
      });
      expect(r.degradations, `route=${route}`).toHaveLength(0);
      expect(r.outcomes[0].reasons.join(" | "), `route=${route}`).toContain("no claims extracted");
    }
  });

  it("does NOT degrade when the affirmation gave it a pointer to try", () => {
    // An affirmation the engine could not resolve already has its own
    // reason line and is a different thing from finding nothing at all.
    const r = decide({
      now: NOW,
      state: world({ confirmed: ["kemal"] }),
      messages: [
        msg({
          from: "mojib",
          body: "Confirmed",
          route: "other_att",
          facts: attendanceFacts([], { affirmation: "yes" }),
        }),
      ],
    });
    expect(r.degradations).toHaveLength(0);
    expect(r.outcomes[0].reasons.join(" | ")).toContain("no pending set");
  });
});

// ── S43c · the tension, written down rather than hidden ────────────────
//
// "yes" is on BOTH lists. Kemal, naming what must register: "not just
// in, anyone can say yes, count me, sure. Many different words." And the
// same word, answering something else, must register nobody.
//
// What separates them is not the word. It is the batch, and the ROUTER
// is the only stage that sees the batch. Measured on the live router, 20
// runs each:
//
//   "yes" alone in a batch                          self_att 20/20
//   "sure" alone in a batch                         self_att 20/20
//   "Yes" under "@Wasim can Najib come please?"     none     20/20   ← live, 2026-09-08
//   "yes" under "did anyone watch the Como game?"   none     20/20
//   "sure" under "could you bring the bibs?"        none 19/20, admin_ops 1/20
//
// So the engine does not have to choose between Kemal's two sentences,
// and it does not need a word list to honour both. These two tests pin
// the two halves, and the second one is the behaviour CHANGE — stated
// out loud because it is a change, on the most ambiguous word there is.
describe("S43c · the same bare word, both ways round", () => {
  const bare = () => attendanceFacts([], { affirmation: "yes" });

  it("a bare 'yes' answering something else registers nobody (router: none/other_att)", () => {
    const r = decide({
      now: NOW,
      state: world({ confirmed: ["kemal"] }),
      messages: [
        msg({ from: "kemal", body: "@Wasim can Najib come please?", route: "other_att", facts: attendanceFacts([]) }),
        msg({ from: "wasim", body: "Yes", route: "none", facts: { kind: "none" } }),
      ],
    });
    expect(r.writes).toHaveLength(0);
    expect(statusOf(r.nextState, "wasim")).toBe("ABSENT");
  });

  it("a bare 'yes' the router read as the sender's own attendance DOES register them", () => {
    // THE DELIBERATE CHANGE. Before this, an unresolvable affirmation
    // was discarded whatever the route, which is what cost Abid and
    // Mojib their places. After it, a member whose message stage 1 read
    // as "joining this match themselves" is registered — and the cost of
    // being wrong is one ✅ they undo with one word, against a slot they
    // lose in silence.
    const r = decide({
      now: NOW,
      state: world({ confirmed: ["kemal"] }),
      messages: [msg({ from: "mojib", body: "yes", route: "self_att", facts: bare() })],
    });
    expect(statusOf(r.nextState, "mojib")).toBe("CONFIRMED");
  });
});
