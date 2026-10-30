/**
 * AN ORGANISER'S TAGGED "CHASE" IS A REQUEST TO FIND PLAYERS (MT Test,
 * 2026-10-29). The owner's "@Match Time invite players from pool" was routed
 * `offer` and its extractor said `claims: [], sideRequests: ["chase"]`:
 * "chase" means nudging for players, and only "recruit" reached the pool
 * and partner decision, so MatchTime said nothing. From an owner or admin
 * who tagged MatchTime, a chase now requests the recruit exactly as
 * "recruit" does. Anyone else's chase stays the silent nudge it was.
 */
import { describe, it, expect } from "vitest";
import { decide } from "../engine";
import { NOW, attendanceFacts, msg, world } from "./helpers";

const chase = (from: string, body: string, tagged = true) =>
  msg({ id: "wa-chase", from, body, route: "offer", tagged, taggedExplicitly: tagged, facts: attendanceFacts([], { sideRequests: ["chase"] }) });

describe("a chase side request with no claims", () => {
  it("from the owner, tagged: the recruit is requested, explicitly tagged", () => {
    const r = decide({ now: NOW, state: world(), messages: [chase("kemal", "@Match Time invite players from pool")] });
    expect(r.outcomes[0].recruitRequested).toBe(true);
    expect(r.outcomes[0].recruitTaggedExplicitly).toBe(true);
    expect(r.writes).toEqual([]);
  });

  it("from a member who is not an organiser, tagged: still a nudge, no recruit", () => {
    const r = decide({ now: NOW, state: world(), messages: [chase("sait", "@Match Time invite players from pool")] });
    expect(r.outcomes[0].recruitRequested ?? false).toBe(false);
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/chase nudge/);
  });

  it("from the owner, NOT tagged to MatchTime ('@all we need more players'): still a nudge, no recruit", () => {
    const r = decide({ now: NOW, state: world(), messages: [chase("kemal", "@all we need more players pls", false)] });
    expect(r.outcomes[0].recruitRequested ?? false).toBe(false);
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/chase nudge/);
  });
});
