/**
 * A NAME NOBODY COULD PLACE IS ASKED ABOUT, AND THE ANSWER IS ACTED ON
 * (Sutton, 2026-11-17).
 *
 * "@Match Time Abu Ayoub is IN as a guest": who-is-who was not sure
 * whether Abu Ayoub is the member Yoobie, so it answered "ambiguous" with
 * Yoobie as the one candidate, "so the sender is asked". The engine
 * degraded instead, nothing was asked, and the organiser got the
 * not-understood line. These pin the ask (one per message, only for a
 * message addressed to MatchTime or an organiser's) and the two answers:
 * a candidate's name, and "new".
 *
 * Made-up people only.
 */
import { describe, expect, it } from "vitest";
import { decide } from "../engine";
import { compose, renderAttendanceAsk } from "../compose";
import { NOW, attendanceFacts, claim, msg, statusOf, world } from "./helpers";
import type { PersonPick } from "../who-is-who";
import type { EngineMessage, EngineResult } from "../types";

// "yoobie" is a member; Abu Ayoub is not on the roster.
const NAMES: Record<string, string> = { "u-yoobie": "Yoobie", "u-dansmith": "Dan Smith", "u-danjones": "Dan Jones" };
const state = (opts: { language?: "en" | "tr" } = {}) => {
  const st = world({
    players: ["kemal", "yoobie", "dansmith", "danjones", "pete"],
    confirmed: ["pete"],
    admins: ["kemal"],
    maxPlayers: 14,
    ...(opts.language ? { features: { language: opts.language } } : {}),
  });
  return { ...st, roster: st.roster.map((m) => ({ ...m, name: NAMES[m.userId] ?? m.name })) };
};

const abuIn = claim({ subject: "other", personRef: "Abu Ayoub", personKind: "named", personNamed: true, polarity: "in" });
const ORIGINAL = "@Match Time Abu Ayoub is IN as a guest";

const run = (m: EngineMessage, st = state()): EngineResult => decide({ now: NOW, state: st, messages: [m] });
const asks = (r: EngineResult) => r.speech.filter((s) => s.kind === "ask_attendance_person");
const people = (entries: Array<[string, PersonPick]>) => new Map<string, PersonPick>(entries);
const yoobieMaybe = people([["Abu Ayoub", { kind: "ambiguous", userIds: ["u-yoobie"] }]]);
/** The open question the answers below answer. */
const ASK = { body: ORIGINAL, ref: "Abu Ayoub", candidateIds: ["u-yoobie"] };

