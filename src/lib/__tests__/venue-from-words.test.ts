/**
 * "@Match Time our pitch is Goals Sutton" end to end, without a database or
 * Google: the suggestions and the setter are injected.
 */
import { describe, it, expect, vi } from "vitest";
import { setVenueFromWords, type VenueFromWordsDeps } from "../venue-from-words";
import type { VenueSuggestion } from "../venue-suggest-rules";

const NOW = new Date("2026-10-28T15:40:00Z");
const s = (primary: string, secondary: string, placeId: string): VenueSuggestion => ({ placeId, primary, secondary });
const GOALS = s("Goals Sutton", "Oxford Road, Sutton, UK", "ChIJgoalssutton01");

function deps(over: Partial<VenueFromWordsDeps> = {}) {
  const setPlace = vi.fn(async () => ({ status: "found" as const, name: "Goals Sutton", address: "Oxford Rd, Sutton SM1 2AA, UK", activityId: "act-1" }));
  const autocomplete = vi.fn(async () => ({ status: "ok" as const, suggestions: [GOALS] }));
  return { setPlace, autocomplete, d: { autocomplete, setPlace, claimSuggestCall: async () => true, placesConfigured: () => true, ...over } as VenueFromWordsDeps };
}

const run = (d: VenueFromWordsDeps, words: string | null, choice: number | null = null, lang = "en") =>
  setVenueFromWords({ orgId: "org-1", userId: "u-kemal", words, choice, lang, now: NOW, deps: d });

describe("setVenueFromWords", () => {
  it("one clear match: set, and the reply names the place with its address and the settings link", async () => {
    const { d, setPlace } = deps();
    const r = await run(d, "Goals Sutton");
    expect(r.outcome).toBe("venue-set");
    expect(r.set).toBe(true);
    expect(setPlace).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-1", userId: "u-kemal", confirmed: false, pick: expect.objectContaining({ placeId: "ChIJgoalssutton01" }) }));
    expect(r.replyText).toContain("*Goals Sutton*, Oxford Rd, Sutton SM1 2AA, UK");
    expect(r.replyText).toMatch(/\/admin\/settings#club-venue/);
  });

  it("several: a numbered list and nothing set", async () => {
    const b = s("Goals Sutton", "Sutton Common Rd, Sutton, UK", "ChIJgoalssutton02");
    const { d, setPlace } = deps({ autocomplete: async () => ({ status: "ok", suggestions: [GOALS, b] }) });
    const r = await run(d, "Goals Sutton");
    expect(r.outcome).toBe("venue-which");
    expect(r.set).toBe(false);
    expect(setPlace).not.toHaveBeenCalled();
    expect(r.replyText).toContain("1. Goals Sutton, Oxford Road, Sutton, UK\n2. Goals Sutton, Sutton Common Rd, Sutton, UK");
  });

  it("a number picked from that list is set, and confirmed (a pick from a list)", async () => {
    const b = s("Goals Sutton", "Sutton Common Rd, Sutton, UK", "ChIJgoalssutton02");
    const { d, setPlace } = deps({ autocomplete: async () => ({ status: "ok", suggestions: [GOALS, b] }) });
    const r = await run(d, "Goals Sutton", 2);
    expect(r.outcome).toBe("venue-set");
    expect(setPlace).toHaveBeenCalledWith(expect.objectContaining({ confirmed: true, pick: expect.objectContaining({ placeId: "ChIJgoalssutton02" }) }));
  });

  it("nothing found: said, with the settings link, nothing set", async () => {
    const { d, setPlace } = deps({ autocomplete: async () => ({ status: "ok", suggestions: [] }) });
    const r = await run(d, "Nowhere Park");
    expect(r.outcome).toBe("venue-none");
    expect(r.replyText).toContain("*Nowhere Park*");
    expect(r.replyText).toMatch(/\/admin\/settings#club-venue/);
    expect(setPlace).not.toHaveBeenCalled();
  });

  it("no name: asks for it, and asks Google nothing", async () => {
    const { d, autocomplete } = deps();
    const r = await run(d, null);
    expect(r.outcome).toBe("venue-no-name");
    expect(autocomplete).not.toHaveBeenCalled();
  });

  it("Google off, the hourly cap used up, or Google failing: the settings link, nothing set", async () => {
    for (const over of [
      { placesConfigured: () => false },
      { claimSuggestCall: async () => false },
      { autocomplete: async () => ({ status: "error" as const, code: "timeout" }) },
    ] as Partial<VenueFromWordsDeps>[]) {
      const { d, setPlace } = deps(over);
      const r = await run(d, "Goals Sutton");
      expect(r.outcome).toBe("venue-unavailable");
      expect(r.replyText).toMatch(/\/admin\/settings#club-venue/);
      expect(setPlace).not.toHaveBeenCalled();
    }
  });

  it("the place lookup capped or unresolved: unavailable, nothing claimed as set", async () => {
    for (const status of ["capped", "unresolved"] as const) {
      const { d } = deps({ setPlace: async () => ({ status }) });
      const r = await run(d, "Goals Sutton");
      expect(r.outcome).toBe("venue-unavailable");
      expect(r.set).toBe(false);
    }
  });

  it("speaks Turkish for a Turkish club", async () => {
    const { d } = deps();
    const r = await run(d, "Goals Sutton", null, "tr");
    expect(r.replyText).toContain("sahanız *Goals Sutton*");
  });
});
