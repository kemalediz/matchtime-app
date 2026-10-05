/**
 * F1 (2026-10-05): the finish-setup review page explains itself.
 *
 * Kemal saw a red "low" badge on a player card and could not tell what
 * it meant: it is how sure MatchTime was guessing the position and seed
 * rating from the chat, not a low rating. The badge now reads as a guess,
 * the stock "No clear signal in chat" note reads as a plain sentence, and
 * every section and field has an ⓘ.
 */
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/app/actions/finish-setup", () => ({ applyEnrichment: vi.fn() }));

import { FinishSetupForm } from "../FinishSetupForm";

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

const roster = [
  {
    name: "Pat Player",
    matchedUserId: "u1",
    proposedPosition: "MID",
    proposedSeedRating: 6,
    evidence: "No clear signal in chat — defaulting to neutral",
    confidence: 0,
  },
  {
    name: "Sam Striker",
    matchedUserId: "u2",
    proposedPosition: "FWD",
    proposedSeedRating: 8,
    evidence: "scored twice in the chat",
    confidence: 0.9,
  },
];

function render(lang: string) {
  return renderToStaticMarkup(
    createElement(FinishSetupForm, {
      sessionId: "s1",
      roster,
      unresolved: [{ name: "Gary Guest", userId: "g1" }],
      schedule: {},
      positions: ["GK", "DEF", "MID", "FWD"],
      lang,
    } as Parameters<typeof FinishSetupForm>[0]),
  );
}

describe("FinishSetupForm explains itself", () => {
  it("shows a low-confidence player as a guess to check, never as 'low'", () => {
    const html = render("en");
    expect(text(html)).toContain("Guess: please check");
    expect(text(html)).toContain("Confident");
    expect(html).not.toMatch(/>\s*low\s*</);
  });

  it("rewrites the analyser's 'no clear signal' note and keeps a real quote", () => {
    const out = text(render("en"));
    expect(out).toContain("Nothing in the chat about this player, so I've set a neutral starting point.");
    expect(out).not.toContain("No clear signal");
    expect(out).toContain("scored twice in the chat");
  });

  it("has an ⓘ on every section and field", () => {
    const html = render("en");
    for (const k of ["fs_players", "fs_confidence", "fs_position", "fs_seed", "fs_evidence", "fs_phones", "fs_schedule"]) {
      expect(html, k).toContain(`data-testid="info-${k}"`);
    }
  });

  it("reads in Turkish for a Turkish club", () => {
    const html = render("tr");
    expect(text(html)).toContain("Tahmin: lütfen kontrol edin");
    expect(html).toContain('aria-label="Başlangıç puanı nedir?"');
  });
});
