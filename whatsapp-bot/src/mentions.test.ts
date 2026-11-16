/**
 * RED-first spec: the Pi must stop pasting an UNVERIFIED name into the
 * message body.
 *
 * ── The defect (measured, 2026-09-08) ────────────────────────────────
 * `enrichInbound` resolved every @-mention through
 * `client.getContactById(jid)` and pasted `pushname || name || shortName`
 * straight into the text the analyzer reads. Two real messages from the
 * live Sutton FC group:
 *
 *   typed:  "@Shahrokh🐔 Sutton Football Club is out due to unforeseen …"
 *   stored: "@DÇ  is out due to unforeseen issue at work"
 *
 *   typed:  "@David David 67 and @~Najib out"
 *   stored: "@割::::.̸̢̤̋̃̓̉͗̏̾̃̌̚͘̕.̵͆͂ and @Najib out"
 *
 * The contact lookup was NOT corrupt and did NOT return the wrong person.
 * `"割::::.̸̢̤̋̃̓̉͗̏̾̃̌̚͘̕.̵͆͂"` appears 13 times in
 * `AnalyzedMessage.authorName` for this org — it is David's OWN WhatsApp
 * pushname, and an admin has already curated `UserAlias["割::::.."] →
 * David`. WhatsApp renders an @-mention to the SENDER using the SENDER's
 * address book ("David David 67"); the bot only ever sees the mentioned
 * person's self-chosen profile name. When those two agree the substitution
 * looks fine ("@Mojib Jalali", "@Najib"); when they do not, MatchTime is
 * handed a name nobody in the club uses — and it is a string the mentioned
 * person controls.
 *
 * ── What this file pins ──────────────────────────────────────────────
 * The Pi rewrites EXACTLY ONE thing: a mention of the BOT ITSELF, to the
 * literal "@Match Time" — an identity only the Pi knows and a name only we
 * choose. Every other mention is left as its raw "@<digits>" token and the
 * contact's display name travels as STRUCTURED, clearly-untrusted data
 * (`mentionNames`) for the server to check against the org roster.
 *
 * Leaving "@<digits>" is strictly better than inserting a wrong name: the
 * engine's "raw digits are never a name" refusal is correct behaviour, and
 * it should fire on an honest unknown rather than on fabricated text.
 */
import { describe, it, expect } from "vitest";
import {
  BOT_MENTION_TEXT,
  contactIsBot,
  botIdentitySet,
  mentionDigits,
  sanitiseMentionName,
  rewriteMentions,
} from "./mentions.js";

const DAVID_PUSHNAME = "割::::.̸̢̤̋̃̓̉͗̏̾̃̌̚͘̕.̵͆͂";
const BOT_LID = "111222333444555@lid";
const BOT_WID = "447700900999@c.us";

describe("mentionDigits", () => {
  it("strips the @lid / @c.us suffix and any punctuation", () => {
    expect(mentionDigits("158055467598020@lid")).toBe("158055467598020");
    expect(mentionDigits("447700900123@c.us")).toBe("447700900123");
    expect(mentionDigits("+447700900123@c.us")).toBe("447700900123");
  });
  it("is total for rubbish input", () => {
    expect(mentionDigits(undefined)).toBe("");
    expect(mentionDigits(42)).toBe("");
    expect(mentionDigits("@lid")).toBe("");
  });
});

describe("sanitiseMentionName", () => {
  it("rejects a name with no letters at all", () => {
    expect(sanitiseMentionName("::::..")).toBeNull();
    expect(sanitiseMentionName("...")).toBeNull();
    expect(sanitiseMentionName("   ")).toBeNull();
  });

  it("rejects a raw phone / lid masquerading as a name", () => {
    expect(sanitiseMentionName("158055467598020")).toBeNull();
    expect(sanitiseMentionName("+44 7700 900123")).toBeNull();
    expect(sanitiseMentionName("158055467598020@lid")).toBeNull();
  });

  it("rejects anything that is not a usable string", () => {
    expect(sanitiseMentionName(null)).toBeNull();
    expect(sanitiseMentionName(undefined)).toBeNull();
    expect(sanitiseMentionName(123)).toBeNull();
    expect(sanitiseMentionName({})).toBeNull();
  });

  it("strips combining-mark graffiti but keeps the base characters", () => {
    // David's real pushname. What survives, "割::::..", is EXACTLY the key
    // the admin-curated UserAlias row is stored under, so the server can
    // still recover "David" from it. It is a LOOKUP KEY, never body text.
    expect(sanitiseMentionName(DAVID_PUSHNAME)).toBe("割::::..");
  });

  it("keeps an emoji name usable by dropping the emoji, not the name", () => {
    expect(sanitiseMentionName("Shahrokh🐔 Sutton Football Club")).toBe(
      "Shahrokh Sutton Football Club",
    );
    expect(sanitiseMentionName("🐔")).toBeNull();
  });

  it("keeps accents intact (this squad is Turkish, Azerbaijani and South Asian)", () => {
    expect(sanitiseMentionName("Aydın Kocahal")).toBe("Aydın Kocahal");
    expect(sanitiseMentionName("DÇ")).toBe("DÇ");
  });

  it("strips WhatsApp's ~ prefix for an unsaved contact", () => {
    expect(sanitiseMentionName("~Najib")).toBe("Najib");
  });
});

