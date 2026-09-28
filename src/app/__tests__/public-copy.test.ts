import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * House rules for the public website copy (Kemal): no em dashes or en
 * dashes anywhere a visitor can read them, the real domain is
 * matchtime.ai (never matchtime.app), the bot is tagged as "@Match Time",
 * and no real club or player names on public pages.
 *
 * Checks the source of every public page with comments stripped, so the
 * rendered strings, metadata and JSON-LD are all covered.
 */
const ROOT = path.resolve(__dirname, "../../..");
const PUBLIC_FILES = [
  "src/components/landing/landing-page.tsx",
  "src/components/landing/stats-showcase.tsx",
  "src/app/help/layout.tsx",
  "src/app/help/page.tsx",
  "src/app/help/player/page.tsx",
  "src/app/help/admin/page.tsx",
  "src/app/layout.tsx",
  "src/app/create-org/page.tsx",
];

function stripComments(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const sources = PUBLIC_FILES.map((f) => ({
  file: f,
  text: stripComments(readFileSync(path.join(ROOT, f), "utf8")),
}));

describe("public website copy", () => {
  it.each(sources)("$file has no em dash or en dash", ({ text }) => {
    const hits = text.split("\n").filter((l) => /[—–]|&mdash;|&ndash;/.test(l));
    expect(hits).toEqual([]);
  });

  it.each(sources)("$file never says matchtime.app", ({ text }) => {
    expect(text).not.toMatch(/matchtime\.app/i);
  });

  it.each(sources)("$file spells the bot tag @Match Time", ({ text }) => {
    expect(text).not.toMatch(/@MatchTime/);
  });

  it.each(sources)("$file names no real club, player or venue", ({ text }) => {
    expect(text).not.toMatch(/Sutton|\bAbid\b|\bElvin\b|\bIbrahim\b|\bEhtisham\b|\bKarahan\b|\bNajib\b|at Goals\b|call Goals/);
  });
});
