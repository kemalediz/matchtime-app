/**
 * ══════════════════════════════════════════════════════════════════════
 * TWO NUMBERS, ON PURPOSE. What a player SEES is not what the balancer
 * USES, and this file is the contract that keeps them apart.
 * ══════════════════════════════════════════════════════════════════════
 *
 * Kemal answered open question 2 of
 * `MDs/club-scoped-ratings-design-2026-09-18.md` on 2026-09-19, the
 * other way from the way slice 6 shipped it:
 *
 *   "i think the latter is a better one as whatever ratings are given
 *    the player should see but yeah for team setup shrunk number should
 *    be used initially"
 *
 * So:
 *
 *   SHOWN     the raw mean of the ratings this club actually gave this
 *             player. Their scores, their number, nothing subtracted.
 *   BALANCED  `computeClubRating`, unchanged: the same scores shrunk
 *             toward the club's own mean while there are only one or
 *             two of them, so one early 9 cannot build a team sheet.
 *
 * They answer different questions. "What did people give me" and "how
 * confident is MatchTime in that yet" are not the same question and a
 * single number was answering the second while being read as the first.
 *
 * NOTHING HERE MAY ASSERT THE TWO ARE EQUAL. They are allowed to
 * differ, that is the whole point, and a future test that pins them
 * together would quietly undo this decision.
 *
 * The balancer half of every case below is pinned against the value
 * `computeClubRating` produces on `main` at b2526f5, so a change to the
 * balancer's arithmetic fails here even though this file is about the
 * display.
 */
import { describe, it, expect } from "vitest";
import { computeClubRating, clubDisplayRating } from "@/lib/player-rating";
import { t } from "@/lib/i18n/t";

/** Sutton Football Club's real mean, measured read-only against
 *  production on 2026-09-18 (design section 3.5). Used as the club mean
 *  throughout so the numbers below are the numbers Sutton would see. */
const SUTTON_MEAN = 6.674;

describe("the number shown is the raw mean of this club's ratings", () => {
  it("one rating: the player sees exactly what they were given", () => {
    const shown = clubDisplayRating({ clubSeedRating: null, clubPeerRatings: [9] });
    expect(shown).toBe(9);
  });

  it("two ratings: the mean of the two, not a shrunk figure", () => {
    const shown = clubDisplayRating({ clubSeedRating: null, clubPeerRatings: [9, 8] });
    expect(shown).toBe(8.5);
  });

  it("many ratings: still the plain mean", () => {
    const scores = [8, 7, 9, 6, 7, 8, 8, 7, 9, 6, 7, 8];
    const shown = clubDisplayRating({ clubSeedRating: null, clubPeerRatings: scores });
    expect(shown).toBeCloseTo(scores.reduce((s, r) => s + r, 0) / scores.length, 10);
    expect(shown).toBeCloseTo(7.5, 10);
  });

  it("a seed never dilutes a rating the player was actually given", () => {
    // The club seeded him 4. His team-mates have since given him a 9.
    // What he was GIVEN is 9, and that is what he sees.
    const shown = clubDisplayRating({ clubSeedRating: 4, clubPeerRatings: [9] });
    expect(shown).toBe(9);
  });

  it("the club mean cannot reach the displayed number: there is no parameter for it", () => {
    // Asserted by TYPE, the same way `computeClubRating`'s isolation is
    // (design section 10.2 case 9). The display helper takes this
    // club's seed and this club's peer scores and nothing else, so no
    // shrinking prior can arrive through the signature. If a
    // `clubMeanRating` field is ever added here, this stops compiling.
    const args: Parameters<typeof clubDisplayRating>[0] = {
      clubSeedRating: null,
      clubPeerRatings: [9],
    };
    // @ts-expect-error there is no club mean on the display helper
    args.clubMeanRating = 6.674;
    expect(clubDisplayRating({ clubSeedRating: null, clubPeerRatings: [9] })).toBe(9);
  });
});

