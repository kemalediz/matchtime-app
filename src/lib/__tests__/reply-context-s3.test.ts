/**
 * QUOTED-REPLY CONTEXT, SLICE S3 (2026-10-20): the four remaining DM
 * classifiers read the same chat-context block the payment-claim and
 * match-availability classifiers read since S2 (`renderReplyContext`:
 * the time now, and the message they swipe-replied to, or else MatchTime's
 * recent messages to them).
 *
 *   fee-confirm     the money collector's yes/no to "send the pay links?"
 *   roster-survey   a player's answer to the roster check-in
 *   dm-intent       an admin's DM: recruit blast, rating progress, other
 *   dm-qa           a player's question, answered from a scoped context
 *
 * Offline: the model is injected, so these pin what each one is TOLD.
 * What the real model does with it is the paid dry runs' job.
 */
import { describe, it, expect, vi } from "vitest";
import {
  FEE_REPLY_SYSTEM_PROMPT,
  buildFeeReplySystemPrompt,
  buildFeeReplyUserTurn,
  classifyFeeReply,
  feeReplyBodyOf,
} from "../fee-confirm";
import {
  ROSTER_SURVEY_STUB_FILE_ENV,
  ROSTER_SURVEY_SYSTEM_PROMPT,
  buildRosterSurveyUserTurn,
  classifyRosterReply,
  rosterSurveyBodyOf,
} from "../roster-survey-classifier";
import { DM_INTENT_SYSTEM_PROMPT, buildDmIntentUserTurn, classifyDmIntent, dmBodyOf } from "../dm-intent";
import { DM_QA_SYSTEM_PROMPT, buildDmQaUserTurn, composeScopedAnswer, type DmQaCall } from "../dm-qa";
import { noReplyContext, quoteForClubs, renderReplyContext, type QuotedBotMessage, type ReplyContext } from "../reply-context";
import { HAIKU_MODEL } from "../models";
import { MIN_CACHEABLE_TOKENS, estimateTokens } from "../pipeline/llm";

// Mon 19 Oct 2026, 18:00 London.
const NOW = new Date("2026-10-19T17:00:00Z");

const FEE_ASK: ReplyContext = {
  now: NOW,
  quoted: null,
  recent: [
    {
      at: new Date("2026-10-19T16:55:00Z"),
      text: "Got it, £8 per player for Tuesday 7-a-side, 12 players to charge. Reply ✅ (or \"yes\") to send everyone their pay link, or send a different amount to change it.",
      topic: null,
      match: null,
    },
  ],
  earlier: null,
};

const QUOTING_RATING: ReplyContext = {
  now: NOW,
  quoted: { at: new Date("2026-10-19T09:00:00Z"), text: "Rate your teammates", topic: "playerRating", match: "Tuesday 7-a-side, Tue 13 Oct, 20:00" },
  recent: [],
  earlier: null,
};

const json = (o: Record<string, unknown>) => JSON.stringify({ confidence: 0.95, reasoning: "test", ...o });

// ── fee-confirm ───────────────────────────────────────────────────────

