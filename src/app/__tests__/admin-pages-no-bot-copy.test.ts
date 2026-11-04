import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The admin pages call it MatchTime, never "the bot" or "the WhatsApp
 * bot" (Kemal, 2026-11-04). Comments and code names are not copy, so
 * only the text a person reads is checked: JSX text and string literals.
 */
const ROOT = path.resolve(__dirname, "../../..");
const read = (f: string) => readFileSync(path.join(ROOT, f), "utf8");

/** Drop comments so a code note about "the bot" is not read as copy. */
const copyOf = (src: string) =>
  src
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

const PAGES: Array<[string, string[]]> = [
  ["src/app/admin/players/page.tsx", ["MatchTime recognise them automatically", "Add a nickname or other name MatchTime should recognise"]],
  ["src/app/admin/health/page.tsx", ["What MatchTime has flagged", "No club has MatchTime switched on.", "MatchTime last reported", "MatchTime has not reported yet."]],
  ["src/app/admin/unresolved/page.tsx", ["messages MatchTime received but couldn", "MatchTime hit an error writing these", "MatchTime&apos;s WhatsApp connection"]],
  ["src/app/admin/organisations/dormancy-button.tsx", ["MatchTime for a live club", "switch MatchTime off in settings"]],
];

describe("admin pages: MatchTime, never the bot", () => {
  it.each(PAGES)("%s says MatchTime", (file, phrases) => {
    const copy = copyOf(read(file));
    expect(copy).not.toMatch(/WhatsApp bot|\bthe bot\b|\bBot last\b|\bbot&apos;s\b/i);
    for (const p of phrases) expect(copy, p).toContain(p);
  });
});
