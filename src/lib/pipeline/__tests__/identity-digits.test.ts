/**
 * A NAME WITH A DIGIT IN IT IS NOT THE SAME NAME WITHOUT IT (2026-10-22).
 *
 * MT Test: the partner guests are called "C1" and "C2". `norm()` stripped
 * every digit, so both became "c": an admin's "C1, C2 OUT" resolved both
 * references to C1, dropped C1 twice and left C2 in. Since 2026-11-09 who
 * a name is, is the model's pick (`who-is-who.ts`), filed under the name
 * exactly as quoted: "C1" and "C2" are two keys and two answers, and a
 * reference with no letters is still never a person.
 */
import { describe, it, expect } from "vitest";
import { resolvePerson } from "../identity";
import { decide } from "./support/stub-picks";
import { NOW, attendanceFacts, claim, member, msg, world } from "./helpers";
import type { Member } from "../types";
import type { PersonPick } from "../who-is-who";

const named = (key: string, name: string): Member => member(key, { name });

describe("each quoted name keeps its own pick, digits and all", () => {
  const roster = [named("c1", "C1"), named("c2", "C2"), named("kemal", "Kemal Ediz")];
  const people = new Map<string, PersonPick>([
    ["C1", { kind: "member", userId: "u-c1" }],
    ["C2", { kind: "member", userId: "u-c2" }],
    ["C3", { kind: "none" }],
  ]);

  it("C1 and C2 are two people", () => {
    expect(resolvePerson("C1", roster, people)).toMatchObject({ kind: "resolved", member: { userId: "u-c1" } });
    expect(resolvePerson("C2", roster, people)).toMatchObject({ kind: "resolved", member: { userId: "u-c2" } });
  });

  it("C3 is nobody on the list, never C1 or C2", () => {
    const r = resolvePerson("C3", roster, people);
    expect(r.kind === "resolved" ? r.member.userId : null).toBeNull();
  });

  it("a reference with no letters is still never a person", () => {
    expect(resolvePerson("7", roster, people)).toMatchObject({ kind: "not-a-person" });
    expect(resolvePerson("12", roster, people)).toMatchObject({ kind: "not-a-person" });
  });
});

describe('"@Match Time C1, C2 OUT" from an admin', () => {
  it("drops C1 AND C2, each once", () => {
    const state = world({ players: ["kemal", "elvin", "c1", "c2"], confirmed: ["kemal", "elvin", "c1", "c2"] });
    for (const m of state.roster) {
      if (m.userId === "u-c1") m.name = "C1";
      if (m.userId === "u-c2") m.name = "C2";
    }
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          from: "kemal",
          body: "@Match Time C1, C2 OUT",
          route: "other_att",
          tagged: true,
          facts: attendanceFacts([
            claim({ subject: "other", personRef: "C1", personNamed: true, polarity: "out" }),
            claim({ subject: "other", personRef: "C2", personNamed: true, polarity: "out" }),
          ]),
        }),
      ],
    });
    const status = (id: string) => r.nextState.rows.find((x) => x.userId === id)?.status;
    expect(status("u-c1")).toBe("DROPPED");
    expect(status("u-c2")).toBe("DROPPED");
    expect(r.writes.filter((w) => "userId" in w && w.userId === "u-c1")).toHaveLength(1);
  });
});
