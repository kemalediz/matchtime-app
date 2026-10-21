/**
 * ONE CACHE MARKER, ONE PLACE (2026-10-19).
 *
 * Every raw `messages.create` site used to type its own
 * `cache_control: { type: "ephemeral", ttl: "1h" }` literal, and one
 * (dm-qa) typed none at all. Now every site builds its system prompt with
 * `systemBlock` from `pipeline/llm.ts`, which carries the shared
 * `PIPELINE_CACHE_CONTROL`, and only a once-per-club call opts out with
 * `{ cache: false }`. These scans keep it that way.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "../..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (name === "__tests__" || name === "generated" || name === "node_modules") continue;
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const FILES = sourceFiles(SRC).map((p) => ({ rel: path.relative(SRC, p), text: readFileSync(p, "utf8") }));
const LLM = path.join("lib", "pipeline", "llm.ts");

/** Source with comments removed, so a comment quoting a literal is not code. */
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("one cache marker, one place", () => {
  it("no file but pipeline/llm.ts spells a cache_control literal", () => {
    const offenders = FILES.filter(
      (f) => f.rel !== LLM && /cache_control:\s*\{/.test(code(f.text)),
    ).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("every raw messages.create site builds its system prompt with systemBlock", () => {
    const sites = FILES.filter((f) => f.rel !== LLM && /messages\.create\(/.test(code(f.text)));
    // Nine since 2026-10-20: the chase composer moved onto pipeline/llm.ts.
    // Eight later that day: so did the DM Q&A (DM_QA_CALL, on Haiku 5.5).
    // Six on 2026-10-21: the squad-list and onboarding readings too.
    expect(sites.length).toBeGreaterThanOrEqual(6);
    const missing = sites.filter((f) => !/system:\s*systemBlock\(/.test(code(f.text))).map((f) => f.rel);
    expect(missing).toEqual([]);
  });

  it("dm-qa carries the marker: it goes through pipeline/llm.ts, which always sends it", () => {
    const dmQa = FILES.find((f) => f.rel === path.join("lib", "dm-qa.ts"))!;
    expect(code(dmQa.text)).not.toMatch(/messages\.create\(/);
    expect(code(dmQa.text)).toMatch(/anthropicModel\(/);
  });

  it("the once-per-club onboarding analysis opts out, like the setup reading", () => {
    // One call per org at onboarding: a 1-hour write (2x input) is never read back.
    // Through pipeline/llm.ts since 2026-10-21, which passes `cache` to
    // systemBlock (`ModelRequest.cache`).
    const f = FILES.find((x) => x.rel === path.join("lib", "onboarding-analyzer.ts"))!;
    expect(code(f.text)).not.toMatch(/messages\.create\(/);
    expect(code(f.text)).toMatch(/cache: false,/);
  });
});
