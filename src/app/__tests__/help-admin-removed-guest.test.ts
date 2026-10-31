import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The organiser guide says what a Remove on the Players page now means for
 * guests (Kemal, 2026-10-31): a removed player is not brought back through
 * the player pool or a friend's link, and adding them back undoes it.
 */
const ADMIN = readFileSync(path.resolve(__dirname, "../help/admin/page.tsx"), "utf8");
const text = ADMIN.replace(/&apos;/g, "'").replace(/<[^>]+>/g, "").replace(/\s+/g, " ");

describe("organiser guide: a removed player and the guest doors", () => {
  it("says a removed player is not brought back as a guest by the pool or a friend's link", () => {
    expect(text).toMatch(/A player you remove here won't be brought back into your games as a guest through the MatchTime player pool or a friend's link\./);
  });
  it("says adding them back undoes it", () => {
    expect(text).toMatch(/A player you remove here[^.]*\.\s*Adding them back yourself undoes this\./);
  });
  it("no em or en dashes in the line", () => {
    const line = text.slice(text.indexOf("A player you remove here"), text.indexOf("undoes this.") + 12);
    expect(line).not.toMatch(/[–—]/);
  });
});
