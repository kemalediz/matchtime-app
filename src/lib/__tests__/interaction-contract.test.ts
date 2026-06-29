/**
 * Unit tests for the INTERACTION CONTRACT gate (src/lib/interaction-contract.ts).
 *
 * Pure logic — no DB, no LLM. Two responsibilities:
 *
 *  1. messageTagsBot(msg): did this message tag @Match Time?
 *     PRIMARY  → msg.botMentioned === true (structured signal from the Pi).
 *     FALLBACK → text match for "match time" / "matchtime" / "@mt"
 *                (used ONLY when botMentioned is undefined — older Pi build).
 *
 *  2. actionRequiresTag(verdict, isSelfAttendance): is this verdict
 *     something MT should only DO/ANSWER when explicitly tagged?
 *     ACT WITHOUT A TAG only for a player's OWN clear self-attendance.
 *     Everything else action/answer-y requires a tag.
 *
 * "LLM extracts, code decides": these functions are the deterministic
 * code that decides whether to act on the LLM's classification.
 */
import { describe, it, expect } from "vitest";
import {
  messageTagsBot,
  actionRequiresTag,
  isSelfAttendanceVerdict,
  looksLikeHypotheticalOrPast,
  type TagInput,
  type GateVerdict,
} from "@/lib/interaction-contract";

describe("messageTagsBot — structured signal OR hardened text fallback", () => {
  it("returns true when botMentioned === true (regardless of body)", () => {
    expect(messageTagsBot({ body: "what are the teams?", botMentioned: true })).toBe(true);
  });

  it("HARDENED: botMentioned === false but body clearly tags the bot → true", () => {
    // The structured signal can regress (the @lid-vs-@c.us self-mention bug
    // that dropped a real admin add: "@Match Time Kieran and Rashad are IN").
    // The Pi rewrites a bot @-mention into the literal "@Match Time" in the
    // body, so an explicit text tag is a reliable second signal — don't let a
    // false botMentioned suppress it.
    expect(
      messageTagsBot({ body: "@Match Time Kieran and Rashad are IN", botMentioned: false }),
    ).toBe(true);
    // The looser "matchtime" word match also counts — same false-positive
    // tradeoff already accepted for the undefined-fallback path.
    expect(messageTagsBot({ body: "matchtime is broken lol", botMentioned: false })).toBe(true);
  });

  it("returns false when botMentioned === false and body does NOT tag the bot", () => {
    expect(messageTagsBot({ body: "what are the teams?", botMentioned: false })).toBe(false);
  });
});

describe("messageTagsBot — text fallback (undefined botMentioned, older Pi)", () => {
  it('matches "@Match Time what are the teams?"', () => {
    expect(messageTagsBot({ body: "@Match Time what are the teams?" })).toBe(true);
  });

  it('matches "match time generate the teams"', () => {
    expect(messageTagsBot({ body: "match time generate the teams" })).toBe(true);
  });

  it('matches "matchtime who is playing"', () => {
    expect(messageTagsBot({ body: "matchtime who is playing" })).toBe(true);
  });

  it('matches "@MT what are the teams"', () => {
    expect(messageTagsBot({ body: "@MT what are the teams" })).toBe(true);
  });

  it("does NOT match untagged banter", () => {
    expect(messageTagsBot({ body: "what are the teams?" })).toBe(false);
    expect(messageTagsBot({ body: "Martin and ayaaz on the same team is ridiculous" })).toBe(false);
  });

  it("does NOT match the word 'time' alone", () => {
    expect(messageTagsBot({ body: "what time is kickoff" })).toBe(false);
  });
});

