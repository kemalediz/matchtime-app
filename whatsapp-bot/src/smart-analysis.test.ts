import { describe, it, expect } from "vitest";
import { immediateFlushReason, isSelfMention } from "./smart-analysis.js";

const URGENCY_WINDOW_MS = 60 * 60 * 1000; // mirror the source constant

describe("immediateFlushReason", () => {
  it("returns 'mention' when the bot was @-mentioned (highest precedence)", () => {
    // Not urgent, buffer not full, no kickoff — mention alone wins.
    expect(
      immediateFlushReason({
        botMentioned: true,
        bufferLen: 1,
        maxBufferLen: Infinity,
        kickoffMs: null,
        nowMs: 0,
        urgencyWindowMs: URGENCY_WINDOW_MS,
      }),
    ).toBe("mention");

    // Mention wins even when ALSO urgent AND full.
    expect(
      immediateFlushReason({
        botMentioned: true,
        bufferLen: 50,
        maxBufferLen: 50,
        kickoffMs: 1000,
        nowMs: 0,
        urgencyWindowMs: URGENCY_WINDOW_MS,
      }),
    ).toBe("mention");
  });

  it("returns 'urgency' when kickoff is within the window (no mention)", () => {
    expect(
      immediateFlushReason({
        botMentioned: false,
        bufferLen: 1,
        maxBufferLen: Infinity,
        kickoffMs: URGENCY_WINDOW_MS - 1, // within the window from now=0
        nowMs: 0,
        urgencyWindowMs: URGENCY_WINDOW_MS,
      }),
    ).toBe("urgency");

    // Boundary: exactly at the window edge still counts (<=).
    expect(
      immediateFlushReason({
        botMentioned: false,
        bufferLen: 1,
        maxBufferLen: Infinity,
        kickoffMs: URGENCY_WINDOW_MS,
        nowMs: 0,
        urgencyWindowMs: URGENCY_WINDOW_MS,
      }),
    ).toBe("urgency");
  });

  it("returns 'full' when the buffer is at/over max and not urgent/mentioned", () => {
    expect(
      immediateFlushReason({
        botMentioned: false,
        bufferLen: 50,
        maxBufferLen: 50,
        kickoffMs: null,
        nowMs: 0,
        urgencyWindowMs: URGENCY_WINDOW_MS,
      }),
    ).toBe("full");

    // Over max, kickoff far away (outside window) → still 'full', not urgency.
    expect(
      immediateFlushReason({
        botMentioned: false,
        bufferLen: 99,
        maxBufferLen: 50,
        kickoffMs: URGENCY_WINDOW_MS * 5,
        nowMs: 0,
        urgencyWindowMs: URGENCY_WINDOW_MS,
      }),
    ).toBe("full");
  });

  it("returns null when not mentioned, not urgent, and buffer below max", () => {
    expect(
      immediateFlushReason({
        botMentioned: false,
        bufferLen: 3,
        maxBufferLen: Infinity,
        kickoffMs: null,
        nowMs: 0,
        urgencyWindowMs: URGENCY_WINDOW_MS,
      }),
    ).toBeNull();

    // Kickoff exists but is outside the window → still null (waits for batch).
    expect(
      immediateFlushReason({
        botMentioned: false,
        bufferLen: 3,
        maxBufferLen: 50,
        kickoffMs: URGENCY_WINDOW_MS + 1,
        nowMs: 0,
        urgencyWindowMs: URGENCY_WINDOW_MS,
      }),
    ).toBeNull();
  });
});

// ─── isSelfMention — @lid-vs-@c.us-immune self-mention detection ─────
// Regression context: WhatsApp now encodes @-mentions as opaque "@lid"
// JIDs while client.info.wid is the "@c.us" form, so a string equality of
// the bot's @c.us selfId against the mention list is always false even
// when the bot WAS mentioned. The reliable signal is the resolved
// Contact.isMe; selfId equality is kept as belt-and-suspenders.
describe("isSelfMention — bot mention detection across identity forms", () => {
  const BOT_CUS = "447700900000@c.us";
  const BOT_LID = "158055467598020@lid";

  it("returns true when a mentioned contact resolves to isMe", () => {
    expect(
      isSelfMention(
        [{ jid: "447711111111@c.us", isMe: false }, { jid: BOT_LID, isMe: true }],
        [BOT_CUS],
      ),
    ).toBe(true);
  });

  it("returns true when a mention jid equals the bot's @c.us id", () => {
    expect(isSelfMention([{ jid: BOT_CUS, isMe: false }], [BOT_CUS])).toBe(true);
  });

  it("returns true when a mention jid equals the bot's @lid id", () => {
    // isMe unavailable (unresolved contact) but jid matches the bot's lid identity.
    expect(isSelfMention([{ jid: BOT_LID }], [BOT_CUS, BOT_LID])).toBe(true);
  });

  it("EXACT REGRESSION: only a @lid mention that isMe, selfId is a different @c.us → true", () => {
    // mentionedIds contains ONLY the bot's @lid jid (isMe true); the bot's
    // structured selfId is its @c.us form (a different string). The old
    // `mentionedIds.includes(selfId)` check returned false here — the bug.
    expect(isSelfMention([{ jid: BOT_LID, isMe: true }], [BOT_CUS])).toBe(true);
  });

  it("returns false when no mentioned contact is the bot", () => {
    expect(
      isSelfMention(
        [{ jid: "447711111111@c.us", isMe: false }, { jid: "447722222222@lid", isMe: false }],
        [BOT_CUS, BOT_LID],
      ),
    ).toBe(false);
  });

  it("returns false for empty mentions", () => {
    expect(isSelfMention([], [BOT_CUS, BOT_LID])).toBe(false);
  });

  it("ignores empty/nullish bot identities (no false positive on '')", () => {
    expect(
      isSelfMention([{ jid: "447711111111@c.us", isMe: false }], [null, undefined, ""]),
    ).toBe(false);
  });
});
