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
  ADMIN_REPORTED_OUT_IS_TAG_FREE,
  messageTagsBot,
  messageMentionsBotExplicitly,
  actionRequiresTag,
  isSelfAttendanceVerdict,
  registerForEntryRequiresTag,
  looksLikeHypotheticalOrPast,
  offerIsAboutSomeoneElse,
  type TagInput,
  type GateVerdict,
  type GateRegisterForEntry,
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

  it("moving/benching ANOTHER player (registerFor BENCH) REQUIRES a tag", () => {
    expect(
      actionRequiresTag({
        intent: "out",
        registerAttendance: null,
        registerFor: [{ name: "Pete", action: "BENCH" }],
      }),
    ).toBe(true);
  });

  it("dropping ANOTHER player (registerFor OUT) REQUIRES a tag", () => {
    expect(
      actionRequiresTag({
        intent: "out",
        registerAttendance: null,
        registerFor: [{ name: "Ibrahim", action: "OUT" }],
      }),
    ).toBe(true);
  });

  // ── Third-party ADDITIONS are now tag-free (the behaviour change) ──────
  // Registering a NAMED other player as IN from natural group chat ("Add
  // Rashad please", "my mate Kieran's in") no longer needs an @Match Time
  // tag. Dropping/benching/swapping someone else still does.
  it("an IN-only third-party add does NOT require a tag (single name)", () => {
    expect(
      actionRequiresTag({
        intent: "in",
        registerAttendance: null,
        registerFor: [{ name: "Rashad", action: "IN" }],
      }),
    ).toBe(false);
  });

  it("an IN-only third-party add does NOT require a tag (multiple names)", () => {
    expect(
      actionRequiresTag({
        intent: "in",
        registerAttendance: null,
        registerFor: [
          { name: "Mike", action: "IN" },
          { name: "Steve", action: "IN" },
        ],
      }),
    ).toBe(false);
  });

  it("self IN that ALSO adds a friend (IN-only registerFor) does NOT require a tag", () => {
    expect(
      actionRequiresTag({
        intent: "in",
        registerAttendance: "IN",
        registerFor: [{ name: "Ahmet", action: "IN" }],
      }),
    ).toBe(false);
  });

  it("a SWAP (registerFor with both IN and OUT) STILL requires a tag", () => {
    // "Elnur out, Izzet in" — removing another player is the gated half.
    expect(
      actionRequiresTag({
        intent: "out",
        registerAttendance: null,
        registerFor: [
          { name: "Elnur", action: "OUT" },
          { name: "Izzet", action: "IN" },
        ],
      }),
    ).toBe(true);
  });

  it("an add MIXED with a bench of another player STILL requires a tag", () => {
    expect(
      actionRequiresTag({
        intent: "in",
        registerAttendance: null,
        registerFor: [
          { name: "Rashad", action: "IN" },
          { name: "Pete", action: "BENCH" },
        ],
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

// ══════════════════════════════════════════════════════════════════════
// ADMIN_REPORTED_OUT_IS_TAG_FREE — the 2026-09-07 Shahrokh incident.
//
// The owner posted, in the live group, the day before the match:
//
//     "@Shahrokh🐔 Sutton Football Club is out due to unforeseen issue
//      at work"
//
// Shahrokh was CONFIRMED at position 10 and MatchTime did nothing,
// because the message carries a third-party OUT and no @Match Time tag.
// The squad read 13/14 with a player in it who was not coming, and Kemal
// corrected the row by hand.
//
// ⚠️ THE TRAP IN THE WORDING, because it confused everyone who looked at
// it: that message DOES contain an "@" mention. It mentions the PLAYER.
// "Tagged" in this codebase means THE BOT was mentioned
// (`messageTagsBot`), and nothing in that sentence mentions the bot.
// A player @-mention is not a tag and never has been.
// ══════════════════════════════════════════════════════════════════════
describe("actionRequiresTag — an ADMIN reporting another player OUT", () => {
  const admin = { senderIsAdmin: true };
  const player = { senderIsAdmin: false };

  const dropShahrokh: GateVerdict = {
    intent: "out",
    registerAttendance: null,
    registerFor: [{ name: "Shahrokh", action: "OUT" }],
  };

  it("THE INCIDENT: an admin's third-party OUT is tag-free", () => {
    expect(actionRequiresTag(dropShahrokh, admin)).toBe(false);
  });

  it("the SAME verdict from a non-admin STILL requires a tag", () => {
    // The reason the old rule existed, and it is unchanged for everyone
    // outside the OWNER/ADMIN seats: otherwise anyone in the group
    // removes a player by typing a sentence.
    expect(actionRequiresTag(dropShahrokh, player)).toBe(true);
  });

  it("no options at all is treated as NOT an admin (fail closed)", () => {
    expect(actionRequiresTag(dropShahrokh)).toBe(true);
    expect(actionRequiresTag(dropShahrokh, {})).toBe(true);
  });

  it("an admin's SWAP (OUT + IN) is tag-free — both halves already are", () => {
    // "Shahrokh is out, Amir can take his spot". The OUT half is waived
    // by this rule and the IN half has been tag-free for EVERYONE since
    // the third-party-add change, so the pair adds no capability neither
    // half has on its own. Refusing it would lose the drop in the
    // commonest real phrasing of the incident.
    expect(
      actionRequiresTag(
        {
          intent: "out",
          registerAttendance: null,
          registerFor: [
            { name: "Shahrokh", action: "OUT" },
            { name: "Amir", action: "IN" },
          ],
        },
        admin,
      ),
    ).toBe(false);
  });

  it("a BENCH from an admin STILL requires a tag (the waiver is OUT-only)", () => {
    expect(
      actionRequiresTag(
        {
          intent: "out",
          registerAttendance: null,
          registerFor: [{ name: "Pete", action: "BENCH" }],
        },
        admin,
      ),
    ).toBe(true);
  });

  it("an admin's OUT mixed with a BENCH STILL requires a tag", () => {
    expect(
      actionRequiresTag(
        {
          intent: "out",
          registerAttendance: null,
          registerFor: [
            { name: "Shahrokh", action: "OUT" },
            { name: "Pete", action: "BENCH" },
          ],
        },
        admin,
      ),
    ).toBe(true);
  });

  it("being an admin does NOT waive the tag on anything else", () => {
    for (const intent of [
      "question",
      "generate_teams_request",
      "show_teams_request",
      "reminder_request",
      "bulk_payment_credit",
      "bring_guests_vague",
    ]) {
      expect(
        actionRequiresTag({ intent, registerAttendance: null, registerFor: null }, admin),
        `${intent} must still require a tag for an admin`,
      ).toBe(true);
    }
  });

  it("an admin's third-party IN is unchanged (already tag-free)", () => {
    expect(
      actionRequiresTag(
        { intent: "in", registerAttendance: null, registerFor: [{ name: "Rashad", action: "IN" }] },
        admin,
      ),
    ).toBe(false);
  });

  it("an admin's OWN out is unchanged (already tag-free)", () => {
    expect(
      actionRequiresTag({ intent: "out", registerAttendance: "OUT", registerFor: null }, admin),
    ).toBe(false);
  });

  it("the constant is a boolean and is ON", () => {
    expect(typeof ADMIN_REPORTED_OUT_IS_TAG_FREE).toBe("boolean");
    expect(ADMIN_REPORTED_OUT_IS_TAG_FREE).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 2026-09-08 · THE DAVID INCIDENT — the gate was ALL-OR-NOTHING PER
// MESSAGE, so one refused clause threw away every other one.
//
// Kemal posted to the live Sutton FC group, untagged:
//
//     "David is OUT voluntarily to switch to 5aside.
//
//      Either @Mojib Jalali or @Najib can be in the main squad and the
//      other can go to bench"
//
// `ADMIN_REPORTED_OUT_IS_TAG_FREE` waives the tag for an admin only when
// every entry is IN or OUT. The bench clause failed that `every`, the
// whole message was refused, and David stayed in a squad he had just
// left. The owner corrected it by hand, twice, on match day.
//
// THE BENCH EXCLUSION IS NOT THE BUG and is not being reversed: a demote
// still needs a tag from everybody, the owner included. The bug is the
// GRANULARITY. One refused entry must not silently discard the others,
// so the question "does this need a tag?" is asked PER ENTRY, and
// `actionRequiresTag` is exactly the OR of the per-entry answers.
// ══════════════════════════════════════════════════════════════════════
describe("registerForEntryRequiresTag — the gate, asked one entry at a time", () => {
  const admin = { senderIsAdmin: true };
  const player = { senderIsAdmin: false };

  const IN = { name: "Amir", action: "IN" } as const;
  const OUT = { name: "David", action: "OUT" } as const;
  const BENCH = { name: "Mojib", action: "BENCH" } as const;

  it("a third-party IN is tag-free for anyone (unchanged)", () => {
    expect(registerForEntryRequiresTag(IN, admin)).toBe(false);
    expect(registerForEntryRequiresTag(IN, player)).toBe(false);
    expect(registerForEntryRequiresTag(IN)).toBe(false);
  });

  it("a third-party OUT is tag-free for an ADMIN only", () => {
    expect(registerForEntryRequiresTag(OUT, admin)).toBe(false);
    expect(registerForEntryRequiresTag(OUT, player)).toBe(true);
    expect(registerForEntryRequiresTag(OUT, {})).toBe(true);
    expect(registerForEntryRequiresTag(OUT)).toBe(true);
  });

  it("a BENCH requires a tag from EVERYONE, the owner included", () => {
    expect(registerForEntryRequiresTag(BENCH, admin)).toBe(true);
    expect(registerForEntryRequiresTag(BENCH, player)).toBe(true);
    expect(registerForEntryRequiresTag(BENCH)).toBe(true);
  });

  it("THE INCIDENT, split: the OUT is free and the BENCH is refused", () => {
    // The whole point. The same message, two answers, and the OUT half
    // no longer dies with the BENCH half.
    expect(registerForEntryRequiresTag(OUT, admin)).toBe(false);
    expect(registerForEntryRequiresTag(BENCH, admin)).toBe(true);
  });

  it("the entry gate does not read the entry's NAME", () => {
    // Nothing here may depend on who was named: identity is the
    // roster's business and it is resolved later, in the engine.
    for (const name of ["David", "", "  ", "@Mojib Jalali", "07700900123"]) {
      expect(registerForEntryRequiresTag({ name, action: "OUT" }, admin)).toBe(false);
      expect(registerForEntryRequiresTag({ name, action: "BENCH" }, admin)).toBe(true);
    }
  });
});

describe("actionRequiresTag is EXACTLY the OR of the per-entry answers", () => {
  // The message-level answer must stay derivable from the per-entry one,
  // or the engine's "is anything at all permitted?" check and the gate
  // itself can disagree, and the split leaks. Enumerated over every
  // combination of up to three entries, for every seat.
  const ACTIONS = ["IN", "OUT", "BENCH"] as const;
  const combos: GateRegisterForEntry[][] = [];
  for (const a of ACTIONS) {
    combos.push([{ name: "A", action: a }]);
    for (const b of ACTIONS) {
      combos.push([
        { name: "A", action: a },
        { name: "B", action: b },
      ]);
      for (const c of ACTIONS) {
        combos.push([
          { name: "A", action: a },
          { name: "B", action: b },
          { name: "C", action: c },
        ]);
      }
    }
  }

  it("agrees on every combination, for an admin, a member and no sender", () => {
    for (const sender of [{ senderIsAdmin: true }, { senderIsAdmin: false }, {}, undefined]) {
      for (const entries of combos) {
        const v: GateVerdict = { intent: "out", registerAttendance: null, registerFor: entries };
        expect(
          actionRequiresTag(v, sender),
          `${JSON.stringify(entries)} for ${JSON.stringify(sender)}`,
        ).toBe(entries.some((e) => registerForEntryRequiresTag(e, sender)));
      }
    }
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

describe("offerIsAboutSomeoneElse — third-party-subject seatbelt", () => {
  // The production regression (Amir, 2026-08-30): the offer is about his
  // BROTHER, and Amir never says he is playing.
  it("flags the production message, @mention and all", () => {
    expect(offerIsAboutSomeoneElse("@Kemal Ediz my brother can play if needed")).toBe(true);
  });

  it("flags other third-party-subject offers", () => {
    expect(offerIsAboutSomeoneElse("my brother can play if needed")).toBe(true);
    expect(offerIsAboutSomeoneElse("my mate could fill in if you're short")).toBe(true);
    expect(offerIsAboutSomeoneElse("My cousin is up for it")).toBe(true);
    expect(offerIsAboutSomeoneElse("my brother Shahrokh can play")).toBe(true);
    expect(offerIsAboutSomeoneElse("Dan's brother can play if you need one")).toBe(true);
    expect(offerIsAboutSomeoneElse("his mate wants a game")).toBe(true);
  });

  // MIXED — the sender says they are playing too. Never strip these.
  it("does NOT flag a mixed offer that includes the sender", () => {
    expect(offerIsAboutSomeoneElse("me and my brother are both in")).toBe(false);
    expect(offerIsAboutSomeoneElse("my brother and I are in")).toBe(false);
    expect(offerIsAboutSomeoneElse("my mate and I can fill in if you're short")).toBe(false);
    expect(offerIsAboutSomeoneElse("my brother and me are playing")).toBe(false);
    expect(offerIsAboutSomeoneElse("put us both down, my brother's coming")).toBe(false);
  });

  // The third-party phrase must be the SUBJECT of the message. A self
  // statement that merely MENTIONS a mate is a legitimate self write.
  it("does NOT flag a self statement that only mentions a third party later", () => {
    expect(offerIsAboutSomeoneElse("in, my mate's coming too")).toBe(false);
    expect(offerIsAboutSomeoneElse("count me in and my brother wants to play")).toBe(false);
    expect(offerIsAboutSomeoneElse("I'll be the 14th if my mate can't")).toBe(false);
  });

  it("does NOT flag plain self attendance", () => {
    expect(offerIsAboutSomeoneElse("in")).toBe(false);
    expect(offerIsAboutSomeoneElse("I'm in")).toBe(false);
    expect(offerIsAboutSomeoneElse("I'll be the 14th if you're short")).toBe(false);
    expect(offerIsAboutSomeoneElse("ping me if you need one more")).toBe(false);
    expect(offerIsAboutSomeoneElse("happy to fill in if anyone drops")).toBe(false);
    expect(offerIsAboutSomeoneElse("available as a back-up tonight")).toBe(false);
  });

  it("does NOT flag possessives that are not people", () => {
    expect(offerIsAboutSomeoneElse("my back is fine, in")).toBe(false);
    expect(offerIsAboutSomeoneElse("my car broke down")).toBe(false);
  });

  it("handles empty / junk input", () => {
    expect(offerIsAboutSomeoneElse("")).toBe(false);
    expect(offerIsAboutSomeoneElse("   ")).toBe(false);
  });
});

// Type smoke — TagInput accepts the InboundMessage subset we feed it.
const _t: TagInput = { body: "x", botMentioned: undefined };
void _t;

// ── THE 2026-09-10 NEAR-MISS: "tagged" is weaker than it reads ────────
//
// `messageTagsBot` counts the bare word "matchtime", anywhere in a
// message, as a tag. That is deliberate and it is right for what it
// gates — the 2026-06-29 hardening exists because a real admin command
// was dropped when the Pi's structured signal regressed, and dropping a
// real action is the worse error for an ANSWER.
//
// It is NOT right in front of a mass DM. On 2026-09-10 Kemal wrote
// "…the link from Matchtime DM'ed to you…" to his players — a sentence
// ABOUT MatchTime, addressed to the group — and `messageTagsBot` calls
// it tagged. `messageMentionsBotExplicitly` is the stricter question the
// bulk-DM commands ask instead: was the bot ADDRESSED, with an @, or did
// the Pi see a real mention?
describe("messageMentionsBotExplicitly — the stricter test for a bulk-DM command", () => {
  const incident =
    "please do not forget to rate the players via the link from Matchtime DM'ed to you. " +
    "the more accurate ratings, the more balanced teams next time";

  it("THE INCIDENT SENTENCE counts as tagged, and is NOT an explicit mention", () => {
    expect(messageTagsBot({ body: incident })).toBe(true);
    expect(messageMentionsBotExplicitly({ body: incident })).toBe(false);
  });

  it("trusts the Pi's structured mention signal", () => {
    expect(messageMentionsBotExplicitly({ body: "send everyone their stats", botMentioned: true })).toBe(true);
  });

  it("accepts the literal @-tag the Pi writes into the body", () => {
    expect(messageMentionsBotExplicitly({ body: "@Match Time send everyone their stats" })).toBe(true);
    expect(messageMentionsBotExplicitly({ body: "@MatchTime send everyone their stats" })).toBe(true);
    expect(messageMentionsBotExplicitly({ body: "@mt send everyone their stats" })).toBe(true);
  });

  it("refuses the bare word, wherever it appears", () => {
    expect(messageMentionsBotExplicitly({ body: "matchtime is being weird today" })).toBe(false);
    expect(messageMentionsBotExplicitly({ body: "match time lads, get your kit on" })).toBe(false);
    expect(messageMentionsBotExplicitly({ body: "" })).toBe(false);
  });

  it("a FALSE structured signal does not suppress a real @-tag in the body", () => {
    // The 2026-06-29 hardening, kept: the @lid self-mention bug reported
    // botMentioned:false for a genuinely tagged admin command.
    expect(
      messageMentionsBotExplicitly({ body: "@Match Time send everyone their stats", botMentioned: false }),
    ).toBe(true);
  });
});
