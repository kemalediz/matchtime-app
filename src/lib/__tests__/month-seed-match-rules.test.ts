/**
 * The pure part of matching a list's unknown names to nameless members
 * (2026-11-03, Vets MNF: 4 of 13 names matched because 20 members had no
 * name). No database, no model.
 */
import { describe, expect, it } from "vitest";
import { applyListMatch, numberNameless, seedReadKey, unmatchedEntries } from "@/lib/month-seed-match-rules";
import { draftSeedFromList, type SeedRowInput } from "@/lib/squad-month-rules";

const entry = (over: Record<string, unknown>) => ({ slot: null, raw: "", name: "", marks: {}, facts: null, ...over });

describe("draftSeedFromList keeps what an unknown name's line says", () => {
  it("an unknown name keeps its paid mark, its '4 only' and its number", () => {
    const list = {
      month: { month: 11, year: null },
      slots: [entry({ slot: 1, name: "Davide", marks: { paid: true } }), entry({ slot: 2, name: "Nabz", marks: { paid: true, gamesCommitted: 4 } }), entry({ slot: 3, name: "Ben", marks: { payg: true } })],
      sections: { cantPlay: [], reserves: [], other: [] },
    };
    const d = draftSeedFromList(list as never, [{ userId: "u-davide", name: "Davide Russo" }, { userId: "u-anon", name: null }], { month: 11 });
    expect(d.rows.map((r) => r.userId)).toEqual(["u-davide"]);
    expect(d.unmatched).toEqual([
      { slot: 2, name: "Nabz", reason: "unknown", candidates: [], kind: "regular", tier: "standard", paid: "claimed", paidAmountPence: null, gamesCommitted: 4 },
      { slot: 3, name: "Ben", reason: "unknown", candidates: [], kind: "payg", tier: "standard", paid: "none", paidAmountPence: null, gamesCommitted: null },
    ]);
  });
});

describe("applyListMatch", () => {
  const base = () => ({
    activityId: "a",
    games: 5,
    rows: [{ userId: "u-davide", kind: "regular", slot: 1, listName: "Davide" }] as SeedRowInput[],
    unmatched: unmatchedEntries([
      { slot: 2, name: "Nabz", reason: "unknown", candidates: [], kind: "regular", tier: "standard", paid: "claimed", paidAmountPence: null, gamesCommitted: 4 },
      { slot: 1, name: "Craig", reason: "unknown", candidates: [], kind: "regular", tier: "standard", paid: "claimed", paidAmountPence: null, gamesCommitted: null },
    ]),
  });

  it("numbers the unknown names u1, u2 ...", () => {
    expect(base().unmatched.map((u) => [u.ref, u.name])).toEqual([["u1", "Nabz"], ["u2", "Craig"]]);
  });

  it("puts the member on the draft with the line's facts and wording, and takes the name off the unknown list", () => {
    const r = applyListMatch(base(), "u1", "u-nabz");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.rows).toContainEqual({ userId: "u-nabz", kind: "regular", tier: "standard", slot: 2, paid: "claimed", paidAmountPence: null, gamesCommitted: 4, listName: "Nabz" });
    expect(r.data.unmatched?.map((u) => u.ref)).toEqual(["u2"]);
    expect(r.entry.name).toBe("Nabz");
    expect(r.data.activityId).toBe("a");
  });

  it("a number another row already has is dropped, never doubled", () => {
    const r = applyListMatch(base(), "u2", "u-craig");
    expect(r.ok && r.data.rows.find((x) => x.userId === "u-craig")?.slot).toBeNull();
  });

  it("refuses a member already on the draft, and a name that is not on the unknown list", () => {
    expect(applyListMatch(base(), "u1", "u-davide")).toEqual({ ok: false, error: "already-on" });
    expect(applyListMatch(base(), "u9", "u-nabz")).toEqual({ ok: false, error: "no-such-name" });
    expect(applyListMatch({ ...base(), unmatched: undefined }, "u1", "u-nabz")).toEqual({ ok: false, error: "no-such-name" });
  });

  it("numberNameless numbers from 1 in the order given", () => {
    expect(numberNameless(["a", "b"])).toEqual([{ n: 1, userId: "a" }, { n: 2, userId: "b" }]);
  });
});

describe("seedReadKey", () => {
  const rows: SeedRowInput[] = [
    { userId: "a", kind: "regular", slot: 1, paid: "claimed", listName: "Davide" },
    { userId: "b", kind: "payg", slot: 2, listName: "Ben" },
  ];
  it("is the same for the same reading, in any order", () => {
    expect(seedReadKey(rows, [{ name: "Nabz" }, { name: "Craig" }])).toBe(seedReadKey([...rows].reverse(), [{ name: "craig " }, { name: "Nabz" }]));
  });
  it("differs when a line or an unknown name differs", () => {
    const k = seedReadKey(rows, [{ name: "Nabz" }]);
    expect(seedReadKey([{ ...rows[0], gamesCommitted: 4 }, rows[1]], [{ name: "Nabz" }])).not.toBe(k);
    expect(seedReadKey(rows, [{ name: "Nabz" }, { name: "Oumesh" }])).not.toBe(k);
    expect(seedReadKey(rows.slice(0, 1), [{ name: "Nabz" }])).not.toBe(k);
  });
});
