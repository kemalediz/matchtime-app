import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The organiser guide explains picture reading only while it is switched
 * on (PICTURE_READING_ENABLED), in plain words, with no dashes.
 */
const GUIDE = readFileSync(path.resolve(__dirname, "../help/admin/page.tsx"), "utf8");

describe("organiser guide: picture reading", () => {
  const block = GUIDE.slice(GUIDE.indexOf("{picturesOn && ("), GUIDE.indexOf("<h3>Can I run two games"));

  it("is shown only behind the flag", () => {
    expect(GUIDE).toContain("const picturesOn = isPictureReadingEnabled();");
    expect(block).toContain("Does MatchTime read pictures?");
  });

  it("says who is read, that the picture is discarded and only text is kept", () => {
    expect(block).toMatch(/owner or admin/);
    expect(block).toMatch(/captioned/);
    expect(block).toMatch(/discarded/);
    expect(block).toMatch(/Only that text is kept/);
  });

  it("has no em or en dashes", () => {
    expect(block).not.toMatch(/[–—]/);
  });
});
