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
  GO_LIVE_MIN_CONFIDENCE,
  classifyDmIntent,
  dmBodyOf,
  parseDmIntent,
  runDmAdminIntent,
  buildDmIntentUserTurn,
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
    partnerAsks: [] as string[],
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
    askPartners: async (orgId) => {
      calls.partnerAsks.push(orgId);
      return "I've asked *Sutton FC*'s organisers.";
    },
    reply: async (args) => {
      calls.replies.push(args);
    },
    isOwner: async () => false,
    sendIntro: async () => {},
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

// ── SLICE S6 (2026-10-21): ASKING THE PARTNER CLUBS BY DM ─────────────
describe("partner_ask: the partner clubs are asked, nobody is DM'd", () => {
  it("an admin's ask goes to the shared door once and replies once", async () => {
    const r = recorder(says("partner_ask"));
    const out = await runDmAdminIntent(r.deps);
    expect(out).toEqual({ handled: "partner-ask-dm", orgId: "org-sutton" });
    expect(r.calls.partnerAsks).toEqual(["org-sutton"]);
    expect(r.calls.replies).toEqual([{ orgId: "org-sutton", text: "I've asked *Sutton FC*'s organisers." }]);
    // Never the club's own recruit blast.
    expect(r.calls.invited).toEqual([]);
  });

  it("no upcoming match anywhere: still one plain reply from the admin's first club", async () => {
    const r = recorder({ ...says("partner_ask"), orgWithUpcomingMatch: async () => null });
    const out = await runDmAdminIntent(r.deps);
    expect(out).toEqual({ handled: "partner-ask-dm", orgId: "org-sutton" });
    expect(r.calls.partnerAsks).toEqual(["org-sutton"]);
  });

  it("a non-admin is never asked about it", async () => {
    const r = recorder({ ...says("partner_ask"), adminOrgIds: async () => [] });
    expect((await runDmAdminIntent(r.deps)).handled).toBeNull();
    expect(r.calls.partnerAsks).toEqual([]);
  });

  it("the classifier reads partner_ask, under the same confidence floor", async () => {
    expect((await classifyDmIntent("ask Sutton if anyone can play", {}, answer("partner_ask"))).intent).toBe("partner_ask");
    expect((await classifyDmIntent("x", {}, answer("partner_ask", DM_INTENT_MIN_CONFIDENCE - 0.01))).intent).toBe("other");
  });

  it("the prompt defines partner_ask once, with English and Turkish beside each other", () => {
    expect(DM_INTENT_SYSTEM_PROMPT.split('- "partner_ask"').length).toBe(2);
    expect(DM_INTENT_SYSTEM_PROMPT).toMatch(/partner_ask: [^\n]*"Sutton'a sor bakalım oynayan var mı"/);
    expect(DM_INTENT_SYSTEM_PROMPT).not.toMatch(/[–—]/);
  });

  it("the user turn names the club's partner clubs when it has any", () => {
    expect(buildDmIntentUserTurn("ask Sutton", { clubName: "FNF", partnerClubs: ["Sutton FC", "MT Vets"] })).toContain("Partner clubs: Sutton FC, MT Vets");
    expect(buildDmIntentUserTurn("ask Sutton", { clubName: "FNF" })).not.toContain("Partner clubs");
  });
});

// ── 2026-10-29: THE OWNER'S INTRO MESSAGES ────────────────────────────
describe("intro_messages: only the platform owner gets them", () => {
  const intro = (cats: number[]) => ({ classify: async () => ({ intent: "intro_messages" as DmIntent, intro: cats }) });
  function withIntro(over: Partial<DmAdminIntentDeps> = {}) {
    const sent: number[][] = [];
    const r = recorder({
      isOwner: async () => true,
      sendIntro: async (cats) => {
        sent.push(cats);
      },
      ...over,
    });
    return { ...r, sent };
  }

  it("the owner's ask sends the category he named, and nothing else happens", async () => {
    const r = withIntro(intro([3]));
    expect(await runDmAdminIntent(r.deps)).toEqual({ handled: "owner-intro-dm", categories: [3] });
    expect(r.sent).toEqual([[3]]);
    expect(r.calls.replies).toEqual([]);
    expect(r.calls.invited).toEqual([]);
  });

  it("no category named: all three", async () => {
    const r = withIntro(intro([]));
    expect(await runDmAdminIntent(r.deps)).toEqual({ handled: "owner-intro-dm", categories: [1, 2, 3] });
  });

  it("anybody else asking: not handled, nothing sent, the DM carries on as normal", async () => {
    const r = withIntro({ ...intro([1]), isOwner: async () => false });
    expect((await runDmAdminIntent(r.deps)).handled).toBeNull();
    expect(r.sent).toEqual([]);
    expect(r.calls.replies).toEqual([]);
  });

  it("the owner is asked even when he runs no club; a non-admin non-owner never reaches the model", async () => {
    const r = withIntro({ ...intro([2]), adminOrgIds: async () => [] });
    expect(await runDmAdminIntent(r.deps)).toEqual({ handled: "owner-intro-dm", categories: [2] });
    const p = withIntro({ ...intro([2]), adminOrgIds: async () => [], isOwner: async () => false });
    expect((await runDmAdminIntent(p.deps)).handled).toBeNull();
    expect(p.calls.classified).toBe(0);
  });

  it("the owner's other asks still go where they went", async () => {
    const r = withIntro(says("rating_progress"));
    expect((await runDmAdminIntent(r.deps)).handled).toBe("rating-progress-dm");
    expect(r.sent).toEqual([]);
  });

  it("the classifier reads the intent and the categories, under the same floor", async () => {
    const said = (o: object) => async () => JSON.stringify({ confidence: 0.95, reasoning: "stub", ...o });
    const c = await classifyDmIntent("kategori 3 tanıtım mesajını gönder", {}, said({ intent: "intro_messages", intro: [3] }));
    expect(c).toMatchObject({ intent: "intro_messages", intro: [3] });
    const low = await classifyDmIntent("x", {}, async () => JSON.stringify({ intent: "intro_messages", intro: [1], confidence: 0.5 }));
    expect(low.intent).toBe("other");
    // A garbled list is the code's to clean (owner-intro.ts): here it is kept as numbers only.
    const odd = await classifyDmIntent("x", {}, said({ intent: "intro_messages", intro: [1, "2", null] }));
    expect(odd.intro).toEqual([1]);
  });

  it("the prompt defines intro_messages once, with its three categories and English beside Turkish", () => {
    expect(DM_INTENT_SYSTEM_PROMPT.split('- "intro_messages"').length).toBe(2);
    expect(DM_INTENT_SYSTEM_PROMPT).toMatch(/intro_messages[^\n]*"kategori 3 tanıtım mesajını gönder"/);
    expect(DM_INTENT_SYSTEM_PROMPT).toContain('"intro"');
  });
});

