/**
 * THE PLAYERS' GROUP'S RECENT CHAT COMES FROM WHAT THE SERVER STORED
 * (Kemal, 2026-10-20).
 *
 * The Pi keeps the last 15 lines per group in memory and sends them with
 * every batch. After the 10:26:59 UTC restart on 2026-10-20 FNF's buffer
 * held two lines, which is part of why Naim's OUT was missed. The server
 * already stores every analysed message (`AnalyzedMessage`), so it builds
 * the history itself: the stored lines, then this batch's own lines, with
 * every author shown by the roster name (never the WhatsApp pushname).
 *
 * The Pi's lines are kept only where the server has nothing of its own for
 * them (a message it never stored); a Pi line that IS a stored row, or a
 * message in this batch, is shown once.
 */
import { describe, it, expect } from "vitest";
import { mergeGroupChatHistory, GROUP_HISTORY_LINES, type StoredChatLine } from "../group-chat-history";

const T0 = Date.parse("2026-10-20T10:20:00.000Z");
const at = (sec: number) => new Date(T0 + sec * 1000);
const iso = (sec: number) => at(sec).toISOString();

function stored(sec: number, authorName: string | null, author: string | null, body: string): StoredChatLine {
  // The server writes the row a few seconds after WhatsApp's timestamp.
  return { authorName, author, body, at: at(sec + 4) };
}

describe("after a Pi restart (the Pi's history is empty)", () => {
  it("the extractor still sees the stored recent lines, oldest first, with roster names, then the batch", () => {
    const lines = mergeGroupChatHistory({
      pi: [],
      stored: [
        stored(0, "Kiz", "Kieran Walsh", "who's playing tonight?"),
        stored(30, "S.D", "Sait Demir", "me"),
      ],
      batch: [{ authorName: "Naimy", timestamp: iso(400), author: "Naim Rahman", body: "@Match Time out", stored: false }],
    });
    expect(lines).toEqual([
      { author: "Kieran Walsh", body: "who's playing tonight?" },
      { author: "Sait Demir", body: "me" },
      { author: "Naim Rahman", body: "@Match Time out" },
    ]);
  });
});

describe("no line twice", () => {
  it("a Pi line that is a stored row is shown once, as the server stored it (roster name, named mention)", () => {
    const lines = mergeGroupChatHistory({
      pi: [
        { authorName: "Kiz", body: "who's playing tonight?", timestamp: iso(0) },
        { authorName: "S.D", body: "@447700900123 you in?", timestamp: iso(30) },
      ],
      stored: [
        stored(0, "Kiz", "Kieran Walsh", "who's playing tonight?"),
        stored(30, "S.D", "Sait Demir", "@Kieran Walsh you in?"),
      ],
      batch: [],
    });
    expect(lines).toEqual([
      { author: "Kieran Walsh", body: "who's playing tonight?" },
      { author: "Sait Demir", body: "@Kieran Walsh you in?" },
    ]);
  });

  it("the Pi's line for a message in THIS batch is dropped; the batch line (its spelling, roster name) is the one shown", () => {
    // Naim's shape: the Pi recorded the raw "@<digits>" mention; the batch
    // carries "@Match Time out" (history-own-lines, #343).
    const lines = mergeGroupChatHistory({
      pi: [
        { authorName: "Kiz", body: "@158055467598020 out", timestamp: iso(0) },
        { authorName: "Naimy", body: "@158055467598020 out", timestamp: iso(400) },
      ],
      stored: [stored(0, "Kiz", "Kieran Walsh", "@Match Time out")],
      batch: [{ authorName: "Naimy", timestamp: iso(400), author: "Naim Rahman", body: "@Match Time out", stored: false }],
    });
    expect(lines).toEqual([
      { author: "Kieran Walsh", body: "@Match Time out" },
      { author: "Naim Rahman", body: "@Match Time out" },
    ]);
  });

  it("another member's line with the same words and the same second is a different line and stays", () => {
    const lines = mergeGroupChatHistory({
      pi: [{ authorName: "Kiz", body: "in", timestamp: iso(400) }],
      stored: [],
      batch: [{ authorName: "Naimy", timestamp: iso(400), author: "Naim Rahman", body: "in", stored: false }],
    });
    expect(lines).toEqual([
      { author: "Kiz", body: "in" },
      { author: "Naim Rahman", body: "in" },
    ]);
  });

  it("the same words twice from one person are two lines, each matched to its own row", () => {
    const lines = mergeGroupChatHistory({
      pi: [
        { authorName: "Kiz", body: "in", timestamp: iso(0) },
        { authorName: "Kiz", body: "in", timestamp: iso(60) },
      ],
      stored: [stored(0, "Kiz", "Kieran Walsh", "in"), stored(60, "Kiz", "Kieran Walsh", "in")],
      batch: [],
    });
    expect(lines).toEqual([
      { author: "Kieran Walsh", body: "in" },
      { author: "Kieran Walsh", body: "in" },
    ]);
  });

  it("a message of this batch the server already stored (a replay) appears once, from its row", () => {
    const lines = mergeGroupChatHistory({
      pi: [{ authorName: "Kiz", body: "in", timestamp: iso(0) }],
      stored: [stored(0, "Kiz", "Kieran Walsh", "in")],
      batch: [{ authorName: "Kiz", timestamp: iso(0), author: "Kieran Walsh", body: "in", stored: true }],
    });
    expect(lines).toEqual([{ author: "Kieran Walsh", body: "in" }]);
  });
});

