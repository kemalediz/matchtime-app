/**
 * ONE WRITER FOR PARTNER ASKS (cross-club ask, slice S2).
 *
 * `PartnerAsk` rows are written by `src/lib/partner-ask.ts` (an ask's
 * life) and, from slice S3, `src/lib/partner-guest.ts` (its volunteers).
 * Nothing else, so the rules (`partner-ask-rules.ts`) and the
 * compare-and-sets cannot be skipped by a second writer.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "..", "..");
const REPO = path.resolve(SRC, "..");
const rel = (f: string) => path.relative(REPO, f);

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === "generated" || name === "node_modules" || name === "__tests__") continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const WRITERS = ["src/lib/partner-ask.ts", "src/lib/partner-guest.ts"];
const WRITE = /partnerAsk\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/;

describe("partner asks: one writer", () => {
  it("nothing but partner-ask.ts and partner-guest.ts writes a PartnerAsk row", () => {
    const files = [...walk(SRC), ...walk(path.join(REPO, "scripts"))];
    const offenders = files.filter((f) => !WRITERS.includes(rel(f)) && WRITE.test(readFileSync(f, "utf8")));
    expect(offenders.map(rel)).toEqual([]);
  });
});
