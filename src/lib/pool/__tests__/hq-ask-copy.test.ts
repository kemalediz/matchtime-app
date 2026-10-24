/**
 * WHAT HQ HEARS WHEN AN ORGANISER ASKS THE POOL IN WORDS, OR SAYS YES TO
 * THE POOL NOTICE (local player pool L10). Pure: the composer over L5a's
 * copy. English and Turkish, no names, no numbers but the places.
 */
import { describe, expect, it } from "vitest";
import { poolHqAskReply } from "../offer-copy";

describe("the reply to an ask that went", () => {
  it("at once: says the pool is being asked, for how many and which game (EN, TR)", () => {
    expect(poolHqAskReply("en", { ok: true, places: 2, day: "Tue 27 Oct, 20:00", partnersFirst: false })).toBe(
      "🔎 Asking nearby players from the MatchTime player pool for 2 places on Tue 27 Oct, 20:00. I'll tell you here when one takes a place.",
    );
    expect(poolHqAskReply("tr", { ok: true, places: 1, day: "27 Eki Sal, 20:00", partnersFirst: false })).toBe(
      "🔎 27 Eki Sal, 20:00 maçı için MatchTime oyuncu havuzundaki yakın oyunculara soruyorum (1 kişi). Biri yer alınca burada haber vereceğim.",
    );
  });

  it("after the partner clubs: says it waits for them first", () => {
    expect(poolHqAskReply("en", { ok: true, places: 1, day: "Tue 27 Oct, 20:00", partnersFirst: true })).toMatch(
      /^🔎 I'll ask nearby players from the MatchTime player pool for 1 place on Tue 27 Oct, 20:00 if your partner clubs have not filled it within the hour\./,
    );
    expect(poolHqAskReply("tr", { ok: true, places: 1, day: "27 Eki Sal, 20:00", partnersFirst: true })).toMatch(/partner kulüpleriniz bir saat içinde doldurmazsa/);
  });
});

describe("the reply to an ask that did not go", () => {
  it("the pool not open for the club: a helpful line, never the match page's wording", () => {
    expect(poolHqAskReply("en", { ok: false, refusal: "pool-closed", placesOpen: 1 })).toBe(
      "The MatchTime player pool is not open for your club yet. I can ask your players' group if anyone can play instead.",
    );
    expect(poolHqAskReply("tr", { ok: false, refusal: "pool-closed", placesOpen: 1 })).toMatch(/^MatchTime oyuncu havuzu kulübünüz için henüz açık değil\./);
  });

  it("every other refusal is L5a's own line (one source for the wording)", () => {
    expect(poolHqAskReply("en", { ok: false, refusal: "none-near", placesOpen: 1 })).toBe("There are no pool players near this venue for this game yet.");
    expect(poolHqAskReply("en", { ok: false, refusal: "round-open", placesOpen: 1 })).toBe("Nearby players are already being asked for this game.");
    expect(poolHqAskReply("en", { ok: false, refusal: "no-places", placesOpen: 0 })).toBe("There are no open places to fill.");
    expect(poolHqAskReply("tr", { ok: false, refusal: "too-late", placesOpen: 1 })).not.toBe(poolHqAskReply("en", { ok: false, refusal: "too-late", placesOpen: 1 }));
  });
});
