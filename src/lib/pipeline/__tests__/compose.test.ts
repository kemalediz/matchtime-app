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
import { en } from "@/lib/i18n/strings.en";
import { decide } from "./support/stub-picks";
import {
  composeSquadStatusPost,
  contradictsSquadState,
  displaysSquadState,
} from "../../group-copy";
import { NOW, SUTTON, attendanceFacts, claim, fullName, msg, world } from "./helpers";
import type { EngineResult, SquadState } from "../types";

/** The stats tables a stats question reads (2026-09-23): appearances on
 *  the club's full record, since the 30-day `SquadState.appearances`
 *  was retired. */
function withAppearances(state: SquadState, rows: Array<{ key: string; matches: number }>): SquadState {
  return {
    ...state,
    stats: {
      fullTableUrl: "https://matchtime.ai/profile/stats",
      ratings: [],
      mom: [],
      elo: [],
      teamOfSeason: null,
      mrReliable: [],
      aliases: [],
      chemistry: {},
      generic: {},
      appearances: rows.map((r) => ({ userId: `u-${r.key}`, name: fullName(r.key), matches: r.matches })),
      recordsStart: { matches: rows.length ? new Date("2026-04-14T20:00:00.000Z") : null, mom: null },
      periods: {},
    },
  };
}

function composeFor(state: SquadState, messages: Parameters<typeof decide>[0]["messages"]) {
  const result: EngineResult = decide({ now: NOW, state, messages });
  return { result, out: compose(result) };
}

const TEN = ["kemal", "elvin", "sait", "mustafa", "abid", "idris", "faris", "shaz", "adam", "efat"];

/** A tagged "who's playing?", which is what MAKES the batch-level roster
 *  post since 2026-09-09 (S36b). The post is demand-driven now: an
 *  attendance change on its own produces the ✅ and nothing else, so a
 *  test about the post's CONTENT has to ask for it. */
const rosterAsk = (from: string) =>
  msg({
    from,
    body: "@Match Time who's playing?",
    route: "question",
    tagged: true,
    facts: { kind: "question", topic: "squad", personRef: null },
  });

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
      rosterAsk("adam"),
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
          rosterAsk("adam"),
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
          rosterAsk("adam"),
        ],
      }),
    );
    expect(b.utterances.map((u) => u.text).join()).not.toMatch(/Bench \(/);
  });

  it("says NOTHING at all for a batch that only changed the squad (2026-09-09)", () => {
    // The other half of the property above, and the reason this file
    // needed `rosterAsk`. Kemal, on the live group: "for every IN, MT is
    // responding with the squad. I think that is overmessaging. Only a
    // tick is enough."
    const { out } = composeFor(world({ confirmed: TEN }), [
      msg({ from: "usama", body: "in", route: "self_att", facts: attendanceFacts([claim({})]) }),
      msg({ from: "karahan", body: "in", route: "self_att", facts: attendanceFacts([claim({})]) }),
    ]);
    expect(out.utterances).toEqual([]);
    // …and the players are still told, by the ✅ each message gets.
    expect(out.reacts.map((r) => r.emoji)).toEqual(["✅", "✅"]);
  });

  it("says exactly one thing for a batch of three squad messages (§3.2 S36)", () => {
    const state = world({ confirmed: TEN });
    const { out } = composeFor(state, [
      msg({ from: "usama", body: "in", route: "self_att", facts: attendanceFacts([claim({})]) }),
      msg({ from: "karahan", body: "in", route: "self_att", facts: attendanceFacts([claim({})]) }),
      msg({
        from: "zair",
        body: "@Match Time what's the list now?",
        route: "question",
        tagged: true,
        facts: { kind: "question", topic: "squad", personRef: null },
      }),
    ]);
    expect(out.utterances).toHaveLength(1);
    expect(out.utterances[0].text).toContain("12/14");
  });
});

