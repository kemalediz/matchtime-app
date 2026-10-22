/**
 * A NAME WITH A DIGIT IN IT IS NOT THE SAME NAME WITHOUT IT (2026-10-22).
 *
 * MT Test: the partner guests are called "C1" and "C2". `norm()` stripped
 * every digit, so both became "c": an admin's "C1, C2 OUT" resolved both
 * references to C1, dropped C1 twice and left C2 in. Real squads have the
 * same shape ("Ali 2", "Mohammed 1"). Digits now stay in the name; a
 * reference with no letters is still never a person; a digit-free name
 * resolves exactly as before.
 */
import { describe, it, expect } from "vitest";
import { resolvePerson } from "../identity";
import { decide } from "../engine";
import { NOW, attendanceFacts, claim, member, msg, world } from "./helpers";
import type { Member } from "../types";

const named = (key: string, name: string): Member => member(key, { name });

describe("resolvePerson keeps digits", () => {
  const roster = [named("c1", "C1"), named("c2", "C2"), named("kemal", "Kemal Ediz")];

  it("C1 and C2 are two people", () => {
    expect(resolvePerson("C1", roster)).toMatchObject({ kind: "resolved", member: { userId: "u-c1" } });
    expect(resolvePerson("C2", roster)).toMatchObject({ kind: "resolved", member: { userId: "u-c2" } });
    expect(resolvePerson("c2", roster)).toMatchObject({ kind: "resolved", member: { userId: "u-c2" } });
  });

  it("C3 is nobody on the list, never C1 or C2", () => {
    const r = resolvePerson("C3", roster);
    expect(r.kind === "resolved" ? r.member.userId : null).toBeNull();
  });

  it('"Ali 2" matches "ali 2", and "Ali2" typed without the space', () => {
    const r2 = [named("ali2", "Ali 2"), named("ali", "Ali Khan")];
    expect(resolvePerson("ali 2", r2)).toMatchObject({ kind: "resolved", member: { userId: "u-ali2" } });
    expect(resolvePerson("Ali2", r2)).toMatchObject({ kind: "resolved", member: { userId: "u-ali2" } });
    expect(resolvePerson("Mohammed 1", [named("m1", "Mohammed 1"), named("m2", "Mohammed 2")])).toMatchObject({
      kind: "resolved",
      member: { userId: "u-m1" },
    });
  });

  it('a first name still finds "Ali 2" when he is the only Ali', () => {
    expect(resolvePerson("Ali", [named("ali2", "Ali 2"), named("kemal", "Kemal Ediz")])).toMatchObject({
      kind: "resolved",
      member: { userId: "u-ali2" },
    });
  });

  it("two Alis: a bare first name is still ambiguous", () => {
    expect(resolvePerson("Ali", [named("ali2", "Ali 2"), named("ali", "Ali Khan")])).toMatchObject({ kind: "ambiguous" });
  });

  it("a reference with no letters is still never a person", () => {
    expect(resolvePerson("7", roster)).toMatchObject({ kind: "not-a-person" });
    expect(resolvePerson("12", roster)).toMatchObject({ kind: "not-a-person" });
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
