/**
 * THE MATCHTIME NUMBER IS SERVER-ONLY (plan section 5.2, Kemal's hard
 * rule for slice 4).
 *
 * The WhatsApp number MatchTime runs on must never be in a public page,
 * a public API response, a JS bundle or the sitemap. It is rendered only
 * inside the signed-in organiser's own club page, after the club exists.
 * The Playwright spec `e2e/web/self-join-organiser.spec.ts` proves the
 * rendered half against a running server; this file proves the source
 * half, so a later change cannot quietly widen the door:
 *
 *   1. exactly one source file reads `MATCHTIME_WA_NUMBER`
 *      (src/lib/club-connect.ts);
 *   2. nothing anywhere names a `NEXT_PUBLIC_` variant of it (Next inlines
 *      those into every client bundle);
 *   3. no client component ("use client") imports lib/club-connect.ts,
 *      so the reader can never be bundled for the browser (importing
 *      the server ACTION in app/actions/club-connect.ts is fine: Next
 *      sends the browser a reference to it, never its code);
 *   4. next.config does not forward it through `env` either.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const SRC = path.join(ROOT, "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === "generated" || name === "node_modules" || name === "__tests__") continue;
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const FILES = walk(SRC);
const READER = path.join(SRC, "lib", "club-connect.ts");

describe("MATCHTIME_WA_NUMBER stays on the server", () => {
  it("exactly one source file reads it: src/lib/club-connect.ts", () => {
    const readers = FILES.filter((f) => readFileSync(f, "utf8").includes("MATCHTIME_WA_NUMBER"));
    expect(readers.map((f) => path.relative(SRC, f))).toEqual([path.relative(SRC, READER)]);
  });

  it("no NEXT_PUBLIC_ variant exists anywhere in src or the Next config", () => {
    const offenders = [...FILES, path.join(ROOT, "next.config.ts")].filter((f) =>
      /NEXT_PUBLIC_[A-Z_]*WA_NUMBER|NEXT_PUBLIC_MATCHTIME_(WA|PHONE|NUMBER)/.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("no client component imports the reader", () => {
    const offenders = FILES.filter((f) => {
      const src = readFileSync(f, "utf8");
      return /^\s*["']use client["']/.test(src) && /from\s+["'](?:@\/lib\/|\.{1,2}\/(?:[^"']*\/)?)club-connect["']/.test(src);
    });
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });

  it("next.config does not forward it to the browser", () => {
    expect(readFileSync(path.join(ROOT, "next.config.ts"), "utf8")).not.toContain("MATCHTIME_WA_NUMBER");
  });
});