describe("the guest name ask", () => {
  // An organiser's offer (friend link D1, 2026-10-31): a player's gets a
  // friend link instead (engine-friend-link.test.ts).
  it("asks for one name in the singular", () => {
    const state = world({ confirmed: TEN.slice(0, 7) });
    const { out } = composeFor(state, [
      msg({
        from: "elvin",
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

  it("asks for names in the plural when more than one unnamed person was offered (claims, not words)", () => {
    const state = world({ confirmed: [...TEN, "usama"] });
    const { out } = composeFor(state, [
      msg({
        from: "elvin",
        body: "my cousin and a mate can play",
        route: "other_att",
        facts: attendanceFacts([
          claim({ subject: "other", personRef: "my cousin", personNamed: false, polarity: "in" }),
          claim({ subject: "other", personRef: "a mate", personNamed: false, polarity: "in" }),
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

// ── §3.2 S16 / S19 · the three answers the 2026-09-06 sweep asked for ──
//
// Each of these was a SILENCE or the wrong answer before this block.
// Twelve tagged questions were replayed against the live Sutton squad on
// 2026-09-06: four produced nothing at all, three answered a roster
// request with a bare count, and one posted a team sheet with nobody on
// it.

describe("a roster question is answered with the roster (2026-09-06 sweep)", () => {
  it("renders the squad post itself, not `We're 11/14`", () => {
    const state = world({ confirmed: [...TEN, "usama"], bench: ["karahan"] });
    const { out } = composeFor(state, [
      msg({
        from: "adam",
        body: "@Match Time who's playing?",
        route: "question",
        tagged: true,
        facts: { kind: "question", topic: "squad", personRef: null },
      }),
    ]);
    const text = out.utterances[0].text;
    // The point of the change: NAMES, and every one of them.
    for (const who of ["Kemal Ediz", "Usama Tariq", "Karahan Yildiz"]) {
      expect(text).toContain(who);
    }
    // Not an approximation of the roster post — the roster post.
    expect(text).toBe(
      composeSquadStatusPost({
        confirmed: [...TEN, "usama"].map(fullName),
        bench: ["Karahan Yildiz"],
        maxPlayers: 14,
      }),
    );
  });

  it("says it ONCE when the same batch also changed the squad (§3.2 S36)", () => {
    // The roster question is answered BY the batch's own squad post.
    // Two rosters one line apart is the 2026-06-12 Sutton Lads shape.
    const state = world({ confirmed: TEN });
    const { out } = composeFor(state, [
      msg({
        from: "usama",
        body: "in",
        route: "self_att",
        facts: attendanceFacts([claim({ polarity: "in" })]),
      }),
      msg({
        from: "adam",
        body: "@Match Time who's playing?",
        route: "question",
        tagged: true,
        facts: { kind: "question", topic: "squad", personRef: null },
      }),
    ]);
    expect(out.utterances.filter((u) => /Playing:/.test(u.text))).toHaveLength(1);
  });
});

describe("showing teams that do not exist (2026-09-06 sweep)", () => {
  it("says so, instead of posting two empty team lists", () => {
    // The measured defect: `formatTeamsPost` over two empty arrays
    // rendered "⚽ *Teams for tonight* … *Red*:\n\n\n*Yellow*:\n\n\n" —
    // a team sheet with nobody on it.
    const state = world({ confirmed: TEN });
    const { out } = composeFor(state, [
      msg({
        from: "elvin",
        body: "@Match Time show me the teams",
        route: "balancer",
        tagged: true,
        facts: { kind: "teams", action: "show", includeRefs: [], teamNames: null, swaps: [], pairings: [] },
      }),
    ]);
    const text = out.utterances[0].text;
    expect(text).toMatch(/no teams generated yet/i);
    expect(text).not.toContain("Teams for tonight");
  });
});

// ── the open-slot line (2026-09-15) ────────────────────────────────────

describe("a drop that opens a spot says so, in one line", () => {
  const FULL = [
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

  /** The DB truth the analyze route hands `composeSquadStateReply`
   *  AFTER the batch's writes land — which is what decides whether this
   *  sentence survives to the group or is replaced by the roster. */
  const truthAfter = (outKeys: string[]) => ({
    confirmed: FULL.filter((k) => !outKeys.includes(k)).map(fullName),
    bench: [],
    maxPlayers: 14,
  });

  const selfOut = (from: string, body: string) =>
    msg({ from, body, route: "self_att", facts: attendanceFacts([claim({ polarity: "out" })]) });

  it("names the player, the count and the way in — the 2026-09-15 incident", () => {
    const { out } = composeFor(world({ confirmed: FULL }), [
      selfOut("abid", "foot injury, I am out today"),
    ]);
    expect(out.utterances).toHaveLength(1);
    expect(out.utterances[0].text).toBe(
      "Abid is out, 13 of 14 for Tue 21:30. One slot open, say *IN* to take it.",
    );
  });

  it("rides the drop message, so the route does not throw the copy away", () => {
    // `attendance-engine-batch.ts` keeps a `messageId: null` utterance
    // only as a BOOLEAN — the text is dropped and `route.ts` expands
    // `[SQUAD]` into the roster instead. A batch-level utterance here
    // would never reach the group.
    const { out } = composeFor(world({ confirmed: FULL }), [
      selfOut("abid", "foot injury, I am out today"),
    ]);
    expect(out.utterances[0].messageId).not.toBeNull();
  });

  it("carries NO slash, so the route cannot mistake it for a roster", () => {
    // `displaysSquadState` rule (c) is an "N/M" beside squad vocabulary,
    // and anything it recognises is REPLACED by the fourteen-line roster
    // (`route.ts`, `composeSquadStateReply`). "13 of 14" says the same
    // thing to a human and survives. This is the trap that kept the
    // STATS and OPTIONS answers refused for months.
    const { out } = composeFor(world({ confirmed: FULL }), [
      selfOut("abid", "foot injury, I am out today"),
    ]);
    expect(displaysSquadState(out.utterances[0].text)).toBe(false);
  });

  it("is CHECKED against the database, and survives when it is right", () => {
    // Both halves are shapes `contradictsSquadState` reads: "Abid is
    // out" is a DROPPED move claim, and "One slot open" is measured
    // against the real shortfall. Saying "spot" instead of "slot" would
    // have escaped the check, which is the wrong kind of clever.
    const { out } = composeFor(world({ confirmed: FULL }), [
      selfOut("abid", "foot injury, I am out today"),
    ]);
    expect(contradictsSquadState(out.utterances[0].text, truthAfter(["abid"]))).toBe(false);
  });

  it("is REPLACED by the roster when the database has moved on", () => {
    // Somebody filled the slot between the engine's projection and the
    // post-write snapshot. The sentence now claims a slot that is not
    // open, `contradictsSquadState` says so, and the composed roster
    // wins. Truth beats copy.
    const { out } = composeFor(world({ confirmed: FULL }), [
      selfOut("abid", "foot injury, I am out today"),
    ]);
    const refilled = { confirmed: FULL.map(fullName), bench: [], maxPlayers: 14 };
    expect(contradictsSquadState(out.utterances[0].text, refilled)).toBe(true);
  });

  it("names every player who went out, in one sentence", () => {
    const { out } = composeFor(world({ confirmed: FULL }), [
      selfOut("abid", "out today lads"),
      selfOut("zair", "cant make it sorry"),
      selfOut("shaz", "im out"),
    ]);
    expect(out.utterances).toHaveLength(1);
    expect(out.utterances[0].text).toBe(
      "Abid, Zair and Shaz are out, 11 of 14 for Tue 21:30. 3 slots open, say *IN* to take one.",
    );
    expect(
      contradictsSquadState(out.utterances[0].text, truthAfter(["abid", "zair", "shaz"])),
    ).toBe(false);
  });

  it("says nobody is OUT when the slot was vacated by a move to the bench", () => {
    // A confirmed player asking for the bench off a full squad opens a
    // slot without anybody being out, and "Wasim is out" would be a
    // sentence the database does not support.
    const { out } = composeFor(world({ confirmed: FULL }), [
      msg({
        from: "wasim",
        body: "stick me on the bench tonight lads",
        route: "self_att",
        facts: attendanceFacts([claim({ polarity: "bench", benchAsked: true })]),
      }),
    ]);
    expect(out.utterances).toHaveLength(1);
    expect(out.utterances[0].text).toBe(
      "That's 13 of 14 for Tue 21:30. One slot open, say *IN* to take it.",
    );
  });

  it("says NOTHING for an IN — PR #63's rule is untouched", () => {
    const { out } = composeFor(world({ confirmed: FULL.slice(0, 10) }), [
      msg({ from: "habib", body: "in", route: "self_att", facts: attendanceFacts([claim({})]) }),
    ]);
    expect(out.utterances).toHaveLength(0);
    expect(out.reacts.map((r) => r.emoji)).toEqual(["✅"]);
  });
});

// ── THE REPLACEMENT POST — the 2026-09-15 copy ────────────────────────
//
// The owner, having repaired the night by hand and posted the result
// himself:
//
//   "match time should let people know that Wasim is out, instead
//    Shakruh will play and these are the teams. And when displaying
//    those teams, it should indicate Wasim is replaced with Shakruh in
//    the respective team… There is no point listing all the 14 players
//    after the teams were announced."
//
// So: one post, the TEAMS and not the roster, the swap named in the lead
// AND marked on the line the replacement took.
describe("the replacement post says who is out, who is in, and the teams", () => {
  const SHEET: Record<string, "RED" | "YELLOW"> = {
    kemal: "RED",
    mustafa: "RED",
    idris: "RED",
    najib: "RED",
    efat: "RED",
    mojib: "RED",
    karahan: "RED",
    elvin: "YELLOW",
    adam: "YELLOW",
    erdal: "YELLOW",
    sait: "YELLOW",
    habib: "YELLOW",
    faris: "YELLOW",
    wasim: "YELLOW",
  };
  const SEATED = Object.keys(SHEET);
  const ROSTER = [...SUTTON, "shahrokh"];

  const amirRegistersShahrokh = () =>
    msg({
      from: "amir",
      body: "Shahrokh can play in sha Allah",
      route: "other_att",
      facts: attendanceFacts([
        claim({ subject: "other", personRef: "Shahrokh", personNamed: true, polarity: "in" }),
      ]),
    });

  const staleSheet = (extra: Record<string, unknown> = {}) =>
    world({
      players: ROSTER,
      confirmed: SEATED.filter((k) => k !== "wasim"),
      dropped: ["wasim"],
      teams: SHEET,
      ...extra,
    });

  it("THE POST, in full", () => {
    const { out } = composeFor(staleSheet(), [amirRegistersShahrokh()]);
    expect(out.utterances).toHaveLength(1);
    expect(out.utterances[0].text).toBe(
      [
        "🔁 *Wasim is out*. *Shahrokh* takes his place and his spot in *Yellow*.",
        "",
        "⚽ *Teams for tonight*: Tue 21:30 at Goals North Cheam",
        "",
        "*Red*:",
        "1. Kemal Ediz",
        "2. Mustafa Kaya",
        "3. Idris Bello",
        "4. Najib Ahmadi",
        "5. Efat Rahman",
        "6. Mojib Sadat",
        "7. Karahan Yildiz",
        "",
        "*Yellow*:",
        "1. Elvin Aliyev",
        "2. Adam Osman",
        "3. Erdal Ozkan",
        "4. Sait Demir",
        "5. Habib Rahman",
        "6. Faris Nasser",
        "7. Shahrokh  (replacing Wasim)",
        "",
        "Objections? An admin can ask me to regenerate the teams.",
      ].join("\n"),
    );
  });

  it("it rides the message, so the route cannot replace it with a roster", () => {
    const { out } = composeFor(staleSheet(), [amirRegistersShahrokh()]);
    expect(out.utterances[0].messageId).not.toBeNull();
  });

  it("it uses the match's OWN labels, never the words Red and Yellow", () => {
    const state = staleSheet();
    state.teamLabels = ["Bibs", "Skins"];
    const { out } = composeFor(state, [amirRegistersShahrokh()]);
    expect(out.utterances[0].text).toContain("his spot in *Skins*");
    expect(out.utterances[0].text).toContain("*Skins*:");
    expect(out.utterances[0].text).not.toContain("Yellow");
  });

  it("two replacements are named in one lead and marked on their own lines", () => {
    const state = world({
      players: ROSTER,
      confirmed: SEATED.filter((k) => k !== "wasim" && k !== "kemal"),
      dropped: ["wasim", "kemal"],
      teams: SHEET,
    });
    const { out } = composeFor(state, [
      amirRegistersShahrokh(),
      msg({
        from: "amir",
        body: "and Ayoub too",
        route: "other_att",
        facts: attendanceFacts([
          claim({ subject: "other", personRef: "Ayoub", personNamed: true, polarity: "in" }),
        ]),
      }),
    ]);
    expect(out.utterances).toHaveLength(1);
    const text = out.utterances[0].text;
    expect(text.split("\n")[0]).toBe(
      "🔁 *Kemal and Wasim are out*. *Shahrokh* takes Kemal's spot in *Red*, *Ayoub* takes Wasim's spot in *Yellow*.",
    );
    expect(text).toContain("1. Shahrokh  (replacing Kemal)");
    expect(text).toContain("7. Ayoub Benali  (replacing Wasim)");
  });

  it("names a player who went to the BENCH as replaced, never as out", () => {
    // A confirmed player demoted to the bench vacates a slot without
    // being out, and "Wasim is out" is a claim the rows do not support.
    const state = world({
      players: ROSTER,
      confirmed: SEATED.filter((k) => k !== "wasim"),
      bench: ["wasim"],
      teams: SHEET,
    });
    const { out } = composeFor(state, [amirRegistersShahrokh()]);
    expect(out.utterances[0].text.split("\n")[0]).toBe(
      "🔁 *Shahrokh* takes Wasim's spot in *Yellow*.",
    );
    expect(out.utterances[0].text).not.toContain("is out");
  });
});

// ── ONCE THE TEAMS EXIST, THE ROSTER IS NOT POSTED ────────────────────
//
// "if the teams are generated, all match time need to do is to declare
// the teams again with the swapped replacement and the person that is
// out. That's it. There is no point listing all the 14 players after the
// teams were announced."
describe("a sheet never lists a player who is not playing (Sutton, 2026-09-29)", () => {
  // 07:57 on the day: Elnur, Burak and Abid had all dropped; Mojib had
  // already inherited Burak's slot; Hamzah arrived and took Elnur's. The
  // re-declared sheet still printed ABID on Red, a man who had said he
  // was not coming. A vacated slot nobody has inherited is an OPEN SLOT
  // on the sheet, not the name of the person who left it.
  const SHEET: Record<string, "RED" | "YELLOW"> = {
    mojib: "RED",
    elnur: "RED",
    abid: "RED",
    kemal: "RED",
    mustafa: "RED",
    idris: "RED",
    efat: "RED",
    elvin: "YELLOW",
    adam: "YELLOW",
    erdal: "YELLOW",
    sait: "YELLOW",
    habib: "YELLOW",
    faris: "YELLOW",
    wasim: "YELLOW",
  };
  const ROSTER = [...SUTTON, "hamzah", "elnur"];
  const hamzahIn = () =>
    msg({
      from: "wasim",
      body: "Hamzah in",
      route: "other_att",
      facts: attendanceFacts([
        claim({ subject: "other", personRef: "Hamzah", personNamed: true, polarity: "in" }),
      ]),
    });
  const at0757 = (language: "en" | "tr" = "en") =>
    world({
      players: ROSTER,
      confirmed: Object.keys(SHEET).filter((k) => k !== "elnur" && k !== "abid"),
      dropped: ["elnur", "abid"],
      teams: SHEET,
      features: { language },
    });

  it("the replacement post names Hamzah in Elnur's slot and shows Abid's as open", () => {
    const { out } = composeFor(at0757(), [hamzahIn()]);
    expect(out.utterances).toHaveLength(1);
    const text = out.utterances[0].text;
    expect(text).toContain("🔁 *Elnur is out*. *Hamzah* takes his place and his spot in *Red*.");
    expect(text).toContain("2. Hamzah  (replacing Elnur)");
    expect(text).toContain("3. (open slot)");
    expect(text).not.toContain("Abid");
  });

  it("Turkish: the open slot is said in Turkish", () => {
    const { out } = composeFor(at0757("tr"), [hamzahIn()]);
    expect(out.utterances[0].text).toContain("3. (boş yer)");
    expect(out.utterances[0].text).not.toContain("Abid");
  });

  it("a squad question answered with the line-ups shows the open slot too", () => {
    const state = world({
      players: ROSTER,
      confirmed: Object.keys(SHEET).filter((k) => k !== "abid"),
      dropped: ["abid"],
      teams: SHEET,
    });
    const { out } = composeFor(state, [rosterAsk("amir")]);
    const said = out.utterances.map((u) => u.text).join("\n");
    expect(said).toContain("⚽ *Teams for");
    expect(said).toContain("(open slot)");
    expect(said).not.toContain("Abid");
  });
});

describe("a squad post with a team sheet on the table is the TEAMS", () => {
  const SHEET: Record<string, "RED" | "YELLOW"> = {
    kemal: "RED",
    mustafa: "RED",
    idris: "RED",
    najib: "RED",
    efat: "RED",
    mojib: "RED",
    karahan: "RED",
    elvin: "YELLOW",
    adam: "YELLOW",
    erdal: "YELLOW",
    sait: "YELLOW",
    habib: "YELLOW",
    faris: "YELLOW",
    wasim: "YELLOW",
  };
  const SEATED = Object.keys(SHEET);

  it("'who's playing?' is answered with the line-ups, not the roster", () => {
    const { out } = composeFor(world({ confirmed: SEATED, teams: SHEET }), [rosterAsk("amir")]);
    const text = out.utterances.map((u) => u.text).join("\n");
    expect(text).toContain("⚽ *Teams for tonight*");
    expect(text).toContain("*Red*:");
    expect(text).not.toContain("*Playing:*");
    expect(text).not.toContain("Based on all the messages");
  });

  it("an admin dropping somebody else posts the TEAMS, not fourteen names", () => {
    const { out } = composeFor(world({ confirmed: SEATED, teams: SHEET }), [
      msg({
        from: "kemal",
        body: "@Match Time Wasim is out",
        tagged: true,
        route: "other_att",
        facts: attendanceFacts([
          claim({ subject: "other", personRef: "Wasim", personNamed: true, polarity: "out" }),
        ]),
      }),
    ]);
    const text = out.utterances.map((u) => u.text).join("\n");
    expect(text).toContain("⚽ *Teams for tonight*");
    expect(text).not.toContain("*Playing:*");
  });

  it("WITHOUT a sheet the roster is EXACTLY what it is today", () => {
    // THE REGRESSION THAT MATTERS. Before teams are generated nothing
    // about the squad post changes, byte for byte.
    const state = world({ confirmed: SEATED });
    const { out } = composeFor(state, [rosterAsk("amir")]);
    expect(out.utterances.map((u) => u.text).join("\n")).toBe(
      composeSquadStatusPost({
        confirmed: SEATED.map(fullName),
        bench: [],
        maxPlayers: 14,
      }),
    );
  });
});

// 2026-10-22, MT Test: partner guests print by name and club (D7), and an
// empty User.name prints the group's own word for "unnamed". Both come in
// on `Member.displayName` from load-state (player-display-name.ts).
describe("partner guests on the squad post and the team sheet", () => {
  const withGuests = (): SquadState => {
    const state = world({ confirmed: [...TEN.slice(0, 5), "usama", "karahan"], bench: ["zair"] });
    const set = (k: string, name: string, displayName: string) => {
      const m = state.roster.find((r) => r.userId === `u-${k}`)!;
      m.name = name;
      m.displayName = displayName;
    };
    set("usama", "C1", "C1 (Friday MT Community)");
    set("karahan", "", "(unnamed) (Friday MT Community)");
    set("zair", "Zair", "Zair (Friday MT Community)");
    return state;
  };

  it("the roster prints each guest with his club, bench included", () => {
    const { out } = composeFor(withGuests(), [rosterAsk("adam")]);
    const text = out.utterances.map((u) => u.text).join("\n");
    expect(text).toContain("6. C1 (Friday MT Community)");
    expect(text).toContain("7. (unnamed) (Friday MT Community)");
    expect(text).toContain("1. Zair (Friday MT Community)");
    expect(text).not.toContain(en.fallback_player);
  });

  it("the team sheet prints the same lines", () => {
    const state = withGuests();
    state.teams = [
      { userId: "u-usama", team: "RED" },
      { userId: "u-karahan", team: "YELLOW" },
    ];
    const { out } = composeFor(state, [rosterAsk("adam")]);
    const text = out.utterances.map((u) => u.text).join("\n");
    expect(text).toContain("C1 (Friday MT Community)");
    expect(text).toContain("(unnamed) (Friday MT Community)");
  });
});
