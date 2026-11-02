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
 *  2. actionRequiresTag(verdict): is this verdict something MT should
 *     only DO/ANSWER when explicitly tagged? Attendance (the sender's own
 *     or anybody else's) never needs a tag (2026-11-02). Everything else
 *     action/answer-y requires one.
 *
 * "LLM extracts, code decides": these functions are the deterministic
 * code that decides whether to act on the LLM's classification.
 */
import { describe, it, expect } from "vitest";
import {
  messageTagsBot,
  messageAddressesBot,
  piMentionsBot,
  actionRequiresTag,
  isAttendanceVerdict,
  type TagInput,
  type GateVerdict,
  type GateRegisterForEntry,
} from "@/lib/interaction-contract";

describe("the tag is FACTS only (2026-10-30, review of #476)", () => {
  it("messageTagsBot: the Pi's mention flag or a reply to MatchTime", () => {
    expect(messageTagsBot({ body: "what are the teams?", botMentioned: true })).toBe(true);
    expect(messageTagsBot({ body: "Bench?", quotedFromMatchTime: true })).toBe(true);
    expect(messageTagsBot({ body: "MatchTime who runs this club?" })).toBe(false);
  });

  // Kemal, 2026-10-31: in the players' group MatchTime answers only on a
  // real tag, the rule HQ got in #482.
  it("messageAddressesBot: an answer opens on the Pi's real mention flag only", () => {
    expect(messageAddressesBot({ body: "x", botMentioned: true })).toBe(true);
    expect(messageAddressesBot({ body: "x", botMentioned: true, quotedFromMatchTime: true })).toBe(true);
    expect(messageAddressesBot({ body: "x" })).toBe(false);
  });

  it("messageAddressesBot: a WhatsApp reply to MatchTime without the tag is not asked of it", () => {
    expect(messageAddressesBot({ body: "Bench? We do bench now?", quotedFromMatchTime: true })).toBe(false);
    expect(messageAddressesBot({ body: "Bench?", botMentioned: false, quotedFromMatchTime: true })).toBe(false);
  });

  it("messageAddressesBot: the router's own to_bot reading is not an input any more", () => {
    // A stray field from an old caller must not open the gate either.
    const legacy = { body: "MatchTime who runs this club?", routerAddressed: true } as unknown as TagInput;
    expect(messageAddressesBot(legacy)).toBe(false);
  });

  it("piMentionsBot: the Pi's mention flag alone; the bot's name in the text is not it", () => {
    expect(piMentionsBot({ body: "x", botMentioned: true })).toBe(true);
    expect(piMentionsBot({ body: "@Match Time send everyone their stats" })).toBe(false);
    expect(piMentionsBot({ body: "x", quotedFromMatchTime: true })).toBe(false);
  });

  it("the bot's name in the text is a tag for none of them", () => {
    for (const body of ["@Match Time what are the teams?", "matchtime is broken lol", "@MT what are the teams"]) {
      expect(messageTagsBot({ body })).toBe(false);
      expect(messageAddressesBot({ body })).toBe(false);
      expect(piMentionsBot({ body })).toBe(false);
    }
  });
});

describe("messageTagsBot: a WhatsApp reply to MatchTime's own message", () => {
  it("a reply quoting MatchTime's own message is a tag", () => {
    expect(messageTagsBot({ body: "Bench? We do bench now?", quotedFromMatchTime: true })).toBe(true);
    expect(messageTagsBot({ body: "Bench? We do bench now?", botMentioned: false, quotedFromMatchTime: true })).toBe(true);
  });

  it("a reply quoting another player's message is not", () => {
    expect(messageTagsBot({ body: "Bench? We do bench now?", botMentioned: false, quotedFromMatchTime: false })).toBe(false);
    expect(messageTagsBot({ body: "Bench? We do bench now?" })).toBe(false);
  });

  it("the stricter bulk-DM test still asks for an explicit @, a reply is not one", () => {
    expect(piMentionsBot({ body: "send everyone their stats", quotedFromMatchTime: true } as never)).toBe(false);
  });
});

describe("isAttendanceVerdict: the sender's own place or anybody else's", () => {
  it("plain self IN, OUT and BENCH are attendance", () => {
    expect(isAttendanceVerdict({ intent: "in", registerAttendance: "IN", registerFor: null })).toBe(true);
    expect(isAttendanceVerdict({ intent: "out", registerAttendance: "OUT", registerFor: null })).toBe(true);
    expect(isAttendanceVerdict({ intent: "in", registerAttendance: "BENCH", registerFor: null })).toBe(true);
  });

  it("adding, dropping or benching someone else is attendance too", () => {
    for (const action of ["IN", "OUT", "BENCH"] as const) {
      expect(
        isAttendanceVerdict({ intent: "out", registerAttendance: null, registerFor: [{ name: "Pete", action }] }),
      ).toBe(true);
    }
  });

  it("a question is NOT attendance", () => {
    expect(isAttendanceVerdict({ intent: "question", registerAttendance: null, registerFor: null })).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// ATTENDANCE NEVER NEEDS A TAG (Kemal, 2026-11-02).
//
// Sutton FC, 2 Nov 2026: a player, Zair, posted untagged "Sorry, Ismayil
// is out". The extractor read a third-party OUT and the contract refused
// it for want of a tag, so Ismayil stayed on the list. Until then a
// third-party OUT or BENCH needed a tag, with exceptions for an admin's
// OUT (2026-09-07) and the leaving half of a stated replacement
// (2026-09-22). Now none does, from anybody. Who may bench whom is the
// engine's admin-only bench guard, not this gate.
// ══════════════════════════════════════════════════════════════════════
describe("actionRequiresTag: attendance is free, everything else needs a tag", () => {
  const verdict = (registerFor: GateRegisterForEntry[] | null, intent = "out"): GateVerdict => ({
    intent,
    registerAttendance: null,
    registerFor,
  });

  it("self IN and self OUT do NOT require a tag", () => {
    expect(actionRequiresTag({ intent: "in", registerAttendance: "IN", registerFor: null })).toBe(false);
    expect(actionRequiresTag({ intent: "out", registerAttendance: "OUT", registerFor: null })).toBe(false);
  });

  it("THE ZAIR CASE: a player's untagged \"Ismayil is out\" does NOT require a tag", () => {
    expect(actionRequiresTag(verdict([{ name: "Ismayil", action: "OUT" }]))).toBe(false);
  });

  it("benching another player does NOT require a tag", () => {
    expect(actionRequiresTag(verdict([{ name: "Ismayil", action: "BENCH" }]))).toBe(false);
  });

  it("a third-party add does NOT require a tag (one name or several)", () => {
    expect(actionRequiresTag(verdict([{ name: "Rashad", action: "IN" }], "in"))).toBe(false);
    expect(
      actionRequiresTag(verdict([{ name: "Mike", action: "IN" }, { name: "Steve", action: "IN" }], "in")),
    ).toBe(false);
  });

  it("a replacement or swap (OUT + IN) does NOT require a tag", () => {
    expect(
      actionRequiresTag(verdict([{ name: "Elnur", action: "OUT" }, { name: "Izzet", action: "IN" }])),
    ).toBe(false);
  });

  it("a mixed message (self IN, an add, a drop and a bench) does NOT require a tag", () => {
    expect(
      actionRequiresTag({
        intent: "in",
        registerAttendance: "IN",
        registerFor: [
          { name: "Rashad", action: "IN" },
          { name: "David", action: "OUT" },
          { name: "Pete", action: "BENCH" },
        ],
      }),
    ).toBe(false);
  });

  it("questions, team ops and reminders still REQUIRE a tag", () => {
    for (const intent of [
      "question",
      "generate_teams_request",
      "show_teams_request",
      "reminder_request",
      "bulk_payment_credit",
    ]) {
      expect(actionRequiresTag({ intent, registerAttendance: null, registerFor: null })).toBe(true);
    }
  });

  it("noise never requires a tag (there is no action to gate)", () => {
    expect(actionRequiresTag({ intent: "noise", registerAttendance: null, registerFor: null })).toBe(false);
  });
});

describe("piMentionsBot: the strict fact a bulk-DM command needs (replaces messageMentionsBotExplicitly)", () => {
  const incident =
    "please do not forget to rate the players via the link from Matchtime DM'ed to you. " +
    "the more accurate ratings, the more balanced teams next time";

  it("THE INCIDENT SENTENCE is neither a tag nor a mention", () => {
    expect(messageTagsBot({ body: incident })).toBe(false);
    expect(piMentionsBot({ body: incident } as never)).toBe(false);
  });

  it("is the Pi's mention flag, and only that", () => {
    expect(piMentionsBot({ botMentioned: true })).toBe(true);
    expect(piMentionsBot({ botMentioned: false })).toBe(false);
    expect(piMentionsBot({})).toBe(false);
  });
});
