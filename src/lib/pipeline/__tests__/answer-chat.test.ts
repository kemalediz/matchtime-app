/**
 * The chat as the unified answer reads it (`answer-chat.ts`): moved from the
 * deleted open answer on 2026-11-18, with the tests that pinned it there.
 */
import { describe, expect, it } from "vitest";
import { ANSWER_CHAT_MAX_CHARS, chatLines, scrubAuthor, scrubPhones } from "../answer-chat";

const NOW = new Date("2026-09-01T10:00:00.000Z");

describe("chatLines", () => {
  it("gives each line its day and time, London, oldest first", () => {
    const lines = chatLines([
      { author: "Ali Kaya", body: "first", at: new Date("2026-09-01T09:00:00.000Z") },
      { author: "MatchTime", body: "second", at: new Date("2026-09-01T09:30:00.000Z") },
    ]).map((l) => l.line);
    expect(lines).toEqual(["  [Tue 1 Sep 10:00] Ali Kaya: first", "  [Tue 1 Sep 10:30] MatchTime: second"]);
  });

  it("keeps a long post's later lines inside its own line", () => {
    const [l] = chatLines([{ author: "Elvin Aliyev", body: "Friday list:\n1. Ali\n2. Can", at: NOW }]);
    expect(l.line).toBe("  [Tue 1 Sep 11:00] Elvin Aliyev: Friday list:\n    1. Ali\n    2. Can");
  });

  it("an input budget: past it, the OLDEST lines go and the newest stay", () => {
    const long = Array.from({ length: 300 }, (_, i) => ({
      author: "Sait Demir",
      body: `${"x".repeat(400)} ${i}`,
      at: new Date(NOW.getTime() - (300 - i) * 60_000),
    }));
    const text = chatLines(long).map((l) => l.line).join("\n");
    expect(text).toMatch(/ 299$/);
    expect(text).not.toMatch(/ 0\n/);
    expect(text.length).toBeLessThanOrEqual(ANSWER_CHAT_MAX_CHARS);
  });

  it("an author that is a phone number is 'a member' (the words are scrubbed with the whole context, `scrubPhones`)", () => {
    const [l] = chatLines([{ author: "+44 7700 900123", body: "text me on 07700 900456", at: null }]);
    expect(l.line).toBe("  a member: text me on 07700 900456");
    expect(scrubPhones(l.line)).toBe("  a member: text me on [number hidden]");
  });
});

describe("scrubPhones and scrubAuthor", () => {
  it("hide a run of nine or more digits, and leave a short number alone", () => {
    expect(scrubPhones("call 07700 900456 at 21:30, 14 players")).toBe("call [number hidden] at 21:30, 14 players");
  });

  it("an author with no letters, or none at all, is 'a member'", () => {
    expect(scrubAuthor(null)).toBe("a member");
    expect(scrubAuthor("447700900123")).toBe("a member");
    expect(scrubAuthor("Ali Kaya")).toBe("Ali Kaya");
  });
});
