import { describe, it, expect } from "vitest";
import { createSeenIds, DEFAULT_SEEN_MAX } from "./dedupe.js";

describe("createSeenIds", () => {
  it("reports the first sighting of an id, and only the first", () => {
    const first = createSeenIds();
    expect(first("3EB0A")).toBe(true);
    expect(first("3EB0A")).toBe(false);
    expect(first("3EB0B")).toBe(true);
  });

  it("is bounded, so a long-running bot does not grow a set forever", () => {
    const first = createSeenIds(3);
    first("a");
    first("b");
    first("c");
    first("d"); // evicts "a"
    expect(first("a")).toBe(true); // forgotten, so it looks new again
    expect(first("d")).toBe(false); // still remembered
  });

  it("has a sane default bound", () => {
    expect(DEFAULT_SEEN_MAX).toBeGreaterThanOrEqual(500);
  });

  it("ignores an empty id rather than collapsing every such message into one", () => {
    const first = createSeenIds();
    expect(first("")).toBe(true);
    expect(first("")).toBe(true);
  });
});