describe("isSelfAttendanceVerdict — only the sender's own IN/OUT is tag-free", () => {
  it("plain self IN is self-attendance", () => {
    const v: GateVerdict = { intent: "in", registerAttendance: "IN", registerFor: null };
    expect(isSelfAttendanceVerdict(v)).toBe(true);
  });

  it("plain self OUT is self-attendance", () => {
    const v: GateVerdict = { intent: "out", registerAttendance: "OUT", registerFor: null };
    expect(isSelfAttendanceVerdict(v)).toBe(true);
  });

  it("self BENCH self-declaration is self-attendance", () => {
    const v: GateVerdict = { intent: "in", registerAttendance: "BENCH", registerFor: null };
    expect(isSelfAttendanceVerdict(v)).toBe(true);
  });

  it("registerFor on someone else is NOT self-attendance", () => {
    const v: GateVerdict = {
      intent: "out",
      registerAttendance: null,
      registerFor: [{ name: "Pete", action: "BENCH" }],
    };
    expect(isSelfAttendanceVerdict(v)).toBe(false);
  });

  it("an IN verdict that ALSO moves another player is NOT pure self-attendance", () => {
    const v: GateVerdict = {
      intent: "in",
      registerAttendance: "IN",
      registerFor: [{ name: "Aydin", action: "IN" }],
    };
    expect(isSelfAttendanceVerdict(v)).toBe(false);
  });

  it("a question is NOT self-attendance", () => {
    const v: GateVerdict = { intent: "question", registerAttendance: null, registerFor: null };
    expect(isSelfAttendanceVerdict(v)).toBe(false);
  });
});

describe("actionRequiresTag — the act-without-tag vs require-tag split", () => {
  const selfIn: GateVerdict = { intent: "in", registerAttendance: "IN", registerFor: null };
  const selfOut: GateVerdict = { intent: "out", registerAttendance: "OUT", registerFor: null };

  it("self IN does NOT require a tag", () => {
    expect(actionRequiresTag(selfIn)).toBe(false);
  });

  it("self OUT does NOT require a tag", () => {
    expect(actionRequiresTag(selfOut)).toBe(false);
  });

  it("a question REQUIRES a tag", () => {
    expect(
      actionRequiresTag({ intent: "question", registerAttendance: null, registerFor: null }),
    ).toBe(true);
  });

  it("generate_teams_request REQUIRES a tag", () => {
    expect(
      actionRequiresTag({
        intent: "generate_teams_request",
        registerAttendance: null,
        registerFor: null,
      }),
    ).toBe(true);
  });

  it("show_teams_request REQUIRES a tag", () => {
    expect(
      actionRequiresTag({
        intent: "show_teams_request",
        registerAttendance: null,
        registerFor: null,
      }),
    ).toBe(true);
  });

  it("moving/benching ANOTHER player (registerFor) REQUIRES a tag", () => {
    expect(
      actionRequiresTag({
        intent: "out",
        registerAttendance: null,
        registerFor: [{ name: "Pete", action: "BENCH" }],
      }),
    ).toBe(true);
  });

  it("reminder_request REQUIRES a tag", () => {
    expect(
      actionRequiresTag({
        intent: "reminder_request",
        registerAttendance: null,
        registerFor: null,
      }),
    ).toBe(true);
  });

  it("noise never requires a tag (there is no action to gate)", () => {
    expect(
      actionRequiresTag({ intent: "noise", registerAttendance: null, registerFor: null }),
    ).toBe(false);
  });
});

describe("looksLikeHypotheticalOrPast — deterministic self-attendance seatbelt", () => {
  it('flags "If I was in the team it won\'t be ruined"', () => {
    expect(looksLikeHypotheticalOrPast("If I was in the team it won't be ruined")).toBe(true);
  });

  it('flags "I would have been in"', () => {
    expect(looksLikeHypotheticalOrPast("I would have been in")).toBe(true);
  });

  it('flags "I would\'ve been in"', () => {
    expect(looksLikeHypotheticalOrPast("I would've been in")).toBe(true);
  });

  it('flags past tense "I was in last week"', () => {
    expect(looksLikeHypotheticalOrPast("I was in last week")).toBe(true);
  });

  it('does NOT flag a plain present-tense "I\'m in"', () => {
    expect(looksLikeHypotheticalOrPast("I'm in")).toBe(false);
    expect(looksLikeHypotheticalOrPast("in")).toBe(false);
    expect(looksLikeHypotheticalOrPast("count me in")).toBe(false);
  });

  it('does NOT flag "I am in for tonight"', () => {
    expect(looksLikeHypotheticalOrPast("I am in for tonight")).toBe(false);
  });
});

// Type smoke — TagInput accepts the InboundMessage subset we feed it.
const _t: TagInput = { body: "x", botMentioned: undefined };
void _t;
