/**
 * RATING PROGRESS — the pure half, and the two constants that carry the
 * policy (2026-09-11).
 *
 * `looksLikeRatingProgressRequest` was (a rating word) AND (a progress
 * word), scattered anywhere in a body — the conjunction shape that
 * queued 69 mass DMs on 2026-09-10 and told an owner his squad was full
 * on 2026-09-01. It is deleted. The ask is now a `question` topic the
 * model extracts, gated in the engine.
 *
 * The DECISION (who may ask, and whether a tag is required) is pinned in
 * `pipeline/__tests__/engine-rating-progress.test.ts`; the end-to-end
 * behaviour is `e2e/sim/rating-progress.spec.ts`.
 */
import { describe, it, expect } from "vitest";
import {
  RATING_PROGRESS_IS_ADMIN_ONLY,
  RATING_PROGRESS_TAG_MUST_BE_EXPLICIT,
  formatRatingProgressReply,
} from "../rating-progress-answer";

describe("the policy constants", () => {
  it("stays admin-only — this answer NAMES the players who have not rated", () => {
    expect(RATING_PROGRESS_IS_ADMIN_ONLY).toBe(true);
  });

  it("does NOT demand an explicit @-mention, unlike the two bulk-DM doors", () => {
    // The ordinary `messageTagsBot` bar, which is what the question
    // route already applies to every other answer. A wrong answer here
    // costs one confused reader; a wrong bulk DM costs the WhatsApp
    // account. The asymmetry that justifies
    // `STATS_BLAST_TAG_MUST_BE_EXPLICIT` does not exist on this path.
    expect(RATING_PROGRESS_TAG_MUST_BE_EXPLICIT).toBe(false);
  });
});

describe("the reply is unchanged from the fast path it replaces", () => {
  const full = {
    ok: true,
    matchName: "Tuesday 7-a-side",
    matchWhen: "Tue 2 Sep",
    confirmed: 10,
    ratedCount: 6,
    momCount: 5,
    notRated: ["Zair Malik", "Wasim Akhtar"],
    ratedNoMom: ["Omar Yusuf"],
  };

  it("reports both counts and both lists", () => {
    const text = formatRatingProgressReply(full);
    expect(text).toContain("Tuesday 7-a-side");
    expect(text).toContain("Rated: 6/10");
    expect(text).toContain("Picked MoM: 5/10");
    expect(text).toContain("Zair Malik, Wasim Akhtar");
    expect(text).toContain("Omar Yusuf");
  });

  it("says everyone is done rather than printing an empty list", () => {
    expect(formatRatingProgressReply({ ...full, notRated: [], ratedNoMom: [] })).toContain(
      "Everyone's rated",
    );
  });

  it("passes a refusal through in the refusal's own words", () => {
    expect(formatRatingProgressReply({ ok: false, reason: "nothing played yet" })).toBe(
      "nothing played yet",
    );
  });
});
