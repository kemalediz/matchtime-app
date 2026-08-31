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
} from "@/lib/bench-offer-copy";
import { SYSTEM_PROMPT, rewriteOverconfidentPromotion } from "@/lib/message-analyzer";

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
 * The LLM writes group text too. If the PROMPT keeps offering "👍/👎
 * above" as a phrasing example the model will keep saying it however the
 * copy constants are set, so the prompt is pinned to the same flag.
 */
describe("the system prompt is pinned to the same flag", () => {
  it("hands the model the gated phrasing example", () => {
    expect(SYSTEM_PROMPT).toContain(benchClaimPhrasingExample());
  });

  it("no longer suggests the model tell a player to use the 👍 above", () => {
    expect(benchClaimPhrasingExample({ mentionReactions: false })).not.toContain("👍");
    expect(SYSTEM_PROMPT).not.toContain("👍/👎 above");
  });

  it("restores the reaction example when the flag is flipped back on", () => {
    expect(benchClaimPhrasingExample({ mentionReactions: true })).toContain("👍");
  });

  it("still teaches the model to READ a 👍 as a bench claim (handling is untouched)", () => {
    // The instruction is withdrawn; the interpretation is not. An
    // unprompted 👍 in the group must still count the moment it arrives.
    expect(SYSTEM_PROMPT).toContain("benchConfirmation");
    expect(SYSTEM_PROMPT).toContain("👍");
  });
});

describe("rewriteOverconfidentPromotion uses the gated line", () => {
  const args = { benchName: "Aydın", confirmedCount: 13, maxPlayers: 14, benchCount: 2 };

  it("prepends a status line that never mentions a reaction", () => {
    const out = rewriteOverconfidentPromotion("Aydın moves up from the bench.", args);
    expect(out).not.toContain("👍");
    expect(out).not.toContain("👎");
    expect(out).toContain(buildBenchAskedLine(args));
  });

  it("still strips the false promotion claim", () => {
    const out = rewriteOverconfidentPromotion("Aydın moves up from the bench.", args);
    expect(out).not.toMatch(/moves up from the bench/i);
  });

  it("adds no status line at all when the bench is empty", () => {
    const out = rewriteOverconfidentPromotion("Aydın moves up from the bench.", {
      ...args,
      benchCount: 0,
    });
    expect(out).not.toContain("Aydın");
  });
});
