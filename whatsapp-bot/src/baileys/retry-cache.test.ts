import { describe, it, expect } from "vitest";
import { createRetryCounterCache } from "./retry-cache.js";

describe("the retry-counter cache handed to makeWASocket", () => {
  it("implements Baileys' CacheStore: get, set, del, flushAll", () => {
    const c = createRetryCounterCache();
    expect(c.get("m:p")).toBeUndefined();
    c.set("m:p", 1);
    expect(c.get<number>("m:p")).toBe(1);
    c.set("m:p", 2);
    expect(c.get<number>("m:p")).toBe(2);
    c.del("m:p");
    expect(c.get("m:p")).toBeUndefined();
    c.set("a", 1);
    c.set("b", 1);
    c.flushAll();
    expect(c.get("a")).toBeUndefined();
    expect(c.get("b")).toBeUndefined();
  });

  it("forgets an entry after its TTL, as Baileys' own one-hour default does", () => {
    let now = 0;
    const c = createRetryCounterCache({ ttlMs: 1_000, now: () => now });
    c.set("m:p", 3);
    now = 999;
    expect(c.get("m:p")).toBe(3);
    now = 1_000;
    expect(c.get("m:p")).toBeUndefined();
  });

  it("is bounded, oldest first", () => {
    const c = createRetryCounterCache({ max: 2 });
    c.set("a", 1);
    c.set("b", 1);
    c.set("c", 1);
    expect(c.get("a")).toBeUndefined();
    expect(c.get("b")).toBe(1);
    expect(c.get("c")).toBe(1);
  });
});