// ── 2026-10-30: the one DM reader (no string parsing) ─────────────────

describe("the one DM reader: GO, stop and start, and a question are its reads", () => {
  const json = (o: Record<string, unknown>) => async () => JSON.stringify({ intro: [], reasoning: "r", ...o });

  it.each(["go_live", "stop_messages", "stop_ratings", "resume_messages", "resume_ratings", "question"] as const)(
    "reads %s at a confident answer",
    async (intent) => {
      const r = await classifyDmIntent("x", {}, json({ intent, confidence: 0.95 }));
      expect(r.intent).toBe(intent);
    },
  );

  it("GO needs 90%: at 85% it is `other`, so no club goes live on a wobbly read", async () => {
    expect(GO_LIVE_MIN_CONFIDENCE).toBe(0.9);
    expect((await classifyDmIntent("go", {}, json({ intent: "go_live", confidence: 0.85 }))).intent).toBe("other");
    expect((await classifyDmIntent("go", {}, json({ intent: "go_live", confidence: 0.9 }))).intent).toBe("go_live");
  });

  it("a stop at 85% clears the general 80% floor", async () => {
    expect((await classifyDmIntent("stop", {}, json({ intent: "stop_messages", confidence: 0.85 }))).intent).toBe("stop_messages");
  });

  it("a failed or garbled read is `other`: no opt-out, no GO, no answer", async () => {
    expect((await classifyDmIntent("stop", {}, async () => { throw new Error("overloaded"); })).intent).toBe("other");
    expect((await classifyDmIntent("GO", {}, async () => "GO!")).intent).toBe("other");
  });

  it("none of the new reads does anything on the admin path", async () => {
    for (const intent of ["go_live", "stop_messages", "resume_ratings", "question"] as const) {
      const { calls, deps } = recorder(says(intent));
      expect(await runDmAdminIntent(deps)).toEqual({ handled: null });
      expect(calls.invited).toEqual([]);
      expect(calls.replies).toEqual([]);
    }
  });

  it("the user turn names the sender's clubs: role and stage, facts the code holds", () => {
    const u = buildDmIntentUserTurn("GO", {
      senderName: "Raihan",
      clubs: [
        { name: "Riverside FC", organiser: true, settingUp: true },
        { name: "Sutton FC", organiser: false, settingUp: false },
      ],
    });
    expect(u).toContain("Their clubs: Riverside FC (organiser, setting up: not live until its organiser says GO); Sutton FC (player, live)");
    expect(u).toContain("Sender: Raihan");
    expect(dmBodyOf(u)).toBe("GO");
  });

  it("the prompt defines each new intent once, with English beside Turkish, and the old incident messages", () => {
    for (const i of ["go_live", "stop_messages", "stop_ratings", "resume_messages", "resume_ratings", "question"]) {
      expect(DM_INTENT_SYSTEM_PROMPT.split(`- "${i}"`).length).toBe(2);
    }
    expect(DM_INTENT_SYSTEM_PROMPT).toContain("do not message me on any topic but payment");
    expect(DM_INTENT_SYSTEM_PROMPT).toContain('"GO" | "BAŞLA"');
    expect(DM_INTENT_SYSTEM_PROMPT).not.toMatch(/[\u2014\u2013]/);
  });
});

describe("parseDmIntent reads the model's FIRST object (seen live 2026-10-30)", () => {
  it("an answer, a self-correction and a second object: the first answer stands", () => {
    const raw = '{"intent": "go_live", "intro": [], "confidence": 0.97, "reasoning": "GO", "confidence_note": ""}\n\nWait, that output included an extra field. Correcting to the strict schema:\n\n{"intent": "go_live", "intro": []';
    expect(parseDmIntent(raw).intent).toBe("go_live");
  });
  it("a brace inside a string does not confuse it", () => {
    expect(parseDmIntent('note {"intent": "question", "confidence": 0.9, "reasoning": "asks about {x}"} trailing').intent).toBe("question");
  });
});
