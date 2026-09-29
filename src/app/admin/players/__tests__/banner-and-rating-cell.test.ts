/**
 * The /admin/players banner and club-rating cell, rendered to HTML.
 *
 * Kemal saw "Hamzahposted in the group and got auto-added": the name and
 * the next word ran together. The banner now renders the sentence from
 * the string table as ONE text node, so the space cannot be lost, and
 * these tests read the rendered HTML to prove it. They also pin the
 * house rule that the copy carries no em dash.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProvisionalPlayersBanner, ClubRatingCell } from "../player-row-bits";

/** Visible text with tags stripped and entities decoded. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"');
}

describe("ProvisionalPlayersBanner", () => {
  it("keeps a space between a single name and 'posted'", () => {
    const out = text(renderToStaticMarkup(createElement(ProvisionalPlayersBanner, { names: ["Hamzah"], lang: "en" })));
    expect(out).toContain("1 new player joined via WhatsApp");
    expect(out).toContain("Hamzah posted in the group and got auto-added.");
    expect(out).not.toContain("Hamzahposted");
  });

  it("joins several names and keeps the space after the last one", () => {
    const out = text(
      renderToStaticMarkup(createElement(ProvisionalPlayersBanner, { names: ["Hamzah", "Ayoub"], lang: "en" })),
    );
    expect(out).toContain("2 new players joined via WhatsApp");
    expect(out).toContain("Hamzah, Ayoub posted in the group");
  });

  it("carries no em dash or en dash", () => {
    for (const lang of ["en", "tr"] as const) {
      const out = text(renderToStaticMarkup(createElement(ProvisionalPlayersBanner, { names: ["Hamzah"], lang })));
      expect(out).not.toMatch(/[—–]/);
    }
  });

  it("speaks Turkish for a Turkish club", () => {
    const out = text(renderToStaticMarkup(createElement(ProvisionalPlayersBanner, { names: ["Hamzah"], lang: "tr" })));
    expect(out).toContain("Hamzah ");
    expect(out).toContain("WhatsApp");
    expect(out).not.toContain("posted in the group");
  });

  it("renders nothing when there is nobody new", () => {
    expect(renderToStaticMarkup(createElement(ProvisionalPlayersBanner, { names: [], count: 0, lang: "en" }))).toBe("");
  });
});

describe("ClubRatingCell", () => {
  it("shows the club rating to one decimal and the rated games", () => {
    const out = text(renderToStaticMarkup(createElement(ClubRatingCell, { rating: 7.5, ratedGames: 1, lang: "en" })));
    expect(out).toContain("7.5");
    expect(out).toContain("1 rated game");
    expect(out).not.toContain("1 rated games");
  });

  it("pluralises the games", () => {
    const out = text(renderToStaticMarkup(createElement(ClubRatingCell, { rating: 6.25, ratedGames: 4, lang: "en" })));
    expect(out).toContain("6.3");
    expect(out).toContain("4 rated games");
  });

  it("says 'Not rated yet' rather than showing the seed", () => {
    const out = text(renderToStaticMarkup(createElement(ClubRatingCell, { rating: null, ratedGames: 0, lang: "en" })));
    expect(out).toContain("Not rated yet");
    expect(out).not.toMatch(/\d/);
  });

  it("speaks Turkish for a Turkish club", () => {
    const rated = text(renderToStaticMarkup(createElement(ClubRatingCell, { rating: 7.5, ratedGames: 2, lang: "tr" })));
    expect(rated).toContain("7.5");
    expect(rated).toContain("2 puanlanmış maç");
    const empty = text(renderToStaticMarkup(createElement(ClubRatingCell, { rating: null, ratedGames: 0, lang: "tr" })));
    expect(empty).toContain("Henüz puan yok");
  });
});
