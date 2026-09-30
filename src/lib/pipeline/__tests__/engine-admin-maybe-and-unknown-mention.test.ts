/**
 * Two engine rules from MT Test, 2026-09-30 ~14:12, owner Kemal posting a
 * run of third-party attendance:
 *
 *   1. "@Sait is a may be, he will decide on Thursday, just remind him if
 *      he wants to come" → "contingent claim about Sait (not the sender):
 *      holding, no write". Kemal wants an organiser's report of a
 *      member's maybe to do what the member's own maybe does: record
 *      them as TENTATIVE, so the follow-up DM chases them before the
 *      match. Nobody is registered. A non-admin's report keeps holding.
 *
 *   2. "@252012071493723 is IN" → "unnamed third party cannot register
 *      anyone; degraded: raw digits are never a name". Silence. When a
 *      claim names nobody but raw digits (a mention nobody could put a
 *      name to), MatchTime asks once: "I couldn't tell who that is, can
 *      you say their name?". Only for a tagged message or an admin's.
 *
 * Deterministic, from the extractor facts that already exist: no prompt
 * changed.
 */
import { describe, it, expect } from "vitest";
import { decide } from "../engine";
import { compose } from "../compose";
import { attendanceFacts, claim, msg, NOW, world } from "./helpers";

const saitMaybe = (conditionOn: "self" | "squad" | "none" = "self", polarity: "in" | "out" = "in") =>
  attendanceFacts([
    claim({
      subject: "other",
      personRef: "Sait",
      personNamed: true,
      polarity,
      contingent: true,
      conditionOn,
      tense: "future",
    }),
  ]);

const MAYBE_BODY = "@Sait is a may be, he will decide on Thursday, just remind him if he wants to come";

describe("an organiser reports a member's maybe", () => {
  it("records the member as tentative and registers nobody", () => {
    const r = decide({
      now: NOW,
      state: world({ confirmed: ["kemal"] }),
      messages: [msg({ from: "kemal", body: MAYBE_BODY, route: "offer", facts: saitMaybe() })],
    });
    expect(r.writes).toEqual([]);
    expect(r.outcomes[0].tentativeUserIds).toEqual(["u-sait"]);
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/admin reports Sait Demir as a maybe: recording tentative/);
    expect(r.outcomes[0].disposition).toBe("acted");
  });

  it("a non-admin's report about someone else still holds, and records nothing", () => {
    const r = decide({
      now: NOW,
      state: world({ confirmed: ["omar"], players: ["kemal", "sait", "omar"] }),
      messages: [msg({ from: "omar", body: MAYBE_BODY, route: "offer", tagged: true, facts: saitMaybe() })],
    });
    expect(r.writes).toEqual([]);
    expect(r.outcomes[0].tentativeUserIds ?? []).toEqual([]);
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/contingent claim about .*not the sender/);
  });

  it("a condition on the squad (a standing offer about someone else) still holds", () => {
    const r = decide({
      now: NOW,
      state: world(),
      messages: [msg({ from: "kemal", body: "Sait can play if we're short", route: "offer", facts: saitMaybe("squad") })],
    });
    expect(r.writes).toEqual([]);
    expect(r.outcomes[0].tentativeUserIds ?? []).toEqual([]);
  });

  it("a contingent DROP reported by an admin still holds and is not a maybe", () => {
    const r = decide({
      now: NOW,
      state: world({ confirmed: ["sait"] }),
      messages: [msg({ from: "kemal", body: "Sait might drop out", route: "offer", facts: saitMaybe("self", "out") })],
    });
    expect(r.writes).toEqual([]);
    expect(r.outcomes[0].tentativeUserIds ?? []).toEqual([]);
  });

  it("a maybe about somebody who is not a member records nothing", () => {
    const r = decide({
      now: NOW,
      state: world(),
      messages: [
        msg({
          from: "kemal",
          body: "Bob is a maybe",
          route: "offer",
          facts: attendanceFacts([
            claim({ subject: "other", personRef: "Bob", personNamed: true, contingent: true, conditionOn: "self" }),
          ]),
        }),
      ],
    });
    expect(r.writes).toEqual([]);
    expect(r.outcomes[0].tentativeUserIds ?? []).toEqual([]);
  });
});