describe("asking who a name is", () => {
  it("the Sutton message: the organiser is asked one question, and nothing is written or degraded", () => {
    const r = run({
      ...msg({ from: "kemal", body: ORIGINAL, tagged: true, route: "other_att", facts: attendanceFacts([abuIn]) }),
      people: yoobieMaybe,
    });
    expect(asks(r)).toEqual([
      expect.objectContaining({ kind: "ask_attendance_person", ref: "Abu Ayoub", candidates: ["Yoobie"] }),
    ]);
    expect(r.writes).toEqual([]);
    expect(r.degradations).toEqual([]);
    const out = r.outcomes[0];
    expect(out.attendanceClarificationAsked).toBe(true);
    expect(out.disposition).toBe("acted");
    expect(compose(r).utterances.map((u) => u.text)).toContain("Do you mean Yoobie, or is Abu Ayoub a new player?");
  });

  it("an organiser's untagged message is asked about too", () => {
    const r = run({
      ...msg({ from: "kemal", body: "Abu Ayoub is IN as a guest", tagged: false, route: "other_att", facts: attendanceFacts([abuIn]) }),
      people: yoobieMaybe,
    });
    expect(asks(r)).toHaveLength(1);
  });

  it("a player's untagged message stays silent: degraded as before, nothing asked", () => {
    const r = run({
      ...msg({ from: "pete", body: "Abu Ayoub is IN", tagged: false, route: "other_att", facts: attendanceFacts([abuIn]) }),
      people: yoobieMaybe,
    });
    expect(asks(r)).toEqual([]);
    expect(r.outcomes[0].attendanceClarificationAsked).toBeUndefined();
    expect(r.degradations.map((d) => d.detail).join(" | ")).toMatch(/ambiguous name "Abu Ayoub"/);
  });

  it("a player's TAGGED message is asked about", () => {
    const r = run({
      ...msg({ from: "pete", body: "@Match Time Abu Ayoub is IN", tagged: true, route: "other_att", facts: attendanceFacts([abuIn]) }),
      people: yoobieMaybe,
    });
    expect(asks(r)).toHaveLength(1);
  });

  it("two unclear names in one message: ONE question", () => {
    const danIn = claim({ subject: "other", personRef: "Dan", personKind: "named", personNamed: true, polarity: "in" });
    const r = run({
      ...msg({ from: "kemal", body: "@Match Time Abu Ayoub and Dan are in", tagged: true, route: "other_att", facts: attendanceFacts([abuIn, danIn]) }),
      people: people([
        ["Abu Ayoub", { kind: "ambiguous", userIds: ["u-yoobie"] }],
        ["Dan", { kind: "ambiguous", userIds: ["u-dansmith", "u-danjones"] }],
      ]),
    });
    expect(asks(r)).toHaveLength(1);
    expect(r.writes).toEqual([]);
  });

  it("several candidates: they are all offered", () => {
    const danIn = claim({ subject: "other", personRef: "Dan", personKind: "named", personNamed: true, polarity: "in" });
    const r = run({
      ...msg({ from: "kemal", body: "@Match Time Dan is in", tagged: true, route: "other_att", facts: attendanceFacts([danIn]) }),
      people: people([["Dan", { kind: "ambiguous", userIds: ["u-dansmith", "u-danjones"] }]]),
    });
    expect(asks(r)[0]).toMatchObject({ ref: "Dan", candidates: ["Dan Smith", "Dan Jones"] });
  });

  it("nobody could say who (the pick failed): asked with no candidate", () => {
    const r = run({
      ...msg({ from: "kemal", body: ORIGINAL, tagged: true, route: "other_att", facts: attendanceFacts([abuIn]) }),
      people: people([["Abu Ayoub", { kind: "unidentified", why: "the call failed" }]]),
    });
    expect(asks(r)[0]).toMatchObject({ ref: "Abu Ayoub", candidates: [] });
    expect(compose(r).utterances.map((u) => u.text)).toContain(
      "Who is Abu Ayoub: someone already in the group, or a new player?",
    );
  });

  it("an OUT about an unclear name is asked about, and nobody is dropped", () => {
    const st = world({ players: ["kemal", "yoobie", "pete"], confirmed: ["pete", "yoobie"], admins: ["kemal"] });
    const r = run(
      {
        ...msg({
          from: "kemal",
          body: "@Match Time Abu Ayoub is out",
          tagged: true,
          route: "other_att",
          facts: attendanceFacts([{ ...abuIn, polarity: "out" }]),
        }),
        people: yoobieMaybe,
      },
      st,
    );
    expect(asks(r)).toHaveLength(1);
    expect(statusOf(r.nextState, "yoobie")).toBe("CONFIRMED");
  });

  it("a bench claim about an unclear name is asked about", () => {
    const r = run({
      ...msg({
        from: "kemal",
        body: "@Match Time Abu Ayoub to the bench",
        tagged: true,
        route: "other_att",
        facts: attendanceFacts([{ ...abuIn, polarity: "bench", benchAsked: true }]),
      }),
      people: yoobieMaybe,
    });
    expect(asks(r)).toHaveLength(1);
    expect(r.writes).toEqual([]);
  });

  it("a replacement whose replaced player is unclear: asked about him, the whole replacement held", () => {
    const st = world({ players: ["kemal", "najib", "mojib"], confirmed: ["kemal", "najib"], admins: ["kemal"] });
    const r = run(
      {
        ...msg({
          from: "kemal",
          body: "@Match Time Mojib in for Najib",
          tagged: true,
          route: "other_att",
          facts: attendanceFacts([
            claim({ subject: "other", personRef: "Mojib", personKind: "named", personNamed: true, polarity: "in", replaces: "Najib" }),
          ]),
        }),
        people: people([
          ["Mojib", { kind: "member", userId: "u-mojib" }],
          ["Najib", { kind: "ambiguous", userIds: ["u-najib"] }],
        ]),
      },
      st,
    );
    expect(asks(r)).toEqual([expect.objectContaining({ ref: "Najib", candidates: ["Najib Ahmadi"] })]);
    expect(statusOf(r.nextState, "mojib")).toBe("ABSENT");
    expect(statusOf(r.nextState, "najib")).toBe("CONFIRMED");
  });
});

