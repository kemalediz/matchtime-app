/**
 * NO GHOST PLAYERS (2026-10-30, the adversarial review of PR #476, HIGH 1).
 *
 * The word lists that refused "my brother", "Amir's brother", "everyone"
 * and "the lads" in `identity.ts` are gone ("no string parsing"). What
 * stands in their place, all of it facts or checks on MODEL OUTPUT:
 *
 *   (a) the attendance extractor states the KIND of person each ref is
 *       (`personKind`: named, relation, group or placeholder), and only a
 *       named person is resolved or provisioned;
 *   (b) a new player is provisioned only when the model said "named" AND
 *       the name it returned is written in the message (a verifier on the
 *       model's output, `refWrittenIn`);
 *   (c) the roster's first-name prefix match never resolves a multi-word
 *       ref (`resolve-or-provision-name.ts`, pinned in its own test).
 */
import { describe, expect, it } from "vitest";
import { decide } from "../engine";
import { attendanceFacts, claim, msg, NOW, world } from "./helpers";

const state = () => world({ confirmed: ["kemal", "elvin", "sait", "mustafa", "abid", "idris", "faris"] });
const attWrites = (r: ReturnType<typeof decide>) => r.writes.filter((w) => w.kind === "attendance");

describe("only a NAMED person is resolved or provisioned", () => {
  it("'Amir's brother' the model calls a relation registers nobody, even with personNamed true", () => {
    const r = decide({
      now: NOW,
      state: state(),
      messages: [
        msg({
          from: "amir",
          body: "my brother can play if needed",
          route: "other_att",
          facts: attendanceFacts([
            claim({ subject: "other", personRef: "Amir's brother", personNamed: true, personKind: "relation", polarity: "in" }),
          ]),
        }),
      ],
    });
    expect(attWrites(r)).toHaveLength(0);
  });

  it("'@everyone in', the model calls it a group: nobody called 'everyone' is provisioned", () => {
    const r = decide({
      now: NOW,
      state: state(),
      messages: [
        msg({
          from: "kemal",
          body: "@everyone in",
          route: "other_att",
          facts: attendanceFacts([claim({ subject: "other", personRef: "everyone", personNamed: true, personKind: "group", polarity: "in" })]),
        }),
      ],
    });
    expect(attWrites(r)).toHaveLength(0);
  });

  it("'the lads' as a group never resolves to a member by a first-name match", () => {
    const r = decide({
      now: NOW,
      state: world({ confirmed: ["kemal"], players: ["kemal", "theo"] }),
      messages: [
        msg({
          from: "kemal",
          body: "the lads are in",
          route: "other_att",
          facts: attendanceFacts([claim({ subject: "other", personRef: "the lads", personNamed: true, personKind: "group", polarity: "in" })]),
        }),
      ],
    });
    expect(attWrites(r)).toHaveLength(0);
  });

  it("a placeholder ('someone') is never resolved, even when it would match a member", () => {
    const r = decide({
      now: NOW,
      state: state(),
      messages: [
        msg({
          from: "kemal",
          body: "someone is out",
          route: "other_att",
          facts: attendanceFacts([claim({ subject: "other", personRef: "someone", personNamed: true, personKind: "placeholder", polarity: "out" })]),
        }),
      ],
    });
    expect(attWrites(r)).toHaveLength(0);
  });
});

describe("a new player is provisioned only when the name returned is written in the message", () => {
  it("a named guest whose name is in the message is provisioned", () => {
    const r = decide({
      now: NOW,
      state: state(),
      messages: [
        msg({
          from: "amir",
          body: "my brother Shahrokh can play",
          route: "other_att",
          facts: attendanceFacts([claim({ subject: "other", personRef: "Shahrokh", personNamed: true, personKind: "named", polarity: "in" })]),
        }),
      ],
    });
    expect(attWrites(r).length).toBeGreaterThan(0);
  });

  it("a 'named' guest the model invented (not in the message) is NOT provisioned", () => {
    const r = decide({
      now: NOW,
      state: state(),
      messages: [
        msg({
          from: "amir",
          body: "my brother can play if needed",
          route: "other_att",
          facts: attendanceFacts([claim({ subject: "other", personRef: "Shahrokh", personNamed: true, personKind: "named", polarity: "in" })]),
        }),
      ],
    });
    expect(attWrites(r)).toHaveLength(0);
    expect(r.outcomes[0].reasons.join(" | ")).toMatch(/not written in the message/);
  });

  it("the check ignores case and accents, as the message is written", () => {
    const r = decide({
      now: NOW,
      state: state(),
      messages: [
        msg({
          from: "amir",
          body: "kuzenim ÖMER de geliyor",
          route: "other_att",
          facts: attendanceFacts([claim({ subject: "other", personRef: "Ömer", personNamed: true, personKind: "named", polarity: "in" })]),
        }),
      ],
    });
    expect(attWrites(r).length).toBeGreaterThan(0);
  });
});
