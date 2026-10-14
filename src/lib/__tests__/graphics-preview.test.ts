/**
 * The Posters card's preview (2026-10-14): the club's real list poster and
 * team sheet for its next match, or, when there is no match or not enough
 * names yet, the same design with clearly marked sample names ("Player 1"
 * to "Player 18"), so the owner always sees what the design looks like.
 * Pure: the data in, the data to draw out.
 */
import { describe, expect, it } from "vitest";
import { MIN_REAL_LIST_NAMES, previewGraphicData, sampleNames } from "../graphics-preview";
import type { ListPosterData, TeamSheetData } from "../match-graphics";

const BASE = { clubName: "Invented FC", lang: "en" as const, matchDate: new Date("2026-10-16T19:30:00Z"), kickoff: "20:30", venue: "Invented Park" };
const listOf = (n: number, reserves = 0): ListPosterData => ({
  kind: "list",
  ...BASE,
  players: Array.from({ length: n }, (_, i) => `Real${i + 1}`),
  reserves: Array.from({ length: reserves }, (_, i) => `Bench${i + 1}`),
});
const teams = (a: number, b: number): TeamSheetData => ({
  kind: "teams",
  ...BASE,
  teams: [
    { label: "Reds", names: Array.from({ length: a }, (_, i) => `A${i}`) },
    { label: "Blues", names: Array.from({ length: b }, (_, i) => `B${i}`) },
  ],
});
const fallback = { ...BASE, teamLabels: ["Reds", "Blues"] as [string, string] };

describe("sampleNames", () => {
  it("Player 1 to Player 18 in English, Oyuncu 1 to Oyuncu 18 in Turkish", () => {
    expect(sampleNames("en")).toEqual(Array.from({ length: 18 }, (_, i) => `Player ${i + 1}`));
    expect(sampleNames("tr")[0]).toBe("Oyuncu 1");
    expect(sampleNames("tr")[17]).toBe("Oyuncu 18");
  });
});

describe("previewGraphicData", () => {
  it("a list with enough real names: the real list, not a sample", () => {
    const real = listOf(MIN_REAL_LIST_NAMES, 2);
    expect(previewGraphicData("list", real, fallback)).toEqual({ data: real, sample: false });
  });

  it("a list with too few names: 18 sample names, no reserves, the real match's day, time, venue and club", () => {
    const r = previewGraphicData("list", listOf(MIN_REAL_LIST_NAMES - 1, 3), fallback);
    expect(r.sample).toBe(true);
    const d = r.data as ListPosterData;
    expect(d.kind).toBe("list");
    expect(d.players).toEqual(sampleNames("en"));
    expect(d.reserves).toEqual([]);
    expect(d).toMatchObject({ clubName: "Invented FC", kickoff: "20:30", venue: "Invented Park" });
    // No real name survives in a sample.
    expect(JSON.stringify(d)).not.toContain("Real1");
    expect(JSON.stringify(d)).not.toContain("Bench1");
  });

  it("no match at all: the sample on the fallback's club, day and labels", () => {
    const r = previewGraphicData("list", null, fallback);
    expect(r).toMatchObject({ sample: true, data: { kind: "list", clubName: "Invented FC" } });
  });

  it("teams that exist: the real team sheet", () => {
    const real = teams(5, 5);
    expect(previewGraphicData("teams", real, fallback)).toEqual({ data: real, sample: false });
  });

  it("no teams yet: nine sample names a side, under the club's own team names", () => {
    const r = previewGraphicData("teams", null, fallback);
    expect(r.sample).toBe(true);
    const d = r.data as TeamSheetData;
    expect(d.teams[0]).toEqual({ label: "Reds", names: sampleNames("en").slice(0, 9) });
    expect(d.teams[1]).toEqual({ label: "Blues", names: sampleNames("en").slice(9, 18) });
  });

  it("a measured template's sample fits it: two columns of its rows, and exactly its rows a side", () => {
    const list = previewGraphicData("list", null, fallback, { rows: 2 }).data as ListPosterData;
    expect(list.players).toEqual(sampleNames("en").slice(0, 4));
    const t = previewGraphicData("teams", null, fallback, { rows: 2 }).data as TeamSheetData;
    expect(t.teams.map((x) => x.names)).toEqual([
      ["Player 1", "Player 2"],
      ["Player 3", "Player 4"],
    ]);
    // FNF's nine rows: the usual 18, nine a side.
    expect((previewGraphicData("list", null, fallback, { rows: 9 }).data as ListPosterData).players).toHaveLength(18);
    // More rows than the usual sample: the team sheet still fills them.
    const big = previewGraphicData("teams", null, fallback, { rows: 12 }).data as TeamSheetData;
    expect(big.teams[0].names).toHaveLength(12);
    expect(big.teams[1].names[11]).toBe("Player 24");
  });

  it("a Turkish club's sample is in Turkish", () => {
    const r = previewGraphicData("list", null, { ...fallback, lang: "tr" });
    expect((r.data as ListPosterData).players[0]).toBe("Oyuncu 1");
  });
});