describe("acting on the answer", () => {
  it('"new": Abu Ayoub is provisioned under the name the EARLIER message wrote, and confirmed', () => {
    const r = run({
      ...msg({
        from: "kemal",
        body: "new",
        route: "other_att",
        facts: attendanceFacts([{ ...abuIn, newPlayer: true }], { answersClarification: true }),
      }),
      clarification: ASK,
      // who-is-who is still asked; "not sure" does not stop a "new".
      people: yoobieMaybe,
    });
    expect(asks(r)).toEqual([]);
    expect(r.writes).toEqual([
      expect.objectContaining({ kind: "attendance", userId: "new:Abu Ayoub", name: "Abu Ayoub", status: "CONFIRMED" }),
    ]);
  });

  it('"new" is not honoured without an open question (no clarification): resolved as usual', () => {
    const r = run({
      ...msg({
        from: "kemal",
        body: "Abu Ayoub is in, he's new",
        route: "other_att",
        facts: attendanceFacts([{ ...abuIn, newPlayer: true }], { answersClarification: true }),
      }),
      people: yoobieMaybe,
    });
    expect(r.writes).toEqual([]);
    expect(asks(r)).toHaveLength(1);
  });

  it('"new" still needs the name written in the earlier message (the provisioning guard)', () => {
    const r = run({
      ...msg({
        from: "kemal",
        body: "new",
        route: "other_att",
        facts: attendanceFacts([{ ...abuIn, personRef: "Abu Ayoub Khan", newPlayer: true }], { answersClarification: true }),
      }),
      clarification: ASK,
      people: people([]),
    });
    expect(r.writes).toEqual([]);
  });

  it('"Yoobie": the claim is applied to the member Yoobie', () => {
    const r = run({
      ...msg({
        from: "kemal",
        body: "Yoobie",
        route: "other_att",
        facts: attendanceFacts([{ ...abuIn, personRef: "Yoobie" }], { answersClarification: true }),
      }),
      clarification: ASK,
      people: people([["Yoobie", { kind: "member", userId: "u-yoobie" }]]),
    });
    expect(statusOf(r.nextState, "yoobie")).toBe("CONFIRMED");
    expect(r.writes).toEqual([expect.objectContaining({ kind: "attendance", userId: "u-yoobie", status: "CONFIRMED" })]);
  });
});

describe("review of #618: the answer is bound to the person asked about", () => {
  const answer = (body: string, claims: Parameters<typeof attendanceFacts>[0], picks: Array<[string, PersonPick]>, st = state()) =>
    run(
      {
        ...msg({ from: "kemal", body, route: "other_att", facts: attendanceFacts(claims, { answersClarification: true }) }),
        clarification: ASK,
        people: people(picks),
      },
      st,
    );
  const peteIn = claim({ subject: "other", personRef: "Pete", personKind: "named", personNamed: true, polarity: "in" });

  it('Pete and Abu: "new" makes only Abu new, never a second Pete', () => {
    const r = answer("new", [{ ...peteIn, newPlayer: true }, { ...abuIn, newPlayer: true }], [
      ["Pete", { kind: "member", userId: "u-pete" }],
      ["Abu Ayoub", { kind: "ambiguous", userIds: ["u-yoobie"] }],
    ]);
    expect(r.writes.map((w) => (w.kind === "attendance" ? w.userId : w.kind))).toEqual(["new:Abu Ayoub"]);
  });

  it("the replay: the rest of the earlier message is never applied again (Pete, since dropped, stays out)", () => {
    const st = state();
    st.rows = [{ userId: "u-pete", status: "DROPPED", position: 1 }];
    const r = answer(
      "new",
      [peteIn, { ...abuIn, newPlayer: true }],
      [
        ["Pete", { kind: "member", userId: "u-pete" }],
        ["Abu Ayoub", { kind: "ambiguous", userIds: ["u-yoobie"] }],
      ],
      st,
    );
    expect(statusOf(r.nextState, "pete")).toBe("DROPPED");
    expect(r.writes).toEqual([expect.objectContaining({ userId: "new:Abu Ayoub", status: "CONFIRMED" })]);
  });

  it("a named answer lands only on a member offered, or one the answer itself names", () => {
    // "the first one" read as Dan Smith, who was never offered: not applied.
    const off = answer("the first one", [{ ...abuIn, personRef: "Dan" }], [["Dan", { kind: "member", userId: "u-dansmith" }]]);
    expect(off.writes).toEqual([]);
    // The member offered, however the answer put it: applied.
    const offered = answer("the first one", [{ ...abuIn, personRef: "Yoob" }], [["Yoob", { kind: "member", userId: "u-yoobie" }]]);
    expect(statusOf(offered.nextState, "yoobie")).toBe("CONFIRMED");
    // A member the answer names in its own words: applied.
    const named = answer("no, it's Dan Smith", [{ ...abuIn, personRef: "Dan Smith" }], [["Dan Smith", { kind: "member", userId: "u-dansmith" }]]);
    expect(statusOf(named.nextState, "dansmith")).toBe("CONFIRMED");
  });

  it('"new" is refused for a name a member already has', () => {
    const r = run({
      ...msg({
        from: "kemal",
        body: "new",
        route: "other_att",
        facts: attendanceFacts(
          [claim({ subject: "other", personRef: "Yoobie", personKind: "named", personNamed: true, polarity: "in", newPlayer: true })],
          { answersClarification: true },
        ),
      }),
      clarification: { body: "@Match Time Yoobie is in", ref: "Yoobie", candidateIds: ["u-yoobie"] },
      people: people([["Yoobie", { kind: "ambiguous", userIds: ["u-yoobie"] }]]),
    });
    expect(r.writes).toEqual([]);
    expect(r.degradations.map((d) => d.detail).join(" | ")).toMatch(/a member already has that name/);
  });

  it('"new" for a name that was not the one asked about is not honoured', () => {
    const r = answer("new", [{ ...abuIn, personRef: "Abu", newPlayer: true }], [["Abu", { kind: "none" }]]);
    expect(r.writes).toEqual([]);
  });
});

