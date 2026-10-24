/**
 * Slice L7 source guards: a block or a report is never told to the other
 * side. The block and report module reaches only the platform owner
 * (`owner-dm.ts`) and the player's OWN pause messages; it never sends the
 * club a notice. The removal DM goes only to the guest himself.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = (f: string) => readFileSync(join(__dirname, "..", f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("blocks and reports reach only the owner", () => {
  const safety = src("safety.ts");
  it("safety.ts never sends a club notice or a club BotJob", () => {
    expect(safety).not.toMatch(/admin-channel|sendAdminNotice|botJob/);
  });
  it("every DM it queues is the owner's, or a pause line to the player himself", () => {
    expect(safety).toMatch(/queueOwnerDm\(/);
    const purposes = [...safety.matchAll(/queuePlatformDm\(\{[^}]*purpose:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(purposes)).toEqual(new Set(["pool-paused"]));
  });
  it("the owner DM carries no report text and no name", () => {
    const calls = [...safety.matchAll(/await tellOwner\(([\s\S]*?)\);/g)].map((m) => m[1]);
    expect(calls.length).toBe(2);
    for (const c of calls) expect(c).not.toMatch(/\btext\b|name|displayName/);
  });
});

describe("the organisers' removal DM goes to the guest alone", () => {
  it("removal.ts queues one platform DM and no club notice", () => {
    const r = src("removal.ts");
    expect(r).not.toMatch(/admin-channel|sendAdminNotice|botJob/);
    expect([...r.matchAll(/purpose:\s*"([^"]+)"/g)].map((m) => m[1])).toEqual(["pool-removed"]);
  });
});
