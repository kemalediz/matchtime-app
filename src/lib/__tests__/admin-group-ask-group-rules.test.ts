/**
 * An organiser asks MatchTime, in HQ, to ask the players' group for a
 * player: the pure decision (post, full, already asked) and the post's
 * words for each pick mode, in English and Turkish.
 */
import { describe, expect, it } from "vitest";
import { buildGroupAskPost, decideGroupAsk, openingFingerprint } from "../admin-group-ask-group-rules";
import { en } from "../i18n/strings.en";

const AT = new Date("2026-10-16T13:05:00Z");

describe("decideGroupAsk", () => {
  it("no place open: full, with the count, and nothing posted", () => {
    expect(decideGroupAsk({ confirmed: 14, maxPlayers: 14, history: [] })).toEqual({ kind: "full" });
    expect(decideGroupAsk({ confirmed: 15, maxPlayers: 14, history: [] })).toEqual({ kind: "full" });
  });

  it("places open and never asked for this opening: post, round 1", () => {
    expect(decideGroupAsk({ confirmed: 13, maxPlayers: 14, history: [] })).toEqual({ kind: "post", open: 1, round: 1 });
    expect(decideGroupAsk({ confirmed: 11, maxPlayers: 14, history: [] })).toEqual({ kind: "post", open: 3, round: 1 });
  });

  it("asked again for the same opening: not posted twice, the organiser is told when", () => {
    expect(decideGroupAsk({ confirmed: 13, maxPlayers: 14, history: [{ step: "post", round: 1, at: AT }] })).toEqual({
      kind: "already",
      open: 1,
      round: 1,
      askedAt: AT,
    });
  });

  it("asked once more after being told: that is an explicit ask again, posted as round 2", () => {
    const history = [
      { step: "post" as const, round: 1, at: AT },
      { step: "told" as const, round: 1, at: new Date(AT.getTime() + 60_000) },
    ];
    expect(decideGroupAsk({ confirmed: 13, maxPlayers: 14, history })).toEqual({ kind: "post", open: 1, round: 2 });
  });

  it("the latest round decides, whatever order the rows come in", () => {
    const later = new Date(AT.getTime() + 120_000);
    const history = [
      { step: "post" as const, round: 2, at: later },
      { step: "post" as const, round: 1, at: AT },
      { step: "told" as const, round: 1, at: new Date(AT.getTime() + 60_000) },
    ];
    expect(decideGroupAsk({ confirmed: 13, maxPlayers: 14, history })).toEqual({ kind: "already", open: 1, round: 2, askedAt: later });
  });
});

describe("openingFingerprint", () => {
  it("the same confirmed players in any order: the same opening", () => {
    expect(openingFingerprint(["u1", "u2", "u3"])).toBe(openingFingerprint(["u3", "u1", "u2"]));
  });
  it("a different squad: a different opening", () => {
    expect(openingFingerprint(["u1", "u2"])).not.toBe(openingFingerprint(["u1", "u3"]));
    expect(openingFingerprint(["u1", "u2"])).not.toBe(openingFingerprint(["u1"]));
  });
});

describe("buildGroupAskPost", () => {
  const base = { kickoffLabel: "Fri 19:15", confirmed: 13, maxPlayers: 14, open: 1 };

  it("first come: the existing place-open post, unchanged", () => {
    const text = buildGroupAskPost({ ...base, lang: "en", pickMode: "first-come" });
    expect(text).toBe(en.slot_opened({ outFirstNames: [], confirmed: 13, maxPlayers: 14, kickoffLabel: "Fri 19:15", open: 1 }));
    expect(text).toBe("That's 13 of 14 for Fri 19:15. One slot open, say *IN* to take it.");
  });

  it("organisers pick: say IN, the organisers pick, a message to whoever is picked", () => {
    expect(buildGroupAskPost({ ...base, lang: "en", pickMode: "organiser" })).toBe(
      "We need 1 more player for Fri 19:15. Say *IN* and the organisers will pick who takes the place. I'll message you if it's you.",
    );
    expect(buildGroupAskPost({ ...base, open: 2, confirmed: 12, lang: "en", pickMode: "organiser" })).toBe(
      "We need 2 more players for Fri 19:15. Say *IN* and the organisers will pick who takes the places. I'll message you if it's you.",
    );
  });

  it("in Turkish, both modes", () => {
    expect(buildGroupAskPost({ ...base, kickoffLabel: "Cuma 19:15", lang: "tr", pickMode: "organiser" })).toBe(
      "Cuma 19:15 maçı için 1 oyuncu daha lazım. *VARIM* yazın, kimin oynayacağını organizatörler seçer. Seçilirseniz size mesaj atarım.",
    );
    expect(buildGroupAskPost({ ...base, kickoffLabel: "Cuma 19:15", lang: "tr", pickMode: "first-come" })).toBe(
      "Cuma 19:15 için 13 kişiyiz, kadro 14 kişilik. Bir yer açıldı, almak için *VARIM* yazın.",
    );
  });

  it("no em or en dash, and no slash in prose", () => {
    for (const lang of ["en", "tr"]) {
      for (const pickMode of ["first-come", "organiser"] as const) {
        const text = buildGroupAskPost({ ...base, open: 2, lang, pickMode });
        expect(text).not.toMatch(new RegExp("[\\u2013\\u2014/]"));
      }
    }
  });
});