describe("review of #618: a replacement with an unclear name is held whole", () => {
  const replacing = (picks: Array<[string, PersonPick]>) =>
    run(
      {
        ...msg({
          from: "kemal",
          body: "@Match Time Mojib in for Najib",
          tagged: true,
          route: "other_att",
          facts: attendanceFacts([
            claim({ subject: "other", personRef: "Mojib", personKind: "named", personNamed: true, polarity: "in", replaces: "Najib" }),
            claim({ subject: "other", personRef: "Najib", personKind: "named", personNamed: true, polarity: "out" }),
          ]),
        }),
        people: people(picks),
      },
      world({ players: ["kemal", "najib", "mojib"], confirmed: ["kemal", "najib"], admins: ["kemal"] }),
    );

  it('"Mojib in for Najib" with Mojib unclear: Najib stays CONFIRMED, one question, about Mojib', () => {
    const r = replacing([
      ["Mojib", { kind: "ambiguous", userIds: ["u-mojib"] }],
      ["Najib", { kind: "member", userId: "u-najib" }],
    ]);
    expect(statusOf(r.nextState, "najib")).toBe("CONFIRMED");
    expect(statusOf(r.nextState, "mojib")).toBe("ABSENT");
    expect(r.writes).toEqual([]);
    expect(asks(r)).toEqual([expect.objectContaining({ ref: "Mojib" })]);
  });

  it("with Najib unclear: Najib's own OUT is held too, one question, about Najib", () => {
    const r = replacing([
      ["Mojib", { kind: "member", userId: "u-mojib" }],
      ["Najib", { kind: "ambiguous", userIds: ["u-najib"] }],
    ]);
    expect(statusOf(r.nextState, "najib")).toBe("CONFIRMED");
    expect(r.writes).toEqual([]);
    expect(asks(r)).toEqual([expect.objectContaining({ ref: "Najib" })]);
  });
});

