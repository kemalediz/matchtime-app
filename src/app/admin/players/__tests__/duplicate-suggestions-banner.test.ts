/**
 * The "possible duplicates" banner on /admin/players (2026-09-29): a
 * placeholder a third party's "X in" created, next to a member with a
 * phone and a matching name, with a one-tap Merge that keeps the phone
 * member.
 */
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DuplicateSuggestionsBanner } from "../player-row-bits";

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

const PAIR = { placeholderId: "g1", placeholderName: "Hamzah", keepId: "p1", keepName: "Hamzah Khan" };

describe("DuplicateSuggestionsBanner", () => {
  it("renders nothing when there are no suggestions", () => {
    expect(renderToStaticMarkup(createElement(DuplicateSuggestionsBanner, { suggestions: [], lang: "en", onMerge: vi.fn() }))).toBe("");
  });

  it("names both players and offers a merge into the phone member", () => {
    const out = text(
      renderToStaticMarkup(createElement(DuplicateSuggestionsBanner, { suggestions: [PAIR], lang: "en", onMerge: vi.fn() })),
    );
    expect(out).toContain("Possible duplicates");
    expect(out).toContain("Hamzah, added by name, may be the same person as Hamzah Khan.");
    expect(out).toContain("Merge into Hamzah Khan");
  });

  it("speaks Turkish for a Turkish club, with no dashes", () => {
    const out = text(
      renderToStaticMarkup(createElement(DuplicateSuggestionsBanner, { suggestions: [PAIR], lang: "tr", onMerge: vi.fn() })),
    );
    expect(out).toContain("Olası çift kayıtlar");
    expect(out).toContain("Birleştir: Hamzah Khan");
    expect(out).not.toMatch(/[–—]/);
  });
});
