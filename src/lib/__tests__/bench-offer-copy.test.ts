/**
 * The bench-slot offer copy — pure builders, no DB.
 *
 * WHY THIS TEST EXISTS (2026-08-31): the group post that offers an open
 * slot to the bench used to say "React 👍 here (or reply *IN*) to take
 * it". Inbound reactions are DEAD in production: the bot drops every
 * `message_reaction` event (`reaction-forwarding is unavailable` in
 * bot.err.log, zero successful forwards ever) and the last
 * `SentNotification.waMessageId` that was not NULL is 18 July, so even
 * an arriving reaction could not be mapped back to the offer.
 *
 * A benched player therefore tapped 👍, believed they had claimed the
 * slot, and the team turned up a player short. This is the highest-stakes
 * instance of the silent-failure pattern the recruit DM was already
 * gated for (RECRUIT_DM_MENTION_REACTIONS), and it is the one that
 * decides whether a club can field a full side.
 *
 * These tests pin the production copy TO the constant by equality, so
 * the two cannot drift: whatever the flag says is what players are told.
 *
 * The reaction HANDLING is deliberately untouched and must stay that
 * way (src/app/api/whatsapp/reaction/route.ts, src/lib/bench-confirmation.ts).
 * Only the INSTRUCTION is withdrawn.
 */
import { describe, it, expect } from "vitest";
import {
  BENCH_PROMPT_MENTION_REACTIONS,
  buildBenchOfferGroupPost,
  buildBenchOfferDm,
  buildBenchIntroLine,
  buildBenchAskedLine,
  benchClaimPhrasingExample,
  buildFullSquadBenchInvite,
} from "@/lib/bench-offer-copy";

const GROUP = {
  context: "on *Reds* (replacing Ehtisham Ekin) for *Tuesday 7-a-side* tonight",
  tagList: "@447700900001 @447700900002",
};

const DM = {
  firstName: "Aydın",
  context: "on Reds (replacing Ehtisham Ekin) for Tuesday 7-a-side tonight",
};

describe("BENCH_PROMPT_MENTION_REACTIONS", () => {
  it("is OFF right now — inbound reaction forwarding is dead on the Pi", () => {
    expect(BENCH_PROMPT_MENTION_REACTIONS).toBe(false);
  });
});

describe("buildBenchOfferGroupPost — the post that decides if we field 11", () => {
  it("NEVER tells the bench to react while the flag is false", () => {
    const text = buildBenchOfferGroupPost({ ...GROUP, mentionReactions: false });
    expect(text).not.toMatch(/\breact\b/i);
    expect(text).not.toMatch(/\btap\b/i);
    expect(text).not.toContain("👍");
    expect(text).not.toContain("👎");
  });

  it("still tells them exactly how to claim it: reply IN", () => {
    const text = buildBenchOfferGroupPost({ ...GROUP, mentionReactions: false });
    expect(text).toContain("*IN*");
    expect(text.toLowerCase()).toContain("reply");
  });

  it("keeps the first-come framing and the no-timeout reassurance", () => {
    const text = buildBenchOfferGroupPost({ ...GROUP, mentionReactions: false });
    expect(text.toLowerCase()).toContain("first");
    expect(text.toLowerCase()).toContain("no timeout");
    expect(text.toLowerCase()).toContain("bench");
  });

  it("keeps the context and the @mentions of everyone on the bench", () => {
    const text = buildBenchOfferGroupPost({ ...GROUP, mentionReactions: false });
    expect(text).toContain(GROUP.context);
    expect(text).toContain("@447700900001");
    expect(text).toContain("@447700900002");
  });

  it("defaults to the flag, so production copy cannot drift from it", () => {
    expect(buildBenchOfferGroupPost(GROUP)).toBe(
      buildBenchOfferGroupPost({ ...GROUP, mentionReactions: BENCH_PROMPT_MENTION_REACTIONS }),
    );
  });

  it("offers the 👍 again the moment the flag is flipped back on", () => {
    const text = buildBenchOfferGroupPost({ ...GROUP, mentionReactions: true });
    expect(text).toContain("👍");
    expect(text).toContain("*IN*"); // the reply route never goes away
  });

  it("uses no em dashes, en dashes or slashes (house style)", () => {
    for (const on of [false, true]) {
      const text = buildBenchOfferGroupPost({ ...GROUP, mentionReactions: on });
      expect(text).not.toContain("—");
      expect(text).not.toContain("–");
      expect(text).not.toContain("/");
    }
  });

  it("stays short — a WhatsApp post, not a letter", () => {
    expect(buildBenchOfferGroupPost(GROUP).length).toBeLessThan(400);
  });
});