describe("what the server cannot vouch for", () => {
  it("a Pi line with no stored row (a message the server never stored) is kept as the Pi sent it", () => {
    const lines = mergeGroupChatHistory({
      pi: [{ authorName: "MatchTime", body: "Squad is full", timestamp: iso(0) }],
      stored: [],
      batch: [{ authorName: "Naimy", timestamp: iso(400), author: "Naim Rahman", body: "out", stored: false }],
    });
    expect(lines).toEqual([
      { author: "MatchTime", body: "Squad is full" },
      { author: "Naim Rahman", body: "out" },
    ]);
  });

  it("stored lines the Pi lost (before its restart) come before the lines it still has, in time order", () => {
    const lines = mergeGroupChatHistory({
      pi: [{ authorName: "S.D", body: "me", timestamp: iso(300) }],
      stored: [stored(0, "Kiz", "Kieran Walsh", "who's playing?"), stored(300, "S.D", "Sait Demir", "me")],
      batch: [],
    });
    expect(lines).toEqual([
      { author: "Kieran Walsh", body: "who's playing?" },
      { author: "Sait Demir", body: "me" },
    ]);
  });
});

describe("the same size as today", () => {
  it(`keeps the newest ${GROUP_HISTORY_LINES} lines, the batch included`, () => {
    expect(GROUP_HISTORY_LINES).toBe(15);
    const rows = Array.from({ length: 20 }, (_, i) => stored(i * 10, "P", "Player", `line ${i}`));
    const lines = mergeGroupChatHistory({
      pi: [],
      stored: rows,
      batch: [{ authorName: "N", timestamp: iso(999), author: "Naim Rahman", body: "out", stored: false }],
    });
    expect(lines).toHaveLength(15);
    expect(lines[0].body).toBe("line 6");
    expect(lines[13].body).toBe("line 19");
    expect(lines[14]).toEqual({ author: "Naim Rahman", body: "out" });
  });

  it("an empty line is not a line", () => {
    const lines = mergeGroupChatHistory({
      pi: [],
      stored: [stored(0, "P", "Player", "   ")],
      batch: [{ authorName: "N", timestamp: iso(9), author: "Naim Rahman", body: "", stored: false }],
    });
    expect(lines).toEqual([]);
  });
});
