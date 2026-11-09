/**
 * The "How ratings work" popup on /admin/players/ratings (Kemal,
 * 2026-11-09). It used to print
 *
 *     balancer_input = 0.5 × peer_avg + 0.5 × (match_rating ÷ 200)
 *
 * which is the second rating formula deleted on 2026-09-15 (the
 * tombstone in `src/app/actions/teams.ts`). The popup now says what the
 * code does, traced from it:
 *
 *   - `computeClubRating` (player-rating.ts): the club seed, else 6,
 *     counted as 3 ratings beside this club's newest 60 peer ratings
 *   - `carriedSeed` (carried-seed.ts): a joiner's empty seed is the
 *     games-weighted average of his shown ratings at other clubs, exact
 *   - `generateTeamsForMatch` / `matchRatingsFor` (team-generation.ts):
 *     the adjuster's per-match change, at most 2 either way
 *     (rating-adjuster.ts MAX_DELTA), the result kept within 1 to 10
 *   - `clubDisplayRating` (player-rating.ts): players see the raw mean of
 *     their newest 60 club ratings, nothing before the first, never the seed
 *   - the Elo is not read by the balancer at all
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { en } from "../strings.en";
import { tr } from "../strings.tr";
import { DEFAULT_SEED_RATING } from "../../default-seed";
import { CLUB_RATING_WINDOW, computeClubRating } from "../../player-rating";

const KEYS = [
  "ratings_info_title",
  "ratings_info_seed_head",
  "ratings_info_seed_body",
  "ratings_info_joiner_head",
  "ratings_info_joiner_body",
  "ratings_info_peers_head",
  "ratings_info_peers_body",
  "ratings_info_match_day_head",
  "ratings_info_match_day_body",
  "ratings_info_shown_head",
  "ratings_info_shown_body",
  "ratings_info_elo",
] as const;

const all = (s: Record<string, unknown>) => KEYS.map((k) => s[k] as string).join("\n");

describe("the How ratings work popup copy", () => {
  it("exists in English and Turkish, and the Turkish is translated", () => {
    for (const k of KEYS) {
      expect(typeof en[k], k).toBe("string");
      expect(typeof tr[k], k).toBe("string");
      expect(tr[k], k).not.toBe(en[k]);
    }
  });

  it("never states the deleted Elo formula", () => {
    for (const text of [all(en), all(tr)]) {
      expect(text).not.toMatch(/÷|\/ ?200|match_rating|peer_avg|balancer_input|50\/50|0\.5 ×/);
    }
  });

  it("says what the code does: a 6 by default, the seed counted as 3 ratings, the newest 60", () => {
    expect(DEFAULT_SEED_RATING).toBe(6);
    expect(CLUB_RATING_WINDOW).toBe(60);
    // The seed counts as 3 ratings: one rating moves the number a quarter
    // of the way, three make it half and half.
    expect(computeClubRating({ clubSeedRating: 6, clubPeerRatings: [10] }).rating).toBe(7);
    expect(computeClubRating({ clubSeedRating: 6, clubPeerRatings: [8, 8, 8] }).rating).toBe(7);

    expect(en.ratings_info_seed_body).toMatch(/\b6\b/);
    expect(tr.ratings_info_seed_body).toMatch(/\b6\b/);
    expect(en.ratings_info_peers_body).toMatch(/\b60\b/);
    expect(en.ratings_info_peers_body).toMatch(/\b3 ratings\b/);
    expect(en.ratings_info_peers_body).toMatch(/quarter/);
    expect(tr.ratings_info_peers_body).toMatch(/\b60\b/);
    expect(tr.ratings_info_peers_body).toMatch(/\b3 puan\b/);
    expect(en.ratings_info_shown_body).toMatch(/\b60\b/);
    expect(tr.ratings_info_shown_body).toMatch(/\b60\b/);
  });

  it("says the match-day change is at most 2, for that match only, and stays within 1 to 10", () => {
    expect(en.ratings_info_match_day_body).toMatch(/up to 2/);
    expect(en.ratings_info_match_day_body).toMatch(/that match only/);
    expect(en.ratings_info_match_day_body).toMatch(/between 1 and 10/);
    expect(tr.ratings_info_match_day_body).toMatch(/en fazla 2/);
    expect(tr.ratings_info_match_day_body).toMatch(/1 ile 10 arasında/);
  });

  it("says a joiner's seed is his games-weighted average elsewhere, not rounded", () => {
    expect(en.ratings_info_joiner_body).toMatch(/average/);
    expect(en.ratings_info_joiner_body).toMatch(/games/);
    expect(en.ratings_info_joiner_body).toMatch(/not rounded/);
    expect(tr.ratings_info_joiner_body).toMatch(/ortalama/);
    expect(tr.ratings_info_joiner_body).toMatch(/yuvarlanmaz/);
  });

  it("says the Elo does not make the teams", () => {
    expect(en.ratings_info_elo).toMatch(/Elo/);
    expect(en.ratings_info_elo).toMatch(/not used/);
    expect(tr.ratings_info_elo).toMatch(/Elo/);
    expect(tr.ratings_info_elo).toMatch(/kullanılmaz/);
  });

  it("no em or en dash, no slash between words, never 'the bot'", () => {
    for (const l of [all(en), all(tr)]) {
      expect(l).not.toMatch(/[—–]/);
      expect(l).not.toMatch(/\w\/\w/);
      expect(l).not.toMatch(/\bthe bot\b/i);
    }
  });
});

describe("the /admin/players/ratings page", () => {
  const src = readFileSync(
    path.resolve(__dirname, "../../../app/admin/players/ratings/page.tsx"),
    "utf8",
  );

  it("renders the popup from the string table in the club's language", () => {
    for (const k of KEYS) expect(src, k).toContain(`.${k}`);
  });

  it("carries no hardcoded copy of the old formula", () => {
    expect(src).not.toMatch(/match_rating|peer_avg|balancer_input|÷ 200|50\/50|hill-climb/);
  });
});