describe("review of #618: one question per message", () => {
  const digits = claim({ subject: "other", personRef: "@252012071493723", personKind: "named", personNamed: true, polarity: "in" });
  const questions = (r: EngineResult) =>
    r.speech.filter((s) => s.kind === "ask_attendance_person" || s.kind === "ask_who_mentioned" || s.kind === "guest_name_ask");

  it('"@<digits> and Abu Ayoub are in": one question, whichever comes first', () => {
    for (const order of [[digits, abuIn], [abuIn, digits]]) {
      const r = run({
        ...msg({ from: "kemal", body: "@Match Time @252012071493723 and Abu Ayoub are in", tagged: true, route: "other_att", facts: attendanceFacts(order) }),
        people: yoobieMaybe,
      });
      expect(questions(r)).toHaveLength(1);
      expect(r.writes).toEqual([]);
    }
  });

  it("the guest-name ask and an unclear name: one question (the guest-name ask)", () => {
    const brother = claim({ subject: "other", personRef: "my brother", personKind: "relation", personNamed: false, polarity: "in" });
    const r = run({
      ...msg({ from: "kemal", body: "@Match Time my brother and Abu Ayoub are in", tagged: true, route: "other_att", facts: attendanceFacts([brother, abuIn]) }),
      people: yoobieMaybe,
    });
    expect(questions(r).map((q) => q.kind)).toEqual(["guest_name_ask"]);
    expect(r.outcomes[0].attendanceClarificationAsked).toBeUndefined();
  });

  it("a name that cannot be printed (a phone number) asks nothing and is not marked acted", () => {
    const phoneRef = claim({ subject: "other", personRef: "Abu 07700900123", personKind: "named", personNamed: true, polarity: "in" });
    const r = run({
      ...msg({ from: "kemal", body: "@Match Time Abu 07700900123 is in", tagged: true, route: "other_att", facts: attendanceFacts([phoneRef]) }),
      people: people([["Abu 07700900123", { kind: "ambiguous", userIds: ["u-yoobie"] }]]),
    });
    expect(asks(r)).toEqual([]);
    expect(r.outcomes[0].attendanceClarificationAsked).toBeUndefined();
    expect(r.outcomes[0].disposition).toBe("degraded");
  });
});

describe("the question's words", () => {
  it("English: one candidate, several, none", () => {
    expect(renderAttendanceAsk({ ref: "Abu Ayoub", candidates: ["Yoobie"] }, "en")).toBe(
      "Do you mean Yoobie, or is Abu Ayoub a new player?",
    );
    expect(renderAttendanceAsk({ ref: "Dan", candidates: ["Dan Smith", "Dan Jones"] }, "en")).toBe(
      "Do you mean Dan Smith or Dan Jones, or is Dan someone new?",
    );
    expect(renderAttendanceAsk({ ref: "Abu Ayoub", candidates: [] }, "en")).toBe(
      "Who is Abu Ayoub: someone already in the group, or a new player?",
    );
  });

  it("Turkish: names where no suffix is needed", () => {
    expect(renderAttendanceAsk({ ref: "Abu Ayoub", candidates: ["Yoobie"] }, "tr")).toBe(
      "Abu Ayoub kim: Yoobie, yoksa yeni bir oyuncu mu?",
    );
    expect(renderAttendanceAsk({ ref: "Dan", candidates: ["Dan Smith", "Dan Jones"] }, "tr")).toBe(
      "Dan kim: Dan Smith ya da Dan Jones, yoksa yeni biri mi?",
    );
    expect(renderAttendanceAsk({ ref: "Abu Ayoub", candidates: [] }, "tr")).toBe(
      "Abu Ayoub kim: gruptan biri mi, yoksa yeni bir oyuncu mu?",
    );
  });

  it("a phone number is never echoed: as a name nothing is asked, as a candidate it is left out", () => {
    expect(renderAttendanceAsk({ ref: "07700 900123", candidates: ["Yoobie"] }, "en")).toBeNull();
    expect(renderAttendanceAsk({ ref: "Abu Ayoub", candidates: ["+44 7700 900123"] }, "en")).toBe(
      "Who is Abu Ayoub: someone already in the group, or a new player?",
    );
  });

  it("house style: no em dash, no slash", () => {
    for (const lang of ["en", "tr"]) {
      for (const c of [[], ["Yoobie"], ["Dan Smith", "Dan Jones"]]) {
        const text = renderAttendanceAsk({ ref: "Abu Ayoub", candidates: c }, lang)!;
        expect(text).not.toMatch(/[—/]/);
      }
    }
  });

  it("the Turkish club hears the Turkish question", () => {
    const r = run(
      {
        ...msg({ from: "kemal", body: ORIGINAL, tagged: true, route: "other_att", facts: attendanceFacts([abuIn]) }),
        people: yoobieMaybe,
      },
      state({ language: "tr" }),
    );
    expect(compose(r).utterances.map((u) => u.text)).toContain("Abu Ayoub kim: Yoobie, yoksa yeni bir oyuncu mu?");
  });
});
