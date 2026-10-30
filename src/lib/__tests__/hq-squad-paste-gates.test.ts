/**
 * THE FACT GATES ON A LIST PASTED IN HQ (2026-10-29), pure.
 *
 * FNF HQ, 29 Oct 18:04: an organiser pasted MatchTime's own two-sided
 * "Proposed teams" sheet back. The old deterministic reader took the 9
 * names under "Non Bibs" as the squad and proposed "Removing" the 9 under
 * "Bibs"; the organiser's YES dropped 9 confirmed players. The model now
 * says what a list is, and these gates hold whatever it says:
 *
 *   - a list whose players are exactly the teams' players is never a
 *     squad change;
 *   - confirmed players come out only when the reading accounts for every
 *     confirmed player left off, and never more than PASTE_MAX_REMOVALS.
 */
import { describe, expect, it } from "vitest";
import { gateSquadPaste, PASTE_MAX_REMOVALS } from "../admin-group-squad-rules";

const ids = (n: number, p = "u") => Array.from({ length: n }, (_, i) => `${p}${i + 1}`);
const confirmed = (list: string[]) => list.map((userId) => ({ userId, status: "CONFIRMED" as const }));
const refs = (list: string[]) => list.map((userId) => ({ userId }));

describe("gateSquadPaste", () => {
  const nonBibs = ids(9, "n");
  const bibs = ids(9, "b");
  const squad = confirmed([...nonBibs, ...bibs]);

  it("29 Oct: the teams sheet pasted back (all 18 team players) is never a squad change", () => {
    const g = gateSquadPaste({
      playing: refs([...nonBibs, ...bibs]),
      reserves: [],
      out: [],
      current: squad,
      teamUserIds: [...nonBibs, ...bibs],
    });
    expect(g).toEqual({ verdict: "teams" });
  });

  it("29 Oct: even a reading that keeps only Non Bibs and says the Bibs are out removes nobody (9 is over the cap)", () => {
    const g = gateSquadPaste({ playing: refs(nonBibs), reserves: [], out: bibs, current: squad, teamUserIds: [] });
    expect(g.verdict).toBe("squad");
    if (g.verdict !== "squad") return;
    expect(g.diff.remove).toEqual([]);
    expect(g.held).toEqual(bibs);
    expect(g.heldReason).toBe("too-many");
  });

  it("a confirmed player left off that the reading does not account for: nobody comes out", () => {
    const current = confirmed(ids(6));
    const g = gateSquadPaste({ playing: refs(ids(4)), reserves: [], out: ["u5"], current, teamUserIds: [] });
    if (g.verdict !== "squad") throw new Error("expected squad");
    expect(g.diff.remove).toEqual([]);
    expect(g.held).toEqual(["u5", "u6"]);
    expect(g.heldReason).toBe("unaccounted");
  });

  it("a real squad list: two left off on purpose come out, a new name goes in", () => {
    const current = confirmed(ids(6));
    const g = gateSquadPaste({
      playing: [...refs(["u1", "u2", "u3", "u4"]), { newName: "Naim" }],
      reserves: [],
      out: ["u5", "u6"],
      current,
      teamUserIds: [],
    });
    if (g.verdict !== "squad") throw new Error("expected squad");
    expect(g.diff.remove).toEqual([{ userId: "u5" }, { userId: "u6" }]);
    expect(g.diff.add).toEqual([{ newName: "Naim" }]);
    expect(g.held).toEqual([]);
    expect(g.heldReason).toBeNull();
  });

  it(`exactly ${PASTE_MAX_REMOVALS} out is allowed; one more holds them all`, () => {
    const current = confirmed(ids(10));
    const at = gateSquadPaste({ playing: refs(ids(7)), reserves: [], out: ["u8", "u9", "u10"], current, teamUserIds: [] });
    if (at.verdict !== "squad") throw new Error("expected squad");
    expect(at.diff.remove).toHaveLength(PASTE_MAX_REMOVALS);
    const over = gateSquadPaste({ playing: refs(ids(6)), reserves: [], out: ["u7", "u8", "u9", "u10"], current, teamUserIds: [] });
    if (over.verdict !== "squad") throw new Error("expected squad");
    expect(over.diff.remove).toEqual([]);
    expect(over.heldReason).toBe("too-many");
  });

  it("a list that IS the teams' players playing (a teams sheet with places open) is teams too", () => {
    const g = gateSquadPaste({
      playing: refs(["u1", "u2", "u3", "u4"]),
      reserves: [],
      out: [],
      current: confirmed(["u1", "u2", "u3", "u4"]),
      teamUserIds: ["u1", "u2", "u3", "u4"],
    });
    expect(g).toEqual({ verdict: "teams" });
  });

  it("a list with a new name is never 'the teams'", () => {
    const g = gateSquadPaste({
      playing: [...refs(["u1", "u2", "u3"]), { newName: "Naim" }],
      reserves: [],
      out: [],
      current: confirmed(["u1", "u2", "u3", "u4"]),
      teamUserIds: ["u1", "u2", "u3", "u4"],
    });
    expect(g.verdict).toBe("squad");
  });

  it("an out the reading names that IS on the list is ignored", () => {
    const current = confirmed(ids(4));
    const g = gateSquadPaste({ playing: refs(ids(4)), reserves: [], out: ["u1"], current, teamUserIds: [] });
    if (g.verdict !== "squad") throw new Error("expected squad");
    expect(g.diff.remove).toEqual([]);
    expect(g.diff.same).toBe(true);
  });
});
