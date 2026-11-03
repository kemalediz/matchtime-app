/**
 * THE FIRST RATING POST EXPLAINS ITSELF (Kemal, 2026-11-03).
 *
 * The group post after the rating DMs is short ("Just DM'd every player
 * ... a personal rating link"). A club seeing it for the first time does
 * not know what the ratings are for, so the FIRST one a club ever gets
 * says why: the ratings pick two balanced teams, they are private, you
 * cannot rate yourself, and (when the players vote) Man of the Match is
 * picked on the same link. Every later one is the short post, as before.
 *
 * "First" is the club's history: no `<matchId>:rate-promo` key (nor the
 * organisers' relay of it, `<matchId>:rate-promo:<adminId>`) for any of
 * its matches. A mute writes no key, so a muted club that had the post
 * before stays on the short one, and one that never had it still gets
 * the long one when unmuted.
 */
import { describe, it, expect } from "vitest";
import { buildRatePromoPost, isFirstRatePromo, isRatePromoKey } from "@/lib/group-copy";

const EN_FIRST =
  "🎯 I've just DM'd the players from the *Monday 7-a-side* on Mon 2 Nov a private link to rate the others out of 10.\n\n" +
  "*Why rate?* I use the ratings to pick two balanced teams, so the games stay close and nobody ends up on the losing side every week. " +
  "Your scores are private: nobody sees who rated what, and you can't rate yourself. The same link is where you pick Man of the Match.\n\n" +
  "It takes about a minute, and the more of you rate, the fairer the teams. Check your DMs from me 👇";

const SHORT =
  "🎯 Just DM'd every player from the *Monday 7-a-side* on Mon 2 Nov a personal rating link. " +
  "The more ratings we get, the better-balanced the teams get next week. Check your DMs from me 👇";

describe("which post a club gets", () => {
  it("a club with no rating post in its history gets the first one", () => {
    expect(isFirstRatePromo([])).toBe(true);
    expect(isFirstRatePromo(["m1:rate-dm:u1", "m1:mom-announce", "org-o1:bot-intro"])).toBe(true);
  });

  it("any earlier rating post, on any match, means the short one from now on", () => {
    expect(isFirstRatePromo(["m0:rate-promo", "m1:rate-dm:u1"])).toBe(false);
  });

  it("the organisers' relay of it counts too (admin group key and per-admin DM key)", () => {
    expect(isFirstRatePromo(["m0:rate-promo:admin-1"])).toBe(false);
  });

  it("only the promo key itself is a rating post", () => {
    expect(isRatePromoKey("m1:rate-promo")).toBe(true);
    expect(isRatePromoKey("m1:rate-promo:u-9")).toBe(true);
    expect(isRatePromoKey("m1:rate-dm:u-9")).toBe(false);
    expect(isRatePromoKey("m1:rate-reminder:u-9:2026-11-03")).toBe(false);
    expect(isRatePromoKey("m1:rate-promoted")).toBe(false);
  });
});

describe("the first post, English", () => {
  const base = { activityName: "Monday 7-a-side", matchDateLabel: "Mon 2 Nov", lang: "en" as const };

  it("explains what the ratings are for, word for word", () => {
    expect(buildRatePromoPost({ ...base, firstTime: { mvpLabel: "Man of the Match", momVote: true } })).toBe(EN_FIRST);
  });

  it("names the sport's own MoM label", () => {
    const text = buildRatePromoPost({ ...base, firstTime: { mvpLabel: "Player of the Match", momVote: true } });
    expect(text).toContain("The same link is where you pick Player of the Match.");
    expect(text).not.toContain("Man of the Match");
  });

  it("when the organisers choose MoM, the MoM sentence is dropped and nothing else changes", () => {
    const text = buildRatePromoPost({ ...base, firstTime: { mvpLabel: "Man of the Match", momVote: false } });
    expect(text).toBe(EN_FIRST.replace(" The same link is where you pick Man of the Match.", ""));
    expect(text).not.toMatch(/Man of the Match|same link/);
  });

  it("without firstTime it is today's short post, byte for byte", () => {
    expect(buildRatePromoPost(base)).toBe(SHORT);
  });

  it("follows the copy rules: no em or en dashes, no slashes", () => {
    for (const momVote of [true, false]) {
      const text = buildRatePromoPost({ ...base, firstTime: { mvpLabel: "Man of the Match", momVote } });
      expect(text).not.toMatch(/[–—\/]/);
    }
  });
});

describe("the first post, Turkish", () => {
  const base = { activityName: "Pazartesi 7'li maç", matchDateLabel: "2 Kasım Pazartesi", lang: "tr" as const };

  it("is translated, carries the match and the date, and explains the same points", () => {
    const text = buildRatePromoPost({ ...base, firstTime: { mvpLabel: "Maçın Adamı", momVote: true } });
    expect(text).toContain("2 Kasım Pazartesi");
    expect(text).toContain("*Pazartesi 7'li maç*");
    expect(text).toContain("10 üzerinden");
    expect(text).toContain("iki dengeli takım");
    expect(text).toContain("kendinize puan veremezsiniz");
    expect(text).toContain("Maçın Adamı");
    expect(text).not.toMatch(/Why rate|private|rated what/);
    expect(text).not.toMatch(/[–—\/]/);
    expect(text.endsWith("DM'lerinize bakın 👇")).toBe(true);
  });

  it("drops the MoM sentence when the organisers choose", () => {
    const withVote = buildRatePromoPost({ ...base, firstTime: { mvpLabel: "Maçın Adamı", momVote: true } });
    const without = buildRatePromoPost({ ...base, firstTime: { mvpLabel: "Maçın Adamı", momVote: false } });
    expect(without).not.toContain("Maçın Adamı");
    expect(without.length).toBeLessThan(withVote.length);
  });
});
