/**
 * The pool's sport catalogue (slice L1, 2026-10-24). Approved spec:
 * MDs/local-player-pool-approved-spec-2026-10-24.md, "Sports".
 *
 * ONE module holds the catalogue (`../sports.ts`): which sports a player can
 * pick, which of them have formats and which formats, the level scale, and
 * the labels in every language. The sign-up form, matching and the offer
 * copy all read it, and the DB CHECK is pinned to it (schema-sql.test.ts).
 */
import { describe, expect, it } from "vitest";
import { LANGS } from "../../i18n/lang";
import {
  DEFAULT_POOL_SPORT,
  OTHER_SPORT,
  POOL_SPORTS,
  POOL_SPORT_KEYS,
  SPORT_LEVELS,
  formatsOf,
  isPoolSportKey,
  levelLabel,
  normaliseSportChoice,
  poolSportOfClubSport,
  sportHasFormats,
  sportLabel,
} from "../sports";

describe("the catalogue", () => {
  it("is the approved list, football first and the default", () => {
    expect(POOL_SPORT_KEYS).toEqual([
      "football",
      "basketball",
      "tennis",
      "badminton",
      "squash",
      "padel",
      "table-tennis",
      "billiards",
      "snooker",
      "pool",
    ]);
    expect(DEFAULT_POOL_SPORT).toBe("football");
    expect(OTHER_SPORT).toBe("other");
  });

  it("only football and basketball have formats, with the approved choices", () => {
    expect(formatsOf("football")).toEqual([5, 7, 8, 9, 11]);
    expect(formatsOf("basketball")).toEqual([3, 5]);
    for (const key of POOL_SPORT_KEYS.filter((k) => k !== "football" && k !== "basketball")) {
      expect(formatsOf(key), key).toEqual([]);
      expect(sportHasFormats(key), key).toBe(false);
    }
    expect(formatsOf(OTHER_SPORT)).toEqual([]);
  });

  it("has a label in every language the product ships, for every sport and level", () => {
    for (const lang of LANGS) {
      for (const s of POOL_SPORTS) expect(sportLabel(s.key, lang).trim(), `${lang} ${s.key}`).not.toBe("");
      for (const l of SPORT_LEVELS) expect(levelLabel(l, lang).trim(), `${lang} ${l}`).not.toBe("");
    }
    expect(sportLabel("football", "tr")).toBe("Futbol");
    expect(levelLabel("novice", "en")).toBe("Novice");
  });

  it("knows its own keys and nothing else", () => {
    expect(isPoolSportKey("padel")).toBe(true);
    expect(isPoolSportKey("other")).toBe(false);
    expect(isPoolSportKey("Football")).toBe(false);
  });

  it("the levels are the approved four, lowest first", () => {
    expect(SPORT_LEVELS).toEqual(["novice", "intermediate", "advanced", "pro"]);
  });
});

describe("normaliseSportChoice: what the form may save for one sport", () => {
  it("keeps a catalogue sport with valid formats, sorted and deduped", () => {
    expect(normaliseSportChoice({ sport: "football", formats: [7, 5, 7] })).toEqual({
      ok: true,
      value: { sport: "football", otherName: "", level: null, levelText: null, formats: [5, 7] },
    });
  });

  it("refuses a format the sport does not have, and any format on a sport without formats", () => {
    expect(normaliseSportChoice({ sport: "football", formats: [6] })).toEqual({ ok: false, error: "bad-format" });
    expect(normaliseSportChoice({ sport: "tennis", formats: [2] })).toEqual({ ok: false, error: "bad-format" });
  });

  it("an 'other' sport needs its own name, trimmed and bounded; a catalogue sport takes none", () => {
    expect(normaliseSportChoice({ sport: "other", otherName: "  Ultimate frisbee " })).toEqual({
      ok: true,
      value: { sport: "other", otherName: "Ultimate frisbee", level: null, levelText: null, formats: [] },
    });
    expect(normaliseSportChoice({ sport: "other", otherName: "  " })).toEqual({ ok: false, error: "other-needs-name" });
    expect(normaliseSportChoice({ sport: "other", otherName: "x".repeat(41) })).toEqual({ ok: false, error: "other-needs-name" });
    expect(normaliseSportChoice({ sport: "padel", otherName: "x" }).ok).toBe(true);
    expect(normaliseSportChoice({ sport: "padel", otherName: "x" })).toMatchObject({ value: { otherName: "" } });
  });

  it("a level is one of the scale OR the player's own words, never both, and optional", () => {
    expect(normaliseSportChoice({ sport: "squash", level: "advanced" })).toMatchObject({ ok: true, value: { level: "advanced", levelText: null } });
    expect(normaliseSportChoice({ sport: "squash", levelText: " played at uni " })).toMatchObject({
      ok: true,
      value: { level: null, levelText: "played at uni" },
    });
    expect(normaliseSportChoice({ sport: "squash", level: "advanced", levelText: "x" })).toEqual({ ok: false, error: "bad-level" });
    expect(normaliseSportChoice({ sport: "squash", level: "legend" })).toEqual({ ok: false, error: "bad-level" });
  });

  it("refuses a sport that is not in the catalogue", () => {
    expect(normaliseSportChoice({ sport: "quidditch" })).toEqual({ ok: false, error: "bad-sport" });
  });
});

describe("poolSportOfClubSport: which pool sport and format a club's game is", () => {
  it("reads the club's sport preset first", () => {
    expect(poolSportOfClubSport({ preset: "football-7aside", name: "Thursday", playersPerTeam: 7 })).toEqual({ sport: "football", format: 7 });
    expect(poolSportOfClubSport({ preset: "football-11aside", name: "x", playersPerTeam: 11 })).toEqual({ sport: "football", format: 11 });
    expect(poolSportOfClubSport({ preset: "futsal", name: "x", playersPerTeam: 5 })).toEqual({ sport: "football", format: 5 });
    expect(poolSportOfClubSport({ preset: "basketball-3v3", name: "x", playersPerTeam: 3 })).toEqual({ sport: "basketball", format: 3 });
  });

  it("a custom sport named football or basketball uses its players per team when that is a format", () => {
    expect(poolSportOfClubSport({ preset: null, name: "Football 8-a-side", playersPerTeam: 8 })).toEqual({ sport: "football", format: 8 });
    expect(poolSportOfClubSport({ preset: null, name: "Football", playersPerTeam: 6 })).toEqual({ sport: "football", format: null });
  });

  it("a sport the pool has no entry for is not matched", () => {
    expect(poolSportOfClubSport({ preset: "netball", name: "Netball", playersPerTeam: 7 })).toBeNull();
    expect(poolSportOfClubSport({ preset: "cricket", name: "Cricket", playersPerTeam: 11 })).toBeNull();
  });
});