describe("the balancer keeps the shrunk number, unchanged", () => {
  it("one rating still shrinks three quarters of the way to the club mean", () => {
    const b = computeClubRating({
      clubSeedRating: null,
      clubPeerRatings: [9],
      clubMeanRating: SUTTON_MEAN,
    });
    // (9 + 6.674 x 3) / (1 + 3)
    expect(b.rating).toBeCloseTo((9 + SUTTON_MEAN * 3) / 4, 10);
    expect(b.source).toBe("blended");
  });

  it("two ratings shrink three fifths of the way", () => {
    const b = computeClubRating({
      clubSeedRating: null,
      clubPeerRatings: [9, 8],
      clubMeanRating: SUTTON_MEAN,
    });
    expect(b.rating).toBeCloseTo((17 + SUTTON_MEAN * 3) / 5, 10);
  });

  it("many ratings barely move: the player's own scores dominate", () => {
    const scores = [8, 7, 9, 6, 7, 8, 8, 7, 9, 6, 7, 8];
    const b = computeClubRating({
      clubSeedRating: null,
      clubPeerRatings: scores,
      clubMeanRating: SUTTON_MEAN,
    });
    expect(b.rating).toBeCloseTo((90 + SUTTON_MEAN * 3) / 15, 10);
    expect(b.source).toBe("peer");
  });
});

/**
 * KEMAL'S EXAMPLE, PINNED SO IT CANNOT SILENTLY REGRESS.
 *
 * "it says I'm 9, why am I on the weaker team" is the question this
 * change invites, and these are the two numbers behind it. One rating
 * of 9 at a club whose mean is 6.674: the player is shown 9.0 and is
 * balanced at roughly 7.3.
 */
describe("one rating of 9 at a club averaging 6.674", () => {
  const clubPeerRatings = [9];

  it("displays 9.0", () => {
    const shown = clubDisplayRating({ clubSeedRating: null, clubPeerRatings });
    expect(shown).not.toBeNull();
    expect(shown!.toFixed(1)).toBe("9.0");
  });

  it("balances at roughly 7.3", () => {
    const b = computeClubRating({
      clubSeedRating: null,
      clubPeerRatings,
      clubMeanRating: SUTTON_MEAN,
    });
    // (9 + 20.022) / 4 = 7.2555
    expect(b.rating).toBeCloseTo(7.2555, 4);
    expect(b.rating.toFixed(1)).toBe("7.3");
  });

  it("and the two are DIFFERENT, which is the decision", () => {
    const shown = clubDisplayRating({ clubSeedRating: null, clubPeerRatings })!;
    const balanced = computeClubRating({
      clubSeedRating: null,
      clubPeerRatings,
      clubMeanRating: SUTTON_MEAN,
    }).rating;
    expect(shown).toBeGreaterThan(balanced);
    expect(shown - balanced).toBeCloseTo(1.7445, 4);
  });
});

/**
 * A SEED IS NOT A RATING, SO IT IS NOT SHOWN.
 *
 * Kemal, 2026-09-19, after slice 6 shipped the seed as a visible club
 * rating:
 *
 *   "i prefer them to see nothing, better not to show seed, the ratings
 *    are important to the player, not the seed and it can be
 *    discouraging too."
 *
 * So the display has ONE input that can produce a number: the ratings
 * this club's players actually gave. A seed is an admin's guess typed
 * before anybody had played, it is not something a team-mate said about
 * this player, and shown as "your rating" it is both wrong and, when
 * the guess is low, discouraging.
 *
 * The seeded-but-unrated player and the unseeded-and-unrated player are
 * therefore the SAME state on screen: the empty state, which already
 * says the true thing ("No ratings at this club yet"). Design section 3
 * and section 8.5.
 *
 * The BALANCER is untouched. `computeClubRating` still takes the seed
 * and still leans on it, because a seed is exactly how a new club gets
 * sensible teams in week one. Every case below asserts both halves so
 * nobody can "simplify" the seed out of team generation on the strength
 * of this decision.
 */
