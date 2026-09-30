/**
 * RED-first spec (2026-09-30, MT Test): a LID mention the Pi CAN tie to a
 * phone must carry that phone to the server, and a LID mention it cannot
 * tie must be flagged so the driver re-reads the group once.
 *
 * The evidence: Kemal posted "@David is IN" and "@Hilal is IN" in the MT
 * Test group. Both arrived at /api/whatsapp/analyze as raw digits
 * ("@252012071493723 is IN") with no `mentionNames` entry, so the server
 * had nothing to match against the roster, and the engine refused them
 * ("raw digits are never a name"). David IS a member, by phone. Under
 * Baileys a mention is a LID, and the server's only exact key (phone) was
 * reachable on the Pi but never forwarded.
 */
import { describe, it, expect } from "vitest";
import {
  lidMentionsWithoutPhone,
  rewriteMentions,
  sanitiseMentionPhone,
} from "./mentions.js";
import { createRosterRefreshLimiter, MENTION_ROSTER_REFRESH_INTERVAL_MS } from "./baileys/roster-refresh.js";

const DAVID_LID = "252012071493723@lid";
const HILAL_LID = "46179639369730@lid";
const ELVIN_CUS = "447423203409@c.us";
const BOT_LID = "111222333444555@lid";

describe("sanitiseMentionPhone", () => {
  it("keeps a plausible phone as digits only", () => {
    expect(sanitiseMentionPhone("447881432810")).toBe("447881432810");
    expect(sanitiseMentionPhone("+44 7881 432810")).toBe("447881432810");
  });

  it("refuses anything that is not a phone", () => {
    expect(sanitiseMentionPhone(undefined)).toBeUndefined();
    expect(sanitiseMentionPhone(12345)).toBeUndefined();
    expect(sanitiseMentionPhone("")).toBeUndefined();
    expect(sanitiseMentionPhone("12345")).toBeUndefined();
    expect(sanitiseMentionPhone("1234567890123456789")).toBeUndefined();
    expect(sanitiseMentionPhone("David")).toBeUndefined();
  });
});

describe("rewriteMentions forwards a LID mention's phone", () => {
  it("a LID with a known phone and no name still travels, as a phone", () => {
    const r = rewriteMentions({
      body: "@252012071493723 is IN",
      contacts: [{ jid: DAVID_LID, isMe: false, phone: "447881432810" }],
    });
    expect(r.body).toBe("@252012071493723 is IN");
    expect(r.mentionNames).toEqual([{ jid: DAVID_LID, phone: "447881432810" }]);
  });

  it("a LID with both a name and a phone carries both", () => {
    const r = rewriteMentions({
      body: "@252012071493723 is IN",
      contacts: [{ jid: DAVID_LID, name: "David", phone: "447881432810" }],
    });
    expect(r.mentionNames).toEqual([{ jid: DAVID_LID, name: "David", phone: "447881432810" }]);
  });

  it("a phone JID never carries a separate phone: the JID already is one", () => {
    const r = rewriteMentions({
      body: "@447423203409 is IN",
      contacts: [{ jid: ELVIN_CUS, name: "Elvin", phone: "447423203409" }],
    });
    expect(r.mentionNames).toEqual([{ jid: ELVIN_CUS, name: "Elvin" }]);
  });

  it("the bot's own mention never carries a phone or a name", () => {
    const r = rewriteMentions({
      body: "@111222333444555 hi",
      contacts: [{ jid: BOT_LID, isMe: true, phone: "447700900999" }],
    });
    expect(r.mentionNames).toEqual([]);
    expect(r.botMentioned).toBe(true);
  });

  it("nothing known means nothing forwarded, exactly as before", () => {
    const r = rewriteMentions({
      body: "@46179639369730 is IN",
      contacts: [{ jid: HILAL_LID }],
    });
    expect(r.mentionNames).toEqual([]);
  });
});

describe("lidMentionsWithoutPhone: which mentions justify one roster re-read", () => {
  it("lists LID mentions with no usable phone, and nothing else", () => {
    expect(
      lidMentionsWithoutPhone(
        [
          { jid: DAVID_LID, phone: "447881432810" },
          { jid: HILAL_LID },
          { jid: ELVIN_CUS },
          { jid: BOT_LID, isMe: true },
          { jid: "123@lid" },
        ],
        [],
      ),
    ).toEqual([HILAL_LID]);
  });

  it("never lists the bot, even without isMe, when its LID is a known identity", () => {
    expect(lidMentionsWithoutPhone([{ jid: BOT_LID }], [BOT_LID])).toEqual([]);
  });
});

describe("createRosterRefreshLimiter: one re-read per group per window", () => {
  it("allows the first, refuses a second inside the window, allows it after", () => {
    let t = 1_000_000;
    const lim = createRosterRefreshLimiter({ now: () => t });
    expect(lim.tryAcquire("g1@g.us")).toBe(true);
    expect(lim.tryAcquire("g1@g.us")).toBe(false);
    expect(lim.tryAcquire("g2@g.us")).toBe(true);
    t += MENTION_ROSTER_REFRESH_INTERVAL_MS - 1;
    expect(lim.tryAcquire("g1@g.us")).toBe(false);
    t += 1;
    expect(lim.tryAcquire("g1@g.us")).toBe(true);
  });

  it("the window is ten minutes", () => {
    expect(MENTION_ROSTER_REFRESH_INTERVAL_MS).toBe(10 * 60 * 1000);
  });
});
