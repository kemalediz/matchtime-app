/**
 * THE FRIEND LINK IN THE ENGINE (Kemal, 2026-10-31; plan
 * MDs/friend-link-plan-2026-10-31.md section 1.3). A player's "my friend
 * Ali is in" or "+1" adds nobody, posts nothing and asks nothing: the
 * engine marks the message for a friend link (`MessageOutcome.friendLinks`)
 * and the batch sends the sender his link. An organiser's keeps today's
 * behaviour (D1). Everything else in the same message still applies.
 */
import { describe, expect, it } from "vitest";
import { decide } from "../engine";
import { NOW, attendanceFacts, claim, msg, statusOf, world } from "./helpers";
import type { ProposedWrite } from "../types";

const att = (ws: ProposedWrite[]) => ws.filter((w) => w.kind === "attendance");
const SEVEN = ["kemal", "elvin", "sait", "mustafa", "abid", "idris", "faris"];

describe("a player's friend: a link, nobody added", () => {
  it("a named friend nobody knows", () => {
    const r = decide({
      now: NOW,
      state: world({ confirmed: SEVEN }),
      messages: [
        msg({
          from: "shane",
          body: "my friend Ali is in",
          route: "other_att",
          facts: attendanceFacts([claim({ subject: "other", personRef: "Ali", personNamed: true, personKind: "named", polarity: "in" })]),
        }),
      ],
    });
    expect(att(r.writes)).toHaveLength(0);
    expect(r.nextState.roster.map((m) => m.name)).not.toContain("Ali");
    expect(r.outcomes[0].friendLinks).toEqual([{ claimIndex: 0, friendName: "Ali" }]);
    expect(r.outcomes[0].react).toBeNull(); // the batch reacts ✉️ once the DM is queued
    expect(r.speech.map((s) => s.kind)).toEqual([]);
    expect(r.outcomes[0].disposition).toBe("acted");
  });

  it("an unnamed friend (+1, my brother): a link with no name, no name question", () => {
    for (const [ref, kind] of [["+1", "placeholder"], ["my brother", "relation"]] as const) {
      const r = decide({
        now: NOW,
        state: world({ confirmed: SEVEN }),
        messages: [msg({ from: "amir", body: ref, route: "offer", facts: attendanceFacts([claim({ subject: "other", personRef: ref, personNamed: false, personKind: kind, polarity: "in", contingent: true, conditionOn: "squad" })]) })],
      });
      expect(att(r.writes)).toHaveLength(0);
      expect(r.outcomes[0].friendLinks).toEqual([{ claimIndex: 0, friendName: null }]);
      expect(r.speech.some((s) => s.kind === "guest_name_ask")).toBe(false);
    }
  });

  it("a full squad still gets the link (the friend goes on the bench when he books)", () => {
    const full = ["kemal", "elvin", "sait", "mustafa", "abid", "idris", "faris", "shaz", "baki", "burak", "deniz", "emre", "ferhat", "gokhan"];
    const r = decide({
      now: NOW,
      state: world({ confirmed: full }),
      messages: [msg({ from: "amir", body: "+1", route: "offer", facts: attendanceFacts([claim({ subject: "other", personRef: "+1", personNamed: false, personKind: "placeholder", polarity: "in" })]) })],
    });
    expect(r.outcomes[0].friendLinks).toHaveLength(1);
  });

  it("the sender's own IN in the same message still writes; two friends get two links", () => {
    const r = decide({
      now: NOW,
      state: world({ confirmed: SEVEN }),
      messages: [
        msg({
          from: "zair",
          body: "I'm in, and Ali and my brother can play too",
          route: "self_att",
          facts: attendanceFacts([
            claim({ subject: "sender", polarity: "in" }),
            claim({ subject: "other", personRef: "Ali", personNamed: true, personKind: "named", polarity: "in" }),
            claim({ subject: "other", personRef: "my brother", personNamed: false, personKind: "relation", polarity: "in" }),
          ]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "zair")).toBe("CONFIRMED");
    expect(r.outcomes[0].friendLinks).toEqual([
      { claimIndex: 1, friendName: "Ali" },
      { claimIndex: 2, friendName: null },
    ]);
    expect(r.outcomes[0].react).toBe("✅");
  });

  it("a member on the roster is an ordinary third-party IN, not a link", () => {
    const r = decide({
      now: NOW,
      state: world({ confirmed: SEVEN.slice(0, 3) }),
      messages: [msg({ from: "shane", body: "Faris is in", route: "other_att", facts: attendanceFacts([claim({ subject: "other", personRef: "Faris", personNamed: true, personKind: "named", polarity: "in" })]) })],
    });
    expect(r.outcomes[0].friendLinks ?? []).toEqual([]);
    expect(att(r.writes)).toHaveLength(1);
  });

  it("no match, attendance off: no link and nothing said", () => {
    const r = decide({
      now: NOW,
      state: world({ confirmed: SEVEN, noMatch: true }),
      messages: [msg({ from: "amir", body: "+1", route: "offer", facts: attendanceFacts([claim({ subject: "other", personRef: "+1", personNamed: false, personKind: "placeholder", polarity: "in" })]) })],
    });
    expect(r.outcomes[0].friendLinks ?? []).toEqual([]);
    expect(r.speech).toEqual([]);
  });
});

describe("an organiser keeps today's behaviour (D1)", () => {
  it("'Ali is in' from an admin adds Ali", () => {
    const r = decide({
      now: NOW,
      state: world({ confirmed: SEVEN.slice(2) }),
      messages: [msg({ from: "kemal", body: "Ali is in", route: "other_att", facts: attendanceFacts([claim({ subject: "other", personRef: "Ali", personNamed: true, personKind: "named", polarity: "in" })]) })],
    });
    expect(r.outcomes[0].friendLinks ?? []).toEqual([]);
    expect(att(r.writes)[0]).toMatchObject({ name: "Ali", status: "CONFIRMED" });
  });
  it("'+1' from an admin still asks for the name", () => {
    const r = decide({
      now: NOW,
      state: world({ confirmed: SEVEN.slice(2) }),
      messages: [msg({ from: "kemal", body: "+1", route: "offer", facts: attendanceFacts([claim({ subject: "other", personRef: "+1", personNamed: false, personKind: "placeholder", polarity: "in" })]) })],
    });
    expect(r.outcomes[0].friendLinks ?? []).toEqual([]);
    expect(r.speech.some((s) => s.kind === "guest_name_ask")).toBe(true);
  });
  it("an organiser's contingent IN for someone else is held, as before", () => {
    const r = decide({
      now: NOW,
      state: world({ confirmed: ["omar"] }),
      messages: [
        msg({
          from: "kemal",
          body: "if David would like to join, I'd be happy for him to take a spot",
          route: "offer",
          tagged: true,
          facts: attendanceFacts([claim({ subject: "other", personRef: "David", personNamed: true, polarity: "in", contingent: true, conditionOn: "squad" })]),
        }),
      ],
    });
    expect(r.writes).toEqual([]);
    expect(r.outcomes[0].friendLinks ?? []).toEqual([]);
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/contingent/);
  });
});
