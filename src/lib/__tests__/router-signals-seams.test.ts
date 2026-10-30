/**
 * The two seams that wait for P1's router and engine fields (2026-10-30):
 * which players'-group messages are read as a pasted list, and which
 * attendance messages also change the teams. Facts from the pipeline, never
 * from the words; until P1 sets them, nothing is flagged.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PASTED_LIST_STUB_FILE_ENV, pastedListIds, routerSaysPastedList } from "../pasted-list-signal";
import { TEAM_ALSO_STUB_FILE_ENV, alsoTeamsIds, engineSaysAlsoTeams } from "../team-also-signal";

const msgs = [
  { waMessageId: "a", body: "1. Ali\n2. Can\n3. Tom" },
  { waMessageId: "b", body: "IN" },
];
const stubFile = (content: unknown) => {
  const f = path.join(mkdtempSync(path.join(tmpdir(), "seam-")), "stub.json");
  writeFileSync(f, JSON.stringify(content));
  return f;
};

describe("pasted-list signal", () => {
  it("nothing is a list until the router says so", () => {
    expect(pastedListIds(msgs, [{ messageId: "a", route: "other_att" }], {}).size).toBe(0);
    expect(routerSaysPastedList(undefined)).toBe(false);
  });
  it("the router's flag marks exactly that message", () => {
    expect([...pastedListIds(msgs, [{ messageId: "a", route: "other_att", pastedList: true }], {})]).toEqual(["a"]);
  });
  it("the e2e stub flags by id or trimmed body", () => {
    const env = { [PASTED_LIST_STUB_FILE_ENV]: stubFile({ bodies: ["IN"] }) };
    expect([...pastedListIds(msgs, [], env)]).toEqual(["b"]);
  });
});

describe("team-also signal", () => {
  it("nothing until the engine says so", () => {
    expect(alsoTeamsIds(msgs, [{ waMessageId: "a" }], {}).size).toBe(0);
    expect(engineSaysAlsoTeams({ alsoChangesTeams: false })).toBe(false);
  });
  it("the engine's flag marks that message", () => {
    expect([...alsoTeamsIds(msgs, [{ waMessageId: "a", alsoChangesTeams: true } as never], {})]).toEqual(["a"]);
  });
  it("the e2e stub flags by id", () => {
    const env = { [TEAM_ALSO_STUB_FILE_ENV]: stubFile({ ids: ["b"] }) };
    expect([...alsoTeamsIds(msgs, [], env)]).toEqual(["b"]);
  });
});
