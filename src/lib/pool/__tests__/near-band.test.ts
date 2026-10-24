/**
 * "Players near you" for the organiser (slice L4): a band, never a count he
 * could narrow down and never an identity. Plan section 6: before asking,
 * the club sees "a band of how many pool players are near"; never names,
 * numbers, areas or any list.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NEAR_BAND_MANY, POOL_NEAR_BANDS, nearBand, nearBandOf } from "../near-band";

describe("nearBand", () => {
  const table: Array<[number, string]> = [
    [0, "none"],
    [1, "few"],
    [4, "few"],
    [5, "5+"],
    [6, "5+"],
    [500, "5+"],
    [-1, "none"],
    [Number.NaN, "none"],
    [2.5, "few"],
  ];
  it.each(table)("%s players: %s", (n, want) => expect(nearBand(n)).toBe(want));
  it("the threshold is one constant", () => expect(NEAR_BAND_MANY).toBe(5));
  it("only three answers exist", () => expect(POOL_NEAR_BANDS).toEqual(["none", "few", "5+"]));
});

describe("privacy: the band can never carry who the players are", () => {
  const people = [
    { userId: "cuid_ali", displayName: "Ali K", phoneNumber: "+447700900001", areaDistrict: "SM1" },
    { userId: "cuid_bob", displayName: "Bob S", phoneNumber: "+447700900002", areaDistrict: "SM2" },
  ];

  it("nearBandOf(list) returns a bare band string, nothing from the list", () => {
    for (let n = 0; n <= 12; n++) {
      const list = Array.from({ length: n }, (_, i) => people[i % 2]);
      const band = nearBandOf(list);
      expect(typeof band).toBe("string");
      expect(POOL_NEAR_BANDS).toContain(band);
      const serialised = JSON.stringify(band);
      for (const p of people) for (const v of Object.values(p)) expect(serialised).not.toContain(v);
    }
  });

  it("the same band for different people of the same count (the output depends on the count alone)", () => {
    const a = nearBandOf([people[0], people[0]]);
    const b = nearBandOf([people[1], { anything: "else" }]);
    expect(a).toBe(b);
  });

  it("the module's exports return only band strings (source check: no object or array is built)", () => {
    const src = readFileSync(path.resolve(__dirname, "..", "near-band.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(src).not.toMatch(/\bimport\b/);
    expect(src).not.toMatch(/return\s*[[{]/);
    expect(src).not.toMatch(/\.(map|filter|slice|find)\(/);
  });
});
