import { describe, it, expect } from "vitest";
import { immediateFlushReason } from "./smart-analysis.js";

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
