/**
 * The privacy policy's "Back to MatchTime" (Kemal, 2026-10-27): an in-site
 * reader goes back to where he came from, a form's new tab closes (or opens
 * the form's page), anyone else goes home.
 */
import { describe, expect, it } from "vitest";
import { backAction } from "../back-nav";

const origin = "https://matchtime.ai";

describe("backAction", () => {
  it("same site, with history: go back", () => {
    expect(backAction({ referrer: `${origin}/play?src=site-hero`, origin, historyLength: 3 })).toEqual({ kind: "back" });
  });
  it("same site, a fresh tab the form opened: close it, else open where he came from", () => {
    expect(backAction({ referrer: `${origin}/play?src=site-hero`, origin, historyLength: 1 })).toEqual({ kind: "close", fallback: "/play?src=site-hero" });
  });
  it("from outside, or no referrer, or a bad one: home", () => {
    for (const referrer of ["", "https://google.com/search?q=matchtime", "http://matchtime.ai/play", "not a url"]) {
      expect(backAction({ referrer, origin, historyLength: 4 })).toEqual({ kind: "home" });
    }
  });
  it("from the policy itself: home", () => {
    expect(backAction({ referrer: `${origin}/privacy`, origin, historyLength: 4 })).toEqual({ kind: "home" });
  });
});