describe("rewriteMentions — the bot's own mention is the ONLY substitution", () => {
  const botIdentities = [BOT_WID, BOT_LID];

  it("rewrites a self-mention to the literal @Match Time", () => {
    const out = rewriteMentions({
      body: "@111222333444555 generate the teams",
      contacts: [{ jid: BOT_LID, isMe: true, name: "Match Time" }],
      botIdentities,
    });
    expect(out.body).toBe("@Match Time generate the teams");
    expect(out.botMentioned).toBe(true);
    // The bot is not a player — it must never appear as a mention candidate.
    expect(out.mentionNames).toEqual([]);
  });

  it("rewrites a self-mention by JID even when the contact could not be fetched", () => {
    const out = rewriteMentions({
      body: "@111222333444555 how many so far?",
      contacts: [{ jid: BOT_LID }], // isMe unknown — getContactById threw
      botIdentities,
    });
    expect(out.body).toBe("@Match Time how many so far?");
    expect(out.botMentioned).toBe(true);
  });

  it("REGRESSION: a garbage pushname is never pasted into the body", () => {
    const out = rewriteMentions({
      body: "@233452997767322 and @447700900321 out",
      contacts: [
        { jid: "233452997767322@lid", isMe: false, name: DAVID_PUSHNAME },
        { jid: "447700900321@c.us", isMe: false, name: "Najib" },
      ],
      botIdentities,
    });
    expect(out.body).toBe("@233452997767322 and @447700900321 out");
    expect(out.body).not.toContain("割");
    expect(out.botMentioned).toBe(false);
    // …but the names DO travel, as structured data for the server to check.
    expect(out.mentionNames).toEqual([
      { jid: "233452997767322@lid", name: "割::::.." },
      { jid: "447700900321@c.us", name: "Najib" },
    ]);
  });

  it("REGRESSION: the Shahrokh drop keeps its raw token", () => {
    const out = rewriteMentions({
      body: "@158055467598020 is out due to unforeseen issue at work",
      contacts: [{ jid: "158055467598020@lid", isMe: false, name: "DÇ" }],
      botIdentities,
    });
    expect(out.body).toBe("@158055467598020 is out due to unforeseen issue at work");
    expect(out.mentionNames).toEqual([{ jid: "158055467598020@lid", name: "DÇ" }]);
  });

  it("drops an unusable candidate name rather than forwarding it", () => {
    const out = rewriteMentions({
      body: "@158055467598020 out",
      contacts: [{ jid: "158055467598020@lid", isMe: false, name: "::::" }],
      botIdentities,
    });
    expect(out.body).toBe("@158055467598020 out");
    expect(out.mentionNames).toEqual([]);
  });

  it("handles several mentions where one is the bot and the others are players", () => {
    const out = rewriteMentions({
      body: "@111222333444555 put me and @233452997767322 and @447700900321 together",
      contacts: [
        { jid: BOT_LID, isMe: true, name: "Match Time" },
        { jid: "233452997767322@lid", isMe: false, name: DAVID_PUSHNAME },
        { jid: "447700900321@c.us", isMe: false, name: "Najib" },
      ],
      botIdentities,
    });
    expect(out.body).toBe(
      "@Match Time put me and @233452997767322 and @447700900321 together",
    );
    expect(out.botMentioned).toBe(true);
    expect(out.mentionNames.map((m) => m.name)).toEqual(["割::::..", "Najib"]);
  });

  it("botMentioned is false when only players are mentioned", () => {
    const out = rewriteMentions({
      body: "@447700900321 out",
      contacts: [{ jid: "447700900321@c.us", isMe: false, name: "Najib" }],
      botIdentities,
    });
    expect(out.botMentioned).toBe(false);
  });

  it("does not touch a longer number that merely starts with a mention's digits", () => {
    const out = rewriteMentions({
      body: "@1112223334445559999 is not the bot",
      contacts: [{ jid: BOT_LID, isMe: true }],
      botIdentities,
    });
    expect(out.body).toBe("@1112223334445559999 is not the bot");
  });

  it("is total: rubbish contacts and a non-string body cannot throw", () => {
    expect(
      rewriteMentions({
        body: undefined as unknown as string,
        contacts: [{ jid: "" }, { jid: "x@lid", name: {} }],
        botIdentities: [null, undefined],
      }),
    ).toEqual({ body: "", mentionNames: [], botMentioned: false });
  });

  it("exposes the tag text the interaction contract matches on", () => {
    // lib/interaction-contract.ts's text fallback is /@?\s*match\s*time\b/i.
    expect(BOT_MENTION_TEXT).toBe("@Match Time");
  });
});