describe("buildBenchOfferDm — the same offer, sent 1:1", () => {
  it("NEVER tells the player to react while the flag is false", () => {
    const text = buildBenchOfferDm({ ...DM, mentionReactions: false });
    expect(text).not.toMatch(/\breact\b/i);
    expect(text).not.toMatch(/\btap\b/i);
    expect(text).not.toContain("👍");
    expect(text).not.toContain("👎");
  });

  it("still gives both working routes: YES here, or IN in the group", () => {
    const text = buildBenchOfferDm({ ...DM, mentionReactions: false });
    expect(text).toContain("*YES*");
    expect(text).toContain("*IN*");
    expect(text.toLowerCase()).toContain("group");
  });

  it("greets the player and keeps the context", () => {
    const text = buildBenchOfferDm({ ...DM, mentionReactions: false });
    expect(text).toContain("Aydın");
    expect(text).toContain(DM.context);
  });

  it("defaults to the flag, so production copy cannot drift from it", () => {
    expect(buildBenchOfferDm(DM)).toBe(
      buildBenchOfferDm({ ...DM, mentionReactions: BENCH_PROMPT_MENTION_REACTIONS }),
    );
  });

  it("offers the 👍 again the moment the flag is flipped back on", () => {
    const text = buildBenchOfferDm({ ...DM, mentionReactions: true });
    expect(text).toContain("👍");
    expect(text).toContain("*YES*");
  });

  it("uses no em dashes, en dashes or slashes (house style)", () => {
    for (const on of [false, true]) {
      const text = buildBenchOfferDm({ ...DM, mentionReactions: on });
      expect(text).not.toContain("—");
      expect(text).not.toContain("–");
      expect(text).not.toContain("/");
    }
  });
});

describe("buildBenchIntroLine — what the group is PROMISED on day one", () => {
  it("does not promise a 👍 confirmation while the flag is false", () => {
    const line = buildBenchIntroLine({ mentionReactions: false });
    expect(line).not.toContain("👍");
    expect(line).not.toContain("👎");
    expect(line).not.toMatch(/\breact\b/i);
  });

  it("describes what actually happens: tagged here, first to reply IN plays", () => {
    const line = buildBenchIntroLine({ mentionReactions: false });
    expect(line).toContain("*IN*");
    expect(line.toLowerCase()).toContain("first");
  });

  it("defaults to the flag", () => {
    expect(buildBenchIntroLine()).toBe(
      buildBenchIntroLine({ mentionReactions: BENCH_PROMPT_MENTION_REACTIONS }),
    );
  });

  it("mentions the 👍 again once the flag is back on", () => {
    expect(buildBenchIntroLine({ mentionReactions: true })).toContain("👍");
  });
});

describe("buildBenchAskedLine — the honest status line the server prepends", () => {
  const args = { benchName: "Aydın", confirmedCount: 13, maxPlayers: 14 };

  it("does not tell the group the bencher was given a 👍/👎 prompt", () => {
    const line = buildBenchAskedLine({ ...args, mentionReactions: false });
    expect(line).not.toContain("👍");
    expect(line).not.toContain("👎");
  });

  it("says how the bencher actually claims it, and keeps the honest count", () => {
    const line = buildBenchAskedLine({ ...args, mentionReactions: false });
    expect(line).toContain("Aydın");
    expect(line).toContain("*IN*");
    expect(line).toContain("*13/14*");
  });

  it("defaults to the flag", () => {
    expect(buildBenchAskedLine(args)).toBe(
      buildBenchAskedLine({ ...args, mentionReactions: BENCH_PROMPT_MENTION_REACTIONS }),
    );
  });
});

/**
 * ── THREE OF THESE FOUR CASES DIED WITH `SYSTEM_PROMPT` (§10 step 8) ──
 *
 * They pinned the PROMPT to the same feature flag as the copy constants,
 * because "if the prompt keeps offering '👍/👎 above' as a phrasing
 * example the model will keep saying it however the copy constants are
 * set". There is no prompt: the bench-offer copy is rendered from these
 * constants directly, so the two cannot disagree and there is nothing
 * left to pin.
 *
 * The fourth — "still teaches the model to READ a 👍 as a bench claim" —
 * was the only one asserting BEHAVIOUR rather than prompt text, and the
 * behaviour did not go anywhere. It moved to a database row: a 👍 from a
 * player with an open offer is caught by `pipeline/awaiting-answer.ts`
 * (the router's open-question rescue, PR #42) and, for an open
 * `PendingBenchConfirmation`, by `lib/bench-prompt-answer.ts`. Both are
 * tested where they live, and both are stronger than a prompt line: they
 * read a row instead of hoping the model remembered a rule.
 *
 * What survives here is the half that was never about the model.
 */
describe("the phrasing example honours the flag in both directions", () => {
  it("does not tell a player to use the 👍 above when reactions are off", () => {
    expect(benchClaimPhrasingExample({ mentionReactions: false })).not.toContain("👍");
  });

  it("restores the reaction example when the flag is flipped back on", () => {
    expect(benchClaimPhrasingExample({ mentionReactions: true })).toContain("👍");
  });
});