const rawIn = (digits: string, polarity: "in" | "out" = "in") =>
  attendanceFacts([
    claim({ subject: "other", personRef: `@${digits}`, personNamed: true, polarity }),
  ]);

const asks = (r: ReturnType<typeof decide>) => r.speech.filter((s) => s.kind === "ask_who_mentioned");

describe("a third-party claim that names only raw digits", () => {
  it("an admin's message gets one 'who is that?' and no guest-name ask", () => {
    const r = decide({
      now: NOW,
      state: world(),
      messages: [msg({ id: "m1", from: "kemal", body: "@252012071493723 is IN", route: "other_att", facts: rawIn("252012071493723") })],
    });
    expect(r.writes).toEqual([]);
    expect(asks(r)).toEqual([{ kind: "ask_who_mentioned", messageId: "m1" }]);
    expect(r.speech.some((s) => s.kind === "guest_name_ask")).toBe(false);
  });

  it("asks once per batch, however many such messages there are", () => {
    const r = decide({
      now: NOW,
      state: world(),
      messages: [
        msg({ id: "m1", from: "kemal", body: "@252012071493723 is IN", route: "other_att", facts: rawIn("252012071493723") }),
        msg({ id: "m2", from: "kemal", body: "@46179639369730 is IN", route: "other_att", facts: rawIn("46179639369730") }),
      ],
    });
    expect(asks(r)).toEqual([{ kind: "ask_who_mentioned", messageId: "m1" }]);
  });

  it("asks for a drop too: the name is missing either way", () => {
    const r = decide({
      now: NOW,
      state: world({ confirmed: ["sait"] }),
      messages: [msg({ id: "m1", from: "kemal", body: "@252012071493723 is out", route: "other_att", facts: rawIn("252012071493723", "out") })],
    });
    expect(asks(r)).toHaveLength(1);
  });

  it("a tagged message from a non-admin is asked too", () => {
    const r = decide({
      now: NOW,
      state: world(),
      messages: [
        msg({ id: "m1", from: "sait", tagged: true, body: "@Match Time @252012071493723 is IN", route: "other_att", facts: rawIn("252012071493723") }),
      ],
    });
    expect(asks(r)).toHaveLength(1);
  });

  it("an untagged non-admin message stays silent", () => {
    const r = decide({
      now: NOW,
      state: world(),
      messages: [msg({ id: "m1", from: "sait", body: "@252012071493723 is IN", route: "other_att", facts: rawIn("252012071493723") })],
    });
    expect(asks(r)).toEqual([]);
  });

  it("an unnamed relationship ('my mate') is the guest path, not this ask", () => {
    const r = decide({
      now: NOW,
      state: world(),
      messages: [
        msg({
          id: "m1",
          from: "kemal",
          body: "my mate is in",
          route: "other_att",
          facts: attendanceFacts([claim({ subject: "other", personRef: "my mate", personNamed: false })]),
        }),
      ],
    });
    expect(asks(r)).toEqual([]);
  });
});

describe("compose(): the 'who is that?' ask, in the group's language", () => {
  const say = (lang: "en" | "tr") => {
    const state = world({ features: { language: lang } });
    return compose({
      outcomes: [],
      writes: [],
      nextState: state,
      speech: [{ kind: "ask_who_mentioned", messageId: "m1" }],
      degradations: [],
    }).utterances;
  };

  it("English", () => {
    expect(say("en")).toEqual([{ messageId: "m1", text: "I couldn't tell who that is, can you say their name?" }]);
  });

  it("Turkish", () => {
    expect(say("tr")).toEqual([{ messageId: "m1", text: "Bunun kim olduğunu anlayamadım, adını yazar mısın?" }]);
  });
});
