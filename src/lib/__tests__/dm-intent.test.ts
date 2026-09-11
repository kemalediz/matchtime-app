/**
 * THE DM SURFACE'S LAST TWO REGEX CLASSIFIERS, REPLACED BY ONE MODEL
 * CALL (2026-09-11).
 *
 * `api/whatsapp/dm-reply/route.ts` asked two questions of every DM it
 * had not already claimed:
 *
 *   looksLikeRecruitRequest         a recruit verb NEAR a people noun,
 *                                   or a shortage phrase — and behind it
 *                                   `inviteRecentPlayers`, a mass DM to
 *                                   13-27 real people
 *   looksLikeRatingProgressRequest  (a rating word) AND (a progress
 *                                   word), anywhere in the body
 *
 * Both are the shape that caused 2026-09-01 and 2026-09-10. These tests
 * pin the replacement, and the FIRST two are the ones that matter: the
 * mass DM must not fire when the model says "other", and must not fire
 * when the model call throws.
 */
import { describe, it, expect } from "vitest";
import {
  DM_INTENT_MIN_CONFIDENCE,
  DM_INTENT_SYSTEM_PROMPT,
  classifyDmIntent,
  dmBodyOf,
  parseDmIntent,
  runDmAdminIntent,
  type DmAdminIntentDeps,
  type DmIntent,
} from "../dm-intent";

/** Every dependency of the DM admin path, recorded rather than run. */
function recorder(over: Partial<DmAdminIntentDeps> = {}) {
  const calls = {
    classified: 0,
    invited: [] as string[],
    progressed: [] as string[],
    replies: [] as Array<{ orgId: string; text: string }>,
  };
  const deps: DmAdminIntentDeps = {
    classify: async () => {
      calls.classified++;
      return "other";
    },
    adminOrgIds: async () => ["org-sutton"],
    orgWithUpcomingMatch: async () => "org-sutton",
    orgWithCompletedMatch: async () => "org-sutton",
    invite: async (orgId) => {
      calls.invited.push(orgId);
      return { reply: "📣 Done — DM'd 13 recent players", invited: 13 };
    },
    ratingProgress: async (orgId) => {
      calls.progressed.push(orgId);
      return "📋 rating progress";
    },
    reply: async (args) => {
      calls.replies.push(args);
    },
    ...over,
  };
  return { calls, deps };
}

const says = (intent: DmIntent) => ({ classify: async () => intent });

describe("NOBODY IS DM'd when the model says this is not the ask", () => {
  it("queues nothing at all on `other`", async () => {
    const r = recorder(says("other"));
    const out = await runDmAdminIntent(r.deps);
    expect(out.handled).toBeNull();
    // The whole point: zero calls on the thing that DMs 13-27 people.
    expect(r.calls.invited).toEqual([]);
    expect(r.calls.progressed).toEqual([]);
    expect(r.calls.replies).toEqual([]);
  });

  it("FAILS CLOSED when the model call throws", async () => {
    const r = recorder({
      classify: async () => {
        throw new Error("529 Overloaded");
      },
    });
    const out = await runDmAdminIntent(r.deps);
    expect(out.handled).toBeNull();
    expect(r.calls.invited).toEqual([]);
    expect(r.calls.replies).toEqual([]);
  });

  it("does not even ASK the model when the sender is not an admin", async () => {
    // The deterministic gate runs FIRST, and it is the dominant filter:
    // almost every DM MatchTime receives is from an ordinary player, so
    // the model call never happens for them.
    const r = recorder({ ...says("recruit_blast"), adminOrgIds: async () => [] });
    const out = await runDmAdminIntent(r.deps);
    expect(out.handled).toBeNull();
    expect(r.calls.classified).toBe(0);
    expect(r.calls.invited).toEqual([]);
  });

  it("refuses the blast when there is no upcoming match to recruit for", async () => {
    const r = recorder({ ...says("recruit_blast"), orgWithUpcomingMatch: async () => null });
    const out = await runDmAdminIntent(r.deps);
    expect(out.handled).toBeNull();
    expect(r.calls.invited).toEqual([]);
  });

  it("refuses the progress read when the club has not played yet", async () => {
    const r = recorder({ ...says("rating_progress"), orgWithCompletedMatch: async () => null });
    const out = await runDmAdminIntent(r.deps);
    expect(out.handled).toBeNull();
    expect(r.calls.progressed).toEqual([]);
  });
});

describe("the genuine asks still work", () => {
  it("an admin's recruit ask blasts once and replies once", async () => {
    const r = recorder(says("recruit_blast"));
    const out = await runDmAdminIntent(r.deps);
    expect(out).toEqual({ handled: "recruit-dm", orgId: "org-sutton", invited: 13 });
    expect(r.calls.invited).toEqual(["org-sutton"]);
    expect(r.calls.replies).toHaveLength(1);
    expect(r.calls.replies[0].text).toContain("13 recent players");
    // A rating-progress read is a different ask and must not ride along.
    expect(r.calls.progressed).toEqual([]);
  });

  it("an admin's rating-progress ask answers, and DMs nobody else", async () => {
    const r = recorder(says("rating_progress"));
    const out = await runDmAdminIntent(r.deps);
    expect(out).toEqual({ handled: "rating-progress-dm", orgId: "org-sutton" });
    expect(r.calls.progressed).toEqual(["org-sutton"]);
    expect(r.calls.replies).toHaveLength(1);
    // THE MASS DM IS A DIFFERENT BRANCH AND MUST STAY SHUT.
    expect(r.calls.invited).toEqual([]);
  });
});

