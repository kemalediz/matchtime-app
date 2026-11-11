/**
 * The organisers-mode net and the unified answer (UNIFIED_ANSWERS round 2,
 * 2026-11-11). In FNF's players' group (the organisers post the list) the
 * net swapped a ratings table and a count for "The organisers will post the
 * list.", because a numbered list reads as squad state. The unified answer's
 * context names nobody in the squad there, and it catches a list copied
 * from the chat itself (`reproducesSquad`), so it passes the net by intent.
 */
import { describe, expect, it } from "vitest";
import { passesOrganisersNet } from "@/lib/organisers-list-copy";
import { OPEN_ANSWER_INTENT, UNIFIED_ANSWER_INTENT, skipsSquadComposition } from "@/lib/group-copy";

describe("the unified answer and the organisers-mode net", () => {
  it("passes by intent, and is skipped by the squad-composition pass", () => {
    expect(UNIFIED_ANSWER_INTENT).toBe("unified_answer");
    expect(passesOrganisersNet(UNIFIED_ANSWER_INTENT)).toBe(true);
    expect(skipsSquadComposition(UNIFIED_ANSWER_INTENT)).toBe(true);
  });

  it("the old open answer still goes through the net, as before", () => {
    expect(passesOrganisersNet(OPEN_ANSWER_INTENT)).toBe(false);
  });
});