describe("fee-confirm: the collector's reply is read against what MatchTime said", () => {
  const CTX = { pending: 8, matchName: "Tuesday 7-a-side, Tue 13 Oct, 20:00", lang: "en" as const, replyContext: FEE_ASK };

  it("the user turn: the match, the amount awaiting a yes, the chat context, then the reply under its header", () => {
    const u = buildFeeReplyUserTurn("yeah go on then", CTX);
    expect(u).toBe(
      [
        "Match: Tuesday 7-a-side, Tue 13 Oct, 20:00",
        "Amount waiting for their yes: £8 per player",
        renderReplyContext(FEE_ASK),
        "THEIR REPLY:",
        "yeah go on then",
      ].join("\n"),
    );
    expect(feeReplyBodyOf(u)).toBe("yeah go on then");
  });

  it("no chat context known: the time now and 'none', never a missing block", () => {
    const u = buildFeeReplyUserTurn("go ahead", { pending: 10.3, matchName: "Tuesday 5-a-side" });
    expect(u).toContain("Amount waiting for their yes: £10.30 per player");
    expect(u).toContain("NOW: ");
    expect(u).toContain("MATCHTIME'S RECENT MESSAGES TO THEM: none");
  });

  it("a swipe-reply shows only the quoted message", () => {
    const u = buildFeeReplyUserTurn("yes", { ...CTX, replyContext: QUOTING_RATING });
    expect(u).toContain("THEY ARE REPLYING TO MatchTime's message of");
    expect(u).not.toContain("Got it, £8 per player");
  });

  it("sends the one system prompt and the user turn", async () => {
    const call = vi.fn(async () => json({ intent: "yes" }));
    expect((await classifyFeeReply("yeah go on then", CTX, call)).intent).toBe("yes");
    expect(call).toHaveBeenCalledWith(FEE_REPLY_SYSTEM_PROMPT, buildFeeReplyUserTurn("yeah go on then", CTX));
  });

  it("the call carries confidence and reasoning, and still fails closed", async () => {
    expect(await classifyFeeReply("x", CTX, async () => json({ intent: "yes", confidence: 0.6 }))).toMatchObject({
      intent: "neither",
    });
    expect(
      await classifyFeeReply("x", CTX, async () => {
        throw new Error("overloaded");
      }),
    ).toMatchObject({ intent: "neither", confidence: 0 });
  });

  it("is ONE prompt for every club: the Turkish examples sit beside the English ones", () => {
    expect(buildFeeReplySystemPrompt()).toBe(FEE_REPLY_SYSTEM_PROMPT);
    expect(FEE_REPLY_SYSTEM_PROMPT).toContain('"great game 👍" | "harika maç 👍"');
  });

  it("says a reply answers the quoted message, or else the newest one", () => {
    expect(FEE_REPLY_SYSTEM_PROMPT).toMatch(/swipe-replied to/);
    expect(FEE_REPLY_SYSTEM_PROMPT).toMatch(/newest/);
  });

  it("no em or en dash, and over Haiku's cache floor", () => {
    expect(FEE_REPLY_SYSTEM_PROMPT).not.toMatch(/[—–]/);
    expect(estimateTokens(FEE_REPLY_SYSTEM_PROMPT)).toBeGreaterThanOrEqual(MIN_CACHEABLE_TOKENS[HAIKU_MODEL]);
  });
});

// ── roster-survey ─────────────────────────────────────────────────────

describe("roster-survey: the check-in answer is read against what MatchTime said", () => {
  const CTX = {
    clubName: "Sutton FC",
    playerName: "Ali",
    checkInSentAt: new Date("2026-10-17T17:00:00Z"),
    replyContext: QUOTING_RATING,
  };

  it("the user turn: club, player, when the check-in went out, the chat context, then the reply under its header", () => {
    const u = buildRosterSurveyUserTurn("yes", CTX);
    expect(u).toBe(
      [
        "Club: Sutton FC",
        "Player: Ali",
        "The check-in was sent: Sat 17 Oct, 18:00",
        renderReplyContext(QUOTING_RATING),
        "THE DM:",
        "yes",
      ].join("\n"),
    );
    expect(rosterSurveyBodyOf(u)).toBe("yes");
  });

  it("drops missing names, says the check-in time is not known, and always carries the block", () => {
    const u = buildRosterSurveyUserTurn("yes", {});
    expect(u.startsWith("The check-in was sent: (not known)\nNOW: ")).toBe(true);
    expect(u.endsWith("THE DM:\nyes")).toBe(true);
  });

  it("sends the system prompt and the user turn", async () => {
    const call = vi.fn(async () => json({ category: "in" }));
    await classifyRosterReply("yes", CTX, call);
    expect(call).toHaveBeenCalledWith(ROSTER_SURVEY_SYSTEM_PROMPT, buildRosterSurveyUserTurn("yes", CTX));
  });

  it("has a stub seam, so the route can be driven for free", () => {
    expect(ROSTER_SURVEY_STUB_FILE_ENV).toBe("MT_TEST_ROSTER_SURVEY_STUB_FILE");
  });

  it("says a reply to another message is not an answer to the check-in", () => {
    expect(ROSTER_SURVEY_SYSTEM_PROMPT).toMatch(/swipe-replied to/);
    expect(ROSTER_SURVEY_SYSTEM_PROMPT).toMatch(/newest/);
  });

  it("no em or en dash, and over Haiku's cache floor", () => {
    expect(ROSTER_SURVEY_SYSTEM_PROMPT).not.toMatch(/[—–]/);
    expect(estimateTokens(ROSTER_SURVEY_SYSTEM_PROMPT)).toBeGreaterThanOrEqual(MIN_CACHEABLE_TOKENS[HAIKU_MODEL]);
  });
});

// ── dm-intent ─────────────────────────────────────────────────────────