// ── THE CLASSIFIER ITSELF ────────────────────────────────────────────
//
// Driven through an INJECTED call so the parse, the enum re-validation
// and the confidence floor are exercised for real without a key. What is
// stubbed is what ENTERS the system (the model's raw text), never what it
// concludes — `MDs/llm-pipeline-testing-playbook.md`, rule 2.

const answer = (intent: string, confidence = 0.95) =>
  async () => JSON.stringify({ intent, confidence, reasoning: "stub" });

describe("classifyDmIntent — the model can only ever say what it saw", () => {
  it("reads a clean, confident recruit_blast", async () => {
    const c = await classifyDmIntent("DM the lads from the last few games", {}, answer("recruit_blast"));
    expect(c.intent).toBe("recruit_blast");
  });

  it("returns `other` for an intent outside the closed enum", async () => {
    const c = await classifyDmIntent("x", {}, answer("send_everyone_money"));
    expect(c.intent).toBe("other");
  });

  it("returns `other` for unparseable output", async () => {
    const c = await classifyDmIntent("x", {}, async () => "I think this is a recruit request!");
    expect(c.intent).toBe("other");
  });

  it("returns `other` when the call throws — no key, an overload, anything", async () => {
    const c = await classifyDmIntent("x", {}, async () => {
      throw new Error("529 Overloaded");
    });
    expect(c.intent).toBe("other");
  });

  it("forces a wobbly answer down to `other`", async () => {
    const c = await classifyDmIntent("x", {}, answer("recruit_blast", DM_INTENT_MIN_CONFIDENCE - 0.01));
    expect(c.intent).toBe("other");
  });

  it("sends the WHOLE message, not its last line", async () => {
    // A real WhatsApp message is routinely several lines long — the
    // 2026-09-01 incident message is — and a seam that read only the
    // last line would classify a fragment. The header is what makes the
    // body recoverable whole.
    let seen = "";
    await classifyDmIntent(
      "Najib is out.\n\nWe need one more player.",
      { senderName: "Kemal Ediz" },
      async (_s, user) => {
        seen = user;
        return JSON.stringify({ intent: "other", confidence: 1, reasoning: "x" });
      },
    );
    expect(dmBodyOf(seen)).toBe("Najib is out.\n\nWe need one more player.");
  });

  it("strips a markdown fence, which the model still sometimes adds", () => {
    expect(
      parseDmIntent('```json\n{"intent":"rating_progress","confidence":0.95,"reasoning":"x"}\n```')
        .intent,
    ).toBe("rating_progress");
  });
});

// ── THE SENTENCES THAT MUST NEVER FIRE ANYTHING ──────────────────────
//
// Two of these are REAL messages from the live Sutton FC group, and each
// is the shape its regex could not tell from a command:
//
//   the 2026-09-10 near-miss  a message ABOUT ratings, players and DMs
//                             that instructs the PLAYERS. 69 mass DMs.
//   the 2026-09-01 incident   "Najib is out. We need one more player." —
//                             `looksLikeRecruitRequest` matched the
//                             SECOND sentence, the drop was never
//                             analysed, and MatchTime told the owner his
//                             squad was full.
//
// Here they are pinned against the PROMPT (they appear in it as negative
// examples) and against the fail-closed path. The live measurement is
// `DMS=1` in `scripts/dryrun-pipeline.ts`; a stubbed assertion can only
// prove the verdict it assumed.
describe("the prompt is taught the real failure shape", () => {
  it("carries negative examples that are ABOUT DMs, players and ratings", () => {
    expect(DM_INTENT_SYSTEM_PROMPT).toContain("rate the players");
    expect(DM_INTENT_SYSTEM_PROMPT).toContain("We need one more player");
    expect(DM_INTENT_SYSTEM_PROMPT).toContain("other");
  });

  it("names the enum and nothing outside it", () => {
    expect(DM_INTENT_SYSTEM_PROMPT).toContain("recruit_blast");
    expect(DM_INTENT_SYSTEM_PROMPT).toContain("rating_progress");
  });
});

describe("a message the model calls `other` is inert whatever it says", () => {
  const REAL_MESSAGES = [
    "please do not forget to rate the players via the link from Matchtime DM'ed to you. " +
      "the more accurate ratings, the more balanced teams next time",
    "Najib is out. We need one more player.",
    "the lads keep asking me to DM them the ratings link",
    "cheers for sorting the players out last week",
  ];

  for (const body of REAL_MESSAGES) {
    it(`queues nothing for ${JSON.stringify(body.slice(0, 40))}…`, async () => {
      const c = await classifyDmIntent(body, {}, answer("other"));
      const r = recorder({ classify: async () => c.intent });
      const out = await runDmAdminIntent(r.deps);
      expect(out.handled).toBeNull();
      expect(r.calls.invited).toEqual([]);
      expect(r.calls.replies).toEqual([]);
    });
  }
});