describe("a player with no club ratings", () => {
  it("unseeded and unrated: nothing to show", () => {
    expect(clubDisplayRating({ clubSeedRating: null, clubPeerRatings: [] })).toBeNull();
  });

  it("but the balancer still gets the club mean out of the same inputs", () => {
    const b = computeClubRating({
      clubSeedRating: null,
      clubPeerRatings: [],
      clubMeanRating: SUTTON_MEAN,
    });
    expect(b.rating).toBeCloseTo(SUTTON_MEAN, 10);
    expect(b.source).toBe("club-average");
  });

  it("seeded but unrated: nothing to show either, because a seed is not a rating", () => {
    expect(clubDisplayRating({ clubSeedRating: 7.5, clubPeerRatings: [] })).toBeNull();
  });

  it("and the balancer still uses that seed, which is the whole point of seeding", () => {
    const b = computeClubRating({
      clubSeedRating: 7.5,
      clubPeerRatings: [],
      clubMeanRating: SUTTON_MEAN,
    });
    expect(b.rating).toBe(7.5);
    expect(b.source).toBe("seed");
  });

  it("a low seed is not shown either: that is the discouraging case Kemal named", () => {
    expect(clubDisplayRating({ clubSeedRating: 3, clubPeerRatings: [] })).toBeNull();
    // The balancer still reads the 3. A weak week-one guess is still the
    // best information the draft has.
    expect(
      computeClubRating({ clubSeedRating: 3, clubPeerRatings: [], clubMeanRating: SUTTON_MEAN }).rating,
    ).toBe(3);
  });

  it("an out of band seed is shown as nothing, not clamped into a number", () => {
    expect(clubDisplayRating({ clubSeedRating: 99, clubPeerRatings: [] })).toBeNull();
    expect(clubDisplayRating({ clubSeedRating: -4, clubPeerRatings: [] })).toBeNull();
    // The balancer clamps it, as it always has.
    expect(
      computeClubRating({ clubSeedRating: 99, clubPeerRatings: [], clubMeanRating: SUTTON_MEAN }).rating,
    ).toBe(10);
    expect(
      computeClubRating({ clubSeedRating: -4, clubPeerRatings: [], clubMeanRating: SUTTON_MEAN }).rating,
    ).toBe(1);
  });

  it("one peer rating is all it takes for a number to appear", () => {
    // Seeded at 4, then a single team-mate says 9. Before that rating he
    // saw nothing; now he sees the 9 he was given, not the 4 he was
    // guessed at, and not a blend of the two.
    expect(clubDisplayRating({ clubSeedRating: 4, clubPeerRatings: [] })).toBeNull();
    expect(clubDisplayRating({ clubSeedRating: 4, clubPeerRatings: [9] })).toBe(9);
  });
});

/**
 * THE COPY HAD TO CHANGE, BECAUSE IT EXPLAINED THE OLD NUMBER.
 *
 * `rating_club_provisional` read "Provisional: 2 ratings so far, so it
 * sits close to the club average until more arrive." That sentence
 * described an adjustment that is no longer applied to the number on
 * the screen, so it was not merely stale, it was false. The caveat is
 * now about confidence: thin evidence, so the number will move.
 *
 * `rating_club_balance_note` is the sentence that pre-empts "it says
 * I'm 9, why am I on the weaker team". One sentence, no jargon, both
 * languages.
 */
describe("the provisional caveat is about confidence, not adjustment", () => {
  for (const lang of ["en", "tr"] as const) {
    it(`${lang}: says nothing about sitting near the club average`, () => {
      const s = t(lang);
      const line = s.rating_club_provisional({ count: 2 });
      expect(line.toLowerCase()).not.toContain("club average");
      expect(line.toLowerCase()).not.toContain("kulüp ortalamas");
    });

    it(`${lang}: warns that the number will move`, () => {
      const s = t(lang);
      expect(s.rating_club_provisional({ count: 1 }).length).toBeGreaterThan(20);
      expect(s.rating_club_provisional({ count: 2 })).toContain("2");
    });

    it(`${lang}: the balance note exists and is one sentence`, () => {
      const s = t(lang);
      const note = s.rating_club_balance_note;
      expect(typeof note).toBe("string");
      expect(note.trim().endsWith(".")).toBe(true);
      // One sentence: exactly one full stop, at the end.
      expect(note.split(".").length - 1).toBe(1);
      // No jargon, and nothing that reads as AI punctuation.
      expect(note.toLowerCase()).not.toContain("bayes");
      expect(note).not.toContain(String.fromCharCode(0x2014));
      expect(note).not.toContain(String.fromCharCode(0x2013));
    });
  }

  it("the English balance note says teams are picked carefully, not that the number is adjusted", () => {
    const note = t("en").rating_club_balance_note.toLowerCase();
    expect(note).toContain("team");
    expect(note).not.toContain("adjust");
  });

  it("the Turkish balance note is in the 'sen' register, like the rest of the player's own page", () => {
    const note = t("tr").rating_club_balance_note;
    expect(note).toMatch(/puanın|senin|sana/);
  });
});
