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
  ["src/app/admin/matches/[matchId]/cancel/page.tsx", ["Match cancelled. MatchTime will announce it in the group.", "MatchTime stops posting reminders, polls, and DMs for this match", "MatchTime posts a cancellation announcement in the group"]],
  ["src/app/admin/matches/[matchId]/switch-format/page.tsx", ["Match switched. MatchTime will announce it in the group.", "MatchTime posts the new lineup in the group"]],
  ["src/app/admin/block-bookings/new/new-block-form.tsx", ["MatchTime will only ever announce the"]],
  ["src/app/admin/players/ratings/page.tsx", ["Edit seed ratings"]],
  ["src/app/admin/players/phones/page.tsx", ["Edit phone numbers"]],
];

describe("admin pages: MatchTime, never the bot", () => {
  it.each(PAGES)("%s says MatchTime", (file, phrases) => {
    const copy = copyOf(read(file));
    expect(copy).not.toMatch(/WhatsApp bot|\bthe bot\b|\bBot (last|will|stops|posts)\b|\bbot&apos;s\b|\bBulk edit\b/i);
    for (const p of phrases) expect(copy, p).toContain(p);
  });
});
