import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * An example phone number in a form placeholder must never be a real
 * person's number (2026-11-15: the players page showed a real player's
 * mobile to every club admin). UK examples come from Ofcom's range
 * reserved for drama and examples, 07700 900000 to 07700 900999.
 */
const ROOT = path.resolve(__dirname, "../../..");
const read = (f: string) => readFileSync(path.join(ROOT, f), "utf8");

/** A UK mobile in any of the usual spellings: 07…, +447…, +44 7…. */
const UK_MOBILE = /(?:\+44\s?7|\b07)\d{3}\s?\d{3}\s?\d{3}\b/g;
const digitsOf = (s: string) => s.replace(/\D/g, "").replace(/^44/, "0");
const isReserved = (s: string) => /^07700900\d{3}$/.test(digitsOf(s));

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(path.join(ROOT, dir))) {
    const rel = path.join(dir, name);
    if (name === "__tests__" || name === "node_modules") continue;
    if (statSync(path.join(ROOT, rel)).isDirectory()) out.push(...filesUnder(rel));
    else if (rel.endsWith(".tsx")) out.push(rel);
  }
  return out;
}

describe("phone placeholders use the reserved example range", () => {
  it("the players page Add a player phone box shows a reserved example", () => {
    const src = read("src/app/admin/players/page.tsx");
    const m = src.match(/placeholder="Phone \(optional, e\.g\. ([^)]+)\)"/);
    expect(m, "Add a player phone placeholder").not.toBeNull();
    expect(isReserved(m![1]), m![1]).toBe(true);
  });

  it("no placeholder in src/app or src/components holds a number outside 07700 900xxx", () => {
    const offenders: string[] = [];
    for (const f of [...filesUnder("src/app"), ...filesUnder("src/components")]) {
      for (const p of read(f).matchAll(/placeholder=(?:"([^"]*)"|\{\s*"([^"]*)"\s*\}|\{\s*'([^']*)'\s*\})/g)) {
        const text = p[1] ?? p[2] ?? p[3] ?? "";
        for (const n of text.match(UK_MOBILE) ?? []) {
          if (!isReserved(n)) offenders.push(`${f}: ${n}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
