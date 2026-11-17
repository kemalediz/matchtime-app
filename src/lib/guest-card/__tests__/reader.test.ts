/**
 * The guest reader's contract (2026-11-17, rewritten after the review of
 * #621), with no model: what it is shown and how its answer is read. The
 * prompt's behaviour is checked against the real model by
 * `scripts/live-check-guest-card.ts` (paid, run once).
 */
import { describe, expect, it } from "vitest";
import { buildGuestAddUserTurn, GUEST_ADD_SYSTEM_PROMPT, parseGuestAdd, readGuestAdd } from "../reader";
import type { PipelineModel } from "../../pipeline/llm";

const now = new Date("2026-11-17T14:05:00Z");
const ctx = {
  now,
  games: [
    { club: "Riverside FC", kickoff: new Date("2026-11-17T20:00:00Z") },
    { club: "Riverside FC", kickoff: new Date("2026-11-24T20:00:00Z") },
  ],
  cards: [{ name: "Abu Ayoub" }],
  quotedCard: false,
  senderName: "Kemal Organiser",
};

describe("buildGuestAddUserTurn", () => {
  it("the time, the games numbered, the cards by name only, then the message", () => {
    expect(buildGuestAddUserTurn("add him for tonight", ctx)).toBe(
      [
        "Time now: Tue 17 Nov, 14:05 (London)",
        "The club's coming games:\n1. Riverside FC, Tue 17 Nov, 20:00 (today)\n2. Riverside FC, Tue 24 Nov, 20:00",
        "Contact cards he just shared: 1. Abu Ayoub",
        "He replied to: nothing (a plain message)",
        "THE MESSAGE (from Kemal Organiser):\nadd him for tonight",
      ].join("\n\n"),
    );
  });
  it("no card, a card with no name, a reply to a card", () => {
    expect(buildGuestAddUserTurn("x", { ...ctx, cards: [] })).toContain("Contact cards he just shared: none");
    expect(buildGuestAddUserTurn("x", { ...ctx, cards: [{ name: null }] })).toContain("Contact cards he just shared: 1. (no name on the card)");
    expect(buildGuestAddUserTurn("x", { ...ctx, quotedCard: true })).toContain("He replied to: a contact card he shared");
  });
  it("never shows a card's number", () => {
    expect(buildGuestAddUserTurn("x", ctx)).not.toMatch(/7700/);
  });
});

describe("parseGuestAdd", () => {
  it("a card's person, with a game", () => {
    expect(parseGuestAdd('{"add":true,"card":true,"name":"","typed":[],"game":1,"game_not_listed":false,"also":false,"confidence":0.95}')).toEqual({
      add: true,
      card: true,
      name: null,
      typed: [],
      game: 1,
      gameNotListed: false,
      also: false,
      confidence: 0.95,
    });
  });
  it("typed people, each a name and the number as written; one without a number is dropped", () => {
    const r = parseGuestAdd(
      '{"add":true,"card":false,"name":"","typed":[{"name":"Sami","phone":"07700 900456"},{"name":"Can","phone":"07700 900457"},{"name":"Ali","phone":""}],"game":0,"game_not_listed":false,"also":true,"confidence":0.9}',
    );
    expect(r.typed).toEqual([
      { name: "Sami", phone: "07700 900456" },
      { name: "Can", phone: "07700 900457" },
    ]);
    expect(r.also).toBe(true);
  });
  it("a named game that is not in the list", () => {
    expect(parseGuestAdd('{"add":true,"card":true,"name":"","typed":[],"game":0,"game_not_listed":true,"also":false,"confidence":0.9}').gameNotListed).toBe(true);
  });
  it("anything off the contract is no add", () => {
    expect(parseGuestAdd("nope").add).toBe(false);
    expect(parseGuestAdd('{"claims":[],"affirmation":"none","sideRequests":[]}').add).toBe(false);
    expect(parseGuestAdd('{"add":"yes","game":1}').add).toBe(false);
  });
});

describe("readGuestAdd", () => {
  it("a failed call adds nobody", async () => {
    const model: PipelineModel = {
      name: "boom",
      complete: async () => {
        throw new Error("529");
      },
    };
    expect((await readGuestAdd("add him", ctx, { model })).add).toBe(false);
  });
  it("asks the model once, with the prompt and the message", async () => {
    const seen: string[] = [];
    const model: PipelineModel = {
      name: "fake",
      complete: async (req) => {
        seen.push(req.system, req.user);
        return {
          text: '{"add":true,"card":true,"name":"","typed":[],"game":1,"game_not_listed":false,"also":false,"confidence":0.9}',
          stopReason: "end_turn",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          costUsd: 0,
          ms: 0,
        };
      },
    };
    const r = await readGuestAdd("add him for tonight", ctx, { model });
    expect(r).toMatchObject({ add: true, card: true, game: 1 });
    expect(seen[0]).toBe(GUEST_ADD_SYSTEM_PROMPT);
    expect(seen[1]).toContain("add him for tonight");
  });
});

describe("the prompt", () => {
  it("has no dashes as punctuation and asks for JSON only", () => {
    expect(GUEST_ADD_SYSTEM_PROMPT).not.toMatch(/[—–]/);
    expect(GUEST_ADD_SYSTEM_PROMPT).toContain("Answer with the JSON object only");
  });
});
