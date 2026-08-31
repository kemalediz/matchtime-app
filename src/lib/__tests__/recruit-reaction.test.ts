/**
 * A 👍 on the recruit invite DM — the PURE half.
 *
 * Emoji → attendance decision, and the SentNotification key that links a
 * dispatched BotJob back to the invite it was (see
 * src/lib/recruit-reaction.ts for why the link lives in a key rather than
 * a new column: no migration was on the table).
 */
import { describe, it, expect } from "vitest";
import {
  classifyReactionAttendance,
  recruitDmLinkKey,
  parseRecruitDmLinkKey,
  botJobIdFromDispatchKey,
} from "@/lib/recruit-reaction";

describe("classifyReactionAttendance", () => {
  it("reads a plain 👍 as IN", () => {
    expect(classifyReactionAttendance("👍")).toBe("in");
  });

  it("reads every 👍 skin tone as IN", () => {
    for (const e of ["👍🏻", "👍🏼", "👍🏽", "👍🏾", "👍🏿"]) {
      expect(classifyReactionAttendance(e)).toBe("in");
    }
  });

  it("reads ✅ as IN", () => {
    expect(classifyReactionAttendance("✅")).toBe("in");
  });

  it("reads 👎 and its skin tones as OUT", () => {
    for (const e of ["👎", "👎🏻", "👎🏼", "👎🏽", "👎🏾", "👎🏿"]) {
      expect(classifyReactionAttendance(e)).toBe("out");
    }
  });

  it("reads ❌ as OUT", () => {
    expect(classifyReactionAttendance("❌")).toBe("out");
  });

  it("ignores anything else — an emoji is not a conversation", () => {
    for (const e of ["❤️", "😂", "🤔", "🙏", "⚽", "🎉", "😢", "🔥", ""]) {
      expect(classifyReactionAttendance(e)).toBeNull();
    }
  });

  it("tolerates surrounding whitespace", () => {
    expect(classifyReactionAttendance(" 👍 ")).toBe("in");
  });
});

describe("recruit DM link key", () => {
  it("round-trips a BotJob id", () => {
    const key = recruitDmLinkKey("cl123abc");
    expect(parseRecruitDmLinkKey(key)).toBe("cl123abc");
  });

  it("is not confusable with any other key class", () => {
    expect(parseRecruitDmLinkKey("botjob-cl123abc")).toBeNull();
    expect(parseRecruitDmLinkKey("match-1:recruit-dm:user-1")).toBeNull();
    expect(parseRecruitDmLinkKey("offer-abc")).toBeNull();
    expect(parseRecruitDmLinkKey("txtlog:org:hash:key")).toBeNull();
  });
});

describe("botJobIdFromDispatchKey", () => {
  it("extracts the BotJob id from the dispatch key", () => {
    expect(botJobIdFromDispatchKey("botjob-cl123abc")).toBe("cl123abc");
  });

  it("returns null for any key that is not a BotJob dispatch", () => {
    expect(botJobIdFromDispatchKey("offer-abc")).toBeNull();
    expect(botJobIdFromDispatchKey("match-1:recruit-dm:user-1")).toBeNull();
    expect(botJobIdFromDispatchKey("botjob-")).toBeNull();
  });
});
