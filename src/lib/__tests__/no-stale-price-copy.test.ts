/**
 * NO USER-FACING STRING STILL STATES THE OLD PRICE OR THE OLD FREE PERIOD
 * (Kemal, 2026-10-28: "Reduce the price to 4.99 and make the trial 3 months
 * everywhere").
 *
 * The price is STANDARD_PRICE_PENCE (club-billing-rules.ts) and the free
 * period FREE_PERIOD_MONTHS; copy reads them through club-price-words.ts and
 * i18n/free-period.ts. This sweep reads every source file under src (tests,
 * generated code and comments left out) and fails on the old numbers typed
 * into copy: "9.99", the old derived amounts (GBP 7.49 for 3 weeks of 4,
 * GBP 2.50 a game), "two months" and "iki ay".
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === "generated" || name === "node_modules" || name === "__tests__" || name === "__fixtures__") continue;
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

function stripComments(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

const STALE: RegExp[] = [/9\.99/, /£7\.49/, /£2\.50/, /\btwo months\b/i, /\biki ay\b/i, /\bfirst two months\b/i];

describe("no stale price or free period length in copy", () => {
  const files = walk(SRC);

  it("the sweep sees the pages and the string tables (so it is not vacuous)", () => {
    for (const rel of ["components/landing/pricing-section.tsx", "app/help/admin/page.tsx", "lib/i18n/strings.en.ts", "lib/i18n/strings.tr.ts"]) {
      expect(files).toContain(path.join(SRC, rel));
    }
  });

  it("no source file types the old price, its old derived amounts, or the old length", () => {
    const hits: string[] = [];
    for (const file of files) {
      const lines = stripComments(readFileSync(file, "utf8")).split("\n");
      lines.forEach((line, i) => {
        if (STALE.some((re) => re.test(line))) hits.push(`${path.relative(SRC, file)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
