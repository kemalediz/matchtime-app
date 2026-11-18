/**
 * WHAT THE OTHER PARTS OF A MESSAGE DID, AS THE UNIFIED ANSWER IS TOLD IT
 * (review of #626). Every route that acted on the same message feeds it,
 * by reply, reaction or post; a refusal is never called done.
 */
import { describe, expect, it } from "vitest";
import { alsoDonePart, hqAlsoDonePart } from "../also-done";

const out = (o: Partial<Parameters<typeof alsoDonePart>[1]> = {}) => ({ reply: null, react: null, intent: "x", action: "none", ...o });

describe("alsoDonePart: one route's outcome for the same message", () => {
  it("a reply that did something is done, in its own words", () => {
    expect(alsoDonePart("admin", out({ reply: "✅ Done: Tuesday is 7-a-side now, 14 places.", intent: "format-switched-activity", action: "reply" }))).toEqual({
      text: "✅ Done: Tuesday is 7-a-side now, 14 places.",
      done: true,
    });
  });

  it("the teams made: done, with the team sheet", () => {
    expect(alsoDonePart("teams", out({ reply: "⚽ Teams for tonight", intent: "generate_teams_request", action: "generate-teams", teamsGenerated: true }))?.done).toBe(true);
  });

  it("a change acknowledged only by a reaction is still done, and said so", () => {
    expect(alsoDonePart("attendance", out({ react: "✅", intent: "in", action: "in" }))).toEqual({
      text: "The change to who plays was recorded (MatchTime reacted ✅ to THE MESSAGE).",
      done: true,
    });
  });

  it("a change shown only by the batch's squad post is done too", () => {
    expect(alsoDonePart("attendance", out({ intent: "other_out", action: "out" }))).toEqual({
      text: "The change to who plays was recorded (the squad list shows it).",
      done: true,
    });
  });

  it("a refusal is answered, never done", () => {
    expect(alsoDonePart("admin", out({ reply: "Only Alex can change the game.", intent: "organisers_only", action: "reply" }))).toEqual({
      text: "Only Alex can change the game.",
      done: false,
    });
    expect(alsoDonePart("teams", out({ reply: "I haven't swapped Elvin and Zork.", intent: "team_swap", action: "team-swap-refused" }))?.done).toBe(false);
    expect(alsoDonePart("teams", out({ reply: "Sorry, I can't do that one yet.", intent: "team_request_unsupported", action: "reply" }))?.done).toBe(false);
  });

  it("nothing said and nothing done, or a write that threw: nothing to tell", () => {
    expect(alsoDonePart("attendance", out())).toBeNull();
    expect(alsoDonePart("admin", out({ reply: "Done", action: "reply", writeFailed: true }))).toBeNull();
    expect(alsoDonePart("admin", out({ intent: "organisers_only", action: "none" }))).toBeNull();
  });
});

describe("hqAlsoDonePart: an HQ part's result", () => {
  it("done, or answered and not done, from its outcome", () => {
    expect(hqAlsoDonePart({ outcome: "hq-squad-changed", replyText: "Done: Luca on the bench." })).toEqual({ text: "Done: Luca on the bench.", done: true });
    expect(hqAlsoDonePart({ outcome: "hq-only-organisers", replyText: "Only Alex can make the teams." })).toEqual({ text: "Only Alex can make the teams.", done: false });
    expect(hqAlsoDonePart({ outcome: "hq-not-here", replyText: "I can't do that from this group." })?.done).toBe(false);
    expect(hqAlsoDonePart({ outcome: "hq-silent", replyText: null })).toBeNull();
  });
});
