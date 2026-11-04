/**
 * GUARD: ONE DEFINITION OF THE FEE A PLAYER IS TOLD (club summary, slice
 * B5; decision K3, Kemal 2026-11-04).
 *
 * Before B5 the fee was worked out five ways (plan D9): `match ?? game` in
 * the DM answer and the club answer, the match's alone on the pay page,
 * `match, then PAYG, then game unless split` for guests, `match else PAYG`
 * at the month's close. `feeFact` (fee-fact.ts) is the one rule now, and
 * every door that tells a player a fee reads it.
 *
 *   - No file outside fee-fact.ts falls back from a match's fee to another
 *     amount inline (`feePerPlayer ?? ...feePerPlayer`, `matchFee ?? ...`),
 *     except the named narrower rules below, each with its reason.
 *   - Each door that tells a player a fee imports the rule.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "../..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (["__tests__", "generated", "node_modules"].includes(name)) continue;
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/** A fallback from one fee to another, written inline. */
const INLINE_FALLBACK = [
  /feePerPlayer\s*\?\?[^;\n]*feePerPlayer/,
  /\bmatchFee\s*\?\?/,
  /feePerPlayer\s*!=\s*null\s*\?[^;\n]*paygPricePence/,
  /\bguestFeePounds\b\s*\(/,
];

/** Narrower rules that combine two amounts on purpose, with the reason. */
const NARROWER = new Map<string, string>([
  [
    "lib/month-close.ts",
    // The month's close summary lists what each pay as you go player owes
    // for the month's games, for the collector: the match's fee where one
    // was confirmed, else the club's PAYG price. A summary, not a charge.
    "the month's PAYG owed list",
  ],
]);

const THE_RULE = "lib/fee-fact.ts";

/** Every door that tells a player a fee (plan D9, the five meanings). */
const DOORS = [
  "lib/club-summary/derive.ts", // the summary's `fee.forPlayers`
  "lib/pipeline/load-state.ts", // the club answer without a summary
  "lib/my-payments.ts", // the DM answer's YOUR PAYMENTS block
  "lib/pool/offer-facts.ts", // the pool offer and, through it, the friend link
  "lib/partner-ask.ts", // the partner ask
  "app/pay/[matchId]/page.tsx", // the pay page
];

describe("one fee (B5, K3)", () => {
  const files = sourceFiles(SRC).map((f) => ({ rel: path.relative(SRC, f), text: readFileSync(f, "utf8") }));

  it("the scan is alive", () => {
    expect(files.some((f) => f.rel === THE_RULE)).toBe(true);
    expect(files.length).toBeGreaterThan(500);
  });

  it("no file falls back from one fee to another inline, outside the rule", () => {
    const offenders = files
      .filter((f) => f.rel !== THE_RULE && !NARROWER.has(f.rel))
      .filter((f) => INLINE_FALLBACK.some((re) => re.test(f.text)))
      .map((f) => f.rel);
    expect(offenders, `use feeFact (fee-fact.ts): ${offenders.join(", ")}`).toEqual([]);
  });

  it("each narrower rule still exists (the list only shrinks)", () => {
    for (const rel of NARROWER.keys()) {
      const f = files.find((x) => x.rel === rel);
      expect(f && INLINE_FALLBACK.some((re) => re.test(f.text)), rel).toBe(true);
    }
  });

  it("every door that tells a player a fee reads the one rule", () => {
    for (const rel of DOORS) {
      const f = files.find((x) => x.rel === rel);
      expect(f?.text, rel).toMatch(/from "(\.\.?\/)+fee-fact"|from "@\/lib\/fee-fact"/);
    }
  });
});
