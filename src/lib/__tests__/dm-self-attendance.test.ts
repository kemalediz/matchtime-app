/**
 * DM self-attendance fallback — PURE classification + fallback decision.
 *
 * WHY THIS EXISTS (2026-08-31): the recruit blast DMs a player "Tap to
 * grab a spot: <link>". Older, less technical players simply reply "IN"
 * to that DM instead of tapping. Before this change that reply matched no
 * pending prompt in /api/whatsapp/dm-reply, so it was silently dropped:
 * the player believed they had signed up and NOTHING was recorded. Same
 * class of silent failure as the duplicate-send incident — the system
 * looked healthy while the human outcome was wrong.
 *
 * The contract these tests pin:
 *   - Only a CLEAR self-attendance statement registers. Anything chatty,
 *     hypothetical, interrogative or ambiguous falls through to the
 *     existing handling (Q&A / ignore) — we NEVER guess.
 *   - A more specific pending prompt (tentative follow-up, roster survey,
 *     bench offer, collector fee) always wins; this is a FALLBACK only.
 */
import { describe, it, expect } from "vitest";
import {
  classifyDmSelfAttendance,
  decideDmSelfAttendanceFallback,
} from "@/lib/dm-self-attendance";

describe("classifyDmSelfAttendance — registers IN", () => {
  const IN_BODIES = [
    "IN",
    "in",
    "In!",
    "in.",
    "I'm in",
    "im in",
    "I am in",
    "am in",
    "Im in 👍",
    "👍 in",
    "count me in",
    "Count me in please",
    "in please",
    "in mate",
    "yes I'm in",
    "yep, in",
    "Yeah im in",
    "put me in",
    "stick me in",
    "add me in",
    "I'll play",
    "ill play",
    "i can play",
    "I can make it",
    "I'm playing",
    "in for tonight",
    "IN for Tuesday",
    "in for the game",
    "in this week",
    "I'll be there",
  ];
  for (const body of IN_BODIES) {
    it(`"${body}" → in`, () => {
      expect(classifyDmSelfAttendance(body)).toBe("in");
    });
  }
});

describe("classifyDmSelfAttendance — registers OUT", () => {
  const OUT_BODIES = [
    "OUT",
    "out",
    "Out.",
    "I'm out",
    "im out",
    "I am out",
    "count me out",
    "can't make it",
    "cant make it",
    "I can't make it",
    "Sorry, can't make it",
    "sorry im out",
    "not playing",
    "I'm not playing",
    "im not available",
    "not this week",
    "out this week",
    "I won't make it",
    "wont be there",
    "I'm not in",
    "cant play",
  ];
  for (const body of OUT_BODIES) {
    it(`"${body}" → out`, () => {
      expect(classifyDmSelfAttendance(body)).toBe("out");
    });
  }
});

describe("classifyDmSelfAttendance — deliberately falls through (null)", () => {
  const FALLTHROUGH = [
    "",
    "   ",
    // Bare acknowledgements: with no prompt to anchor them we cannot know
    // what is being agreed to.
    "👍",
    "✅",
    "yes",
    "yeah",
    "ok",
    "no",
    "nope",
    // Tentative — NOT a firm answer.
    "maybe",
    "not sure",
    "I'll try to make it",
    "probably in",
    // Questions must reach the Q&A path, never an attendance write.
    "in?",
    "am I in?",
    "what time is kick off?",
    "are we in Sutton this week?",
    // "in"/"out" as ordinary English, not attendance.
    "I'm in London this week",
    "I'm in two minds",
    "the game is in Sutton",
    "I'm out of the country",
    "put me in the bench next week if you can",
    // Hypothetical / past tense (interaction-contract seatbelt).
    "I was in last week",
    "if I was in I'd play",
    "I would have been in",
    // Third-party — this fallback is SELF attendance only.
    "my mate Kieran is in",
    "Rashad is out",
    // Chat.
    "cheers mate",
    "see you Tuesday",
  ];
  for (const body of FALLTHROUGH) {
    it(`"${body}" → null`, () => {
      expect(classifyDmSelfAttendance(body)).toBeNull();
    });
  }
});

describe("decideDmSelfAttendanceFallback — a pending prompt always wins", () => {
  it("returns null for a clear IN when a more specific pending prompt exists", () => {
    expect(
      decideDmSelfAttendanceFallback({ text: "IN", hasPendingPrompt: true }),
    ).toBeNull();
  });

  it("returns null for a clear OUT when a more specific pending prompt exists", () => {
    expect(
      decideDmSelfAttendanceFallback({ text: "out", hasPendingPrompt: true }),
    ).toBeNull();
  });

  it("handles a clear IN when there is no pending prompt", () => {
    expect(
      decideDmSelfAttendanceFallback({ text: "I'm in", hasPendingPrompt: false }),
    ).toBe("in");
  });

  it("handles a clear OUT when there is no pending prompt", () => {
    expect(
      decideDmSelfAttendanceFallback({ text: "count me out", hasPendingPrompt: false }),
    ).toBe("out");
  });

  it("still returns null for an ambiguous body with no pending prompt", () => {
    expect(
      decideDmSelfAttendanceFallback({ text: "maybe", hasPendingPrompt: false }),
    ).toBeNull();
  });
});
