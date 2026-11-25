/**
 * Unit tests for the pure half of scripts/_tmp-vets-nov2-ratings.ts and
 * scripts/_tmp-vets-nov-add.ts. scripts/ sits outside the vitest include,
 * so run with the scratch config:
 *
 *   npx vitest run --config scripts/_tmp-vets-nov2.vitest.config.ts
 */
import { describe, expect, it } from "vitest";
import {
  NOV2_GAME,
  allListNames,
  parseMapping,
  parseMonthAdds,
  planNaming,
  planSeed,
  rateDmDecision,
} from "./_tmp-vets-nov2-plan";

const norm = (s: string | null | undefined) => {
  const t = (s ?? "").replace(/\s+/g, "");
  return /^\+44\d{10}$/.test(t) ? t : null;
};

describe("NOV2_GAME", () => {
  it("has the 13 players, Bibs as the RED slot and No bibs as YELLOW, No bibs winning 4-3", () => {
    expect(NOV2_GAME.red.label).toBe("Bibs");
    expect(NOV2_GAME.yellow.label).toBe("No bibs");
    expect(NOV2_GAME.red.score).toBe(3);
    expect(NOV2_GAME.yellow.score).toBe(4);
    expect(NOV2_GAME.red.players).toHaveLength(6);
    expect(NOV2_GAME.yellow.players).toHaveLength(7);
    expect(allListNames()).toHaveLength(13);
    expect(new Set(allListNames().map((n) => n.toLowerCase())).size).toBe(13);
  });
});

describe("parseMapping", () => {
  it("reads a bare phone, a userId, an object with a seed, and normalises the phone", () => {
    const r = parseMapping(
      { Jon: "+44 7745 675276", Kemal: { userId: "cmn5vhtp2000004ifh4dqbsym", seed: 7 }, Luca: { create: "phoneless", seed: 5 } },
      norm,
    );
    expect(r.errors).toEqual([]);
    expect(r.entries.get("jon")).toMatchObject({ listName: "Jon", phone: "+447745675276", userId: null, create: false, seed: null });
    expect(r.entries.get("kemal")).toMatchObject({ userId: "cmn5vhtp2000004ifh4dqbsym", phone: null, seed: 7 });
    expect(r.entries.get("luca")).toMatchObject({ create: true, phone: null, userId: null, seed: 5 });
  });

  it("matches the roster names case-insensitively and refuses a name not on the team sheet", () => {
    const r = parseMapping({ SMILER: "+447983882605", Bob: "+447000000000" }, norm);
    expect(r.entries.get("smiler")?.listName).toBe("smiler");
    expect(r.errors).toEqual(['"Bob" is not one of the 2 Nov players']);
  });

  it("treats null as not known yet (never a guess) and rejects a bad phone, a bad seed and two keys for one player", () => {
    const r = parseMapping({ Nabz: null, Ben: "07984", Craig: { phone: "+447817981094", seed: 11 }, ben: "+447984977298" }, norm);
    expect(r.entries.get("nabz")).toMatchObject({ unknown: true });
    expect(r.errors).toContain('"Ben": "07984" is not a phone number');
    expect(r.errors).toContain('"Craig": a seed is a whole number from 1 to 10');
    expect(r.errors).toContain('"ben" is given twice');
  });

  it("reads skip: the player is left off the recorded game", () => {
    const r = parseMapping({ Luca: { skip: true } }, norm);
    expect(r.errors).toEqual([]);
    expect(r.entries.get("luca")).toMatchObject({ skip: true, create: false, phone: null, userId: null });
  });

  it("refuses an entry that names both a phone and a userId, or neither and no create", () => {
    const r = parseMapping({ Jon: { phone: "+447745675276", userId: "cx" }, Steve: {} }, norm);
    expect(r.errors).toContain('"Jon": give a phone OR a userId, not both');
    expect(r.errors).toContain('"Steve": needs a phone, a userId, "create": "phoneless" or "skip": true');
  });
});

describe("planNaming", () => {
  it("names a nameless user the club owns, and never overwrites a name", () => {
    expect(planNaming({ current: null, listName: "Andrew", clubOwned: true })).toEqual({ action: "name", to: "Andrew" });
    expect(planNaming({ current: "  ", listName: "Andrew", clubOwned: true })).toEqual({ action: "name", to: "Andrew" });
    expect(planNaming({ current: "Cj - Barber Lab", listName: "CJ", clubOwned: true })).toEqual({ action: "keep", current: "Cj - Barber Lab" });
  });
  it("leaves a nameless user the club does not own alone (the app's own rule)", () => {
    expect(planNaming({ current: null, listName: "Ibrahim", clubOwned: false })).toEqual({ action: "not-owned" });
  });
});

describe("planSeed", () => {
  it("writes only over an empty seed, and reports a different existing one", () => {
    expect(planSeed(null, 6)).toEqual({ action: "write", to: 6 });
    expect(planSeed(6, 6)).toEqual({ action: "same" });
    expect(planSeed(4, 7)).toEqual({ action: "differs", current: 4, wanted: 7 });
    expect(planSeed(null, null)).toEqual({ action: "none" });
    expect(planSeed(5, null)).toEqual({ action: "none" });
  });
});

describe("rateDmDecision", () => {
  const base = { hasPhone: true, optedOut: false, engaged: false, alreadyKeyed: false, playerRating: true, momAnnounced: false };
  it("sends to a reachable player who has not rated and has no rate-dm key", () => {
    expect(rateDmDecision(base)).toEqual({ send: true });
  });
  it("gives the first reason that stops it, in the scheduler's and the late-DM path's order", () => {
    expect(rateDmDecision({ ...base, playerRating: false })).toEqual({ send: false, reason: "ratings-off" });
    expect(rateDmDecision({ ...base, momAnnounced: true })).toEqual({ send: false, reason: "mom-announced" });
    expect(rateDmDecision({ ...base, hasPhone: false })).toEqual({ send: false, reason: "no-phone" });
    expect(rateDmDecision({ ...base, optedOut: true })).toEqual({ send: false, reason: "opted-out" });
    expect(rateDmDecision({ ...base, engaged: true })).toEqual({ send: false, reason: "already-rated" });
    expect(rateDmDecision({ ...base, alreadyKeyed: true })).toEqual({ send: false, reason: "already-sent" });
  });
});

describe("parseMonthAdds", () => {
  it("reads the list rows: who, says-paid or not, games", () => {
    const r = parseMonthAdds(
      [
        { name: "Dan", phone: "+447947495343" },
        { name: "Oumesh", phone: "+447919156104", paid: true, games: 4 },
      ],
      norm,
    );
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual([
      { listName: "Dan", phone: "+447947495343", userId: null, paid: false, games: null },
      { listName: "Oumesh", phone: "+447919156104", userId: null, paid: true, games: 4 },
    ]);
  });
  it("refuses a row without a name, without a phone or userId, or with a bad games count", () => {
    const r = parseMonthAdds([{ phone: "+447947495343" }, { name: "Ben" }, { name: "Steve", phone: "+447725834832", games: 0 }], norm);
    expect(r.errors).toEqual(["row 1: needs a name", '"Ben": needs a phone or a userId', '"Steve": games is a whole number from 1 to 10']);
  });
});
