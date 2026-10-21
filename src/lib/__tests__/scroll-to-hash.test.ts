/**
 * A link to /admin/settings#<section> lands at the top when the section is
 * drawn after the page has loaded: the browser looks for the element before
 * it exists. `scrollToHashTarget` is what a section calls once it is drawn.
 */
import { describe, expect, it, vi } from "vitest";
import { scrollToHashTarget } from "@/lib/scroll-to-hash";

function world(hash: string, ids: string[]) {
  const scrolled: string[] = [];
  const options: unknown[] = [];
  const doc = {
    getElementById: (id: string) =>
      ids.includes(id)
        ? ({
            scrollIntoView: vi.fn((o: unknown) => {
              scrolled.push(id);
              options.push(o);
            }),
          } as unknown as HTMLElement)
        : null,
  };
  return { doc, loc: { hash }, scrolled, options };
}

describe("scrollToHashTarget", () => {
  it("scrolls the section into view when the link points at it", () => {
    const w = world("#partner-clubs", ["partner-clubs"]);
    expect(scrollToHashTarget("partner-clubs", w.doc, w.loc)).toBe(true);
    expect(w.scrolled).toEqual(["partner-clubs"]);
  });

  it("jumps instantly: a smooth scroll (the page's CSS default) drifts off the section as the cards above it load", () => {
    const w = world("#payments", ["payments"]);
    scrollToHashTarget("payments", w.doc, w.loc);
    expect(w.options).toEqual([{ block: "start", behavior: "instant" }]);
  });

  it("leaves the page alone when the link points elsewhere or nowhere", () => {
    for (const hash of ["", "#billing", "#partner-clubs-x"]) {
      const w = world(hash, ["partner-clubs"]);
      expect(scrollToHashTarget("partner-clubs", w.doc, w.loc)).toBe(false);
      expect(w.scrolled).toEqual([]);
    }
  });

  it("does nothing when the section is not in the page", () => {
    const w = world("#payments", []);
    expect(scrollToHashTarget("payments", w.doc, w.loc)).toBe(false);
    expect(w.scrolled).toEqual([]);
  });
});
