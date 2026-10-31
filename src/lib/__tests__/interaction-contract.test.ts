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
  REPLACEMENT_OUT_IS_TAG_FREE,
  messageTagsBot,
  messageAddressesBot,
  piMentionsBot,
  actionRequiresTag,
  isSelfAttendanceVerdict,
  registerForEntryRequiresTag,
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

// ══════════════════════════════════════════════════════════════════════
// REPLACEMENT_OUT_IS_TAG_FREE: the 2026-09-22 Mojib/Najib incident.
// ══════════════════════════════════════════════════════════════════════
//
// "Hi guys, Mojib is replacing Najib on the list. We can change", from
// an ordinary member, tagging nobody, 28 minutes before kickoff. Najib
// stayed in the squad he had left: wrong team sheet, wrong rating DM,
// and the fee about to be charged to the wrong man.
//
// The flag is set by a deterministic pairing over the roster
// (`pipeline/replacement.ts`) and by nothing else. These tests are about
// what the CONTRACT does once it is set.
describe("REPLACEMENT_OUT_IS_TAG_FREE", () => {
  it("is a boolean that can be reverted on its own line", () => {
    expect(typeof REPLACEMENT_OUT_IS_TAG_FREE).toBe("boolean");
    expect(REPLACEMENT_OUT_IS_TAG_FREE).toBe(true);
  });

  it("waives the tag on the leaving half, for ANY sender", () => {
    for (const sender of [{ senderIsAdmin: true }, { senderIsAdmin: false }, {}, undefined]) {
      expect(
        registerForEntryRequiresTag(
          { name: "Najib", action: "OUT", isStatedReplacement: true },
          sender,
        ),
      ).toBe(false);
    }
  });

  it("does NOT waive a BENCH, however the pairing is flagged", () => {
    for (const sender of [{ senderIsAdmin: true }, { senderIsAdmin: false }, undefined]) {
      expect(
        registerForEntryRequiresTag(
          { name: "Najib", action: "BENCH", isStatedReplacement: true },
          sender,
        ),
      ).toBe(true);
    }
  });

  it("leaves an ordinary third-party OUT exactly where it was", () => {
    for (const flag of [undefined, false] as const) {
      expect(
        registerForEntryRequiresTag(
          { name: "Najib", action: "OUT", isStatedReplacement: flag },
          { senderIsAdmin: false },
        ),
      ).toBe(true);
      expect(
        registerForEntryRequiresTag(
          { name: "Najib", action: "OUT", isStatedReplacement: flag },
          { senderIsAdmin: true },
        ),
      ).toBe(false);
    }
  });

  it("the incident's message no longer needs a tag at the message level", () => {
    const v: GateVerdict = {
      intent: "in",
      registerAttendance: null,
      registerFor: [
        { name: "Najib", action: "OUT", isStatedReplacement: true },
        { name: "Mojib", action: "IN" },
      ],
    };
    expect(actionRequiresTag(v, { senderIsAdmin: false })).toBe(false);
  });

  it("but the same message with an extra BENCH clause still does", () => {
    const v: GateVerdict = {
      intent: "in",
      registerAttendance: null,
      registerFor: [
        { name: "Najib", action: "OUT", isStatedReplacement: true },
        { name: "Mojib", action: "IN" },
        { name: "Amir", action: "BENCH" },
      ],
    };
    expect(actionRequiresTag(v, { senderIsAdmin: false })).toBe(true);
  });
});

describe("actionRequiresTag is EXACTLY the OR of the per-entry answers", () => {
  // The message-level answer must stay derivable from the per-entry one,
  // or the engine's "is anything at all permitted?" check and the gate
  // itself can disagree, and the split leaks. Enumerated over every
  // combination of up to three entries, for every seat.
  //
  // Enumerated over `isStatedReplacement` too since 2026-09-22: the
  // engine sets it on ONE entry and asks the per-claim question itself,
  // and its own seatbelt compares the two answers. A combination where
  // they could differ is the drift that seatbelt exists to catch.
  const ACTIONS = ["IN", "OUT", "BENCH"] as const;
  const FLAGS = [undefined, false, true] as const;
  const combos: GateRegisterForEntry[][] = [];
  for (const a of ACTIONS) {
    for (const fa of FLAGS) {
      combos.push([{ name: "A", action: a, isStatedReplacement: fa }]);
      for (const b of ACTIONS) {
        for (const fb of FLAGS) {
          combos.push([
            { name: "A", action: a, isStatedReplacement: fa },
            { name: "B", action: b, isStatedReplacement: fb },
          ]);
        }
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