// ─── SELF-MENTION DETECTION — @lid-vs-@c.us-immune ──────────────────
//
// Moved here from `smart-analysis.ts`'s `isSelfMention` when the body
// rewrite and the `botMentioned` flag became one function: the rule now
// has exactly one implementation (`contactIsBot`) and these cases pin it
// through `rewriteMentions`, which is what production actually calls.
//
// Regression context, unchanged: WhatsApp encodes @-mentions as opaque
// "@lid" JIDs while `client.info.wid` is the "@c.us" form, so comparing
// the bot's @c.us selfId against the mention list is ALWAYS false even
// when the bot WAS mentioned. `Contact.isMe` is the reliable signal;
// selfId equality is belt-and-braces for an unresolved contact.
describe("botMentioned across every bot identity form", () => {
  const BOT_CUS = "447700900000@c.us";
  const OTHER_LID = "158055467598020@lid";
  const tagged = (contacts: Parameters<typeof rewriteMentions>[0]["contacts"], ids: Array<string | null | undefined>) =>
    rewriteMentions({ body: "@158055467598020 hello", contacts, botIdentities: ids }).botMentioned;

  it("true when a mentioned contact resolves to isMe", () => {
    expect(
      tagged([{ jid: "447711111111@c.us", isMe: false }, { jid: OTHER_LID, isMe: true }], [BOT_CUS]),
    ).toBe(true);
  });

  it("true when a mention jid equals the bot's @c.us id", () => {
    expect(tagged([{ jid: BOT_CUS, isMe: false }], [BOT_CUS])).toBe(true);
  });

  it("true when a mention jid equals the bot's @lid id (contact unresolved)", () => {
    expect(tagged([{ jid: OTHER_LID }], [BOT_CUS, OTHER_LID])).toBe(true);
  });

  it("EXACT REGRESSION: only an @lid mention that isMe, selfId a different @c.us", () => {
    // The old `mentionedIds.includes(selfId)` returned false here, and a
    // real admin command was dropped by the interaction-contract gate.
    expect(tagged([{ jid: OTHER_LID, isMe: true }], [BOT_CUS])).toBe(true);
  });

  it("false when no mentioned contact is the bot", () => {
    expect(
      tagged(
        [{ jid: "447711111111@c.us", isMe: false }, { jid: "447722222222@lid", isMe: false }],
        [BOT_CUS, OTHER_LID],
      ),
    ).toBe(false);
  });

  it("false for no mentions at all", () => {
    expect(tagged([], [BOT_CUS, OTHER_LID])).toBe(false);
  });

  it("ignores empty/nullish bot identities (no false positive on '')", () => {
    expect(tagged([{ jid: "447711111111@c.us", isMe: false }], [null, undefined, ""])).toBe(false);
  });

  it("contactIsBot / botIdentitySet are the single rule underneath", () => {
    expect(contactIsBot({ jid: "999@lid", isMe: true }, botIdentitySet([BOT_CUS]))).toBe(true);
    expect(contactIsBot({ jid: BOT_CUS }, botIdentitySet([BOT_CUS, null]))).toBe(true);
    expect(
      contactIsBot({ jid: "447700900321@c.us", isMe: false }, botIdentitySet([BOT_CUS])),
    ).toBe(false);
  });
});

// 2026-11-16: the server may SAVE a tagged member's name only from his own
// profile name. `name` falls back to address-book labels on the bot phone.
describe("rewriteMentions: the pushname travels on its own", () => {
  it("an address-book label is `name` only; the person's own pushname is `pushname`", () => {
    const out = rewriteMentions({
      body: "@128539798032620 is IN",
      contacts: [{ jid: "128539798032620@lid", name: "Nico Plumber", pushname: "Nico", phone: "447700900555" }],
    });
    expect(out.mentionNames).toEqual([{ jid: "128539798032620@lid", name: "Nico Plumber", phone: "447700900555", pushname: "Nico" }]);
  });

  it("no pushname, no `pushname` field", () => {
    const out = rewriteMentions({
      body: "@128539798032620 is IN",
      contacts: [{ jid: "128539798032620@lid", name: "Nico Plumber", phone: "447700900555" }],
    });
    expect(out.mentionNames).toEqual([{ jid: "128539798032620@lid", name: "Nico Plumber", phone: "447700900555" }]);
  });
});
