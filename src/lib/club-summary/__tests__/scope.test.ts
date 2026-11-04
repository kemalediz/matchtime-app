/**
 * ONE SUMMARY PER CLUB, FOR ONE REQUEST OR ONE POLL, NEVER LONGER (plan 3.4).
 *
 * Vercel reuses a warm module across requests and the Pi polls every 30
 * seconds: a cache that outlived one request would serve yesterday's squad.
 * The scope is created at the top of each entry point and dropped with it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { summaryScope, type SummaryLoader } from "../scope";
import type { ClubSummary } from "../types";

const NOW = new Date("2026-11-04T12:00:00Z");

function fakeLoader() {
  let n = 0;
  const loader = vi.fn<SummaryLoader>(async (orgId, now, opts) => {
    n++;
    return { orgId, asOf: now.toISOString(), members: opts?.members ? { roster: [], adminUserIds: [] } : null, name: `load ${n}` } as unknown as ClubSummary;
  });
  return loader;
}

describe("summaryScope", () => {
  it("loads a club once per scope, at the scope's clock", async () => {
    const loader = fakeLoader();
    const scope = summaryScope(NOW, loader);
    const [a, b] = await Promise.all([scope.get("org-a"), scope.get("org-a")]);
    expect(a).toBe(b);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledWith("org-a", NOW, { members: false });
  });

  it("each club its own summary", async () => {
    const loader = fakeLoader();
    const scope = summaryScope(NOW, loader);
    await scope.get("org-a");
    await scope.get("org-b");
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("two scopes share nothing (a new request reads the club again)", async () => {
    const loader = fakeLoader();
    const first = await summaryScope(NOW, loader).get("org-a");
    const second = await summaryScope(NOW, loader).get("org-a");
    expect(first).not.toBe(second);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("asking for members after a summary without them loads once more; without them after with them reuses it", async () => {
    const loader = fakeLoader();
    const scope = summaryScope(NOW, loader);
    const bare = await scope.get("org-a");
    const full = await scope.get("org-a", { members: true });
    expect(full).not.toBe(bare);
    expect(full!.members).not.toBeNull();
    expect(await scope.get("org-a")).toBe(full);
    expect(await scope.get("org-a", { members: true })).toBe(full);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("refresh drops the club's summary, so the next read sees the request's own writes", async () => {
    const loader = fakeLoader();
    const scope = summaryScope(NOW, loader);
    const before = await scope.get("org-a", { members: true });
    scope.refresh("org-a");
    const after = await scope.get("org-a");
    expect(after).not.toBe(before);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("a failed load is not kept: the next read tries again", async () => {
    const loader = vi.fn<SummaryLoader>().mockRejectedValueOnce(new Error("db down")).mockResolvedValue(null);
    const scope = summaryScope(NOW, loader);
    await expect(scope.get("org-a")).rejects.toThrow("db down");
    await expect(scope.get("org-a")).resolves.toBeNull();
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("has no module-level state and imports no database client", () => {
    const src = readFileSync(path.resolve(__dirname, "../scope.ts"), "utf8");
    expect(src).not.toMatch(/from "\.\.\/db"|from "@\/lib\/db"|from "\.\/load"/);
    // The only top-level bindings are the exported function and types.
    const topLevel = src.split("\n").filter((l) => /^(const|let|var) /.test(l));
    expect(topLevel).toEqual([]);
  });
});
