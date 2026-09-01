/**
 * Unit tests for the per-checkout port allocator.
 *
 * These pin the PROPERTIES the allocator must have (distinct per
 * checkout, stable across runs, overridable, loud on garbage). They are
 * deliberately NOT the evidence that the suite is isolated — a config
 * assertion proves nothing, and the hard-coded ports these replaced
 * would have satisfied "APP_PORT is a number" just as happily. The
 * evidence lives in `isolation.test.ts`, which starts two real
 * databases from two real checkouts at the same time.
 */
import { describe, expect, it } from "vitest";
import {
  PORT_BASE,
  PORT_SPAN,
  checkoutSlot,
  describePorts,
  resolvePorts,
} from "./ports";

const A = "/Users/dev/Projects/matchtime";
const B = "/Users/dev/Projects/matchtime/.claude/worktrees/agent-a9a9acfa8b2c";
const C = "/Users/dev/Projects/matchtime/.claude/worktrees/agent-ffffffffffff";

describe("checkoutSlot", () => {
  it("is stable for the same checkout path", () => {
    expect(checkoutSlot(A)).toBe(checkoutSlot(A));
    expect(checkoutSlot(B)).toBe(checkoutSlot(B));
  });

  it("is insensitive to trailing separators and non-canonical segments", () => {
    expect(checkoutSlot(`${A}/`)).toBe(checkoutSlot(A));
    expect(checkoutSlot(`${A}/./`)).toBe(checkoutSlot(A));
    expect(checkoutSlot(`${A}/x/..`)).toBe(checkoutSlot(A));
  });

  it("stays inside the allocated span", () => {
    for (const root of [A, B, C, "/", "/tmp/x", "/a/b/c/d/e/f"]) {
      const slot = checkoutSlot(root);
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(slot).toBeLessThan(PORT_SPAN);
    }
  });

  it("separates sibling worktrees whose paths differ only in the suffix", () => {
    // The real-world collision shape: agent worktrees under one repo.
    expect(checkoutSlot(B)).not.toBe(checkoutSlot(C));
    expect(checkoutSlot(A)).not.toBe(checkoutSlot(B));
  });

  it("spreads a realistic fleet of worktrees over distinct slots", () => {
    const roots = Array.from(
      { length: 12 },
      (_, i) => `/Users/dev/Projects/matchtime/.claude/worktrees/agent-${i.toString(16).repeat(6)}`,
    );
    const slots = new Set(roots.map(checkoutSlot));
    // Not a guarantee (see the PR: collisions are possible by design and
    // are caught loudly by the preflight) — but a 12-way pile-up would
    // mean the hash is broken.
    expect(slots.size).toBeGreaterThanOrEqual(11);
  });
});

describe("resolvePorts", () => {
  it("derives both ports from the checkout, above the historical bases", () => {
    const p = resolvePorts(A, {});
    expect(p.appSource).toBe("checkout");
    expect(p.dbSource).toBe("checkout");
    expect(p.app).toBe(PORT_BASE.app + p.slot);
    expect(p.db).toBe(PORT_BASE.db + p.slot);
    expect(p.app).toBeGreaterThanOrEqual(PORT_BASE.app);
    expect(p.app).toBeLessThan(PORT_BASE.app + PORT_SPAN);
  });

  it("gives two different checkouts two different port pairs", () => {
    const a = resolvePorts(A, {});
    const b = resolvePorts(B, {});
    expect(a.app).not.toBe(b.app);
    expect(a.db).not.toBe(b.db);
  });

  it("is reproducible: the same checkout gets the same pair every run", () => {
    expect(resolvePorts(B, {})).toEqual(resolvePorts(B, {}));
  });

  it("lets an explicit override win, and says so", () => {
    const p = resolvePorts(A, { MT_E2E_APP_PORT: "3999", MT_E2E_DB_PORT: "54999" });
    expect(p.app).toBe(3999);
    expect(p.db).toBe(54999);
    expect(p.appSource).toBe("env");
    expect(p.dbSource).toBe("env");
  });

  it("allows overriding one port without the other", () => {
    const p = resolvePorts(A, { MT_E2E_DB_PORT: "54999" });
    expect(p.db).toBe(54999);
    expect(p.dbSource).toBe("env");
    expect(p.appSource).toBe("checkout");
  });

  it("refuses a garbage override rather than silently falling back", () => {
    for (const bad of ["", "  ", "nope", "3105.5", "-1", "0", "80", "70000", "3105 3106"]) {
      expect(() => resolvePorts(A, { MT_E2E_APP_PORT: bad })).toThrow(/MT_E2E_APP_PORT/);
    }
  });

  it("refuses to point the two services at the same port", () => {
    expect(() => resolvePorts(A, { MT_E2E_APP_PORT: "4000", MT_E2E_DB_PORT: "4000" })).toThrow(
      /same port/i,
    );
  });

  it("describes itself well enough to debug a run from its log", () => {
    const line = describePorts(resolvePorts(A, {}));
    expect(line).toContain(String(resolvePorts(A, {}).app));
    expect(line).toContain(String(resolvePorts(A, {}).db));
    expect(line).toContain(A);
    expect(line).toMatch(/MT_E2E_APP_PORT|override/i);
  });
});