describe("dm-intent: an admin's DM is read against what MatchTime said", () => {
  const CTX = { clubName: "Sutton FC", senderName: "Kemal Ediz", replyContext: QUOTING_RATING };

  it("the user turn: club, sender, the chat context, then the DM under its header", () => {
    const u = buildDmIntentUserTurn("who's left?", CTX);
    expect(u).toBe(["Club: Sutton FC", "Sender: Kemal Ediz", renderReplyContext(QUOTING_RATING), "THE DM:", "who's left?"].join("\n"));
    expect(dmBodyOf(u)).toBe("who's left?");
  });

  it("with no context, the block still says the time now and that nothing is known", () => {
    expect(buildDmIntentUserTurn("x", {})).toMatch(/^NOW: [^\n]+\nMATCHTIME'S RECENT MESSAGES TO THEM: none in the last 14 days\.\nTHE DM:\nx$/);
    expect(renderReplyContext(noReplyContext(NOW))).toContain("none in the last 14 days");
  });

  it("sends the system prompt and the user turn", async () => {
    const call = vi.fn(async () => json({ intent: "rating_progress" }));
    const r = await classifyDmIntent("who's left?", CTX, call);
    expect(r.intent).toBe("rating_progress");
    expect(call).toHaveBeenCalledWith(DM_INTENT_SYSTEM_PROMPT, buildDmIntentUserTurn("who's left?", CTX));
  });

  it("gives English and Turkish examples side by side, and keeps the two real incident messages", () => {
    expect(DM_INTENT_SYSTEM_PROMPT).toContain(" | ");
    expect(DM_INTENT_SYSTEM_PROMPT).toContain("We need one more player");
    expect(DM_INTENT_SYSTEM_PROMPT).toContain("rate the players");
  });

  it("no em or en dash, and over Haiku's cache floor", () => {
    expect(DM_INTENT_SYSTEM_PROMPT).not.toMatch(/[—–]/);
    expect(estimateTokens(DM_INTENT_SYSTEM_PROMPT)).toBeGreaterThanOrEqual(MIN_CACHEABLE_TOKENS[HAIKU_MODEL]);
  });
});

// ── dm-qa ─────────────────────────────────────────────────────────────

describe("dm-qa: a question is read against what MatchTime said", () => {
  function recording() {
    const seen: Array<{ system: string; user: string }> = [];
    const call: DmQaCall = async (system, user) => {
      seen.push({ system, user });
      return { text: "Tuesday at 20:00", truncated: false };
    };
    return { call, seen };
  }
  const BASE = { context: "GROUP: Sutton FC", question: "what time?", askerName: "Ali Khan", orgName: "Sutton FC", lang: "en" as const };

  it("the user turn: the CONTEXT, then what MatchTime said, then the question", async () => {
    const { call, seen } = recording();
    await composeScopedAnswer({ ...BASE, replyContext: QUOTING_RATING, call });
    expect(seen[0].system).toBe(DM_QA_SYSTEM_PROMPT);
    expect(seen[0].user).toBe(
      [
        "CONTEXT (everything you may use; nothing else exists for you):",
        "GROUP: Sutton FC",
        "",
        "WHAT MATCHTIME SAID TO THEM:",
        renderReplyContext(QUOTING_RATING),
        "",
        "The player (Ali) asks:",
        "what time?",
        "",
        "Answer per your rules.",
      ].join("\n"),
    );
    expect(buildDmQaUserTurn({ ...BASE, replyContext: QUOTING_RATING })).toBe(seen[0].user);
  });

  it("with no chat context known, the block says the time now and none", async () => {
    const { call, seen } = recording();
    await composeScopedAnswer({ ...BASE, call });
    expect(seen[0].user).toContain("WHAT MATCHTIME SAID TO THEM:\nNOW: ");
    expect(seen[0].user).toContain("MATCHTIME'S RECENT MESSAGES TO THEM: none");
  });

  it("the user turn carries no em or en dash", () => {
    expect(buildDmQaUserTurn({ ...BASE, replyContext: QUOTING_RATING })).not.toMatch(/[—–]/);
  });

  describe("the system prompt", () => {
    it("states the contact-detail rule once", () => {
      expect(DM_QA_SYSTEM_PROMPT.split("\n").filter((l) => /contact detail/i.test(l))).toHaveLength(1);
      expect(DM_QA_SYSTEM_PROMPT.match(/never write a phone number/gi)).toHaveLength(1);
    });

    it("hardcodes no match format: the CONTEXT has the club's", () => {
      expect(DM_QA_SYSTEM_PROMPT).not.toMatch(/\d\s*-a-side|5\/7/);
    });

    it("answers the asker's OWN money and declines anyone else's, each said once (Kemal, 2026-10-20)", () => {
      const own = DM_QA_SYSTEM_PROMPT.split("\n").filter((l) => /their own money/i.test(l));
      expect(own).toHaveLength(1);
      expect(own[0]).toMatch(/YOUR PAYMENTS/);
      const others = DM_QA_SYSTEM_PROMPT.split("\n").filter((l) => /anyone else's payments/i.test(l));
      expect(others).toHaveLength(1);
      expect(others[0].startsWith("- ")).toBe(true);
      // The old blanket refusal is gone.
      expect(DM_QA_SYSTEM_PROMPT).not.toMatch(/money: fees, who owes/);
    });

    it("tells the model a short question refers to the message they replied to", () => {
      expect(DM_QA_SYSTEM_PROMPT).toMatch(/swipe-replied to/);
    });

    it("carries no em or en dash", () => {
      expect(DM_QA_SYSTEM_PROMPT).not.toMatch(/[—–]/);
    });
  });
});

// ── a club-scoped path's quote ────────────────────────────────────────

describe("quoteForClubs: a quote steers a club-scoped path only within its clubs", () => {
  const q = (matchId: string | null): QuotedBotMessage => ({ key: "k", sentAt: NOW, text: "x", topic: "playerRating", matchId });

  it("a quote naming no match is kept and picks no club", () => {
    expect(quoteForClubs(q(null), null, ["org-a"])).toEqual({ quoted: q(null), orgId: null });
  });

  it("a quote naming a match of one of the clubs is kept, and that club is acted on", () => {
    expect(quoteForClubs(q("m1"), "org-b", ["org-a", "org-b"])).toEqual({ quoted: q("m1"), orgId: "org-b" });
  });

  it("a quote naming another club's match is dropped, and picks no club", () => {
    expect(quoteForClubs(q("m1"), "org-z", ["org-a"])).toEqual({ quoted: null, orgId: null });
    expect(quoteForClubs(q("m1"), null, ["org-a"])).toEqual({ quoted: null, orgId: null });
  });

  it("no quote is no quote", () => {
    expect(quoteForClubs(null, "org-a", ["org-a"])).toEqual({ quoted: null, orgId: null });
  });
});

// ── review of #339 ────────────────────────────────────────────────────

import { topicOfDueKey } from "../due-key-feature";
import { buildFeeConfirmPrompt, buildFeeReleasedAck } from "../dm-copy";

describe("review of #339: the fee question is a topic of its own (H2, H3)", () => {
  it("the scheduler's fee ask and the queued confirm question are both the fee question", () => {
    expect(topicOfDueKey("m1:fee-ask")).toBe("feeQuestion");
    expect(topicOfDueKey("m1:fee-ask:again")).toBe("feeQuestion");
    expect(topicOfDueKey("m1:fee-confirm")).toBe("feeQuestion");
  });

  it("is told to the model as the fee to charge, never as a fee they owe", () => {
    const block = renderReplyContext({
      now: NOW,
      quoted: { at: NOW, text: "Got it", topic: "feeQuestion", match: "Tuesday 7-a-side, Tue 13 Oct, 20:00" },
      recent: [],
      earlier: null,
    });
    expect(block).toContain("(about: the match fee to charge for Tuesday 7-a-side, Tue 13 Oct, 20:00)");
  });
});

describe("review of #339: the collector's acks", () => {
  for (const lang of ["en", "tr"] as const) {
    it(`${lang}: the confirm question carries no em or en dash`, () => {
      expect(buildFeeConfirmPrompt({ perPlayer: 8, headcount: 9, matchName: "Tuesday 7-a-side", wasTotal: false, lang })).not.toMatch(/[—–]/);
    });
    it(`${lang}: the release ack names the match's date, so two of the same activity can be told apart`, () => {
      const ack = buildFeeReleasedAck({ released: 9, fee: 8, matchName: "Tuesday 7-a-side", matchWhen: lang === "tr" ? "13 Ekim Salı" : "Tue 13 Oct", methods: ["card"], lang });
      expect(ack).toContain(lang === "tr" ? "13 Ekim Salı" : "Tue 13 Oct");
      expect(ack).not.toMatch(/[—–]/);
    });
  }
});

describe("review of #339 (M2): the roster check-in saves an answer only at the prompt's 80%", () => {
  it("in at 0.75 is unclear (it was saved at 0.7 and above)", async () => {
    const r = await classifyRosterReply("yes", {}, async () => json({ category: "in", confidence: 0.75 }));
    expect(r.category).toBe("unclear");
  });
  it("out at 0.79 is unclear", async () => {
    const r = await classifyRosterReply("I'm done", {}, async () => json({ category: "out", confidence: 0.79 }));
    expect(r.category).toBe("unclear");
  });
  it("in at 0.8 is in", async () => {
    const r = await classifyRosterReply("yes", {}, async () => json({ category: "in", confidence: 0.8 }));
    expect(r.category).toBe("in");
  });
});