/**
 * `rewriteOverconfidentPromotion` was deleted on 2026-09-01 (§10 step 4)
 * and its three cases here went with it. It stripped a hallucinated
 * promotion out of a reply and prepended `buildBenchAskedLine()` in its
 * place; the model no longer writes the squad sentence at all, so there
 * is nothing to strip. `buildBenchAskedLine` itself is kept and still
 * covered above: the copy is the bench-offer feature's, not the
 * post-processor's, and the flag it is pinned to is a shipped guard.
 */

/**
 * ── THE FIFTH SURFACE: THE RECRUIT ASK INTO A FULL SQUAD ─────────────
 *
 * 2026-09-14, Sutton FC, live. Kemal asked his group, untagged, for
 * benchers: "it would be great to have some benchers in case someone
 * drops tomorrow? Anybody else interested". MatchTime replied "The squad
 * for *Tuesday 7-a-side* is already full — no open spots to recruit
 * for." and the match kicked off at 14 of 14 with nobody on the bench.
 *
 * The answer was backwards: benchers are wanted BECAUSE the squad is
 * full. `buildFullSquadBenchInvite` is what MatchTime says instead, and
 * it lives in this file because it is a PROMISE about the bench, the
 * same promise `buildBenchIntroLine` makes on day one, made again at the
 * moment somebody asks. If it ever drifts from what the platform can
 * receive (today: no reactions, inbound forwarding is dead) it sends a
 * volunteer off to do something that does nothing, which is the failure
 * this whole file exists to prevent.
 */
describe("buildFullSquadBenchInvite — the answer to a recruit ask at 14 of 14", () => {
  const ARGS = { matchName: "Tuesday 7-a-side", confirmedCount: 14, maxPlayers: 14 };

  it("never repeats the incident sentence", () => {
    for (const on of [false, true]) {
      const text = buildFullSquadBenchInvite({ ...ARGS, mentionReactions: on });
      expect(text).not.toContain("no open spots");
      expect(text).not.toContain("already full");
    }
  });

  it("names the match, states the honest count, and opens the bench", () => {
    const text = buildFullSquadBenchInvite({ ...ARGS, mentionReactions: false });
    expect(text).toContain("*Tuesday 7-a-side*");
    expect(text).toContain("14 of 14");
    expect(text.toLowerCase()).toContain("bench");
  });

  it("tells a volunteer the one thing that actually works: reply IN", () => {
    const text = buildFullSquadBenchInvite({ ...ARGS, mentionReactions: false });
    expect(text).toContain("*IN*");
    expect(text).not.toMatch(/\breact\b/i);
    expect(text).not.toMatch(/\btap\b/i);
    expect(text).not.toContain("👍");
    expect(text).not.toContain("👎");
  });

  it("describes the promotion the way the day-one promise does, first come", () => {
    const text = buildFullSquadBenchInvite({ ...ARGS, mentionReactions: false });
    expect(text.toLowerCase()).toContain("first");
    expect(text.toLowerCase()).toContain("drops");
  });

  it("defaults to the flag, so production copy cannot drift from it", () => {
    expect(buildFullSquadBenchInvite(ARGS)).toBe(
      buildFullSquadBenchInvite({ ...ARGS, mentionReactions: BENCH_PROMPT_MENTION_REACTIONS }),
    );
  });

  it("offers the 👍 again the moment the flag is flipped back on", () => {
    const text = buildFullSquadBenchInvite({ ...ARGS, mentionReactions: true });
    expect(text).toContain("👍");
    expect(text).toContain("*IN*"); // the reply route never goes away
  });

  it("makes the SAME promotion promise as the day-one intro line", () => {
    // Both sentences describe one mechanism (a drop opens a
    // BenchSlotOffer that the first claimer takes), so they share the
    // fragment rather than each carrying their own wording. Two copies
    // of one promise is one copy too many: a flag flip could move one
    // and leave the other lying.
    for (const on of [false, true]) {
      const claim = on
        ? "the first to react 👍 or reply *IN* takes the slot"
        : "the first to reply *IN* takes the slot";
      expect(buildBenchIntroLine({ mentionReactions: on })).toContain(claim);
      expect(buildFullSquadBenchInvite({ ...ARGS, mentionReactions: on })).toContain(claim);
    }
  });

  it("uses no em dashes, en dashes or slashes (house style)", () => {
    for (const on of [false, true]) {
      const text = buildFullSquadBenchInvite({ ...ARGS, mentionReactions: on });
      expect(text).not.toContain("—");
      expect(text).not.toContain("–");
      expect(text).not.toContain("/");
    }
  });

  it("stays short — a WhatsApp reply, not a letter", () => {
    expect(buildFullSquadBenchInvite(ARGS).length).toBeLessThan(400);
  });
});
