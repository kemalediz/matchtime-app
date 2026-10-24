/**
 * A SQUAD ROW WHOSE PLAYER IS NO LONGER A MEMBER IS PRINTED BY NAME
 * (FNF, 2026-10-24).
 *
 * Prod: "Glazers" was removed from FNF on the admin players page while on
 * the bench of the Fri 30 Oct match. The roster is built from live
 * memberships only, so his row had no name and the HQ squad post read
 * "Bench (1): 1. a player". Removal now takes him off upcoming matches
 * (member-removal.ts); this is the defence for any row that still slips
 * through: `load-state.ts` carries the names of row users who are not on
 * the roster in `SquadState.rowNames`, and the composer prints them. The
 * roster, which is what people are MATCHED on, is unchanged: a former
 * member is printed, never resolved.
 */
import { describe, expect, it } from "vitest";
import { compose } from "../compose";
import { decide } from "../engine";
import { NOW, msg, world } from "./helpers";
import type { SquadState } from "../types";

const rosterAsk = () =>
  msg({
    from: "adam",
    body: "@Match Time who's playing?",
    route: "question",
    tagged: true,
    facts: { kind: "question", topic: "squad", personRef: null, statedCount: null },
  });

function withFormerOnBench(rowNames: SquadState["rowNames"]): SquadState {
  const state = world({ confirmed: ["kemal", "elvin"], bench: [] });
  return {
    ...state,
    rows: [...state.rows, { userId: "u-glazers", status: "BENCH", position: 19 }],
    rowNames,
  };
}

describe("a former member's squad row", () => {
  it("is printed by his name, never as 'a player'", () => {
    const state = withFormerOnBench({ "u-glazers": "Glazers" });
    const text = compose(decide({ now: NOW, state, messages: [rosterAsk()] })).utterances.map((u) => u.text).join("\n");
    expect(text).toContain("Glazers");
    expect(text).not.toContain("a player");
  });

  it("is not on the roster, so nobody can be matched to him", () => {
    const state = withFormerOnBench({ "u-glazers": "Glazers" });
    expect(state.roster.some((m) => m.userId === "u-glazers")).toBe(false);
  });

  it("without a carried name (an older state) the fallback is unchanged", () => {
    const state = withFormerOnBench(undefined);
    const text = compose(decide({ now: NOW, state, messages: [rosterAsk()] })).utterances.map((u) => u.text).join("\n");
    expect(text).toContain("a player");
  });
});
